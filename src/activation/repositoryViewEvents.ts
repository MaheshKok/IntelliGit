import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch, GitWorktree } from "../types";
import type {
    BranchAction,
    CommitAction,
    WorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import { handleCommitContextAction } from "../commands/commitCommands";
import { openCommitFileDiff } from "../services/diffService";
import { RefreshService } from "../views/RefreshService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "../views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { getErrorMessage } from "../utils/errors";

interface CommitFileDiffDeps {
    executor: GitExecutor;
    gitOps: GitOps;
    getRepoRoot: () => string;
}

type BranchDeleteSelection = Array<Branch | string>;

/** Extracts a branch name from current and legacy bulk-delete event payloads. */
function getBranchSelectionName(branch: Branch | string): string {
    return typeof branch === "string" ? branch : branch.name;
}

/**
 * Shared callback used by repository-backed views to open a commit-scoped file diff.
 *
 * Implementations receive repository-relative file paths from view contexts and
 * are responsible for surfacing user-visible failures.
 */
export type OpenCommitFileDiffHandler = (params: {
    commitHash: string;
    filePath: string;
}) => Promise<void>;

/**
 * Creates the shared commit-file diff handler for all repository-backed views.
 *
 * The handler reads the active root when invoked, opens readonly diff content via
 * `openCommitFileDiff`, and converts failures into a VS Code error notification
 * instead of letting event emitters reject unhandled.
 */
export function createOpenCommitFileDiffHandler(
    deps: CommitFileDiffDeps,
): OpenCommitFileDiffHandler {
    return async (params) => {
        try {
            await openCommitFileDiff(
                params.commitHash,
                params.filePath,
                deps.getRepoRoot(),
                deps.gitOps,
                deps.executor,
            );
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to open commit diff: {message}", { message }),
            );
        }
    };
}

/**
 * Providers and repository services captured by view event subscriptions.
 *
 * Accessors must resolve the current active repository state because these
 * subscriptions remain registered across repository switches.
 */
export interface RepositoryViewEventDeps {
    context: vscode.ExtensionContext;
    executor: GitExecutor;
    gitOps: GitOps;
    commitGraph: CommitGraphViewProvider;
    sidebarGraph: CommitGraphViewProvider;
    commitPanel: CommitPanelViewProvider;
    commitInfo: CommitInfoViewProvider;
    getRepoRoot: () => string;
    getCurrentBranches: () => Branch[];
    getCurrentWorktrees: () => GitWorktree[];
    refreshService: () => RefreshService;
}

/**
 * Subscribes repository views to shared selection, branch, commit, and diff handlers.
 *
 * Called once during repository mode after providers are created. Listener
 * disposables are pushed to `deps.context.subscriptions`; callbacks use accessors
 * for repository root, branches, and refresh service so they continue to target
 * the active repository after root switches.
 *
 * Commit-detail loads use a sequence guard so slower responses from earlier
 * selections cannot overwrite newer selections across graph, sidebar, panel, and
 * commit-info views.
 */
export function registerRepositoryViewEvents(
    deps: RepositoryViewEventDeps,
    handleOpenCommitFileDiff: OpenCommitFileDiffHandler,
): void {
    let commitDetailRequestSeq = 0;
    const {
        context,
        executor,
        gitOps,
        commitGraph,
        sidebarGraph,
        commitPanel,
        commitInfo,
        getRepoRoot,
        getCurrentBranches,
        getCurrentWorktrees,
        refreshService,
    } = deps;

    /**
     * Loads one commit detail and fans it out to every docked repository view.
     *
     * A sequence counter drops stale async responses so rapid selection changes do
     * not show details for a previously selected commit.
     */
    const loadCommitDetail = async (hash: string): Promise<void> => {
        const requestId = ++commitDetailRequestSeq;
        try {
            const detail = await gitOps.getCommitDetail(hash);
            if (requestId === commitDetailRequestSeq) {
                commitGraph.setCommitDetail(detail);
                sidebarGraph.setCommitDetail(detail);
                commitPanel.setCommitDetail(detail);
                commitInfo.setCommitDetail(detail);
            }
        } catch (err) {
            if (requestId !== commitDetailRequestSeq) return;
            const msg = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to load commit: {message}", { message: msg }),
            );
        }
    };

    /**
     * Clears commit detail state after branch filtering invalidates the selection.
     */
    const clearCommitDetail = (): void => {
        commitDetailRequestSeq += 1;
        commitGraph.clearCommitDetail({ loading: true });
        sidebarGraph.clearCommitDetail({ loading: true });
        commitPanel.clearCommitDetail({ loading: true });
        commitInfo.clear({ loading: true });
    };

    /**
     * Forwards view-originated branch actions through registered VS Code commands.
     *
     * Branch names from webviews are matched against current branch state before
     * dispatch so command handlers receive the same context shape as tree actions.
     */
    const forwardBranchAction = ({
        action,
        branchName,
    }: {
        action: BranchAction;
        branchName: string;
    }): void => {
        const branch = getCurrentBranches().find((b) => b.name === branchName);
        if (!branch) return;
        void vscode.commands.executeCommand(`intelligit.${action}`, { branch });
    };

    /**
     * Forwards bulk branch deletion through the dedicated command payload.
     *
     * Branch selections are resolved against the latest trusted branch list so stale or
     * forged webview payloads are rejected before Git operations run.
     */
    const forwardDeleteBranches = (branches: BranchDeleteSelection): void => {
        const requestedNames = Array.from(new Set(branches.map(getBranchSelectionName)));
        const selected = requestedNames
            .map((name) => getCurrentBranches().find((branch) => branch.name === name))
            .filter((branch): branch is Branch => Boolean(branch));
        if (selected.length !== requestedNames.length) {
            const found = new Set(selected.map((branch) => branch.name));
            const missing = requestedNames.filter((name) => !found.has(name));
            vscode.window.showErrorMessage(
                vscode.l10n.t("Cannot delete missing branch(es): {branches}", {
                    branches: missing.join(", "),
                }),
            );
            return;
        }
        void vscode.commands.executeCommand("intelligit.deleteBranches", { branches: selected });
    };

    /** Forwards only worktree actions whose path came from the latest trusted host snapshot. */
    const forwardWorktreeAction = ({
        action,
        path: worktreePath,
    }: {
        action: WorktreeAction;
        path: string;
    }): void => {
        const worktree = getCurrentWorktrees().find((candidate) => candidate.path === worktreePath);
        if (!worktree) return;
        if (action === "open") {
            void vscode.commands.executeCommand("intelligit.openWorktree", {
                branch: {
                    name: worktree.branch ?? worktree.path,
                    worktreePath: worktree.path,
                },
            });
            return;
        }
        void vscode.commands.executeCommand(`intelligit.worktree.${action}`, worktree);
    };

    /**
     * Runs a view-originated commit action against the active repository state.
     *
     * Refresh callbacks are resolved lazily so actions that mutate history refresh
     * the current repository even after a repository switch.
     */
    const runCommitAction = async ({ action, hash }: { action: CommitAction; hash: string }) => {
        try {
            await handleCommitContextAction({
                action,
                hash,
                executor,
                gitOps,
                repoRoot: getRepoRoot(),
                currentBranches: getCurrentBranches(),
                refreshAll: () => refreshService().refreshAll(),
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.error(`Commit action '${action}' failed:`, error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit action failed: {message}", { message }),
            );
        }
    };

    context.subscriptions.push(
        commitGraph.onCommitSelected(loadCommitDetail),
        sidebarGraph.onCommitSelected(loadCommitDetail),
        commitPanel.onCommitSelected(loadCommitDetail),
        commitGraph.onBranchFilterChanged(clearCommitDetail),
        sidebarGraph.onBranchFilterChanged(clearCommitDetail),
        commitPanel.onBranchFilterChanged(clearCommitDetail),
        commitGraph.onBranchAction(forwardBranchAction),
        sidebarGraph.onBranchAction(forwardBranchAction),
        commitPanel.onBranchAction(forwardBranchAction),
        commitGraph.onDeleteBranches?.(forwardDeleteBranches) ??
            new vscode.Disposable(() => undefined),
        sidebarGraph.onDeleteBranches?.(forwardDeleteBranches) ??
            new vscode.Disposable(() => undefined),
        commitGraph.onWorktreeAction?.(forwardWorktreeAction) ??
            new vscode.Disposable(() => undefined),
        sidebarGraph.onWorktreeAction?.(forwardWorktreeAction) ??
            new vscode.Disposable(() => undefined),
        commitGraph.onCommitAction(runCommitAction),
        sidebarGraph.onCommitAction(runCommitAction),
        commitPanel.onCommitAction(runCommitAction),
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        sidebarGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitPanel.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );
}
