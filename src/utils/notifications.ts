import * as vscode from "vscode";

const PREFIX = "IntelliGit";

function withPrefix(message: string): string {
    return `${PREFIX}: ${message}`;
}

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
