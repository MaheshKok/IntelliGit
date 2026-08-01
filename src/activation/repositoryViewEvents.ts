import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch, GitWorktree } from "../types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
    WorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import { createInteractiveRebaseSubmissionHandler } from "../git/interactiveRebase/submission";
import type {
    InteractiveRebaseSubmissionRejectionReason,
    PendingRebaseDialogRequests,
    RebaseSubmissionEntry,
} from "../git/interactiveRebase/types";
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
    /** Registry shared with undocked dispatch so only one request exists for each origin/root pair. */
    pendingRebaseDialogRequests: PendingRebaseDialogRequests;
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
        pendingRebaseDialogRequests,
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
     * Binds a commit-action listener to the provider that emitted it.
     *
     * The bound callback keeps interactive-rebase dialog delivery on the originating webview while
     * preserving the lazy active-repository access used by every other commit context action.
     */
    const runCommitAction =
        (
            originProvider: object,
            postRebaseDialog: (
                message: Extract<CommitGraphInbound, { type: "showRebaseDialog" }>,
            ) => boolean,
        ) =>
        async ({ action, hash }: { action: CommitAction; hash: string }): Promise<void> => {
            try {
                await handleCommitContextAction({
                    action,
                    hash,
                    executor,
                    gitOps,
                    repoRoot: getRepoRoot(),
                    currentBranches: getCurrentBranches(),
                    refreshAll: () => refreshService().refreshAll(),
                    originProvider,
                    postRebaseDialog,
                    pendingRebaseDialogRequests,
                });
            } catch (error) {
                const message = getErrorMessage(error);
                console.error(`Commit action '${action}' failed:`, error);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit action failed: {message}", { message }),
                );
            }
        };

    const rebaseSubmissionHandler = createInteractiveRebaseSubmissionHandler({
        executor,
        pendingRebaseDialogRequests,
        getRepoRoot,
        hasWholeIndexOperationInProgress: () => gitOps.hasWholeIndexOperationInProgress(),
    });
    const handleRebaseDialogSubmit =
        (originProvider: object) =>
        async ({ requestId, entries }: { requestId: string; entries: RebaseSubmissionEntry[] }) => {
            const result = await rebaseSubmissionHandler.submit(
                { requestId, entries },
                originProvider,
            );
            if (result.status === "rejected") {
                showInteractiveRebaseSubmissionRejection(result.reason);
                return;
            }
            console.info("[IntelliGit] Interactive rebase submission accepted:", result);
            // Phase seam: the next phase wires accepted entries to the rebase engine.
            await vscode.window.showInformationMessage(
                vscode.l10n.t(
                    "Interactive rebase is ready, but the rebase engine is not wired yet.",
                ),
            );
        };
    const handleRebaseDialogCancel =
        (originProvider: object) =>
        ({ requestId }: { requestId: string }) => {
            // An already-consumed request is a benign no-op, so its boolean result is intentionally ignored.
            rebaseSubmissionHandler.cancel({ requestId }, originProvider);
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
        commitGraph.onCommitAction(
            runCommitAction(commitGraph, (message) => commitGraph.showRebaseDialog(message)),
        ),
        sidebarGraph.onCommitAction(
            runCommitAction(sidebarGraph, (message) => sidebarGraph.showRebaseDialog(message)),
        ),
        commitPanel.onCommitAction(
            runCommitAction(commitPanel, (message) => commitPanel.showRebaseDialog(message)),
        ),
        commitGraph.onRebaseDialogSubmit(handleRebaseDialogSubmit(commitGraph)),
        sidebarGraph.onRebaseDialogSubmit(handleRebaseDialogSubmit(sidebarGraph)),
        commitPanel.onRebaseDialogSubmit(handleRebaseDialogSubmit(commitPanel)),
        commitGraph.onRebaseDialogCancel(handleRebaseDialogCancel(commitGraph)),
        sidebarGraph.onRebaseDialogCancel(handleRebaseDialogCancel(sidebarGraph)),
        commitPanel.onRebaseDialogCancel(handleRebaseDialogCancel(commitPanel)),
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        sidebarGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitPanel.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );
}

/** Shows the distinct host-side reason an interactive-rebase dialog submission was refused. */
export function showInteractiveRebaseSubmissionRejection(
    reason: InteractiveRebaseSubmissionRejectionReason,
): void {
    switch (reason) {
        case "unknown-or-expired":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase dialog is no longer active."),
            );
            return;
        case "wrong-origin":
            vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "This interactive rebase dialog belongs to a different IntelliGit view.",
                ),
            );
            return;
        case "invalid-action":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase contains an invalid action."),
            );
            return;
        case "invalid-hash":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase contains an invalid commit hash."),
            );
            return;
        case "hash-not-offered":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase contains a commit that was not offered."),
            );
            return;
        case "duplicate-hash":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase contains the same commit more than once."),
            );
            return;
        case "entry-count-mismatch":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase changed the offered commit count."),
            );
            return;
        case "missing-message":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase requires a replacement message for this action."),
            );
            return;
        case "invalid-message":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase contains an invalid commit message."),
            );
            return;
        case "invalid-first-action":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase cannot start with squash or fixup."),
            );
            return;
        case "repo-changed":
            vscode.window.showErrorMessage(
                vscode.l10n.t("The selected repository changed while the dialog was open."),
            );
            return;
        case "branch-unavailable":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase could not resolve the current branch."),
            );
            return;
        case "head-unavailable":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase could not resolve the current HEAD."),
            );
            return;
        case "branch-moved":
            vscode.window.showErrorMessage(
                vscode.l10n.t("The checked-out branch changed while the dialog was open."),
            );
            return;
        case "head-moved":
            vscode.window.showErrorMessage(
                vscode.l10n.t("HEAD changed while the interactive rebase dialog was open."),
            );
            return;
        case "invalid-selected-hash":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase received an invalid selected commit."),
            );
            return;
        case "operation-in-progress":
            vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "Interactive rebase cannot start while another Git operation is in progress.",
                ),
            );
            return;
        case "detached-head":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase requires a checked-out branch."),
            );
            return;
        case "selected-merge-commit":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase is not available for merge commits."),
            );
            return;
        case "commit-not-ancestor":
            vscode.window.showErrorMessage(
                vscode.l10n.t("The selected commit is not in the current branch history."),
            );
            return;
        case "initial-commit":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase is not available for the initial commit."),
            );
            return;
        case "working-tree-dirty":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase requires a clean working tree."),
            );
            return;
        case "range-contains-merge-commit":
            vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "Interactive rebase is not available for ranges containing merge commits.",
                ),
            );
            return;
        case "git-error":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase could not inspect the repository."),
            );
            return;
        default:
            return assertNeverInteractiveRebaseSubmissionReason(reason);
    }
}

/** Makes newly added submission rejection reasons a compile-time exhaustiveness error. */
function assertNeverInteractiveRebaseSubmissionReason(reason: never): never {
    void reason;
    throw new Error("Unhandled interactive rebase submission rejection reason.");
}
