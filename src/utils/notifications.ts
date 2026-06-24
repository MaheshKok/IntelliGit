import * as vscode from "vscode";

const PREFIX = "IntelliGit";
const TRANSIENT_MESSAGE_MS = 5000;

function withPrefix(message: string): string {
    return `${PREFIX}: ${message}`;
}

function showTimedMessage(message: string): void {
    void vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: withPrefix(message),
            cancellable: false,
        },
        () => new Promise<void>((resolve) => setTimeout(resolve, TRANSIENT_MESSAGE_MS)),
    );
}

/** Shows a non-blocking information notification that auto-dismisses after five seconds. */
export function showTimedInformationMessage(message: string): void {
    showTimedMessage(message);
}

/** Shows a non-blocking warning notification that auto-dismisses after five seconds. */
export function showTimedWarningMessage(message: string): void {
    showTimedMessage(message.replace(/^\$\([^)]+\)\s*/, ""));
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
