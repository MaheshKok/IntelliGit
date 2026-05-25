// Diff and comparison operations extracted from extension.ts.
// Handles opening diffs against git refs, commit file diffs,
// and applying/reverting single-file patches.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import {
    getCommitParentHashes,
    pickMainlineParent,
    buildCommitFilePatch,
    isValidGitHash,
} from "./gitHelpers";
import { assertRepoRelativePath } from "../utils/fileOps";
import { EMPTY_TREE_HASH } from "../utils/constants";

export function normalizeGitPath(fsPathValue: string): string {
    return fsPathValue.split(path.sep).join("/");
}

export function getRepoRelativeFilePathFromUri(uri: vscode.Uri, repoRoot: string): string | null {
    if (uri.scheme !== "file") return null;
    const relative = path.relative(repoRoot, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return normalizeGitPath(relative);
}

export function getEditorContextFileUri(ctx?: unknown): vscode.Uri | null {
    if (ctx instanceof vscode.Uri) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri?.scheme === "file" ? activeUri : null;
}

export interface CommitInfoFileContext {
    filePath: string;
    commitHash: string;
    commitShortHash?: string;
}

export function getCommitInfoFileContext(value: unknown): CommitInfoFileContext | null {
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

async function closeTemporaryDiffSourceTab(uri: vscode.Uri): Promise<void> {
    const matchingTab = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((tab) => {
            const input = tab.input;
            return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
        });
    if (!matchingTab) return;
    try {
        await vscode.window.tabGroups.close(matchingTab, true);
    } catch {
        // Best-effort cleanup only; diff view is already open.
    }
}

export async function openDiffAgainstGitRef(
    fileUri: vscode.Uri,
    repoRelativeFilePath: string,
    ref: string,
    sourceLabel: "revision" | "branch",
    gitOps: GitOps,
): Promise<void> {
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    const currentDoc = await vscode.workspace.openTextDocument(fileUri);
    const refContent = await gitOps.getFileContentAtRef(repoRelativeFilePath, trimmedRef);
    const leftDoc = await vscode.workspace.openTextDocument({
        content: refContent,
        language: currentDoc.languageId,
    });
    const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, fileUri, title);
    await closeTemporaryDiffSourceTab(leftDoc.uri);
}

export async function openCommitFileDiff(
    commitHash: string,
    filePath: string,
    repoRoot: string,
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

    // Detect language from the working tree file if it exists on disk.
    let language: string | undefined;
    const diskPath = path.join(repoRoot, safePath);
    try {
        const diskDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(diskPath));
        language = diskDoc.languageId;
    } catch {
        // File may not exist on disk (deleted or only in history).
    }

    const leftDoc = await vscode.workspace.openTextDocument({ content: leftContent, language });
    const rightDoc = await vscode.workspace.openTextDocument({
        content: rightContent,
        language,
    });
    const shortParent = parentDisplayHash.slice(0, 8);
    const shortCommit = validatedHash.slice(0, 8);
    const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title);
    await closeTemporaryDiffSourceTab(leftDoc.uri);
    await closeTemporaryDiffSourceTab(rightDoc.uri);
}

export async function applyPatchTextToRepo(
    patchText: string,
    reverse: boolean,
    executor: GitExecutor,
): Promise<void> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "intelligit-filepatch-"));
    const patchFilePath = path.join(tempDir, "selected-change.patch");
    try {
        await fs.promises.writeFile(patchFilePath, patchText, "utf8");
        const args = [
            "apply",
            "--index",
            "--3way",
            "--whitespace=nowarn",
            ...(reverse ? ["-R"] : []),
            patchFilePath,
        ];
        await executor.run(args);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
            console.warn(`[intelligit] Failed to clean up temp patch dir ${tempDir}:`, err);
        });
    }
}

export async function compareEditorFileWithBranch(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage("Compare with Branch is only available for local files.");
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            "Selected file is outside the current IntelliGit repository workspace.",
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
            title: "Compare with Branch",
            placeHolder: `Select a branch for ${repoRelativeFilePath}`,
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
        vscode.window.showErrorMessage(`Compare with branch failed: ${message}`);
    }
}

export async function compareEditorFileWithRevision(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage("Compare with Revision is only available for local files.");
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            "Selected file is outside the current IntelliGit repository workspace.",
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
                label: "$(edit) Enter revision manually",
                description: "Commit hash, tag, or ref name",
                detail: undefined as string | undefined,
                refName: MANUAL_SENTINEL,
            },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
            title: "Compare with Revision",
            placeHolder:
                historyPicks.length > 0
                    ? `Select a recent revision for ${repoRelativeFilePath}`
                    : `No recent file history found. Enter a revision for ${repoRelativeFilePath}`,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        let refName = picked.refName;
        if (refName === MANUAL_SENTINEL) {
            const input = await vscode.window.showInputBox({
                title: "Compare with Revision",
                prompt: `Enter a commit hash, tag, or ref for ${repoRelativeFilePath}`,
                placeHolder: "HEAD~1",
                ignoreFocusOut: true,
            });
            if (!input?.trim()) return;
            refName = input.trim();
        }

        await openDiffAgainstGitRef(fileUri, repoRelativeFilePath, refName, "revision", gitOps);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`Compare with revision failed: ${message}`);
    }
}

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
        vscode.window.showErrorMessage(`Compare with local failed: ${message}`);
    }
}

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

    const confirmed = await vscode.window.showWarningMessage(
        labels.confirmPrompt(short, fileCtx.filePath),
        { modal: true },
        labels.confirmLabel,
    );
    if (confirmed !== labels.confirmLabel) return;

    try {
        const patchText = await buildCommitFilePatch(
            fileCtx.commitHash,
            fileCtx.filePath,
            labels.actionTitle,
            executor,
        );
        if (patchText === null) return; // merge parent selection cancelled
        if (!patchText.trim()) {
            vscode.window.showInformationMessage(
                `No file-level patch found for ${fileCtx.filePath} in ${short}.`,
            );
            return;
        }

        await runWithNotificationProgress(
            `${labels.progressVerb} selected change for ${fileCtx.filePath}...`,
            async () => {
                await applyPatchTextToRepo(patchText, mode === "revert", executor);
            },
        );

        vscode.window.showInformationMessage(
            `${labels.successVerb} selected change from ${short} for ${fileCtx.filePath}.`,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`${labels.errorLabel} failed: ${message}`);
    } finally {
        await refreshConflictUi().catch(() => {});
    }
}

const COMMIT_FILE_CHANGE_MODE_LABELS = {
    "cherry-pick": {
        actionTitle: "Cherry-pick Selected Change",
        confirmLabel: "Apply Change",
        confirmPrompt: (short: string, filePath: string) =>
            `Apply the change from ${short} for ${filePath} to your working tree and stage it?`,
        progressVerb: "Applying",
        successVerb: "Applied",
        errorLabel: "Cherry-pick selected change",
    },
    revert: {
        actionTitle: "Revert Selected Change",
        confirmLabel: "Revert Change",
        confirmPrompt: (short: string, filePath: string) =>
            `Apply the inverse of the change from ${short} for ${filePath} to your working tree and stage it?`,
        progressVerb: "Reverting",
        successVerb: "Reverted",
        errorLabel: "Revert selected change",
    },
} as const;
