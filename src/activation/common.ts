import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import { UndockedViewProvider } from "../views/UndockedViewProvider";
import { getErrorMessage } from "../utils/errors";

export const SELECTED_REPOSITORY_KEY = "intelligit.selectedRepositoryRoot";
export const NO_REPOSITORY_MESSAGE = "No Git repositories found in this workspace.";
export const HAS_MERGE_CONFLICTS_CONTEXT = "intelligit.hasMergeConflicts";

export function setViewContext(key: string, value: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand("setContext", key, value);
}

export class SwitchableWebviewViewProvider implements vscode.WebviewViewProvider {
    private resolved:
        | {
              view: vscode.WebviewView;
              context: vscode.WebviewViewResolveContext;
              token: vscode.CancellationToken;
          }
        | undefined;

    constructor(private currentProvider: vscode.WebviewViewProvider) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken,
    ): void | Thenable<void> {
        this.resolved = { view: webviewView, context, token };
        return this.currentProvider.resolveWebviewView(webviewView, context, token);
    }

    setProvider(provider: vscode.WebviewViewProvider): void {
        this.currentProvider = provider;
        if (!this.resolved) return;
        void provider.resolveWebviewView(
            this.resolved.view,
            this.resolved.context,
            this.resolved.token,
        );
    }
}

export interface RepositoryViewProviders {
    commitGraph?: SwitchableWebviewViewProvider;
    sidebarGraph?: SwitchableWebviewViewProvider;
    commitPanel?: SwitchableWebviewViewProvider;
}

export function workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

export async function initializeRepository(
    options: {
        onInitialized?: (repositories: DiscoveredRepository[]) => Promise<void>;
    } = {},
): Promise<void> {
    const roots = workspaceRoots();
    if (roots.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Open a folder first to initialize a repository."),
        );
        return;
    }

    let targetPath: string;
    if (roots.length === 1) {
        targetPath = roots[0];
    } else {
        const picked = await vscode.window.showQuickPick(
            roots.map((root) => ({
                label: root.split("/").pop() || root,
                description: root,
                path: root,
            })),
            { placeHolder: vscode.l10n.t("Select a folder to initialize a Git repository") },
        );
        if (!picked) return;
        targetPath = picked.path;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("Initializing Git repository..."),
                cancellable: false,
            },
            async () => {
                const gitOps = new GitOps(new GitExecutor(targetPath));
                await gitOps.init(targetPath);
            },
        );

        const newRepos = await discoverGitRepositories(workspaceRoots());
        if (newRepos.length > 0) {
            if (options.onInitialized) {
                await options.onInitialized(newRepos);
            }
            vscode.window.showInformationMessage(vscode.l10n.t("Repository initialized."));
        } else {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to initialize repository. Check folder permissions."),
            );
        }
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to initialize repository: {message}", { message }),
        );
    }
}

export function selectInitialRepository(
    repositories: DiscoveredRepository[],
    storedRoot: string | undefined,
): DiscoveredRepository {
    return repositories.find((repo) => repo.root === storedRoot) ?? repositories[0];
}

export function registerStaleUndockedPanelSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(UndockedViewProvider.viewType, {
            deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
                panel.dispose();
                return Promise.resolve();
            },
        }),
    );
}
