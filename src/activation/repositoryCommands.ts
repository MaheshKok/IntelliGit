import * as path from "path";
import * as vscode from "vscode";
import { createBranchCommands } from "../commands/branchCommands";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { runPublishBranchFlow } from "../services/publishService";
import type { WorktreeService } from "../services/worktreeService";
import {
    applySelectedCommitFileChange,
    compareCommitInfoFileWithLocal,
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
} from "../services/diffService";
import {
    detectAndPickJetBrainsMergeToolPath,
    openJetBrainsMergeToolForFile,
} from "../services/jetbrainsMergeService";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { discoverGitRepositories } from "../services/repositoryDiscovery";
import type { Branch } from "../types";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { runWithNotificationProgress } from "../utils/notifications";
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
    setRepositories: (repositories: DiscoveredRepository[]) => void;
    getCurrentBranches: () => Branch[];
    commitGraphFilterByBranch: (branchName: string | null) => Promise<void>;
    sidebarGraphFilterByBranch: (branchName: string | null) => Promise<void>;
    getCurrentBranchName: () => string | undefined;
    setActiveRepository: (repository: DiscoveredRepository) => Promise<void>;
    clearSelection: () => void;
    refreshActiveRepository: () => Promise<void>;
    refreshService: () => RefreshService;
    showUndockedGitLog: (options?: { deferDataLoad?: boolean }) => Promise<void>;
    pickUndockTargetAndOpen: () => Promise<void>;
    dockIntelliGit: () => Promise<void>;
    openMergeConflictForFile: (filePath: string) => Promise<void>;
    openConflictSession: (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }) => Promise<void>;
    openBuiltInMergeEditorForFile: (filePath: string) => Promise<void>;
}

const isFilePathContext = (value: unknown): value is { filePath: string } => {
    return (
        !!value &&
        typeof value === "object" &&
        "filePath" in value &&
        typeof value.filePath === "string"
    );
};

const resolveConflictPath = (ctx: unknown): string | null =>
    isFilePathContext(ctx) ? ctx.filePath : null;

/**
 * Registers the command surface that requires an active IntelliGit repository.
 *
 * Called only from repository mode after Git services, providers, and refresh
 * state exist. Each command disposable is pushed into `deps.context.subscriptions`;
 * when no-repository mode transitions here it has already disposed placeholder
 * handlers for the same command IDs.
 */
export function registerRepositoryCommands(deps: RepositoryCommandsDeps): void {
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
        getCurrentBranches,
        setActiveRepository,
        clearSelection,
        refreshActiveRepository,
        showUndockedGitLog,
        pickUndockTargetAndOpen,
        dockIntelliGit,
        refreshService,
    } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            await vscode.window.withProgress(
                { location: { viewId: "intelligit.commitPanel" } },
                async () => {
                    await refreshActiveRepository();
                },
            );
        }),
        vscode.commands.registerCommand("intelligit.publishBranch", async () => {
            const hasCommits = await gitOps.hasAnyCommits();
            if (!hasCommits) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t("Create a commit before publishing this branch."),
                );
                return;
            }
            const currentBranch = getCurrentBranches().find((b) => b.isCurrent);
            if (!currentBranch) {
                vscode.window.showErrorMessage(vscode.l10n.t("No current branch found."));
                return;
            }
            await runPublishBranchFlow(gitOps, currentBranch.name, getRepoRoot(), context.secrets);
        }),
        vscode.commands.registerCommand("intelligit.selectRepository", async () => {
            const repositories = await discoverGitRepositories(workspaceRoots());
            setRepositories(repositories);
            if (repositories.length === 0) {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
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
        }),
        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                await Promise.all([
                    deps.commitGraphFilterByBranch(branchName ?? null),
                    deps.sidebarGraphFilterByBranch(branchName ?? null),
                ]);
                clearSelection();
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
        getRepoRoot,
        openMergeConflictForFile,
        openConflictSession,
        openBuiltInMergeEditorForFile,
        refreshService,
    } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            await openMergeConflictForFile(filePath);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            await compareEditorFileWithRevision(ctx, getRepoRoot(), gitOps);
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            await compareEditorFileWithBranch(ctx, getRepoRoot(), gitOps);
        }),
        vscode.commands.registerCommand("intelligit.openConflictSession", async () => {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t("No unresolved merge conflicts found."),
                );
                return;
            }
            await openConflictSession();
        }),
        vscode.commands.registerCommand("intelligit.detectJetBrainsMergeTool", async () => {
            await detectAndPickJetBrainsMergeToolPath();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInJetBrains",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                await openJetBrainsMergeToolForFile(
                    filePath,
                    getRepoRoot(),
                    gitOps,
                    () => refreshService().refreshConflictUi(),
                    openBuiltInMergeEditorForFile,
                );
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
        await runWithNotificationProgress(actionText.progress, async () => {
            await deps.gitOps.acceptConflictSide(filePath, side);
        });
        vscode.window.showInformationMessage(actionText.success);
        await deps.refreshService().refreshConflictUi();
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
            vscode.commands.registerCommand(cmd.id, (item: unknown) => {
                const validated =
                    item &&
                    typeof item === "object" &&
                    ("branch" in item || "branches" in item || "branchNames" in item)
                        ? (item as { branch?: Branch; branches?: Branch[]; branchNames?: string[] })
                        : { branch: undefined };
                return cmd.handler(validated);
            }),
        );
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
    const { context, executor, gitOps, getRepoRoot, refreshService } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "intelligit.commitFileCompareWithLocal",
            async (ctx: unknown) => {
                await compareCommitInfoFileWithLocal(ctx, getRepoRoot(), gitOps);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileCherryPickChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "cherry-pick", executor, () =>
                    refreshService().refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileRevertChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "revert", executor, () =>
                    refreshService().refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileRollback",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const rollbackAction = vscode.l10n.t("Rollback");
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t("Rollback {path}?", { path: safePath }),
                        { modal: true },
                        rollbackAction,
                    );
                    if (confirm !== rollbackAction) return;
                    await gitOps.rollbackFiles([safePath]);
                    vscode.window.showInformationMessage(vscode.l10n.t("Changes rolled back."));
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to rollback file:", error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Rollback failed: {message}", { message }),
                    );
                } finally {
                    await refreshService().refreshCommitPanels();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const uri = vscode.Uri.file(
                    path.join(getRepoRoot(), assertRepoRelativePath(ctx.filePath)),
                );
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const deleteAction = vscode.l10n.t("Delete");
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t("Delete {path}?", { path: safePath }),
                        { modal: true },
                        deleteAction,
                    );
                    if (confirm !== deleteAction) return;

                    const deleted = await deleteFileWithFallback(
                        gitOps,
                        vscode.Uri.file(getRepoRoot()),
                        safePath,
                    );
                    if (deleted) {
                        vscode.window.showInformationMessage(
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
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    await gitOps.shelveSave([safePath]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Shelved {path}.", { path: safePath }),
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to shelve file:", error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Shelve failed: {message}", { message }),
                    );
                } finally {
                    await refreshService().refreshCommitPanels();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShowHistory",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const history = await gitOps.getFileHistory(safePath);
                    const doc = await vscode.workspace.openTextDocument({
                        content: history || vscode.l10n.t("No history found."),
                        language: "git-commit",
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to load file history:", error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Show history failed: {message}", { message }),
                    );
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await refreshService().refreshCommitPanels();
        }),
        vscode.commands.registerCommand("intelligit.fileRefreshing", () => {
            // No-op: visual-only command shown while refreshing (disabled via enablement).
        }),
    );
}
