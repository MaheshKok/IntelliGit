import * as vscode from "vscode";
import { runCloneFlow } from "../services/cloneService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { OnboardingViewProvider } from "../views/OnboardingViewProvider";
import { initializeRepository, NO_REPOSITORY_MESSAGE } from "./common";

export function registerOnboardingCommands(context: vscode.ExtensionContext): void {
    const showUnavailableMessage = (): void => {
        vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.cloneRepository", () =>
            runCloneFlow(context.secrets),
        ),
        vscode.commands.registerCommand("intelligit.openFolder", async () => {
            await vscode.commands.executeCommand("vscode.openFolder");
        }),
        vscode.commands.registerCommand("intelligit.initializeRepository", initializeRepository),
        vscode.commands.registerCommand("intelligit.selectRepository", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.showGitLog", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.openUndocked", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.dockWindow", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.toggleUndocked", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.publishBranch", showUnavailableMessage),
    );
}

export function registerNoWorkspaceViews(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CommitGraphViewProvider.viewType,
            new OnboardingViewProvider(
                context.extensionUri,
                "no-workspace",
                vscode.l10n.t("IntelliGit"),
            ),
        ),
        vscode.window.registerWebviewViewProvider(
            CommitGraphViewProvider.sidebarViewType,
            new OnboardingViewProvider(
                context.extensionUri,
                "no-workspace",
                vscode.l10n.t("Graph"),
                false,
            ),
        ),
        vscode.window.registerWebviewViewProvider(
            CommitPanelViewProvider.viewType,
            new OnboardingViewProvider(
                context.extensionUri,
                "no-workspace",
                vscode.l10n.t("Commit"),
            ),
        ),
    );
}

export function activateNoWorkspaceMode(context: vscode.ExtensionContext): void {
    registerOnboardingCommands(context);
    registerNoWorkspaceViews(context);
}
