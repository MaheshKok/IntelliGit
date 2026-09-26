import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import {
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
    createReadonlyDiffUri,
    showEditorFileDiff,
} from "../services/diffService";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import { rejectWhenOperationInProgress } from "./operationFence";

interface ResolvedFileCommandContext {
    selectedUri: vscode.Uri;
    canonicalFilePath: string;
    repoRoot: string;
    repoRelativePath: string;
    gitOps: GitOps;
}

const MAX_GIT_BLAME_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Canonicalizes a file's parent without following the leaf, preserving tracked symlink identity.
 * Missing-parent callers may walk ENOENT ancestors and append the missing lexical suffix; the
 * returned directory always exists so repository discovery can use it without creating folders.
 */
async function resolveCanonicalFileLocation(
    filePath: string,
    allowMissingParent = false,
): Promise<{ canonicalDirectory: string; canonicalFilePath: string }> {
    let existingDirectory = path.dirname(filePath);
    let canonicalDirectory: string;
    for (;;) {
        try {
            canonicalDirectory = await realpath(existingDirectory);
            break;
        } catch (error) {
            const parentDirectory = path.dirname(existingDirectory);
            if (
                !allowMissingParent ||
                (error as NodeJS.ErrnoException).code !== "ENOENT" ||
                parentDirectory === existingDirectory
            ) {
                throw error;
            }
            existingDirectory = parentDirectory;
        }
    }
    return {
        canonicalDirectory,
        canonicalFilePath: path.join(
            canonicalDirectory,
            path.relative(existingDirectory, filePath),
        ),
    };
}

/**
 * Resolves an explicit local-file command context, or the active editor only when context is absent.
 *
 * Repository discovery follows the canonical parent directory for linked worktrees and symlinked
 * parents, while `selectedUri` retains the original editor identity for dirty-buffer comparisons.
 * Malformed explicit contexts return `undefined`; repository and path validation failures reject.
 * Commit may opt into walking missing parents to the nearest existing ancestor, retaining their
 * lexical suffix beneath that ancestor's canonical path. Its caller must then validate an exact
 * tracked deletion; other commands continue to require the immediate parent to exist.
 */
async function resolveFileCommandContext(
    ctx: unknown,
    gitOps: GitOps,
    options?: { allowMissingParent?: boolean },
): Promise<ResolvedFileCommandContext | undefined> {
    const selectedUri =
        ctx === undefined
            ? vscode.window.activeTextEditor?.document.uri
            : ctx instanceof vscode.Uri
              ? ctx
              : undefined;
    if (!selectedUri || selectedUri.scheme !== "file") return undefined;

    const { canonicalDirectory, canonicalFilePath } = await resolveCanonicalFileLocation(
        selectedUri.fsPath,
        options?.allowMissingParent,
    );
    const executor = new GitExecutor(canonicalDirectory);
    const output = await executor.run(["rev-parse", "--show-toplevel"]);
    const repoRoot = output.replace(/\r?\n$/, "");
    const relativePath = path.relative(repoRoot, canonicalFilePath);
    if (
        !repoRoot ||
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(
            vscode.l10n.t("Selected file is outside the current IntelliGit repository workspace."),
        );
    }

    return {
        selectedUri,
        canonicalFilePath,
        repoRoot,
        repoRelativePath: relativePath.split(path.sep).join("/"),
        gitOps: gitOps.deriveFor(repoRoot),
    };
}

/**
 * Fetches remote refs for the repository that owns the selected local file.
 *
 * The selected path is used only to resolve repository ownership. A successful fetch returns the
 * canonical repository root so callers can avoid refreshing a different active repository.
 */
export async function fetchFile(ctx: unknown, gitOps: GitOps): Promise<string | undefined> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Fetch is only available for local files."),
            );
            return undefined;
        }
        await runWithNotificationProgress(vscode.l10n.t("Fetching..."), async () => {
            await resolved.gitOps.fetch();
        });
        await vscode.window.showInformationMessage(vscode.l10n.t("Fetched successfully."));
        return resolved.repoRoot;
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Fetch failed: {message}", { message: getErrorMessage(error) }),
        );
        return undefined;
    }
}

/**
 * Resolves the selected local file's repository and delegates Pull to the shared panel flow.
 *
 * The callback receives repository-scoped Git operations plus the canonical root so its caller can
 * refresh only the matching active graph. Resolution and callback failures are reported here.
 */
export async function pullFileRepositoryFromContext(
    ctx: unknown,
    gitOps: GitOps,
    runPull: (scopedGitOps: GitOps, repoRoot: string) => Promise<void>,
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Pull is only available for local files."),
            );
            return;
        }
        await runPull(resolved.gitOps, resolved.repoRoot);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Pull failed: {message}", { message: getErrorMessage(error) }),
        );
    }
}

/**
 * Resolves the selected local file's repository and delegates Push to the shared panel flow.
 *
 * The callback receives repository-scoped Git operations plus the canonical root so its caller can
 * publish and refresh the selected repository without borrowing active-repository state.
 */
export async function pushFileRepositoryFromContext(
    ctx: unknown,
    gitOps: GitOps,
    runPush: (scopedGitOps: GitOps, repoRoot: string) => Promise<void>,
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Push is only available for local files."),
            );
            return;
        }
        await runPush(resolved.gitOps, resolved.repoRoot);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Push failed: {message}", { message: getErrorMessage(error) }),
        );
    }
}

/**
 * Finds unsaved editors through direct or canonical parent aliases without querying Git.
 * Commit opts into missing-parent resolution so deleted files keep their dirty-buffer identity;
 * other callers preserve the existing behavior for inaccessible parent directories.
 */
async function hasDirtyDocument(
    resolved: ResolvedFileCommandContext,
    allowMissingParent = false,
): Promise<boolean> {
    for (const document of vscode.workspace.textDocuments) {
        if (!document.isDirty) continue;
        if (document.uri.toString() === resolved.selectedUri.toString()) return true;
        if (document.uri.scheme !== "file") continue;
        try {
            const { canonicalFilePath } = await resolveCanonicalFileLocation(
                document.uri.fsPath,
                allowMissingParent,
            );
            if (canonicalFilePath === resolved.canonicalFilePath) return true;
        } catch {
            // An inaccessible alias cannot identify the selected file.
        }
    }
    return false;
}

/** Accepts filesystem files/symlinks or an exact tracked deletion, never a directory pathspec. */
async function isCommitFileTarget(resolved: ResolvedFileCommandContext): Promise<boolean> {
    try {
        const file = await lstat(resolved.canonicalFilePath);
        return file.isFile() || file.isSymbolicLink();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const status = await resolved.gitOps.getStatus({ withStats: false });
        return status.some(
            (file) => file.path === resolved.repoRelativePath && file.status === "D",
        );
    }
}

/**
 * Refuses Commit before staging for both classified operations and additional whole-index markers.
 * Specific operation messages are preserved; unreadable extra markers reject to the caller's
 * localized failure handler rather than being treated as an idle repository.
 */
async function rejectFileCommitWhenOperationInProgress(gitOps: GitOps): Promise<boolean> {
    if (await rejectWhenOperationInProgress(gitOps)) return true;
    if (!(await gitOps.hasWholeIndexOperationInProgress())) return false;
    await vscode.window.showErrorMessage(
        vscode.l10n.t("A Git operation is in progress — continue or abort it first."),
    );
    return true;
}

/**
 * Prompts for a saved local file commit in the repository that owns the selected URI.
 *
 * Explicit contexts never fall back to the editor. Dirty buffers and active Git operations are
 * refused before and after the prompt; cancellation and blank messages never reach the callback.
 * The callback must keep commits path-scoped and report refresh failures separately after success.
 */
export async function commitFileFromContext(
    ctx: unknown,
    gitOps: GitOps,
    runCommit: (
        scopedGitOps: GitOps,
        repoRoot: string,
        filePath: string,
        message: string,
    ) => Promise<void>,
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps, { allowMissingParent: true });
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Commit is only available for local files."),
            );
            return;
        }
        const selectedPath = resolved.repoRelativePath;
        if (!(await isCommitFileTarget(resolved))) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Commit is only available for local files."),
            );
            return;
        }
        if (await hasDirtyDocument(resolved, true)) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Save {path} before committing.", { path: selectedPath }),
            );
            return;
        }
        if (await rejectFileCommitWhenOperationInProgress(resolved.gitOps)) return;
        const message = await vscode.window.showInputBox({
            title: vscode.l10n.t("Commit File: {path}", { path: selectedPath }),
            prompt: vscode.l10n.t("Press Enter to commit only {path}. Escape to cancel.", {
                path: selectedPath,
            }),
            placeHolder: vscode.l10n.t("Enter a commit message."),
            validateInput: (value) =>
                value.trim() ? undefined : vscode.l10n.t("Enter a commit message."),
        });
        if (!message?.trim()) return;
        if (!(await isCommitFileTarget(resolved))) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Commit is only available for local files."),
            );
            return;
        }
        if (await hasDirtyDocument(resolved, true)) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Save {path} before committing.", { path: selectedPath }),
            );
            return;
        }
        if (await rejectFileCommitWhenOperationInProgress(resolved.gitOps)) return;
        await runCommit(resolved.gitOps, resolved.repoRoot, selectedPath, message);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Commit failed: {message}", { message: getErrorMessage(error) }),
        );
    }
}

/**
 * Rolls back one clicked local file, or the active editor when no explicit context was supplied.
 *
 * Dirty editor buffers are rejected because Git cannot restore their in-memory text. The selected
 * path must exist in `HEAD` before confirmation so untracked and staged-new files never reach the
 * cleanup branches of `rollbackFiles`.
 */
export async function rollbackFile(ctx: unknown, gitOps: GitOps): Promise<void> {
    let selectedPath: string | undefined;
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Rollback is only available for local files."),
            );
            return;
        }
        selectedPath = resolved.repoRelativePath;
        if (await hasDirtyDocument(resolved)) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Save or discard unsaved changes to {path} before rolling it back.", {
                    path: selectedPath,
                }),
            );
            return;
        }
        if (!(await resolved.gitOps.hasFileAtHead(selectedPath))) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Cannot roll back {path} because it does not exist in HEAD.", {
                    path: selectedPath,
                }),
            );
            return;
        }

        const rollbackAction = vscode.l10n.t("Rollback");
        const confirmation = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback {path}?", { path: selectedPath }),
            { modal: true },
            rollbackAction,
        );
        if (confirmation !== rollbackAction) return;

        await resolved.gitOps.rollbackFiles([selectedPath]);
        await vscode.window.showInformationMessage(
            vscode.l10n.t("Rolled back {path}.", { path: selectedPath }),
        );
    } catch (error) {
        const message = getErrorMessage(error);
        await vscode.window.showErrorMessage(
            selectedPath
                ? vscode.l10n.t("Rollback failed for {path}: {message}", {
                      path: selectedPath,
                      message,
                  })
                : vscode.l10n.t("Rollback failed: {message}", { message }),
        );
    }
}

/**
 * Compares the explicitly selected local file, or the active editor when no context was supplied,
 * using Git services scoped to the repository that owns that file.
 *
 * Explicit malformed and non-file contexts fail closed instead of borrowing the active editor.
 * The selected URI is captured before repository discovery so an editor change during Git lookup
 * cannot redirect the action. Discovery failures are reported without switching the active graph.
 */
export async function compareFileWithRevision(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Compare with Revision is only available for local files."),
            );
            return;
        }
        await compareEditorFileWithRevision(
            resolved.selectedUri,
            resolved.repoRoot,
            resolved.gitOps,
            resolved.repoRelativePath,
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with revision failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/**
 * Compares the selected local file with a branch or tag from the repository that owns that file.
 *
 * The original URI remains the working-tree editor identity, while Git reads use the canonical
 * repository root and validated relative path. Invalid explicit contexts fail closed, and discovery
 * or comparison failures are reported without switching the active IntelliGit repository.
 */
export async function compareFileWithBranchOrTag(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Compare with Branch or Tag is only available for local files."),
            );
            return;
        }
        await compareEditorFileWithBranch(
            resolved.selectedUri,
            resolved.repoRoot,
            resolved.gitOps,
            resolved.repoRelativePath,
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with branch or tag failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/**
 * Opens `HEAD` against the selected file's current working document in its owning repository.
 *
 * The original URI is preserved for dirty-buffer and symlink identity, while Git reads use the
 * canonical repository root and validated relative path. Explicit malformed contexts fail closed;
 * only an absent context may fall back to the active editor.
 */
export async function showFileDiff(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Show Diff is only available for local files."),
            );
            return;
        }
        await showEditorFileDiff(
            resolved.selectedUri,
            resolved.repoRoot,
            resolved.gitOps,
            resolved.repoRelativePath,
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Show Diff failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/**
 * Opens the selected file's immutable `HEAD` content in a readonly virtual document.
 *
 * Git reads use the canonical repository-relative path and the `GitOps` instance derived for the
 * file's owning repository. Explicit malformed contexts fail closed; only an absent context may
 * fall back to the active editor. Read or repository failures are reported without opening a
 * working-tree document.
 */
export async function showCurrentRevision(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Show Current Revision is only available for local files."),
            );
            return;
        }
        const content = await resolved.gitOps.getFileContentAtRef(
            resolved.repoRelativePath,
            "HEAD",
        );
        const uri = createReadonlyDiffUri(resolved.repoRelativePath, content, "HEAD");
        await vscode.window.showTextDocument(uri);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Show Current Revision failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/**
 * Opens Git blame output for a selected local file in an immutable virtual document.
 *
 * Dirty documents are passed to Git through stdin so the view reflects the exact editor buffer,
 * including an empty buffer, without writing the document or repository. Output is capped at
 * 4 MiB and discarded entirely when Git reports truncation.
 */
export async function annotateWithGitBlame(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Annotate with Git Blame is only available for local files."),
            );
            return;
        }

        const dirtyDocument = vscode.workspace.textDocuments.find(
            (document) =>
                document.isDirty && document.uri.toString() === resolved.selectedUri.toString(),
        );
        const args = ["blame", "--date=short"];
        if (dirtyDocument) args.push("--contents", "-");
        args.push("--", resolved.repoRelativePath);

        const executor = new GitExecutor(resolved.repoRoot);
        const result = await executor.runBinary(args, {
            ...(dirtyDocument ? { input: Buffer.from(dirtyDocument.getText()) } : {}),
            maxOutputBytes: MAX_GIT_BLAME_OUTPUT_BYTES,
        });
        if (result.truncated) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Git Blame output is too large to open (maximum 4 MiB)."),
            );
            return;
        }

        const uri = createReadonlyDiffUri(
            `${resolved.repoRelativePath}.blame`,
            result.stdout.toString("utf8"),
            vscode.l10n.t("Git Blame"),
        );
        await vscode.window.showTextDocument(uri);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Annotate with Git Blame failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
