import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { FileHistoryPanel } from "../views/FileHistoryPanel";
import { getErrorMessage } from "../utils/errors";

/**
 * Captures the clicked file before asynchronous discovery, including inactive editor tabs.
 * Repository ownership comes from that file's directory, independently of the active graph.
 * Unsupported resources and discovery failures surface errors without changing repositories.
 */
export async function showFileHistory(extensionUri: vscode.Uri, uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    try {
        if (!target || target.scheme !== "file" || typeof target.fsPath !== "string") {
            throw new Error(vscode.l10n.t("Select a local file to show Git history."));
        }
        const directory = await realpath(path.dirname(target.fsPath));
        const executor = new GitExecutor(directory);
        const output = await executor.run(["rev-parse", "--show-toplevel"]);
        const repoRoot = output.replace(/\r?\n$/, "");
        const relativePath = path.relative(
            repoRoot,
            path.join(directory, path.basename(target.fsPath)),
        );
        if (
            !repoRoot ||
            !relativePath ||
            relativePath === ".." ||
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath)
        ) {
            throw new Error(vscode.l10n.t("The selected file is outside its Git repository."));
        }
        const filePath = relativePath.split(path.sep).join("/");
        await FileHistoryPanel.open({ extensionUri, repoRoot, filePath });
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Unable to show Git history: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
