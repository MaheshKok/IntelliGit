import * as vscode from "vscode";

const PREFIX = "IntelliGit";

function withPrefix(message: string): string {
    return `${PREFIX}: ${message}`;
}

function stripCodiconPrefix(message: string): string {
    return message.replace(/^\$\([^)]+\)\s*/, "");
}

/** Shows a non-blocking information notification with the IntelliGit product prefix. */
export function showTimedInformationMessage(message: string): void {
    void vscode.window.showInformationMessage(withPrefix(message));
}

/** Shows a non-blocking warning notification with the IntelliGit product prefix. */
export function showTimedWarningMessage(message: string): void {
    void vscode.window.showWarningMessage(withPrefix(stripCodiconPrefix(message)));
}

/**
 * Run an uncancellable VS Code notification progress task with the IntelliGit product prefix.
 * The helper centralizes user-visible progress labeling while preserving the task's return value.
 */
export async function runWithNotificationProgress<T>(
    message: string,
    task: (
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
    ) => Thenable<T>,
): Promise<T> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: withPrefix(message),
            cancellable: false,
        },
        task,
    );
}
