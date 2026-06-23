import * as vscode from "vscode";
import { runCloneFlow } from "../services/cloneService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { OnboardingViewProvider } from "../views/OnboardingViewProvider";
import { initializeRepository, NO_REPOSITORY_MESSAGE } from "./common";
import { showTimedInformationMessage } from "../utils/notifications";

/**
 * Registers command handlers that are available before a workspace folder exists.
 *
 * Clone, open-folder, and initialize actions remain usable from the onboarding UI.
 * Repository-only command IDs receive placeholder handlers so Command Palette and
 * view actions never invoke an unregistered command in no-workspace activation.
 * The extension context owns all returned disposables.
 */
function registerOnboardingCommands(context: vscode.ExtensionContext): void {
    const showUnavailableMessage = (): void => {
        showTimedInformationMessage(NO_REPOSITORY_MESSAGE);
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

/**
 * Registers onboarding webview providers for activation without workspace folders.
 *
 * The providers only render guidance and do not require Git services or repository
 * state. Their registration disposables are owned by `context.subscriptions` for
 * normal VS Code shutdown.
 */
function registerNoWorkspaceViews(context: vscode.ExtensionContext): void {
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

/**
 * Activates the no-workspace startup mode selected by `activate`.
 *
 * This path runs when VS Code has no workspace folders. It registers onboarding
 * commands and views only; repository discovery is deferred until the user opens
 * or initializes a folder.
 */
export function activateNoWorkspaceMode(context: vscode.ExtensionContext): void {
    registerOnboardingCommands(context);
    registerNoWorkspaceViews(context);
}
