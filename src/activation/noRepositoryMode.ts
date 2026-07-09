import * as vscode from "vscode";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import { runCloneFlow } from "../services/cloneService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { OnboardingViewProvider } from "../views/OnboardingViewProvider";
import {
    HAS_MERGE_CONFLICTS_CONTEXT,
    HAS_MULTIPLE_REPOSITORIES_CONTEXT,
    initializeRepository,
    NO_REPOSITORY_MESSAGE,
    type RepositoryViewProviders,
    setViewContext,
    SwitchableWebviewViewProvider,
    workspaceRoots,
} from "./common";
import { showTimedInformationMessage } from "../utils/notifications";

/**
 * Hooks that let no-repository activation transition after a repository appears.
 */
export interface NoRepositoryModeDeps {
    activateRepositoryMode: (
        repositories: DiscoveredRepository[],
        viewProviders?: RepositoryViewProviders,
    ) => Promise<void>;
}

/**
 * Activates IntelliGit for a workspace that currently contains no Git repositories.
 *
 * This mode requires workspace folders but no discovered repository. It registers
 * onboarding providers for the graph/panel views, an empty merge-conflicts tree,
 * and placeholder command handlers owned by `context.subscriptions`. The
 * no-repository command/tree disposables are also tracked separately so they can
 * be disposed before repository mode registers real handlers.
 *
 * Repository discovery from select/init commands transitions to repository mode
 * once, reusing the switchable view providers so visible onboarding views become
 * repository-backed without duplicate provider registrations.
 */
export function activateNoRepositoryMode(
    context: vscode.ExtensionContext,
    deps: NoRepositoryModeDeps,
): void {
    let repositories: DiscoveredRepository[] = [];
    void setViewContext(HAS_MULTIPLE_REPOSITORIES_CONTEXT, false);
    const noRepositoryDisposables: vscode.Disposable[] = [];
    let repositoryModeActivated = false;
    let repositoryModeActivationPromise: Promise<void> | undefined;
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

    /**
     * Tracks a disposable under both extension ownership and no-repository teardown.
     *
     * `context.subscriptions` handles extension shutdown; the local collection
     * allows early disposal when repository mode takes over command IDs and trees.
     */
    const registerNoRepositoryDisposable = (disposable: vscode.Disposable): void => {
        noRepositoryDisposables.push(disposable);
        context.subscriptions.push(disposable);
    };
    /**
     * Switches the existing workspace into repository mode after discovery succeeds.
     *
     * Concurrent command invocations share the same activation promise. On success,
     * no-repository command/tree disposables are disposed before repository handlers
     * are registered; on failure, a later command can retry the transition.
     */
    const activateDiscoveredRepositories = async (
        discoveredRepositories: DiscoveredRepository[],
    ): Promise<void> => {
        if (repositoryModeActivationPromise) {
            await repositoryModeActivationPromise;
            return;
        }
        if (repositoryModeActivated) return;

        repositoryModeActivated = true;
        repositoryModeActivationPromise = (async () => {
            for (const disposable of noRepositoryDisposables) {
                disposable.dispose();
            }
            await deps.activateRepositoryMode(discoveredRepositories, {
                commitGraph: commitGraphProvider,
                sidebarGraph: sidebarGraphProvider,
                commitPanel: commitPanelProvider,
            });
        })();

        try {
            await repositoryModeActivationPromise;
        } catch (error) {
            repositoryModeActivated = false;
            throw error;
        } finally {
            repositoryModeActivationPromise = undefined;
        }
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
                showTimedInformationMessage(NO_REPOSITORY_MESSAGE);
                return;
            }
            await activateDiscoveredRepositories(repositories);
            showTimedInformationMessage(vscode.l10n.t("Git repositories found."));
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
        "intelligit.graph.fetch",
        "intelligit.graph.fetch.color",
        "intelligit.graph.pull",
        "intelligit.graph.pull.color",
        "intelligit.graph.push",
        "intelligit.graph.push.color",
        "intelligit.graph.sync",
        "intelligit.graph.sync.color",
    ]) {
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand(command, () => {
                showTimedInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
    }
    void setViewContext(HAS_MERGE_CONFLICTS_CONTEXT, false);
}
