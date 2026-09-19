import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import {
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
    openDiffAgainstGitRef,
} from "../services/diffService";
import { getErrorMessage } from "../utils/errors";

interface ResolvedFileCommandContext {
    selectedUri: vscode.Uri;
    repoRoot: string;
    repoRelativePath: string;
    gitOps: GitOps;
}

/**
 * Resolves an explicit local-file command context, or the active editor only when context is absent.
 *
 * Repository discovery follows the canonical parent directory for linked worktrees and symlinked
 * parents, while `selectedUri` retains the original editor identity for dirty-buffer comparisons.
 * Malformed explicit contexts return `undefined`; repository and path validation failures reject.
 */
async function resolveFileCommandContext(
    ctx: unknown,
    gitOps: GitOps,
): Promise<ResolvedFileCommandContext | undefined> {
    const selectedUri =
        ctx === undefined
            ? vscode.window.activeTextEditor?.document.uri
            : ctx instanceof vscode.Uri
              ? ctx
              : undefined;
    if (!selectedUri || selectedUri.scheme !== "file") return undefined;

    const selectedDirectory = path.dirname(selectedUri.fsPath);
    const canonicalDirectory = await realpath(selectedDirectory);
    const executor = new GitExecutor(canonicalDirectory);
    const output = await executor.run(["rev-parse", "--show-toplevel"]);
    const repoRoot = output.replace(/\r?\n$/, "");
    const canonicalFilePath = path.join(canonicalDirectory, path.basename(selectedUri.fsPath));
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
        repoRoot,
        repoRelativePath: relativePath.split(path.sep).join("/"),
        gitOps: gitOps.deriveFor(repoRoot),
    };
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
 * Opens HEAD against the selected file's current working content in its owning repository.
 *
 * The original URI is preserved so the diff service can load an unsaved editor document, while
 * Git reads use the canonical repository root and validated relative path. Explicit malformed
 * contexts fail closed instead of borrowing the active editor.
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
        await openDiffAgainstGitRef(
            resolved.selectedUri,
            resolved.repoRoot,
            resolved.repoRelativePath,
            "HEAD",
            "revision",
            resolved.gitOps,
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Show Diff failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
