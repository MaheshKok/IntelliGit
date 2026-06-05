import * as vscode from "vscode";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import { runCloneFlow } from "../services/cloneService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { OnboardingViewProvider } from "../views/OnboardingViewProvider";
import {
    HAS_MERGE_CONFLICTS_CONTEXT,
    initializeRepository,
    NO_REPOSITORY_MESSAGE,
    type RepositoryViewProviders,
    setViewContext,
    SwitchableWebviewViewProvider,
    workspaceRoots,
} from "./common";

export interface NoRepositoryModeDeps {
    activateRepositoryMode: (
        repositories: DiscoveredRepository[],
        viewProviders?: RepositoryViewProviders,
    ) => Promise<void>;
}

export function activateNoRepositoryMode(
    context: vscode.ExtensionContext,
    deps: NoRepositoryModeDeps,
): void {
    let repositories: DiscoveredRepository[] = [];
    const noRepositoryDisposables: vscode.Disposable[] = [];
    let repositoryModeActivated = false;
    const emptyTreeProvider: vscode.TreeDataProvider<never> = {
        getTreeItem: () => {
            throw new Error("unreachable");
        },
        getChildren: () => [],
    };
    const emptyMergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: emptyTreeProvider,
    });
    const commitGraphProvider = new SwitchableWebviewViewProvider(
        new OnboardingViewProvider(
            context.extensionUri,
            "no-git-repo",
            vscode.l10n.t("IntelliGit"),
        ),
    );
    const sidebarGraphProvider = new SwitchableWebviewViewProvider(
        new OnboardingViewProvider(
            context.extensionUri,
            "no-git-repo",
            vscode.l10n.t("Graph"),
            false,
        ),
    );
    const commitPanelProvider = new SwitchableWebviewViewProvider(
        new OnboardingViewProvider(context.extensionUri, "no-git-repo", vscode.l10n.t("Commit")),
    );

    const registerNoRepositoryDisposable = (disposable: vscode.Disposable): void => {
        noRepositoryDisposables.push(disposable);
        context.subscriptions.push(disposable);
    };
    const activateDiscoveredRepositories = async (
        discoveredRepositories: DiscoveredRepository[],
    ): Promise<void> => {
        if (repositoryModeActivated) return;
        repositoryModeActivated = true;
        for (const disposable of noRepositoryDisposables) {
            disposable.dispose();
        }
        await deps.activateRepositoryMode(discoveredRepositories, {
            commitGraph: commitGraphProvider,
            sidebarGraph: sidebarGraphProvider,
            commitPanel: commitPanelProvider,
        });
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CommitGraphViewProvider.viewType,
            commitGraphProvider,
        ),
        vscode.window.registerWebviewViewProvider(
            CommitGraphViewProvider.sidebarViewType,
            sidebarGraphProvider,
        ),
        vscode.window.registerWebviewViewProvider(
            CommitPanelViewProvider.viewType,
            commitPanelProvider,
        ),
    );
    registerNoRepositoryDisposable(emptyMergeConflictsView);
    registerNoRepositoryDisposable(
        vscode.commands.registerCommand("intelligit.selectRepository", async () => {
            repositories = await discoverGitRepositories(workspaceRoots());
            if (repositories.length === 0) {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
                return;
            }
            await activateDiscoveredRepositories(repositories);
            vscode.window.showInformationMessage(vscode.l10n.t("Git repositories found."));
        }),
    );
    registerNoRepositoryDisposable(
        vscode.commands.registerCommand("intelligit.cloneRepository", () =>
            runCloneFlow(context.secrets),
        ),
    );
    registerNoRepositoryDisposable(
        vscode.commands.registerCommand("intelligit.openFolder", async () => {
            await vscode.commands.executeCommand("vscode.openFolder");
        }),
    );
    registerNoRepositoryDisposable(
        vscode.commands.registerCommand("intelligit.initializeRepository", async () =>
            initializeRepository({
                onInitialized: async (initializedRepositories) => {
                    await activateDiscoveredRepositories(initializedRepositories);
                },
            }),
        ),
    );
    registerNoRepositoryDisposable(
        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),
    );
    for (const command of [
        "intelligit.openUndocked",
        "intelligit.dockWindow",
        "intelligit.toggleUndocked",
        "intelligit.publishBranch",
    ]) {
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand(command, () => {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
    }
    void setViewContext(HAS_MERGE_CONFLICTS_CONTEXT, false);
}
