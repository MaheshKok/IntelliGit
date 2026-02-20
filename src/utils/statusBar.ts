import * as vscode from "vscode";

export async function runWithStatusBar<T>(message: string, task: () => Promise<T>): Promise<T> {
    const disposable = vscode.window.setStatusBarMessage(`$(sync~spin) IntelliGit: ${message}`);
    try {
        return await task();
    } finally {
        disposable.dispose();
    }
}
