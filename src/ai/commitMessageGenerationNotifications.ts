import * as vscode from "vscode";
import type { CommitMessageGenerationCoordinatorErrorKind } from "./commitMessageGenerationCoordinator";

const COPILOT_MARKETPLACE_URL =
    "https://marketplace.visualstudio.com/items?itemName=GitHub.copilot";

/** Shows the smallest actionable native notification for a terminal generation availability error. */
export async function showCommitMessageGenerationNotification(
    errorKind: CommitMessageGenerationCoordinatorErrorKind,
): Promise<void> {
    const installCopilot = vscode.l10n.t("Install Copilot");
    const signIn = vscode.l10n.t("Sign In");
    switch (errorKind) {
        case "copilotUnavailable":
        case "notFound": {
            const selected = await vscode.window.showErrorMessage(
                vscode.l10n.t("GitHub Copilot is unavailable for commit-message generation."),
                installCopilot,
                signIn,
            );
            await runSelectedAction(selected, installCopilot, signIn);
            return;
        }
        case "noPermissions": {
            const selected = await vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "GitHub Copilot permission is required for commit-message generation.",
                ),
                signIn,
            );
            await runSelectedAction(selected, installCopilot, signIn);
            return;
        }
        case "blocked":
            await vscode.window.showInformationMessage(
                vscode.l10n.t("GitHub Copilot blocked commit-message generation."),
            );
            return;
        default:
            return;
    }
}

/** Performs a user-selected native remediation action and leaves dismissal as a no-op. */
async function runSelectedAction(
    selected: string | undefined,
    installCopilot: string,
    signIn: string,
): Promise<void> {
    if (selected === installCopilot) {
        await vscode.env.openExternal(vscode.Uri.parse(COPILOT_MARKETPLACE_URL));
    } else if (selected === signIn) {
        await vscode.authentication.getSession("github", ["user:email"], { createIfNone: true });
    }
}
