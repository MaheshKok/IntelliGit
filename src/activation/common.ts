import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import { UndockedViewProvider } from "../views/UndockedViewProvider";
import { getErrorMessage } from "../utils/errors";
import { showTimedInformationMessage } from "../utils/notifications";

/**
 * Workspace-state key that persists the repository root selected across activation modes.
 */
export const SELECTED_REPOSITORY_KEY = "intelligit.selectedRepositoryRoot";

/**
 * Empty-state copy shown when activation cannot discover any Git repositories.
 */
export const NO_REPOSITORY_MESSAGE = "No Git repositories found in this workspace.";

/**
 * VS Code when-clause key that enables conflict-specific views and commands.
 */
export const HAS_MERGE_CONFLICTS_CONTEXT = "intelligit.hasMergeConflicts";

/**
 * VS Code when-clause key that enables UI for multi-repository workspaces.
 */
export const HAS_MULTIPLE_REPOSITORIES_CONTEXT = "intelligit.hasMultipleRepositories";

/**
 * Updates a VS Code when-clause context key for IntelliGit views and commands.
 *
 * This is a host-wide side effect and does not create a disposable. Callers may
 * intentionally fire-and-forget when activation should not block on context
 * propagation.
 */
export function setViewContext(key: string, value: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand("setContext", key, value);
}

/**
 * Keeps a registered webview view ID stable while swapping the provider that renders it.
 *
 * No-repository mode uses this wrapper for onboarding views that can later become
 * repository-backed views without registering duplicate view providers. The
 * wrapper does not own the inner providers; the activation context owns the
 * registration disposable.
 */
export class SwitchableWebviewViewProvider implements vscode.WebviewViewProvider {
    private resolved:
        | {
              view: vscode.WebviewView;
              context: vscode.WebviewViewResolveContext;
              token: vscode.CancellationToken;
          }
        | undefined;

    /**
     * Creates a wrapper around the provider currently responsible for the view.
     */
    constructor(private currentProvider: vscode.WebviewViewProvider) {}

    /**
     * Records the resolved VS Code view and delegates initial rendering to the active provider.
     */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken,
    ): void | Thenable<void> {
        this.resolved = { view: webviewView, context, token };
        return this.currentProvider.resolveWebviewView(webviewView, context, token);
    }

    /**
     * Replaces the active provider and re-resolves an already visible view immediately.
     *
     * The existing webview registration remains owned by the original activation
     * subscription; this only changes which provider receives future resolves.
     */
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

/**
 * Switchable view providers that no-repository mode has already registered.
 *
 * Repository mode uses these wrappers to take over visible onboarding views
 * instead of registering a second provider for the same view ID.
 */
export interface RepositoryViewProviders {
    commitGraph?: SwitchableWebviewViewProvider;
    sidebarGraph?: SwitchableWebviewViewProvider;
    commitPanel?: SwitchableWebviewViewProvider;
}

/**
 * Returns absolute filesystem paths for the workspace folders visible to activation.
 *
 * This helper is read-only and central to startup mode selection: callers use an
 * empty result for no-workspace onboarding, a single result for direct repository
 * operations, and multiple results when prompting the user to choose a workspace
 * root.
 */
export function workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

/**
 * Initializes a Git repository from onboarding or no-repository command handlers.
 *
 * Requires at least one workspace folder. Multi-root workspaces prompt for the
 * target folder, run `git init` under notification progress, rediscover
 * repositories, and optionally hand the discovery result to `options.onInitialized`.
 * User-facing errors are reported through VS Code notifications.
 */
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
                label: path.basename(root) || root,
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
            showTimedInformationMessage(vscode.l10n.t("Repository initialized."));
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

/**
 * Selects the repository that repository mode should activate first.
 *
 * @returns The repository matching persisted workspace state, or the first
 * discovered repository when the stored root is missing or stale.
 * @throws When called with no discovered repositories; callers should route that
 * state through no-repository activation instead.
 */
export function selectInitialRepository(
    repositories: DiscoveredRepository[],
    storedRoot: string | undefined,
): DiscoveredRepository {
    if (repositories.length === 0) {
        throw new Error("No repositories discovered.");
    }
    return repositories.find((repo) => repo.root === storedRoot) ?? repositories[0];
}

/**
 * Registers a serializer that discards restored undocked IntelliGit panels on startup.
 *
 * Undocked panels are recreated from repository mode so stale serialized webviews
 * are disposed instead of being revived without live Git services. The serializer
 * registration is owned by `context.subscriptions`.
 */
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
