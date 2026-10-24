import * as path from "path";
import * as vscode from "vscode";
import { createBranchCommands, type BranchCommandEntry } from "../commands/branchCommands";
import {
    BRANCH_COMMAND_FENCE_DECISIONS,
    rejectWhenOperationInProgress,
} from "../commands/operationFence";
import { GitExecutor } from "../git/executor";
import { showFileHistory } from "../commands/fileHistoryCommand";
import {
    addFileToVcsFromContext,
    annotateWithGitBlame,
    branchesFileFromContext,
    commitFileFromContext,
    compareFileWithBranchOrTag,
    compareFileWithRevision,
    fetchFile,
    mergeFileFromContext,
    manageRemotesFileFromContext,
    newBranchFileFromContext,
    newTagFileFromContext,
    resetHeadFileFromContext,
    resolveFileCommandContext,
    stashChangesFromContext,
    unstashChangesFromContext,
    rebaseFileFromContext,
    pullFileRepositoryFromContext,
    pushFileRepositoryFromContext,
    rollbackFile,
    showCurrentRevision,
    showFileDiff,
} from "../commands/fileContextCommands";
import { GitOps } from "../git/operations";
import { remoteUrlToWebUrl } from "../git/remoteWebUrl";
import { runPublishBranchFlow } from "../services/publishService";
import { runCloneFlow, runGitHubCloneFlow } from "../services/cloneService";
import {
    createGitHubGistFromContext,
    createGitHubPullRequestFromContext,
    manageGitHubAccounts,
    shareGitHubProjectFromContext,
    syncGitHubForkFromContext,
    viewGitHubFileFromContext,
    viewGitHubPullRequestsFromContext,
} from "../commands/githubContextCommands";
import { WorktreeService } from "../services/worktreeService";
import {
    applySelectedCommitFileChange,
    compareCommitInfoFileWithLocal,
} from "../services/diffService";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import type { Branch, GitWorktree } from "../types";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { areSameRepositoryRoot } from "../utils/repositoryRoot";
import {
    runWithNotificationProgress,
    showTimedWarningMessage,
    showTimedInformationMessage,
} from "../utils/notifications";
import {
    commitSelectedFromPanel,
    runGitOperationFromPanel,
    type CommitPanelGitOperation,
} from "../views/commitPanelActions";
import { trackUnversionedFilesFromPanel } from "../views/panelFileActions";
import type { RefreshService } from "../views/RefreshService";
import { NO_REPOSITORY_MESSAGE, workspaceRoots } from "./common";

/**
 * Runtime services and callbacks captured by repository command handlers.
 *
 * Accessor callbacks must reflect the currently active repository because command
 * registrations stay alive while repository mode can switch roots.
 */
interface RepositoryCommandsDeps {
    context: vscode.ExtensionContext;
    executor: GitExecutor;
    gitOps: GitOps;
    worktreeService: WorktreeService;
    getRepoRoot: () => string;
    isKnownRepositoryRoot: (repositoryRoot: string) => boolean;
    setRepositories: (repositories: DiscoveredRepository[]) => void;
    getCurrentBranches: () => Branch[];
    commitGraphFilterByBranch: (branchName: string | null) => Promise<void>;
    getCurrentBranchName: () => string | undefined;
    setActiveRepository: (repository: DiscoveredRepository) => Promise<void>;
    clearSelection: (options?: { loading?: boolean }) => void;
    refreshActiveRepository: () => Promise<void>;
    refreshRepository?: (repositoryRoot: string) => Promise<void>;
    refreshService: () => RefreshService;
    showUndockedGitLog: (options?: { deferDataLoad?: boolean }) => Promise<void>;
    pickUndockTargetAndOpen: () => Promise<void>;
    dockIntelliGit: () => Promise<void>;
    openMergeConflictForFile: (filePath: string) => Promise<void>;
    openConflictSession: (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }) => Promise<void>;
    openConflictSessionForRepository: (
        gitOps: GitOps,
        repoRoot: string,
        labels: { sourceBranch?: string; targetBranch?: string },
    ) => Promise<void>;
    openVsCodeMergeEditorForFile: (filePath: string) => Promise<void>;
    /** Opens the resolved local file through its known repository's shared partial workflow. */
    openPartialChanges: (repositoryRoot: string, filePath: string) => Promise<void>;
    /** Saves one explicitly resolved whole file without changing repository selection or local bytes. */
    saveWholeFileToShelf?: (repositoryRoot: string, filePath: string) => Promise<void>;
}

/** Narrows command payloads from tree rows before file operations touch the repository. */
const isFilePathContext = (value: unknown): value is { filePath: string } => {
    return (
        !!value &&
        typeof value === "object" &&
        "filePath" in value &&
        typeof value.filePath === "string"
    );
};

/** Narrows VS Code tree-row payloads before destructive worktree commands can use the path. */
const isWorktreeContext = (value: unknown): value is GitWorktree => {
    return (
        !!value && typeof value === "object" && "path" in value && typeof value.path === "string"
    );
};

/** Captures a host-known repository without falling back after an explicit invalid request. */
function captureRepositoryRoot(deps: RepositoryCommandsDeps, value?: unknown): string {
    const root = value === undefined ? deps.getRepoRoot() : value;
    if (typeof root !== "string" || !root || !deps.isKnownRepositoryRoot(root)) {
        throw new Error(
            vscode.l10n.t(
                "The requested repository is no longer available. Select it again before running branch actions.",
            ),
        );
    }
    return root;
}

/** Native row contexts may address a repository independently of the active graph. */
function captureContextRepositoryRoot(deps: RepositoryCommandsDeps, context: unknown): string {
    const requested =
        context && typeof context === "object" && "repositoryRoot" in context
            ? context.repositoryRoot
            : undefined;
    return captureRepositoryRoot(deps, requested);
}

/** Publishes through root-stable services and fresh branch metadata across credential prompts. */
async function publishRepository(deps: RepositoryCommandsDeps, root: string): Promise<void> {
    const gitOps = deps.gitOps.deriveFor(root);
    if (!(await gitOps.hasAnyCommits())) {
        showTimedWarningMessage(vscode.l10n.t("Create a commit before publishing this branch."));
        return;
    }
    const currentBranch = (await gitOps.getBranches()).find(
        (branch) => branch.isCurrent && !branch.isRemote,
    );
    if (!currentBranch) {
        vscode.window.showErrorMessage(vscode.l10n.t("No current branch found."));
        return;
    }
    await runPublishBranchFlow(gitOps, currentBranch.name, root, deps.context.secrets);
}

/** Keeps a worktree service and its refresh bound to one command, including confirmation waits. */
async function withCapturedWorktree(
    deps: RepositoryCommandsDeps,
    value: unknown,
    operation: (service: WorktreeService) => Promise<void | false>,
): Promise<void> {
    const root = captureContextRepositoryRoot(deps, value);
    const service = new WorktreeService(deps.executor.deriveFor(root), () => root);
    try {
        if ((await operation(service)) === false) return;
        if (deps.refreshRepository) await deps.refreshRepository(root);
        else if (areSameRepositoryRoot(root, deps.getRepoRoot()))
            await deps.refreshActiveRepository();
        else await deps.refreshService().refreshCommitPanels();
    } finally {
        service.dispose();
    }
}

/** Extracts merge-conflict file paths only from known VS Code command payload shapes. */
const resolveConflictPath = (ctx: unknown): string | null =>
    isFilePathContext(ctx) ? ctx.filePath : null;

/**
 * Accepts only native Add to VCS payloads whose root and paths can be validated before GitOps
 * selection. Returning undefined deliberately keeps malformed context-menu input side-effect free.
 */
function resolveAddToVcsContext(
    value: unknown,
): { repositoryRoot: string; filePaths: string[] } | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { repositoryRoot, filePaths } = value as {
        repositoryRoot?: unknown;
        filePaths?: unknown;
    };
    if (typeof repositoryRoot !== "string" || !Array.isArray(filePaths) || filePaths.length === 0)
        return undefined;
    try {
        return {
            repositoryRoot,
            filePaths: filePaths.map((filePath) => {
                if (typeof filePath !== "string") throw new Error("Invalid repository path.");
                return assertRepoRelativePath(filePath);
            }),
        };
    } catch {
        return undefined;
    }
}

/**
 * Registers the command surface that requires an active IntelliGit repository.
 *
 * Called only from repository mode after Git services, providers, and refresh
 * state exist. Each command disposable is pushed into `deps.context.subscriptions`;
 * when no-repository mode transitions here it has already disposed placeholder
 * handlers for the same command IDs.
 */
export function registerRepositoryCommands(deps: RepositoryCommandsDeps): void {
    deps.context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.showFileHistory", (uri?: vscode.Uri) =>
            showFileHistory(deps.context.extensionUri, uri),
        ),
    );
    registerWindowAndRepositoryCommands(deps);
    registerMergeCommands(deps);
    registerBranchCommands(deps);
    registerCommitFileCommands(deps);
}

/**
 * Registers repository-level commands for refresh, publish, selection, filtering, and undocking.
 *
 * These handlers assume `getRepoRoot`, `gitOps`, and branch callbacks point at the
 * current active repository. They may rediscover workspace repositories, mutate
 * configuration, focus views, and refresh providers through the active
 * `RefreshService`.
 */
function registerWindowAndRepositoryCommands(deps: RepositoryCommandsDeps): void {
    const {
        context,
        gitOps,
        getRepoRoot,
        setRepositories,
        setActiveRepository,
        clearSelection,
        refreshActiveRepository,
        showUndockedGitLog,
        pickUndockTargetAndOpen,
        dockIntelliGit,
        refreshService,
    } = deps;
    const runGraphGitOperation = async (operation: CommitPanelGitOperation): Promise<void> => {
        const repoRoot = captureRepositoryRoot(deps);
        const operationGitOps = gitOps.deriveFor(repoRoot);
        await runGitOperationFromPanel(
            {
                gitOps: operationGitOps,
                refreshData: async () => {
                    if (!areSameRepositoryRoot(repoRoot, getRepoRoot())) return;
                    await refreshActiveRepository();
                },
                publishBranch: () => publishRepository(deps, repoRoot),
                openConflictSession: async () =>
                    deps.openConflictSessionForRepository(operationGitOps, repoRoot, {}),
                fireWorkingTreeChanged: () => undefined,
            },
            operation,
        );
    };
    const refreshRepository = async (): Promise<void> => {
        await vscode.window.withProgress(
            { location: { viewId: "intelligit.commitPanel" } },
            async () => {
                await refreshActiveRepository();
            },
        );
    };
    const selectRepository = async (): Promise<void> => {
        const repositories = await discoverGitRepositories(workspaceRoots());
        setRepositories(repositories);
        if (repositories.length === 0) {
            showTimedInformationMessage(NO_REPOSITORY_MESSAGE);
            return;
        }
        const picked = await vscode.window.showQuickPick(
            repositories.map((repo) => ({
                label: repo.label,
                description: repo.root === getRepoRoot() ? "Active" : repo.root,
                repository: repo,
            })),
            { placeHolder: vscode.l10n.t("Select IntelliGit repository") },
        );
        if (!picked) return;
        await setActiveRepository(picked.repository);
    };

    const openRepositoryInBrowser = async (repositoryRoot?: string): Promise<void> => {
        // Both panels are multi-repository: the accordion row or pane the user clicked
        // can be scoped to a repository that is not the active one, and it already sends
        // its root with the message. Honour it the way `fetch`/`pull`/`push`/`sync` do --
        // reading the active repository here opened the wrong remote for every other row.
        const ops = repositoryRoot ? gitOps.deriveFor(repositoryRoot) : gitOps;
        // `origin` is the remote a browsing user means. Falling back to the first
        // configured remote keeps the button useful on forks and mirrors, where the
        // only remote may be named `upstream`.
        const remotes = await ops.getRemotes();
        const remote = remotes.includes("origin") ? "origin" : remotes[0];
        if (!remote) {
            showTimedWarningMessage(
                vscode.l10n.t("This repository has no remote to open in a browser."),
            );
            return;
        }
        const remoteUrl = await ops.getRemoteUrl(remote);
        const webUrl = remoteUrl ? remoteUrlToWebUrl(remoteUrl) : null;
        if (!webUrl) {
            showTimedWarningMessage(
                vscode.l10n.t("Could not determine a web page for remote '{0}'.", remote),
            );
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(webUrl));
    };

    // The same two ids are invoked from a `view/title` menu, where VS Code passes the
    // view's own context object as the first argument, and from the webview panels,
    // which pass a repository root. Narrowing to `string` keeps the menu payload from
    // being handed to `deriveFor` as a bogus root.
    const openRepositoryFromCommand = async (repositoryRoot?: unknown): Promise<void> => {
        await openRepositoryInBrowser(
            typeof repositoryRoot === "string" ? repositoryRoot : undefined,
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", refreshRepository),
        vscode.commands.registerCommand("intelligit.openRepository", openRepositoryFromCommand),
        vscode.commands.registerCommand(
            "intelligit.openRepository.color",
            openRepositoryFromCommand,
        ),
        vscode.commands.registerCommand("intelligit.refresh.color", refreshRepository),
        vscode.commands.registerCommand("intelligit.graph.fetch", async () => {
            await runGraphGitOperation("fetch");
        }),
        vscode.commands.registerCommand("intelligit.graph.fetch.color", async () => {
            await runGraphGitOperation("fetch");
        }),
        vscode.commands.registerCommand("intelligit.graph.pull", async () => {
            await runGraphGitOperation("pull");
        }),
        vscode.commands.registerCommand("intelligit.graph.pull.color", async () => {
            await runGraphGitOperation("pull");
        }),
        vscode.commands.registerCommand("intelligit.graph.push", async () => {
            await runGraphGitOperation("push");
        }),
        vscode.commands.registerCommand("intelligit.graph.push.color", async () => {
            await runGraphGitOperation("push");
        }),
        vscode.commands.registerCommand("intelligit.graph.sync", async () => {
            await runGraphGitOperation("sync");
        }),
        vscode.commands.registerCommand("intelligit.graph.sync.color", async () => {
            await runGraphGitOperation("sync");
        }),
        vscode.commands.registerCommand("intelligit.publishBranch", async (root?: unknown) => {
            await publishRepository(deps, captureRepositoryRoot(deps, root));
        }),
        vscode.commands.registerCommand("intelligit.worktree.delete", async (ctx: unknown) => {
            if (!isWorktreeContext(ctx)) return;
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    const removed = await runWithNotificationProgress(
                        vscode.l10n.t("Deleting worktree {path}...", { path: ctx.path }),
                        () => service.removeWorktree(ctx.path),
                    );
                    if (!removed) return false;
                    showTimedInformationMessage(
                        vscode.l10n.t("Deleted worktree {path}", { path: ctx.path }),
                    );
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Delete worktree failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.worktree.lock", async (ctx: unknown) => {
            if (!isWorktreeContext(ctx)) return;
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    const reason = await vscode.window.showInputBox({
                        prompt: vscode.l10n.t("Lock reason (optional)"),
                    });
                    if (reason === undefined) return false;
                    await runWithNotificationProgress(
                        vscode.l10n.t("Locking worktree {path}...", { path: ctx.path }),
                        () => service.lockWorktree(ctx.path, reason.trim() || undefined),
                    );
                    showTimedInformationMessage(
                        vscode.l10n.t("Locked worktree {path}", { path: ctx.path }),
                    );
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Worktree operation failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.worktree.unlock", async (ctx: unknown) => {
            if (!isWorktreeContext(ctx)) return;
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    await service.unlockWorktree(ctx.path);
                    showTimedInformationMessage(
                        vscode.l10n.t("Unlocked worktree {path}", { path: ctx.path }),
                    );
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Worktree operation failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.worktree.move", async (ctx: unknown) => {
            if (!isWorktreeContext(ctx)) return;
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    const picked = await vscode.window.showOpenDialog({
                        title: vscode.l10n.t("Select New Worktree Location"),
                        openLabel: vscode.l10n.t("Move Worktree"),
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                    });
                    const newPath = picked?.[0]?.fsPath;
                    if (!newPath) return false;
                    await runWithNotificationProgress(
                        vscode.l10n.t("Moving worktree {path}...", { path: ctx.path }),
                        () => service.moveWorktree(ctx.path, newPath),
                    );
                    showTimedInformationMessage(
                        vscode.l10n.t("Moved worktree {path}", { path: newPath }),
                    );
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Worktree operation failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.worktree.prune", async (ctx?: unknown) => {
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    await service.pruneWorktrees();
                    showTimedInformationMessage(vscode.l10n.t("Pruned worktrees."));
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Worktree operation failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.worktree.repair", async (ctx?: unknown) => {
            try {
                await withCapturedWorktree(deps, ctx, async (service) => {
                    await service.repairWorktrees();
                    showTimedInformationMessage(vscode.l10n.t("Repaired worktrees."));
                });
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Worktree operation failed: {message}", {
                        message: getErrorMessage(err),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.selectRepository", selectRepository),
        vscode.commands.registerCommand("intelligit.selectRepository.color", selectRepository),
        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                clearSelection({ loading: true });
                await deps.commitGraphFilterByBranch(branchName ?? null);
            },
        ),
        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
            const useUndockedWindow = vscode.workspace
                .getConfiguration("intelligit")
                .get<boolean>("undockableWindow", false);
            if (useUndockedWindow) {
                await showUndockedGitLog();
                return;
            }
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),
        vscode.commands.registerCommand("intelligit.openUndocked", pickUndockTargetAndOpen),
        vscode.commands.registerCommand("intelligit.openUndocked.color", pickUndockTargetAndOpen),
        vscode.commands.registerCommand("intelligit.dockWindow", dockIntelliGit),
        vscode.commands.registerCommand("intelligit.mergeConflictsRefresh", async () => {
            await refreshService().refreshMergeConflicts();
        }),
        vscode.commands.registerCommand("intelligit.toggleUndocked", async () => {
            const config = vscode.workspace.getConfiguration("intelligit");
            const nextValue = !config.get<boolean>("undockableWindow", false);
            if (nextValue) {
                await config.update("undockableWindow", true, true);
                await showUndockedGitLog();
            } else {
                await dockIntelliGit();
            }
        }),
    );
}

/**
 * Registers merge-conflict and editor-compare commands for the active repository.
 *
 * Tree-view command contexts are treated as optional UI input and ignored when
 * they do not carry a conflict file path. Merge side effects refresh conflict UI
 * through the current `RefreshService`; command disposables are owned by the
 * extension context.
 */
function registerMergeCommands(deps: RepositoryCommandsDeps): void {
    const {
        context,
        gitOps,
        openMergeConflictForFile,
        openConflictSession,
        openVsCodeMergeEditorForFile,
    } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            await openMergeConflictForFile(filePath);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            await compareFileWithRevision(ctx, gitOps);
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            await compareFileWithBranchOrTag(ctx, gitOps);
        }),
        vscode.commands.registerCommand("intelligit.showFileDiff", async (ctx?: unknown) => {
            await showFileDiff(ctx, gitOps);
        }),
        vscode.commands.registerCommand("intelligit.showCurrentRevision", async (ctx?: unknown) => {
            await showCurrentRevision(ctx, gitOps);
        }),
        vscode.commands.registerCommand(
            "intelligit.annotateWithGitBlame",
            async (ctx?: unknown) => {
                await annotateWithGitBlame(ctx, gitOps, context);
            },
        ),
        vscode.commands.registerCommand("intelligit.openConflictSession", async (ctx?: unknown) => {
            // Explicit roots can arrive from a webview-backed Pull. Reject invalid payloads;
            // never silently redirect a captured-repository request into the active repository.
            if (ctx !== undefined) {
                const root =
                    ctx && typeof ctx === "object" && "repositoryRoot" in ctx
                        ? ctx.repositoryRoot
                        : undefined;
                if (typeof root !== "string" || !deps.isKnownRepositoryRoot(root)) {
                    throw new Error(
                        vscode.l10n.t(
                            "The requested repository is no longer available. Select it again before opening conflicts.",
                        ),
                    );
                }
                const scoped = gitOps.deriveFor(root);
                const conflicts = await scoped.getConflictFilesDetailed();
                if (conflicts.length) await deps.openConflictSessionForRepository(scoped, root, {});
                return;
            }
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                showTimedInformationMessage(vscode.l10n.t("No unresolved merge conflicts found."));
                return;
            }
            await openConflictSession();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInVsCode",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                await openVsCodeMergeEditorForFile(filePath);
            },
        ),
        vscode.commands.registerCommand("intelligit.conflictAcceptYours", async (ctx: unknown) => {
            await acceptConflictSide(ctx, "ours", deps);
        }),
        vscode.commands.registerCommand("intelligit.conflictAcceptTheirs", async (ctx: unknown) => {
            await acceptConflictSide(ctx, "theirs", deps);
        }),
    );
}

/** Applies one side of a merge conflict and refreshes conflict UI after Git mutates the file. */
async function acceptConflictSide(
    ctx: unknown,
    side: "ours" | "theirs",
    deps: RepositoryCommandsDeps,
): Promise<void> {
    const filePath = resolveConflictPath(ctx);
    if (!filePath) return;
    const actionText =
        side === "ours"
            ? {
                  progress: vscode.l10n.t("Accepting yours for {path}...", { path: filePath }),
                  success: vscode.l10n.t("Accepted yours for {path}", { path: filePath }),
                  failure: (message: string) =>
                      vscode.l10n.t("Accept yours failed: {message}", { message }),
              }
            : {
                  progress: vscode.l10n.t("Accepting theirs for {path}...", { path: filePath }),
                  success: vscode.l10n.t("Accepted theirs for {path}", { path: filePath }),
                  failure: (message: string) =>
                      vscode.l10n.t("Accept theirs failed: {message}", { message }),
              };
    try {
        const root = captureContextRepositoryRoot(deps, ctx);
        const gitOps = deps.gitOps.deriveFor(root);
        await runWithNotificationProgress(actionText.progress, async () => {
            await gitOps.acceptConflictSide(filePath, side);
        });
        showTimedInformationMessage(actionText.success);
        if (areSameRepositoryRoot(root, deps.getRepoRoot()))
            await deps.refreshService().refreshConflictUi();
        else await deps.refreshRepository?.(root);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(actionText.failure(message));
    }
}

/**
 * Registers branch action commands created by the branch command factory.
 *
 * The command item is normalized before dispatch because branch actions can be
 * invoked from different VS Code surfaces. Handlers use callbacks so branch
 * state, merge-conflict refreshes, and repository roots follow the active
 * repository.
 */
function registerBranchCommands(deps: RepositoryCommandsDeps): void {
    const branchCommands = createBranchCommands({
        executor: deps.executor,
        gitOps: deps.gitOps,
        getCurrentBranchName: deps.getCurrentBranchName,
        getCurrentBranches: deps.getCurrentBranches,
        createWorktree: (opts) => deps.worktreeService.createWorktree(opts).then(() => undefined),
        openConflictSession: deps.openConflictSession,
        refreshConflictUi: () => deps.refreshService().refreshConflictUi(),
    });

    for (const cmd of branchCommands) {
        deps.context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, async (item: unknown) => {
                // Capture ownership before either an operation fence or a prompt can yield.
                const explicitRoot =
                    item && typeof item === "object" && "repositoryRoot" in item
                        ? item.repositoryRoot
                        : undefined;
                const hasExplicitRoot =
                    !!item && typeof item === "object" && "repositoryRoot" in item;
                if (
                    hasExplicitRoot &&
                    (typeof explicitRoot !== "string" ||
                        !explicitRoot ||
                        !deps.isKnownRepositoryRoot(explicitRoot))
                ) {
                    throw new Error(
                        vscode.l10n.t(
                            "The requested repository is no longer available. Select it again before running branch actions.",
                        ),
                    );
                }
                if (hasExplicitRoot)
                    return runScopedBranchCommand(deps, cmd.id, explicitRoot as string, item);
                const repoRoot = captureRepositoryRoot(deps);
                const executor = deps.executor.deriveFor(repoRoot);
                const operationGitOps = deps.gitOps.deriveFor(repoRoot);
                const currentBranch = deps.getCurrentBranchName();
                const branches = deps.getCurrentBranches();
                const worktrees = new WorktreeService(executor, () => repoRoot);
                try {
                    const captured = createBranchCommands({
                        executor,
                        gitOps: operationGitOps,
                        getCurrentBranchName: () => currentBranch,
                        getCurrentBranches: () => branches,
                        createWorktree: (opts) =>
                            worktrees.createWorktree(opts).then(() => undefined),
                        openConflictSession: (labels = {}) =>
                            deps.openConflictSessionForRepository(
                                operationGitOps,
                                repoRoot,
                                labels,
                            ),
                        refreshConflictUi: async () => {
                            if (areSameRepositoryRoot(repoRoot, deps.getRepoRoot()))
                                await deps.refreshService().refreshConflictUi();
                        },
                        refreshRepository: async () => {
                            if (deps.refreshRepository) await deps.refreshRepository(repoRoot);
                            else if (areSameRepositoryRoot(repoRoot, deps.getRepoRoot()))
                                await deps.refreshActiveRepository();
                            else await deps.refreshService().refreshCommitPanels();
                        },
                        publishBranch: () => publishRepository(deps, repoRoot),
                    }).find((entry) => entry.id === cmd.id);
                    if (
                        BRANCH_COMMAND_FENCE_DECISIONS[cmd.id] !== false &&
                        (await rejectWhenOperationInProgress(operationGitOps))
                    )
                        return;
                    if (!captured) throw new Error(`Missing captured branch command: ${cmd.id}`);
                    const validated =
                        item &&
                        typeof item === "object" &&
                        ("branch" in item || "branches" in item || "branchNames" in item)
                            ? (item as {
                                  branch?: Branch;
                                  branches?: Branch[];
                                  branchNames?: string[];
                              })
                            : { branch: undefined };
                    return await captured.handler(validated);
                } finally {
                    worktrees.dispose();
                }
            }),
        );
    }
}

/** Resolves the originating panel's trusted root before any prompt, gate or Git mutation. */
async function runScopedBranchCommand(
    deps: RepositoryCommandsDeps,
    commandId: string,
    repositoryRoot: string,
    item: object,
): Promise<void> {
    const executor = deps.executor.deriveFor(repositoryRoot);
    const gitOps = deps.gitOps.deriveFor(repositoryRoot);
    const worktrees = new WorktreeService(executor, () => repositoryRoot);
    try {
        if (
            BRANCH_COMMAND_FENCE_DECISIONS[commandId] !== false &&
            (await rejectWhenOperationInProgress(gitOps))
        )
            return;
        const canUseUndecoratedBranches =
            commandId === "intelligit.mergeIntoCurrent" || commandId === "intelligit.updateBranch";
        const [branches, hasWorktreeMetadata] = await Promise.all([
            gitOps.getBranches(),
            worktrees.listWorktrees().then(
                () => true,
                (error: unknown) => {
                    if (!canUseUndecoratedBranches) throw error;
                    return false;
                },
            ),
        ]);
        const currentBranches = hasWorktreeMetadata
            ? worktrees.decorateBranches(branches)
            : branches;
        const branchesByName = new Map(currentBranches.map((branch) => [branch.name, branch]));
        const payload = item as {
            branch?: Branch;
            branches?: Array<Branch | string>;
            branchNames?: string[];
        };
        const resolveBranch = (value: Branch | string): Branch => {
            const name = typeof value === "string" ? value : value?.name;
            const branch = branchesByName.get(name);
            if (!branch)
                throw new Error(
                    vscode.l10n.t(
                        "The selected branch is no longer available. Refresh the repository and try again.",
                    ),
                );
            return branch;
        };
        const validated = {
            ...(payload.branch ? { branch: resolveBranch(payload.branch) } : {}),
            ...(payload.branches ? { branches: payload.branches.map(resolveBranch) } : {}),
            ...(payload.branchNames
                ? { branchNames: payload.branchNames.map((name) => resolveBranch(name).name) }
                : {}),
        };
        const refresh = async (): Promise<void> => {
            if (deps.refreshRepository) await deps.refreshRepository(repositoryRoot);
            else if (areSameRepositoryRoot(repositoryRoot, deps.getRepoRoot()))
                await deps.refreshActiveRepository();
            else await deps.refreshService().refreshCommitPanels();
        };
        const commands: BranchCommandEntry[] = createBranchCommands({
            executor,
            gitOps,
            getCurrentBranchName: () => currentBranches.find((branch) => branch.isCurrent)?.name,
            getCurrentBranches: () => currentBranches,
            createWorktree: (options) => worktrees.createWorktree(options).then(() => undefined),
            openConflictSession: (labels = {}) =>
                deps.openConflictSessionForRepository(gitOps, repositoryRoot, labels),
            refreshConflictUi: async () => {
                if (areSameRepositoryRoot(repositoryRoot, deps.getRepoRoot()))
                    await deps.refreshService().refreshConflictUi();
            },
            refreshRepository: refresh,
            publishBranch: () => publishRepository(deps, repositoryRoot),
        });
        await commands.find((command) => command.id === commandId)?.handler(validated);
    } finally {
        worktrees.dispose();
    }
}

/**
 * Registers commit-panel file commands that operate on repository-relative paths.
 *
 * Handlers validate path input before filesystem or Git side effects, prompt for
 * destructive rollback/delete actions, and refresh commit panels after operations
 * that can change the working tree. All disposables are owned by the extension
 * context.
 */
function registerCommitFileCommands(deps: RepositoryCommandsDeps): void {
    const {
        context,
        executor,
        gitOps,
        getRepoRoot,
        isKnownRepositoryRoot,
        refreshActiveRepository,
        refreshService,
    } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openPartialChanges", async (ctx: unknown) => {
            try {
                const resolved = await resolveFileCommandContext(ctx, gitOps);
                if (!resolved) {
                    await vscode.window.showErrorMessage(
                        vscode.l10n.t("Open Partial Changes is only available for local files."),
                    );
                    return;
                }
                await deps.openPartialChanges(resolved.repoRoot, resolved.repoRelativePath);
            } catch (error) {
                await vscode.window.showErrorMessage(
                    vscode.l10n.t("Open Partial Changes failed: {message}", {
                        message: getErrorMessage(error),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.fileSaveToShelf", async (ctx: unknown) => {
            try {
                const resolved = isFilePathContext(ctx)
                    ? {
                          repoRoot: captureContextRepositoryRoot(deps, ctx),
                          repoRelativePath: assertRepoRelativePath(ctx.filePath),
                      }
                    : await resolveFileCommandContext(ctx, gitOps);
                if (!resolved || !deps.saveWholeFileToShelf)
                    throw new Error(
                        "Save to Shelf is only available for a local file in a known repository.",
                    );
                await deps.saveWholeFileToShelf(resolved.repoRoot, resolved.repoRelativePath);
            } catch (error) {
                await vscode.window.showErrorMessage(
                    vscode.l10n.t("Save to Shelf failed: {message}", {
                        message: getErrorMessage(error),
                    }),
                );
            }
        }),
        vscode.commands.registerCommand("intelligit.fileCommit", async (ctx: unknown) => {
            await commitFileFromContext(
                ctx,
                gitOps,
                async (scopedGitOps, repoRoot, filePath, message) => {
                    await commitSelectedFromPanel(
                        {
                            gitOps: scopedGitOps,
                            refreshData: async () => {
                                try {
                                    await refreshService().refreshCommitPanels();
                                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                                        await refreshActiveRepository();
                                    }
                                } catch (error) {
                                    console.error("Failed to refresh after file Commit:", error);
                                    await vscode.window.showErrorMessage(
                                        vscode.l10n.t(
                                            "Commit succeeded, but refresh failed: {message}",
                                            { message: getErrorMessage(error) },
                                        ),
                                    );
                                }
                            },
                            fireWorkingTreeChanged: () => undefined,
                            postCommitted: () => undefined,
                            maybeOfferPublishBranch: () => Promise.resolve(),
                        },
                        {
                            message,
                            paths: [filePath],
                            amend: false,
                            push: false,
                            rejectActiveOperation: true,
                        },
                    );
                },
            );
        }),
        vscode.commands.registerCommand("intelligit.fileAddToVcs", async (ctx: unknown) => {
            if (ctx === undefined || ctx instanceof vscode.Uri) {
                await addFileToVcsFromContext(
                    ctx,
                    gitOps,
                    async (scopedGitOps, repoRoot, filePath) => {
                        await trackUnversionedFilesFromPanel(
                            {
                                gitOps: scopedGitOps,
                                getWorkspaceRoot: () => vscode.Uri.file(repoRoot),
                                refreshData: async () => {
                                    try {
                                        await refreshService().refreshCommitPanels();
                                    } catch (error) {
                                        await vscode.window.showErrorMessage(
                                            vscode.l10n.t(
                                                "Added to VCS, but refresh failed: {message}",
                                                { message: getErrorMessage(error) },
                                            ),
                                        );
                                    }
                                },
                                fireWorkingTreeChanged: () => undefined,
                            },
                            [filePath],
                        );
                    },
                );
                return;
            }
            const input = resolveAddToVcsContext(ctx);
            if (!input || !isKnownRepositoryRoot(input.repositoryRoot)) return;
            const scopedGitOps = gitOps.deriveFor(input.repositoryRoot);
            await trackUnversionedFilesFromPanel(
                {
                    gitOps: scopedGitOps,
                    getWorkspaceRoot: () => vscode.Uri.file(input.repositoryRoot),
                    refreshData: () => refreshService().refreshCommitPanels(),
                    fireWorkingTreeChanged: () => undefined,
                },
                input.filePaths,
            );
        }),
        vscode.commands.registerCommand(
            "intelligit.commitFileCompareWithLocal",
            async (ctx: unknown) => {
                const root = captureContextRepositoryRoot(deps, ctx);
                await compareCommitInfoFileWithLocal(ctx, root, gitOps.deriveFor(root));
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileCherryPickChange",
            async (ctx: unknown) => {
                const root = captureContextRepositoryRoot(deps, ctx);
                await applySelectedCommitFileChange(
                    ctx,
                    "cherry-pick",
                    executor.deriveFor(root),
                    async () => {
                        if (areSameRepositoryRoot(root, getRepoRoot()))
                            await refreshService().refreshConflictUi();
                        else await deps.refreshRepository?.(root);
                    },
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileRevertChange",
            async (ctx: unknown) => {
                const root = captureContextRepositoryRoot(deps, ctx);
                await applySelectedCommitFileChange(
                    ctx,
                    "revert",
                    executor.deriveFor(root),
                    async () => {
                        if (areSameRepositoryRoot(root, getRepoRoot()))
                            await refreshService().refreshConflictUi();
                        else await deps.refreshRepository?.(root);
                    },
                );
            },
        ),
        vscode.commands.registerCommand("intelligit.fileFetch", async (ctx: unknown) => {
            const fetchedRoot = await fetchFile(ctx, gitOps);
            if (fetchedRoot && areSameRepositoryRoot(fetchedRoot, getRepoRoot())) {
                await refreshActiveRepository();
            }
        }),
        vscode.commands.registerCommand("intelligit.fileMerge", async (ctx: unknown) => {
            await mergeFileFromContext(ctx, gitOps, {
                refresh: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                        await refreshActiveRepository();
                    }
                },
                refreshConflicts: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                        await refreshService().refreshConflictUi();
                    }
                },
                openConflictSession: deps.openConflictSessionForRepository,
            });
        }),
        vscode.commands.registerCommand("intelligit.fileRebase", async (ctx: unknown) => {
            await rebaseFileFromContext(ctx, gitOps, {
                refresh: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                        await refreshActiveRepository();
                    }
                },
                refreshConflicts: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                        await refreshService().refreshConflictUi();
                    }
                },
                openConflictSession: deps.openConflictSessionForRepository,
            });
        }),
        vscode.commands.registerCommand("intelligit.fileBranches", async (ctx: unknown) => {
            await branchesFileFromContext(ctx, gitOps, executor, async (repoRoot) => {
                await refreshService().refreshCommitPanels();
                if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                    await refreshActiveRepository();
                }
            });
        }),
        vscode.commands.registerCommand("intelligit.fileNewBranch", async (ctx: unknown) => {
            await newBranchFileFromContext(ctx, gitOps, executor, async (repoRoot) => {
                await refreshService().refreshCommitPanels();
                if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                    await refreshActiveRepository();
                }
            });
        }),
        vscode.commands.registerCommand("intelligit.fileNewTag", async (ctx: unknown) => {
            await newTagFileFromContext(ctx, gitOps, executor, async (repoRoot) => {
                await refreshService().refreshCommitPanels();
                if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                    await refreshActiveRepository();
                }
            });
        }),
        vscode.commands.registerCommand("intelligit.fileResetHead", async (ctx: unknown) => {
            await resetHeadFileFromContext(ctx, gitOps, executor, async (repoRoot) => {
                await refreshService().refreshCommitPanels();
                if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                    await refreshActiveRepository();
                }
            });
        }),
        vscode.commands.registerCommand("intelligit.fileStashChanges", async (ctx: unknown) => {
            await stashChangesFromContext(ctx, gitOps, async (repoRoot) => {
                await refreshService().refreshCommitPanels();
                if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                    await refreshActiveRepository();
                }
            });
        }),
        vscode.commands.registerCommand("intelligit.fileManageRemotes", async (ctx: unknown) => {
            await manageRemotesFileFromContext(
                ctx,
                gitOps,
                deps.context.extensionUri,
                async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                        await refreshActiveRepository();
                    }
                },
            );
        }),
        vscode.commands.registerCommand(
            "intelligit.fileContextUnstashChanges",
            async (ctx: unknown) => {
                await unstashChangesFromContext(ctx, gitOps, {
                    refresh: async (repoRoot) => {
                        await refreshService().refreshCommitPanels();
                        if (areSameRepositoryRoot(repoRoot, getRepoRoot())) {
                            await refreshActiveRepository();
                        }
                    },
                    openConflictSession: async (scopedGitOps, repoRoot) =>
                        deps.openConflictSessionForRepository(scopedGitOps, repoRoot, {}),
                });
            },
        ),
        vscode.commands.registerCommand("intelligit.github.createPullRequest", (ctx: unknown) =>
            createGitHubPullRequestFromContext(ctx, gitOps),
        ),
        vscode.commands.registerCommand("intelligit.github.viewPullRequests", (ctx: unknown) =>
            viewGitHubPullRequestsFromContext(ctx, gitOps),
        ),
        vscode.commands.registerCommand("intelligit.github.syncFork", (ctx: unknown) =>
            syncGitHubForkFromContext(ctx, gitOps, {
                refresh: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot()))
                        await refreshActiveRepository();
                },
                refreshConflicts: async (repoRoot) => {
                    await refreshService().refreshCommitPanels();
                    if (areSameRepositoryRoot(repoRoot, getRepoRoot()))
                        await refreshService().refreshConflictUi();
                },
                openConflictSession: async (scopedGitOps, repoRoot) =>
                    deps.openConflictSessionForRepository(scopedGitOps, repoRoot, {}),
            }),
        ),
        vscode.commands.registerCommand("intelligit.github.createGist", (ctx: unknown) =>
            createGitHubGistFromContext(ctx, gitOps),
        ),
        vscode.commands.registerCommand("intelligit.github.viewInBrowser", (ctx: unknown) =>
            viewGitHubFileFromContext(ctx, gitOps),
        ),
        vscode.commands.registerCommand("intelligit.github.shareProject", (ctx: unknown) =>
            shareGitHubProjectFromContext(ctx, gitOps),
        ),
        vscode.commands.registerCommand("intelligit.github.cloneRepository", () =>
            runGitHubCloneFlow(),
        ),
        vscode.commands.registerCommand("intelligit.cloneRepository", () =>
            runCloneFlow(deps.context.secrets),
        ),
        vscode.commands.registerCommand("intelligit.github.manageAccounts", () =>
            manageGitHubAccounts(),
        ),
        vscode.commands.registerCommand("intelligit.filePull", async (ctx: unknown) => {
            await pullFileRepositoryFromContext(ctx, gitOps, async (scopedGitOps, repoRoot) => {
                await runGitOperationFromPanel(
                    {
                        gitOps: scopedGitOps,
                        refreshData: async () => {
                            if (!areSameRepositoryRoot(repoRoot, getRepoRoot())) return;
                            await refreshActiveRepository();
                        },
                        openConflictSession: async () =>
                            deps.openConflictSessionForRepository(scopedGitOps, repoRoot, {}),
                        fireWorkingTreeChanged: () => undefined,
                    },
                    "pull",
                );
            });
        }),
        vscode.commands.registerCommand("intelligit.filePush", async (ctx: unknown) => {
            await pushFileRepositoryFromContext(ctx, gitOps, async (scopedGitOps, repoRoot) => {
                await runGitOperationFromPanel(
                    {
                        gitOps: scopedGitOps,
                        refreshData: async () => {
                            if (!areSameRepositoryRoot(repoRoot, getRepoRoot())) return;
                            try {
                                await refreshActiveRepository();
                            } catch (error) {
                                console.error("Failed to refresh after file Push:", error);
                                await vscode.window.showErrorMessage(
                                    vscode.l10n.t("Could not refresh after Push: {message}", {
                                        message: getErrorMessage(error),
                                    }),
                                );
                            }
                        },
                        fireWorkingTreeChanged: () => undefined,
                        publishBranch: async () => {
                            const hasCommits = await scopedGitOps.hasAnyCommits();
                            if (!hasCommits) {
                                showTimedWarningMessage(
                                    vscode.l10n.t("Create a commit before publishing this branch."),
                                );
                                return;
                            }
                            const currentBranch = (await scopedGitOps.getBranches()).find(
                                (branch) => branch.isCurrent,
                            );
                            if (!currentBranch) {
                                vscode.window.showErrorMessage(
                                    vscode.l10n.t("No current branch found."),
                                );
                                return;
                            }
                            await runPublishBranchFlow(
                                scopedGitOps,
                                currentBranch.name,
                                repoRoot,
                                context.secrets,
                            );
                        },
                    },
                    "push",
                );
            });
        }),
        vscode.commands.registerCommand("intelligit.fileRollback", async (ctx: unknown) => {
            if (!isFilePathContext(ctx)) {
                try {
                    await rollbackFile(ctx, gitOps);
                } finally {
                    await refreshService().refreshCommitPanels();
                }
                return;
            }
            try {
                const root = captureRepositoryRoot(
                    deps,
                    "repositoryRoot" in ctx ? ctx.repositoryRoot : undefined,
                );
                const scopedGitOps = gitOps.deriveFor(root);
                const safePath = assertRepoRelativePath(ctx.filePath);
                const rollbackAction = vscode.l10n.t("Rollback");
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t("Rollback {path}?", { path: safePath }),
                    { modal: true },
                    rollbackAction,
                );
                if (confirm !== rollbackAction) return;
                await scopedGitOps.rollbackFiles([safePath]);
                showTimedInformationMessage(vscode.l10n.t("Changes rolled back."));
            } catch (error) {
                const message = getErrorMessage(error);
                console.error("Failed to rollback file:", error);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Rollback failed: {message}", { message }),
                );
            } finally {
                await refreshService().refreshCommitPanels();
            }
        }),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string; repositoryRoot?: unknown }) => {
                if (!ctx?.filePath) return;
                const root = captureRepositoryRoot(deps, ctx.repositoryRoot);
                const uri = vscode.Uri.file(path.join(root, assertRepoRelativePath(ctx.filePath)));
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string; repositoryRoot?: unknown }) => {
                if (!ctx?.filePath) return;
                try {
                    const root = captureRepositoryRoot(deps, ctx.repositoryRoot);
                    const scopedGitOps = gitOps.deriveFor(root);
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const deleteAction = vscode.l10n.t("Delete");
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t("Delete {path}?", { path: safePath }),
                        { modal: true },
                        deleteAction,
                    );
                    if (confirm !== deleteAction) return;

                    const deleted = await deleteFileWithFallback(
                        scopedGitOps,
                        vscode.Uri.file(root),
                        safePath,
                    );
                    if (deleted) {
                        showTimedInformationMessage(
                            vscode.l10n.t("Deleted {path}", { path: safePath }),
                        );
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Delete failed for '{path}': {message}", {
                            path: ctx.filePath,
                            message,
                        }),
                    );
                } finally {
                    await refreshService().refreshCommitPanels();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string; repositoryRoot?: unknown }) => {
                if (!ctx?.filePath) return;
                try {
                    const root = captureRepositoryRoot(deps, ctx.repositoryRoot);
                    const scopedGitOps = gitOps.deriveFor(root);
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    await scopedGitOps.stashSave([safePath]);
                    showTimedInformationMessage(
                        vscode.l10n.t("Stashed {path}.", { path: safePath }),
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to stash file:", error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Stash failed: {message}", { message }),
                    );
                } finally {
                    await refreshService().refreshCommitPanels();
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await refreshService().refreshCommitPanels();
        }),
    );
}
