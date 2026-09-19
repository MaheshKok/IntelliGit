import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { compareEditorFileWithRevision } from "../services/diffService";
import { getErrorMessage } from "../utils/errors";

/**
 * Compares the explicitly selected local file, or the active editor when no context was supplied,
 * using Git services scoped to the repository that owns that file.
 *
 * Explicit malformed and non-file contexts fail closed instead of borrowing the active editor.
 * The selected URI is captured before repository discovery so an editor change during Git lookup
 * cannot redirect the action. Discovery failures are reported without switching the active graph.
 */
export async function compareFileWithRevision(ctx: unknown, gitOps: GitOps): Promise<void> {
    const selectedUri =
        ctx === undefined
            ? vscode.window.activeTextEditor?.document.uri
            : ctx instanceof vscode.Uri
              ? ctx
              : undefined;
    if (!selectedUri || selectedUri.scheme !== "file") {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with Revision is only available for local files."),
        );
        return;
    }

    try {
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
                vscode.l10n.t(
                    "Selected file is outside the current IntelliGit repository workspace.",
                ),
            );
        }
        await compareEditorFileWithRevision(
            selectedUri,
            repoRoot,
            gitOps.deriveFor(repoRoot),
            relativePath.split(path.sep).join("/"),
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with revision failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
