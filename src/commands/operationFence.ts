import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import type { CommitAction } from "../webviews/protocol/commitGraphTypes";

/**
 * Exhaustive operation-fence decision for each supported commit context-menu action.
 *
 * Adding a protocol action requires an explicit decision here so it cannot silently bypass the
 * whole-index-operation fence.
 */
export const COMMIT_ACTION_FENCE_DECISIONS = {
    copyRevision: false,
    createPatch: false,
    cherryPick: true,
    checkoutRevision: true,
    resetCurrentToHere: true,
    revertCommit: true,
    pushAllUpToHere: false,
    undoCommit: true,
    editCommitMessage: true,
    squashCommits: true,
    dropCommit: true,
    interactiveRebaseFromHere: true,
    newBranch: false,
    newTag: false,
} satisfies Record<CommitAction, boolean>;

/**
 * Explicit operation-fence decision for every command registered by the branch command factory.
 *
 * Unknown command IDs deliberately fall through to the fence so new mutations cannot silently
 * bypass the active-operation guard. The value type admits `undefined` to keep that lookup honest:
 * `strict` alone does not enable `noUncheckedIndexedAccess`, so a plain `Record<string, boolean>`
 * would type an unknown-ID lookup as `boolean` and make the fail-closed branch read as dead code.
 */
export const BRANCH_COMMAND_FENCE_DECISIONS: Readonly<Record<string, boolean | undefined>> = {
    "intelligit.checkout": true,
    "intelligit.checkoutAndRebase": true,
    "intelligit.rebaseCurrentOnto": true,
    "intelligit.mergeIntoCurrent": true,
    "intelligit.updateBranch": true,
    "intelligit.renameBranch": true,
    "intelligit.deleteBranch": true,
    "intelligit.deleteBranches": true,
    "intelligit.openWorktree": false,
    "intelligit.createWorktreeFromBranch": false,
    "intelligit.worktree.create": false,
    "intelligit.newBranchFrom": false,
    "intelligit.pushBranch": false,
};

/**
 * Reports an active whole-index Git operation and returns whether dispatch must stop.
 *
 * The operation probe is deliberately fail-closed: a failed marker check cannot be treated as a
 * clear repository because a history mutation could corrupt the active operation.
 *
 * @returns Whether the caller must stop dispatching the action.
 */
export async function rejectWhenOperationInProgress(
    gitOps: Pick<GitOps, "getActiveOperation">,
): Promise<boolean> {
    try {
        const activeOperation = await gitOps.getActiveOperation();
        switch (activeOperation) {
            case "none":
                return false;
            case "rebase":
                vscode.window.showErrorMessage(
                    vscode.l10n.t("A rebase is in progress — continue or abort it first."),
                );
                return true;
            case "merge":
                vscode.window.showErrorMessage(
                    vscode.l10n.t("A merge is in progress — resolve or abort it first."),
                );
                return true;
            case "cherry-pick":
                vscode.window.showErrorMessage(
                    vscode.l10n.t("A cherry-pick is in progress — continue or abort it first."),
                );
                return true;
            case "revert":
                vscode.window.showErrorMessage(
                    vscode.l10n.t("A revert is in progress — continue or abort it first."),
                );
                return true;
        }
        // An operation kind this fence does not recognize is refused through the same failure
        // path as an unreadable probe. Falling out of the switch would return `undefined`, which
        // the dispatcher reads as "not refused" — a fail-open exit from a fail-closed contract.
        throw new Error(`Unhandled active operation: ${String(activeOperation)}`);
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Unable to check whether a Git operation is in progress. Try again before changing history.",
            ),
        );
        return true;
    }
}

/**
 * Refuses a fenced commit action while another whole-index Git operation controls the repository.
 *
 * The operation probe is deliberately fail-closed: a failed marker check cannot be treated as a
 * clear repository because a history mutation could corrupt the active operation.
 *
 * @returns Whether the caller must stop dispatching the action.
 */
export async function rejectCommitActionWhenOperationInProgress(
    action: CommitAction,
    gitOps: Pick<GitOps, "getActiveOperation">,
): Promise<boolean> {
    if (!COMMIT_ACTION_FENCE_DECISIONS[action]) return false;

    return rejectWhenOperationInProgress(gitOps);
}
