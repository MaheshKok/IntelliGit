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
import { runInteractiveRebaseSubmission } from "../git/interactiveRebase/run";
import { dismissRebasePushOffer, forcePushRebasedHead } from "../git/interactiveRebase/push";
import {
    abortInteractiveRebase,
    continueInteractiveRebase,
    type InteractiveRebaseControlResult,
} from "../git/interactiveRebase/control";
import { RepositoryMutationGate } from "../git/repositoryMutationGate";
import type {
    InteractiveRebaseSubmissionRejectionReason,
    PendingRebaseDialogRequests,
    RebaseSubmissionEntry,
    RebaseSessionManifest,
} from "../git/interactiveRebase/types";
import { handleCommitContextAction } from "../commands/commitCommands";
import { openCommitFileDiff } from "../services/diffService";
import { RefreshService } from "../views/RefreshService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "../views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";

/** Exported so `registerUndockedCommitFileDiffHandler` and its test can build this bundle
 * without reaching into `createOpenCommitFileDiffHandler`'s call site for the shape. */
export interface CommitFileDiffDeps {
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
 * Undocked-panel counterpart to the four docked subscriptions `registerRepositoryViewEvents`
 * wires below.
 *
 * Kept separate because the undocked panel is assembled by `ensureUndockedPanel`, a factory
 * with a large, mostly-unrelated dependency graph (WorktreeService, rebase submission
 * handlers, workspace-state persistence, ...). This seam isolates just the commit-file-diff
 * wiring -- built from the same shared factory the docked providers use -- so a test can
 * exercise it without constructing that graph.
 */
export function registerUndockedCommitFileDiffHandler(
    deps: CommitFileDiffDeps,
    undocked: { onOpenCommitFileDiff: vscode.Event<{ commitHash: string; filePath: string }> },
): vscode.Disposable {
    const handleOpenCommitFileDiff = createOpenCommitFileDiffHandler(deps);
    return undocked.onOpenCommitFileDiff(handleOpenCommitFileDiff);
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
    /** Shared mutation gate used to keep the final check and rebase spawn adjacent. */
    mutationGate: RepositoryMutationGate;
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
        mutationGate,
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
            try {
                const result = await rebaseSubmissionHandler.submit(
                    { requestId, entries },
                    originProvider,
                );
                if (result.status === "rejected") {
                    showInteractiveRebaseSubmissionRejection(result.reason);
                    return;
                }
                const directories = await gitOps.getGitDirectories();
                const runResult = await runWithNotificationProgress(
                    vscode.l10n.t("Running interactive rebase..."),
                    async () =>
                        runInteractiveRebaseSubmission(
                            {
                                executor,
                                mutationGate,
                                storageRoot: context.globalStorageUri?.fsPath,
                                gitDir: directories.gitDir,
                                commonDir: directories.commonDir,
                                hasWholeIndexOperationInProgress: () =>
                                    gitOps.hasWholeIndexOperationInProgress(),
                                helperScriptPath: context.asAbsolutePath(
                                    "dist/interactive-rebase-editor-helper.cjs",
                                ),
                            },
                            result,
                        ),
                );
                await showInteractiveRebaseSubmissionRunResult(
                    runResult,
                    () => refreshService().refreshAll(),
                    {
                        forcePush: (manifest) =>
                            forcePushRebasedHead(
                                {
                                    executor,
                                    mutationGate,
                                    storageRoot: context.globalStorageUri?.fsPath ?? "",
                                    commonDir: directories.commonDir,
                                },
                                manifest,
                            ),
                        dismiss: (manifest) =>
                            dismissRebasePushOffer(
                                context.globalStorageUri?.fsPath ?? "",
                                manifest,
                            ),
                    },
                );
            } catch (error) {
                const message = getErrorMessage(error);
                console.error("Interactive rebase submission failed:", error);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Interactive rebase failed: {message}", { message }),
                );
            }
        };
    const handleRebaseDialogCancel =
        (originProvider: object) =>
        ({ requestId }: { requestId: string }) => {
            // An already-consumed request is a benign no-op, so its boolean result is intentionally ignored.
            rebaseSubmissionHandler.cancel({ requestId }, originProvider);
        };
    const handleRebaseControl = async ({
        action,
        repositoryRoot,
    }: {
        action: "continue" | "abort";
        repositoryRoot?: string;
    }): Promise<void> => {
        try {
            const repoRoot = repositoryRoot ?? getRepoRoot();
            const scopedGitOps = repoRoot === getRepoRoot() ? gitOps : gitOps.deriveFor(repoRoot);
            const scopedExecutor =
                repoRoot === getRepoRoot() ? executor : new GitExecutor(repoRoot, mutationGate);
            const directories = await scopedGitOps.getGitDirectories();
            const dependencies = {
                executor: scopedExecutor,
                mutationGate,
                storageRoot: context.globalStorageUri?.fsPath,
                gitDir: directories.gitDir,
                commonDir: directories.commonDir,
                helperScriptPath: context.asAbsolutePath(
                    "dist/interactive-rebase-editor-helper.cjs",
                ),
            };
            const result = await (action === "continue"
                ? continueInteractiveRebase(dependencies, repoRoot)
                : abortInteractiveRebase(dependencies, repoRoot));
            await showInteractiveRebaseControlResult(result, () => refreshService().refreshAll(), {
                forcePush: (manifest) =>
                    forcePushRebasedHead(
                        {
                            executor: scopedExecutor,
                            mutationGate,
                            storageRoot: context.globalStorageUri?.fsPath ?? "",
                            commonDir: directories.commonDir,
                        },
                        manifest,
                    ),
                dismiss: (manifest) =>
                    dismissRebasePushOffer(context.globalStorageUri?.fsPath ?? "", manifest),
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.error(`Interactive rebase ${action} failed:`, error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase failed: {message}", { message }),
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
        commitPanel.onRebaseControl(handleRebaseControl),
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        sidebarGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitPanel.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );
}

/**
 * Maps each host-side submission refusal to its message.
 *
 * Keying a `Record` by the reason union makes a newly added reason a compile-time error at this
 * table, replacing the `assertNever` default the previous `switch` needed. Every reason is decided
 * host-side by submission validation — the webview supplies entries, never the reason itself — so
 * no unvalidated value reaches this lookup.
 *
 * The messages are thunks because `vscode.l10n.t` resolves against the active bundle when it is
 * called, and this table is built at module load.
 */
const INTERACTIVE_REBASE_SUBMISSION_REJECTION_MESSAGES: Record<
    InteractiveRebaseSubmissionRejectionReason,
    () => string
> = {
    "unknown-or-expired": () => vscode.l10n.t("Interactive rebase dialog is no longer active."),
    "wrong-origin": () =>
        vscode.l10n.t("This interactive rebase dialog belongs to a different IntelliGit view."),
    "invalid-action": () => vscode.l10n.t("Interactive rebase contains an invalid action."),
    "invalid-hash": () => vscode.l10n.t("Interactive rebase contains an invalid commit hash."),
    "hash-not-offered": () =>
        vscode.l10n.t("Interactive rebase contains a commit that was not offered."),
    "duplicate-hash": () =>
        vscode.l10n.t("Interactive rebase contains the same commit more than once."),
    "entry-count-mismatch": () =>
        vscode.l10n.t("Interactive rebase changed the offered commit count."),
    "missing-message": () =>
        vscode.l10n.t("Interactive rebase requires a replacement message for this action."),
    "invalid-message": () =>
        vscode.l10n.t("Interactive rebase contains an invalid commit message."),
    "invalid-first-action": () =>
        vscode.l10n.t("Interactive rebase cannot start with squash or fixup."),
    "repo-changed": () =>
        vscode.l10n.t("The selected repository changed while the dialog was open."),
    "branch-unavailable": () =>
        vscode.l10n.t("Interactive rebase could not resolve the current branch."),
    "head-unavailable": () =>
        vscode.l10n.t("Interactive rebase could not resolve the current HEAD."),
    "branch-moved": () =>
        vscode.l10n.t("The checked-out branch changed while the dialog was open."),
    "head-moved": () => vscode.l10n.t("HEAD changed while the interactive rebase dialog was open."),
    "invalid-selected-hash": () =>
        vscode.l10n.t("Interactive rebase received an invalid selected commit."),
    "operation-in-progress": () =>
        vscode.l10n.t(
            "Interactive rebase cannot start while another Git operation is in progress.",
        ),
    "detached-head": () => vscode.l10n.t("Interactive rebase requires a checked-out branch."),
    "selected-merge-commit": () =>
        vscode.l10n.t("Interactive rebase is not available for merge commits."),
    "commit-not-ancestor": () =>
        vscode.l10n.t("The selected commit is not in the current branch history."),
    "initial-commit": () =>
        vscode.l10n.t("Interactive rebase is not available for the initial commit."),
    "working-tree-dirty": () => vscode.l10n.t("Interactive rebase requires a clean working tree."),
    "range-contains-merge-commit": () =>
        vscode.l10n.t("Interactive rebase is not available for ranges containing merge commits."),
    "git-error": () => vscode.l10n.t("Interactive rebase could not inspect the repository."),
};

/** Shows the distinct host-side reason an interactive-rebase dialog submission was refused. */
export function showInteractiveRebaseSubmissionRejection(
    reason: InteractiveRebaseSubmissionRejectionReason,
): void {
    vscode.window.showErrorMessage(INTERACTIVE_REBASE_SUBMISSION_REJECTION_MESSAGES[reason]());
}

/** Shows the truthful terminal or paused outcome of an interactive-rebase run. */
export async function showInteractiveRebaseSubmissionRunResult(
    result: import("../git/interactiveRebase/types").InteractiveRebaseRunResult,
    refresh: () => Promise<void>,
    pushOfferActions: {
        forcePush: (
            manifest: import("../git/interactiveRebase/types").RebaseSessionManifest,
        ) => Promise<import("../git/interactiveRebase/push").RebaseForcePushResult>;
        dismiss: (
            manifest: import("../git/interactiveRebase/types").RebaseSessionManifest,
        ) => Promise<void>;
    },
): Promise<void> {
    switch (result.status) {
        case "completed":
            await refresh();
            await vscode.window.showInformationMessage(
                vscode.l10n.t("Interactive rebase completed."),
            );
            return;
        case "completed-with-local-state-warning":
            await refresh();
            await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Interactive rebase completed, but IntelliGit could not save its local completion state.",
                ),
            );
            return;
        case "completed-pending-push": {
            await refresh();
            const forcePush = vscode.l10n.t("Force Push");
            const dismiss = vscode.l10n.t("Dismiss");
            const action = await vscode.window.showWarningMessage(
                vscode.l10n.t("Interactive rebase completed. Force-push the rewritten commits?"),
                forcePush,
                dismiss,
            );
            if (action === dismiss) {
                await pushOfferActions.dismiss(result.manifest);
                return;
            }
            if (action !== forcePush) return;
            const pushResult = await pushOfferActions.forcePush(result.manifest);
            if (pushResult.status === "pushed") {
                // The push landed either way, so the outcome is never reported as a failure. A
                // retained offer still resurfaces on the next reload, and saying so here is the
                // only way the user learns that reappearance is bookkeeping, not a missed push.
                await (pushResult.offerRetained
                    ? vscode.window.showWarningMessage(
                          vscode.l10n.t(
                              "Force push completed, but its pending offer could not be cleared and may reappear.",
                          ),
                      )
                    : vscode.window.showInformationMessage(vscode.l10n.t("Force push completed.")));
                await refresh();
                return;
            }
            if (pushResult.status === "branch-moved" || pushResult.status === "head-moved") {
                await vscode.window.showWarningMessage(
                    vscode.l10n.t("The branch moved since the rebase — push manually."),
                );
                return;
            }
            if (pushResult.status === "failed") {
                await vscode.window.showErrorMessage(
                    vscode.l10n.t("Force push failed: {message}", { message: pushResult.message }),
                );
                return;
            }
            return assertNeverForcePushResult(pushResult);
        }
        case "guard-rejected":
            // The in-gate re-check found the same condition the up-front guard reports, so the
            // user gets the same remedy text rather than a second vocabulary for one problem.
            showInteractiveRebaseSubmissionRejection(result.reason);
            return;
        case "paused-conflict":
            await vscode.window.showWarningMessage(
                vscode.l10n.t("Rebase paused on conflict — resolve, then Continue."),
            );
            return;
        case "paused-helper-stop":
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Rebase editor stopped: {message}", { message: result.stderr }),
            );
            return;
        case "failed":
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Interactive rebase failed: {message}", {
                    message: interactiveRebaseRunFailureMessage(result),
                }),
            );
            return;
        default:
            return assertNeverInteractiveRebaseRunResult(result);
    }
}

/**
 * Reports every Continue/Abort outcome and refreshes the affected repository before returning.
 *
 * Each outcome refreshes once. The exception is a retained completed manifest, which is delegated
 * whole to the existing pinned post-rebase force-push offer: that flow refreshes at two points the
 * user can distinguish — the finished rebase, then the landed push — and owns both itself.
 */
export async function showInteractiveRebaseControlResult(
    result: InteractiveRebaseControlResult,
    refresh: () => Promise<void>,
    pushOfferActions: {
        forcePush: (
            manifest: RebaseSessionManifest,
        ) => Promise<import("../git/interactiveRebase/push").RebaseForcePushResult>;
        dismiss: (manifest: RebaseSessionManifest) => Promise<void>;
    },
): Promise<void> {
    let refreshed = false;
    const refreshOnce = async (): Promise<void> => {
        if (refreshed) return;
        refreshed = true;
        await refresh();
    };
    try {
        switch (result.status) {
            case "no-rebase-in-progress":
                await vscode.window.showWarningMessage(
                    vscode.l10n.t("No interactive rebase is in progress."),
                );
                return;
            case "foreign-continue-refused":
                await vscode.window.showWarningMessage(
                    vscode.l10n.t("Another tool owns this rebase. IntelliGit cannot continue it."),
                );
                return;
            case "continued":
                await vscode.window.showInformationMessage(
                    vscode.l10n.t("Interactive rebase continued."),
                );
                return;
            case "aborted":
                await vscode.window.showInformationMessage(
                    vscode.l10n.t("Interactive rebase aborted."),
                );
                return;
            case "completed":
                await refreshOnce();
                await vscode.window.showInformationMessage(
                    vscode.l10n.t("Interactive rebase completed."),
                );
                return;
            case "completed-with-local-state-warning":
                await refreshOnce();
                await vscode.window.showWarningMessage(
                    vscode.l10n.t(
                        "Interactive rebase completed, but IntelliGit could not save its local completion state.",
                    ),
                );
                return;
            case "completed-pending-push":
                // The offer refreshes twice on purpose — once before it is shown, once after a
                // push lands — so it receives the unguarded refresh and owns its own bookkeeping.
                // Collapsing those into one would leave the panel showing the pre-push branch
                // state after the push had already succeeded.
                refreshed = true;
                await showInteractiveRebaseSubmissionRunResult(result, refresh, pushOfferActions);
                return;
            case "paused-conflict":
                await vscode.window.showWarningMessage(
                    vscode.l10n.t("Rebase paused on conflict — resolve, then Continue."),
                );
                return;
            case "paused-helper-stop":
                await vscode.window.showErrorMessage(
                    vscode.l10n.t("Rebase editor stopped: {message}", { message: result.stderr }),
                );
                return;
            case "failed":
                await vscode.window.showErrorMessage(
                    result.reason === "git-failed"
                        ? vscode.l10n.t("Git could not complete the rebase: {message}", {
                              message: result.message,
                          })
                        : vscode.l10n.t(
                              "Rebase ownership changed while the action was running: {message}",
                              { message: result.message },
                          ),
                );
                return;
            default:
                return assertNeverInteractiveRebaseControlResult(result);
        }
    } finally {
        await refreshOnce();
    }
}

/** Maps runner failure reasons to user-facing detail without inventing a recovery state. */
function interactiveRebaseRunFailureMessage(
    result: Extract<
        import("../git/interactiveRebase/types").InteractiveRebaseRunResult,
        { status: "failed" }
    >,
): string {
    switch (result.reason) {
        case "storage-unavailable":
            return vscode.l10n.t("Extension storage is unavailable.");
        case "editor-helper-missing":
            return vscode.l10n.t("The interactive rebase editor helper is missing.");
        case "reservation-exists":
            return vscode.l10n.t("Another interactive rebase is already reserved.");
        case "rebase-in-progress":
            return vscode.l10n.t("A Git rebase is already in progress.");
        case "branch-moved":
            return vscode.l10n.t("The checked-out branch changed before the rebase started.");
        case "head-moved":
            return vscode.l10n.t("HEAD changed before the rebase started.");
        case "rebase-failed":
            return vscode.l10n.t("Git stopped without leaving a resumable rebase.");
        case "unexpected-error":
            return result.message ?? vscode.l10n.t("An unexpected error occurred.");
    }
}

/** Makes a newly added force-push outcome a compile-time exhaustiveness error. */
function assertNeverForcePushResult(result: never): never {
    void result;
    throw new Error("Unhandled interactive rebase force-push result.");
}

/** Makes a newly added control outcome a compile-time exhaustiveness error. */
function assertNeverInteractiveRebaseControlResult(result: never): never {
    void result;
    throw new Error("Unhandled interactive rebase control result.");
}

/** Makes a newly added runner outcome a compile-time exhaustiveness error. */
function assertNeverInteractiveRebaseRunResult(result: never): never {
    void result;
    throw new Error("Unhandled interactive rebase run result.");
}
