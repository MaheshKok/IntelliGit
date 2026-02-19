// Shared file operation utilities used by extension host and view providers.

import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import { getErrorMessage, isUntrackedPathspecError } from "./errors";

/**
 * Delete a file via git rm, falling back to filesystem delete for untracked files.
 * Returns true if deleted successfully, false if an error was shown.
 */
export async function deleteFileWithFallback(
    gitOps: GitOps,
    workspaceRoot: vscode.Uri,
    filePath: string,
): Promise<boolean> {
    try {
        await gitOps.deleteFile(filePath, true);
    } catch (error) {
        if (!isUntrackedPathspecError(error)) {
            const message = getErrorMessage(error);
            console.error("Failed to delete file with git rm:", error);
            vscode.window.showErrorMessage(`Delete failed: ${message}`);
            return false;
        }

        try {
            const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
            await vscode.workspace.fs.delete(uri);
        } catch (fsError) {
            const message = getErrorMessage(fsError);
            console.error("Failed to delete file from filesystem:", fsError);
            vscode.window.showErrorMessage(`Delete failed: ${message}`);
            return false;
        }
    }
    return true;
}
