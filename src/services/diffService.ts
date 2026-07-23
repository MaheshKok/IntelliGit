// Diff and comparison operations extracted from extension.ts.
// Handles opening diffs against git refs, commit file diffs,
// and applying/reverting single-file patches.

import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { applyPatchTextToRepo } from "../git/patchApplication";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";
import {
    getCommitParentHashes,
    pickMainlineParent,
    buildCommitFilePatch,
    isValidGitHash,
} from "./gitHelpers";
import { assertRepoRelativePath } from "../utils/fileOps";
import { EMPTY_TREE_HASH } from "../utils/constants";

const READONLY_DIFF_SCHEME = "intelligit-diff";
const readonlyDiffDocuments = new Map<string, string>();
let readonlyDiffDocumentSeq = 0;

/**
 * Serves ephemeral read-only documents used as the left and right sides of VS Code diffs.
 *
 * Content is keyed by the full virtual URI and removed when the document closes
 * or the provider is disposed, so callers must not treat these URIs as stable
 * across sessions.
 */
class ReadonlyDiffContentProvider implements vscode.TextDocumentContentProvider {
    /** Returns the registered virtual document text, or an empty document for stale URIs. */
    provideTextDocumentContent(uri: vscode.Uri): string {
        return readonlyDiffDocuments.get(uri.toString()) ?? "";
    }

    /** Clears all virtual diff documents owned by this provider instance. */
    dispose(): void {
        readonlyDiffDocuments.clear();
    }
}

/**
 * Registers the virtual document provider backing commit and ref comparison diffs.
 *
 * The returned disposable unregisters the provider, removes the close listener,
 * and clears cached document content. Activation code should keep the disposable
 * in the extension context so virtual diff documents do not leak between sessions.
 */
export function registerReadonlyDiffContentProvider(
    context: vscode.ExtensionContext,
): vscode.Disposable {
    const provider = new ReadonlyDiffContentProvider();
    const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
        READONLY_DIFF_SCHEME,
        provider,
    );
    const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === READONLY_DIFF_SCHEME) {
            readonlyDiffDocuments.delete(document.uri.toString());
        }
    });
    const cleanup = {
        dispose: () => {
            providerRegistration.dispose();
            closeListener.dispose();
            provider.dispose();
        },
    };
    context.subscriptions.push(providerRegistration, closeListener, cleanup);
    return cleanup;
}

/**
 * Creates a unique virtual URI for immutable diff content from a Git ref or commit side.
 *
 * `filePath` must already be a repository-relative Git path. It is stored as a decoded
 * URI path so VS Code serializes special characters exactly once; it is never resolved
 * against the workspace filesystem. `refLabel` is stored as JSON `query.ref` so the
 * contributed resource formatter identifies each readonly diff side without changing
 * provider storage semantics.
 */
export function createReadonlyDiffUri(
    filePath: string,
    content: string,
    refLabel: string,
): vscode.Uri {
    readonlyDiffDocumentSeq += 1;
    const query = JSON.stringify({
        id: String(readonlyDiffDocumentSeq),
        ref: refLabel,
    });
    const uri = vscode.Uri.from({
        scheme: READONLY_DIFF_SCHEME,
        path: `/${filePath}`,
        query,
    });
    readonlyDiffDocuments.set(uri.toString(), content);
    return uri;
}

/**
 * Converts local path separators to the slash-separated path format expected by Git output.
 *
 * This does not resolve `..`, check containment, or touch the filesystem; callers
 * that receive user input must validate the path separately.
 */
export function normalizeGitPath(fsPathValue: string): string {
    return fsPathValue.split(path.sep).join("/");
}

/**
 * Converts a local file URI under the active repository root into a Git-relative path.
 *
 * Non-file URIs, the repository root itself, and paths outside `repoRoot` return
 * `null` so command handlers can show a user-facing availability error instead
 * of passing unsafe paths to Git or VS Code diff commands.
 */
export function getRepoRelativeFilePathFromUri(uri: vscode.Uri, repoRoot: string): string | null {
    if (uri.scheme !== "file") return null;
    const relative = path.relative(repoRoot, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return normalizeGitPath(relative);
}

function getEditorContextFileUri(ctx?: unknown): vscode.Uri | null {
    if (ctx instanceof vscode.Uri) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri?.scheme === "file" ? activeUri : null;
}

interface CommitInfoFileContext {
    filePath: string;
    commitHash: string;
    commitShortHash?: string;
}

/**
 * Extracts the commit-info context supplied by tree and webview command handlers.
 *
 * The object is treated as untrusted boundary data: missing or whitespace-only
 * commit hashes and file paths are ignored before any Git or filesystem work runs.
 */
function getCommitInfoFileContext(value: unknown): CommitInfoFileContext | null {
    if (!value || typeof value !== "object") return null;
    const maybe = value as {
        filePath?: unknown;
        commitHash?: unknown;
        commitShortHash?: unknown;
    };
    if (typeof maybe.filePath !== "string" || typeof maybe.commitHash !== "string") return null;
    const filePath = maybe.filePath.trim();
    const commitHash = maybe.commitHash.trim();
    const commitShortHash =
        typeof maybe.commitShortHash === "string" ? maybe.commitShortHash.trim() : undefined;
    if (!filePath || !commitHash) return null;
    return { filePath, commitHash, commitShortHash };
}

/**
 * Opens a VS Code diff between a working-tree file and its content at a Git ref.
 *
 * `repoRelativeFilePath` must already be validated and slash-separated. Git read
 * failures propagate to the caller so UI command handlers can display the
 * workflow-specific error message.
 */
async function openDiffAgainstGitRef(
    fileUri: vscode.Uri,
    repoRelativeFilePath: string,
    ref: string,
    sourceLabel: "revision" | "branch",
    gitOps: GitOps,
): Promise<void> {
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    const refContent = await gitOps.getFileContentAtRef(repoRelativeFilePath, trimmedRef);
    const leftUri = createReadonlyDiffUri(repoRelativeFilePath, refContent, trimmedRef);
    const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, fileUri, title);
}

/**
 * Opens a read-only diff for the selected file as changed by a specific commit.
 *
 * The commit hash is validated before Git is called and `filePath` must be a
 * repository-relative path. Merge commits prompt for the mainline parent; files
 * missing on either side are represented as empty virtual documents so deletes
 * and adds still open in the diff editor.
 *
 * @throws When the commit hash or file path is unsafe, or when parent discovery
 * fails before the user can choose a merge mainline.
 */
export async function openCommitFileDiff(
    commitHash: string,
    filePath: string,
    _repoRoot: string,
    gitOps: GitOps,
    executor: GitExecutor,
): Promise<void> {
    const validatedHash = commitHash.trim();
    if (!isValidGitHash(validatedHash)) {
        throw new Error("Invalid commit hash received for file diff action.");
    }
    const safePath = assertRepoRelativePath(filePath);
    const parents = await getCommitParentHashes(validatedHash, executor);

    let parentRef: string;
    let parentDisplayHash: string;
    if (parents.length > 1) {
        const result = await pickMainlineParent(
            validatedHash,
            "Open Commit File Diff",
            executor,
            parents,
        );
        if (result.kind === "cancelled") return;
        if (result.kind === "notMerge") return;
        parentRef = `${validatedHash}^${result.parentNumber}`;
        parentDisplayHash = parents[result.parentNumber! - 1] ?? parentRef;
    } else {
        parentRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
        parentDisplayHash = parentRef;
    }

    let leftContent: string;
    try {
        leftContent = await gitOps.getFileContentAtRef(safePath, parentRef);
    } catch {
        leftContent = "";
    }

    let rightContent: string;
    try {
        rightContent = await gitOps.getFileContentAtRef(safePath, validatedHash);
    } catch {
        rightContent = "";
    }

    const shortParent = parentDisplayHash.slice(0, 8);
    const shortCommit = validatedHash.slice(0, 8);
    const leftUri = createReadonlyDiffUri(safePath, leftContent, shortParent);
    const rightUri = createReadonlyDiffUri(safePath, rightContent, shortCommit);
    const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
}

/**
 * Prompts for a branch and opens a read-only comparison with the active editor file.
 *
 * The command is safe to invoke only when a local file under `repoRoot` is active.
 * Invalid editor context and Git failures are shown to the user; the comparison
 * does not mutate the repository.
 */
export async function compareEditorFileWithBranch(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with Branch is only available for local files."),
        );
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Selected file is outside the current IntelliGit repository workspace."),
        );
        return;
    }

    try {
        const branches = await gitOps.getBranches();
        const picks = branches
            .slice()
            .sort((a, b) => {
                if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
                if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .map((branch) => ({
                label: branch.isCurrent ? `${branch.name} (current)` : branch.name,
                description: branch.isRemote ? "remote branch" : "local branch",
                detail: branch.hash,
                refName: branch.name,
            }));

        const picked = await vscode.window.showQuickPick(picks, {
            title: vscode.l10n.t("Compare with Branch"),
            placeHolder: vscode.l10n.t("Select a branch for {path}", {
                path: repoRelativeFilePath,
            }),
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        await openDiffAgainstGitRef(
            fileUri,
            repoRelativeFilePath,
            picked.refName,
            "branch",
            gitOps,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with branch failed: {message}", { message }),
        );
    }
}

/**
 * Prompts for a recent or manually entered revision and compares it with the active file.
 *
 * Recent history is limited to the selected repository-relative file path. Prompt
 * cancellation is a no-op, and any Git or diff opening error is converted into a
 * user-facing message without changing repository state.
 */
export async function compareEditorFileWithRevision(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with Revision is only available for local files."),
        );
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Selected file is outside the current IntelliGit repository workspace."),
        );
        return;
    }

    try {
        const historyEntries = await gitOps.getFileHistoryEntries(repoRelativeFilePath, 20);
        const MANUAL_SENTINEL = "__manual__";
        const historyPicks = historyEntries.map((entry) => ({
            label: `${entry.shortHash}  ${entry.subject || "(no subject)"}`,
            description: entry.author,
            detail: entry.date,
            refName: entry.hash,
        }));
        const picks = [
            ...historyPicks,
            {
                label: vscode.l10n.t("$(edit) Enter revision manually"),
                description: vscode.l10n.t("Commit hash, tag, or ref name"),
                detail: undefined as string | undefined,
                refName: MANUAL_SENTINEL,
            },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
            title: vscode.l10n.t("Compare with Revision"),
            placeHolder:
                historyPicks.length > 0
                    ? vscode.l10n.t("Select a recent revision for {path}", {
                          path: repoRelativeFilePath,
                      })
                    : vscode.l10n.t("No recent file history found. Enter a revision for {path}", {
                          path: repoRelativeFilePath,
                      }),
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        let refName = picked.refName;
        if (refName === MANUAL_SENTINEL) {
            const input = await vscode.window.showInputBox({
                title: vscode.l10n.t("Compare with Revision"),
                prompt: vscode.l10n.t("Enter a commit hash, tag, or ref for {path}", {
                    path: repoRelativeFilePath,
                }),
                placeHolder: "HEAD~1",
                ignoreFocusOut: true,
            });
            if (!input?.trim()) return;
            refName = input.trim();
        }

        await openDiffAgainstGitRef(fileUri, repoRelativeFilePath, refName, "revision", gitOps);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with revision failed: {message}", { message }),
        );
    }
}

/**
 * Opens a diff from a commit-info file entry to the current local workspace file.
 *
 * The context object may come from a tree item or webview message and is ignored
 * when it lacks a commit hash or file path. The file path must validate as
 * repository-relative before it is joined with `repoRoot` for the local side.
 */
export async function compareCommitInfoFileWithLocal(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;
    try {
        const safePath = assertRepoRelativePath(fileCtx.filePath);
        const fileUri = vscode.Uri.file(path.join(repoRoot, safePath));
        await openDiffAgainstGitRef(fileUri, safePath, fileCtx.commitHash, "revision", gitOps);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with local failed: {message}", { message }),
        );
    }
}

/**
 * Applies or reverts the selected commit's change for a single file.
 *
 * This workflow mutates both the working tree and index through `git apply --index --3way`
 * after a modal confirmation. Merge commits may prompt for a
 * mainline parent, empty patches notify without mutation, errors are shown to
 * the user, and conflict UI refresh runs best-effort in `finally`.
 */
export async function applySelectedCommitFileChange(
    ctx: unknown,
    mode: "cherry-pick" | "revert",
    executor: GitExecutor,
    refreshConflictUi: () => Promise<void>,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;

    const short = fileCtx.commitShortHash || fileCtx.commitHash.slice(0, 8);
    const labels = COMMIT_FILE_CHANGE_MODE_LABELS[mode];
    const confirmLabel = labels.confirmLabel();

    const confirmed = await vscode.window.showWarningMessage(
        labels.confirmPrompt(short, fileCtx.filePath),
        { modal: true },
        confirmLabel,
    );
    if (confirmed !== confirmLabel) return;

    try {
        const patchText = await buildCommitFilePatch(
            fileCtx.commitHash,
            fileCtx.filePath,
            labels.actionTitle(),
            executor,
        );
        if (patchText === null) return; // merge parent selection cancelled
        if (!patchText.trim()) {
            showTimedInformationMessage(
                vscode.l10n.t("No file-level patch found for {path} in {short}.", {
                    path: fileCtx.filePath,
                    short,
                }),
            );
            return;
        }

        await runWithNotificationProgress(labels.progressMessage(fileCtx.filePath), async () => {
            await applyPatchTextToRepo(patchText, mode === "revert", executor);
        });

        showTimedInformationMessage(labels.successMessage(short, fileCtx.filePath));
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(labels.errorMessage(message));
    } finally {
        await refreshConflictUi().catch(() => {});
    }
}

const COMMIT_FILE_CHANGE_MODE_LABELS = {
    "cherry-pick": {
        actionTitle: () => vscode.l10n.t("Cherry-pick Selected Change"),
        confirmLabel: () => vscode.l10n.t("Apply Change"),
        confirmPrompt: (short: string, filePath: string) =>
            vscode.l10n.t(
                "Apply the change from {short} for {path} to your working tree and stage it?",
                { short, path: filePath },
            ),
        progressMessage: (filePath: string) =>
            vscode.l10n.t("Applying selected change for {path}...", { path: filePath }),
        successMessage: (short: string, filePath: string) =>
            vscode.l10n.t("Applied selected change from {short} for {path}.", {
                short,
                path: filePath,
            }),
        errorMessage: (message: string) =>
            vscode.l10n.t("Cherry-pick selected change failed: {message}", { message }),
    },
    revert: {
        actionTitle: () => vscode.l10n.t("Revert Selected Change"),
        confirmLabel: () => vscode.l10n.t("Revert Change"),
        confirmPrompt: (short: string, filePath: string) =>
            vscode.l10n.t(
                "Apply the inverse of the change from {short} for {path} to your working tree and stage it?",
                { short, path: filePath },
            ),
        progressMessage: (filePath: string) =>
            vscode.l10n.t("Reverting selected change for {path}...", { path: filePath }),
        successMessage: (short: string, filePath: string) =>
            vscode.l10n.t("Reverted selected change from {short} for {path}.", {
                short,
                path: filePath,
            }),
        errorMessage: (message: string) =>
            vscode.l10n.t("Revert selected change failed: {message}", { message }),
    },
} as const;
