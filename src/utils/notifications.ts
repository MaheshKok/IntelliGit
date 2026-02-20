import * as vscode from "vscode";

const PREFIX = "IntelliGit";

function withPrefix(message: string): string {
    return `${PREFIX}: ${message}`;
}

export async function runWithNotificationProgress<T>(
    message: string,
    task: () => Promise<T>,
): Promise<T> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: withPrefix(message),
            cancellable: false,
        },
        async () => task(),
    );
}
