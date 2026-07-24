import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { promptRebaseAfterPushRejection } from "../services/gitHelpers";
import { assertValidBranchName } from "../utils/gitRefs";
import { assertRepoRelativePath } from "../utils/fileOps";
import { assertStashIndex } from "../git/operationSupport";
import { assertNumber, assertString } from "./messageValidation";
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
    postCommitted: () => void | Promise<void>;
    maybeOfferPublishBranch: () => Promise<void>;
    publishBranch?: () => Promise<void>;
}

/** Describes one validated stash mutation initiated by either commit-panel provider. */
export type StashMutation =
    | { action: "apply" | "pop"; index: number; reinstateIndex: boolean }
    | { action: "branch"; index: number; branchName: string }
    | { action: "cherryPickFile"; index: number; stashHash: string; path: string }
    | { action: "delete"; index: number }
    | { action: "clear" };

/** Validates a typed single-file stash request before any repository mutation begins. */
function stashFileMutationFromMessage(
    message: Record<string, unknown>,
): Extract<StashMutation, { action: "cherryPickFile" }> {
    const index = assertNumber(message.index, "index");
    assertStashIndex(index);
    const stashHash = assertString(message.stashHash, "stashHash").trim();
    if (!/^[0-9a-fA-F]{40}$/.test(stashHash)) {
        throw new Error("Invalid stash hash received from webview.");
    }
    const path = assertRepoRelativePath(assertString(message.path, "path"));
    return { action: "cherryPickFile", index, stashHash, path };
}

/**
 * Validates an untrusted typed unstash payload and translates it into a host mutation.
 *
 * Current-branch mode accepts only apply/pop plus an explicit index-restoration flag. Branch mode
 * validates the new branch name and rejects an independent index-restoration option because
 * `git stash branch` restores the index by definition.
 */
export function stashMutationFromUnstashMessage(message: Record<string, unknown>): StashMutation {
    const index = assertNumber(message.index, "index");
    if (message.mode === "currentBranch") {
        if (message.action !== "apply" && message.action !== "pop") {
            throw new Error("Invalid stash unstash action received from webview.");
        }
        if (typeof message.reinstateIndex !== "boolean") {
            throw new Error("Expected boolean for 'reinstateIndex'.");
        }
        return {
            action: message.action,
            index,
            reinstateIndex: message.reinstateIndex,
        };
    }
    if (message.mode !== "branch") {
        throw new Error("Invalid stash unstash mode received from webview.");
    }
    if ("reinstateIndex" in message) {
        throw new Error("Branch stash unstash cannot set 'reinstateIndex'.");
    }
    const branchName = assertString(message.branchName, "branchName");
    assertValidBranchName(branchName);
    return { action: "branch", index, branchName };
}

/**
 * Executes one optionally correlated stash mutation and always posts its completion acknowledgement.
 *
 * Request IDs cross the untrusted webview boundary here. Missing IDs preserve legacy behavior;
 * present IDs must be non-empty strings and are echoed exactly once from an outer `finally`, after
 * mutation confirmation, conflict handling, and refresh have either completed or thrown.
 */
export async function executeStashMutationRequest(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutation: StashMutation,
    requestIdValue: unknown,
    postCompleted: (requestId: string) => void,
): Promise<void> {
    const requestId =
        requestIdValue === undefined ? undefined : assertString(requestIdValue, "requestId");
    if (requestId !== undefined && requestId.trim().length === 0) {
        throw new Error("Expected non-empty string for 'requestId'.");
    }
    try {
        await stashMutationFromPanel(deps, mutation);
    } finally {
        if (requestId !== undefined) postCompleted(requestId);
    }
}

/**
 * Validates and executes a correlated single-file stash request.
 *
 * Payload validation stays inside the completion `finally`, ensuring malformed or stale requests
 * clear webview pending state without allowing an invalid index, hash, or path to reach Git.
 */
export async function executeStashFileMutationRequest(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    message: Record<string, unknown>,
    postCompleted: (requestId: string) => void,
): Promise<void> {
    const requestId = assertString(message.requestId, "requestId");
    if (requestId.trim().length === 0) {
        throw new Error("Expected non-empty string for 'requestId'.");
    }
    try {
        await stashMutationFromPanel(deps, stashFileMutationFromMessage(message));
    } finally {
        postCompleted(requestId);
    }
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
            await postCommitted();
            await refreshData();
            fireWorkingTreeChanged();
            throw err;
        }
        await postCommitted();
    } else {
        showTimedInformationMessage(vscode.l10n.t("Committed successfully."));
        await postCommitted();
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
    await deps.postCommitted();
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
    try {
        await runGitOperationFromPanel(deps, "push");
    } catch (error) {
        await deps.postCommitted();
        throw error;
    }
    await deps.postCommitted();
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
        "gitOps" | "refreshData" | "refreshGraphData" | "fireWorkingTreeChanged" | "publishBranch"
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
            await (deps.publishBranch?.() ??
                vscode.commands.executeCommand("intelligit.publishBranch"));
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
 * Runs a stash mutation and opens the merge session when Git leaves conflict markers behind.
 */
async function runStashMutationWithConflicts(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutate: () => Promise<unknown>,
): Promise<boolean> {
    try {
        await mutate();
        return false;
    } catch (err) {
        const conflicts = await deps.gitOps.getConflictFilesDetailed();
        if (conflicts.length === 0) throw err;
        await vscode.commands.executeCommand("intelligit.openConflictSession");
        return true;
    }
}

/**
 * Applies, pops, branches, deletes, or clears stashes selected in the panel.
 *
 * Destructive requests require a modal confirmation. Every attempt refreshes stash data in `finally`
 * so both providers clear their busy state even after cancellation, conflict, or failure; only actions
 * that changed the working tree notify working-tree listeners.
 */
export async function stashMutationFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutation: StashMutation,
): Promise<void> {
    let workingTreeChanged = false;
    try {
        if (mutation.action === "delete") {
            const deleteAction = vscode.l10n.t("Delete");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Delete this stashed change?"),
                { modal: true },
                deleteAction,
            );
            if (confirm !== deleteAction) return;
            await deps.gitOps.stashDelete(mutation.index);
            showTimedInformationMessage(vscode.l10n.t("Stashed change deleted."));
            return;
        }
        if (mutation.action === "clear") {
            const clearAction = vscode.l10n.t("Clear All Stashes");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Clear all stashes? This is irreversible and may prevent recovery of saved work.",
                ),
                { modal: true },
                clearAction,
            );
            if (confirm !== clearAction) return;
            await deps.gitOps.stashClear();
            showTimedInformationMessage(vscode.l10n.t("All stashed changes cleared."));
            return;
        }
        if (mutation.action === "cherryPickFile") {
            const applyAction = vscode.l10n.t("Apply Change");
            const short = vscode.l10n.t("Stash {reference}", {
                reference: `{${mutation.index}}`,
            });
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Apply the change from {short} for {path} to your working tree and stage it?",
                    { short, path: mutation.path },
                ),
                { modal: true },
                applyAction,
            );
            if (confirm !== applyAction) return;
            const conflicted = await runStashMutationWithConflicts(deps, () =>
                deps.gitOps.applyStashFile(mutation.index, mutation.stashHash, mutation.path),
            );
            workingTreeChanged = true;
            if (conflicted) return;
            showTimedInformationMessage(
                vscode.l10n.t("Applied selected change from {short} for {path}.", {
                    short,
                    path: mutation.path,
                }),
            );
            return;
        }

        const conflicted =
            mutation.action === "branch"
                ? await runStashMutationWithConflicts(deps, () =>
                      deps.gitOps.stashBranch(mutation.branchName, mutation.index),
                  )
                : await runStashMutationWithConflicts(deps, () =>
                      mutation.action === "pop"
                          ? mutation.reinstateIndex
                              ? deps.gitOps.stashPop(mutation.index, true)
                              : deps.gitOps.stashPop(mutation.index)
                          : mutation.reinstateIndex
                            ? deps.gitOps.stashApply(mutation.index, true)
                            : deps.gitOps.stashApply(mutation.index),
                  );
        workingTreeChanged = true;
        if (conflicted) return;
        if (mutation.action === "branch") {
            showTimedInformationMessage(vscode.l10n.t("Stashed changes restored on new branch."));
        } else if (mutation.action === "pop") {
            showTimedInformationMessage(vscode.l10n.t("Unstashed changes."));
        } else {
            showTimedInformationMessage(vscode.l10n.t("Applied stashed changes."));
        }
    } finally {
        await deps.refreshData();
        if (workingTreeChanged) deps.fireWorkingTreeChanged();
    }
}
