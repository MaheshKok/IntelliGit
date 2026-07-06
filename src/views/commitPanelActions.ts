import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { promptRebaseAfterPushRejection } from "../services/gitHelpers";
import {
    runWithNotificationProgress,
    showTimedWarningMessage,
    showTimedInformationMessage,
} from "../utils/notifications";

interface CommitPanelActionDeps {
    gitOps: GitOps;
    refreshData: () => Promise<void>;
    refreshGraphData?: () => Promise<void>;
    fireWorkingTreeChanged: () => void;
    postCommitted: () => void;
    maybeOfferPublishBranch: () => Promise<void>;
}

/**
 * Git operation identifiers accepted from the Changes toolbar.
 *
 * `fetch` updates remote-tracking refs, `pull` rebases the current branch onto its upstream,
 * `push` sends local commits to the upstream, and `sync` runs pull-rebase followed by push.
 */
export type CommitPanelGitOperation = "fetch" | "pull" | "push" | "sync";

/** Returns whether the current local branch has already been published upstream. */
async function currentBranchIsPublished(gitOps: GitOps): Promise<boolean> {
    const branches = await gitOps.getBranches();
    const currentBranch = branches.find((branch) => branch.isCurrent && !branch.isRemote);
    return currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0;
}

/** Warns when repository-modifying actions should wait for a clean working tree. */
async function warnIfUncommittedChanges(gitOps: GitOps): Promise<boolean> {
    if (!(await gitOps.hasUncommittedChanges())) return false;
    showTimedWarningMessage(
        vscode.l10n.t("There are uncommitted changes, please commit or stash them first."),
    );
    return true;
}

/**
 * Commits the validated subset of selected Changes-panel files and optionally pushes it.
 *
 * Callers must pass repository-relative paths that have already crossed the webview validation
 * boundary. The action stages those paths, warns on missing commit input, retries push rejection via
 * the rebase prompt, and refreshes panel/working-tree state only after a successful commit path.
 */
export async function commitSelectedFromPanel(
    deps: CommitPanelActionDeps,
    options: { message: string; amend: boolean; push: boolean; paths: string[] },
): Promise<void> {
    const { gitOps, refreshData, fireWorkingTreeChanged, postCommitted } = deps;
    const { message, amend, push, paths } = options;
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    if (paths.length === 0 && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Select files to commit."));
        return;
    }
    if (paths.length > 0) {
        await gitOps.stageFiles(paths);
    }
    const progressTitle = push
        ? vscode.l10n.t("Committing and pushing...")
        : vscode.l10n.t("Committing...");
    await runWithNotificationProgress(progressTitle, async () => {
        await gitOps.commit(message, amend);
    });
    if (push) {
        try {
            await runGitOperationFromPanel(deps, "push");
        } catch (err) {
            postCommitted();
            await refreshData();
            fireWorkingTreeChanged();
            throw err;
        }
        postCommitted();
    } else {
        showTimedInformationMessage(vscode.l10n.t("Committed successfully."));
        postCommitted();
        await refreshData();
        fireWorkingTreeChanged();
    }
}

/**
 * Runs the commit-only button action for the current Changes-panel repository.
 *
 * The helper owns user-facing validation for empty messages, progress notification, success UI,
 * draft reset signaling, panel refresh, and working-tree change notification.
 */
export async function commitOnlyFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    await runWithNotificationProgress(vscode.l10n.t("Committing..."), async () => {
        await deps.gitOps.commit(message, amend);
    });
    showTimedInformationMessage(vscode.l10n.t("Committed successfully."));
    deps.postCommitted();
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Commits the current panel changes and pushes the active branch with push-rejection recovery.
 *
 * Rebase retry prompts are handled here so both docked and undocked panels surface the same UX;
 * unrecovered errors are rethrown for the provider message handler to report to the webview.
 */
export async function commitAndPushFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    await runWithNotificationProgress(vscode.l10n.t("Committing and pushing..."), async () => {
        await deps.gitOps.commit(message, amend);
    });
    await runGitOperationFromPanel(deps, "push");
    deps.postCommitted();
}

/**
 * Runs a top-level Git operation requested from the Changes toolbar.
 *
 * The caller supplies `gitOps` for Git I/O, `refreshData` for the Changes snapshot,
 * optional `refreshGraphData` for the embedded graph, and `fireWorkingTreeChanged` for
 * extension listeners that react to repository updates. On success, the panel shows the
 * operation-specific completion message, refreshes panel data, refreshes graph data when
 * available, and fires the working-tree change event.
 *
 * `fetch` updates remote-tracking refs only, `pull` runs `pull --rebase`, `push` pushes the
 * current branch, and `sync` always runs pull-rebase before push. Git failures are rethrown
 * except rejected `push` or `sync` operations may prompt for a rebase retry through
 * `promptRebaseAfterPushRejection`.
 */
export async function runGitOperationFromPanel(
    deps: Pick<
        CommitPanelActionDeps,
        "gitOps" | "refreshData" | "refreshGraphData" | "fireWorkingTreeChanged"
    >,
    operation: CommitPanelGitOperation,
): Promise<void> {
    if (
        (operation === "pull" || operation === "sync") &&
        (await warnIfUncommittedChanges(deps.gitOps))
    ) {
        return;
    }

    if (!(await currentBranchIsPublished(deps.gitOps))) {
        if (operation === "push") {
            // Publishing must finish before commit-panel and graph refresh read branch state.
            // react-doctor-disable-next-line react-doctor/async-parallel
            await vscode.commands.executeCommand("intelligit.publishBranch");
            await deps.refreshData();
            await deps.refreshGraphData?.();
            deps.fireWorkingTreeChanged();
            return;
        }
        if (operation === "pull" || operation === "sync") {
            showTimedWarningMessage(vscode.l10n.t("The repo has not been published yet."));
            return;
        }
    }

    const labels = {
        fetch: {
            progress: vscode.l10n.t("Fetching..."),
            success: vscode.l10n.t("Fetched successfully."),
        },
        pull: {
            progress: vscode.l10n.t("Pulling..."),
            success: vscode.l10n.t("Pulled successfully."),
        },
        push: {
            progress: vscode.l10n.t("Pushing..."),
            success: vscode.l10n.t("Pushed successfully."),
        },
        sync: {
            progress: vscode.l10n.t("Syncing..."),
            success: vscode.l10n.t("Synced successfully."),
        },
    }[operation];

    try {
        await runWithNotificationProgress(labels.progress, async () => {
            if (operation === "fetch") {
                await deps.gitOps.fetch();
            } else if (operation === "pull") {
                await deps.gitOps.pullRebase();
            } else if (operation === "push") {
                await deps.gitOps.push();
            } else {
                await deps.gitOps.pullRebase();
                await deps.gitOps.push();
            }
        });
    } catch (err) {
        if (
            (operation === "push" || operation === "sync") &&
            (await promptRebaseAfterPushRejection(err, deps.gitOps, async () => {
                await deps.gitOps.push();
            }))
        ) {
            showTimedInformationMessage(labels.success);
            await deps.refreshData();
            await deps.refreshGraphData?.();
            deps.fireWorkingTreeChanged();
            return;
        }
        throw err;
    }

    showTimedInformationMessage(labels.success);
    await deps.refreshData();
    await deps.refreshGraphData?.();
    deps.fireWorkingTreeChanged();
}

/**
 * Prompts before rolling back selected paths or the entire working tree from the panel.
 *
 * An empty path list intentionally means “rollback all changes.” Path values must already be
 * validated by the caller before this destructive Git operation is offered to the user.
 */
export async function rollbackFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    paths: string[],
): Promise<void> {
    const rollbackAction = vscode.l10n.t("Rollback");
    if (paths.length === 0) {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback all changes?"),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackAll();
    } else {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback {count} file(s)?", { count: paths.length }),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackFiles(paths);
    }
    showTimedInformationMessage(vscode.l10n.t("Changes rolled back."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Saves the current or selected working-tree changes to a stash entry from the panel.
 *
 * The caller supplies the UI-derived stash name and already validated optional paths; this helper
 * owns the success notification plus follow-up refresh/change events after Git mutates the stash.
 */
export async function stashSaveFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    options: { name: string; paths?: string[] },
): Promise<void> {
    await deps.gitOps.stashSave(options.paths, options.name);
    showTimedInformationMessage(vscode.l10n.t("Changes stashed."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Applies, pops, or deletes a stash entry selected in the panel.
 *
 * Delete requests require a modal confirmation because they discard the saved stash entry, while
 * apply/pop immediately mutate the working tree and then refresh both panel and host state.
 */
export async function stashMutationFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    action: "pop" | "apply" | "delete",
    index: number,
): Promise<void> {
    if (action === "delete") {
        const deleteAction = vscode.l10n.t("Delete");
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Delete this stashed change?"),
            { modal: true },
            deleteAction,
        );
        if (confirm !== deleteAction) return;
        await deps.gitOps.stashDelete(index);
        showTimedInformationMessage(vscode.l10n.t("Stashed change deleted."));
    } else if (action === "pop") {
        try {
            await deps.gitOps.stashPop(index);
        } catch (err) {
            const conflicts = await deps.gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) throw err;
            await deps.refreshData();
            deps.fireWorkingTreeChanged();
            await vscode.commands.executeCommand("intelligit.openConflictSession");
            return;
        }
        showTimedInformationMessage(vscode.l10n.t("Unstashed changes."));
    } else {
        try {
            await deps.gitOps.stashApply(index);
        } catch (err) {
            const conflicts = await deps.gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) throw err;
            await deps.refreshData();
            deps.fireWorkingTreeChanged();
            await vscode.commands.executeCommand("intelligit.openConflictSession");
            return;
        }
        showTimedInformationMessage(vscode.l10n.t("Applied stashed changes."));
    }
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}
