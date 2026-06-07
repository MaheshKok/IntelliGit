// Branch action command handlers extracted from extension.ts.
// Each handler corresponds to a right-click action on a branch
// in the branch column: checkout, rebase, merge, push, delete, etc.

import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps, UpstreamPushDeclinedError } from "../git/operations";
import type { Branch } from "../types";
import { getErrorMessage, isBranchNotFullyMergedError } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import {
    checkoutBranch,
    getCheckedOutBranchName,
    getLocalBranchMergeStatusForDelete,
    isValidBranchName,
    promptRebaseAfterPushRejection,
    resolveRemoteDeleteTarget,
    resolveRemoteName,
    resolveTrackedRemoteBranch,
    showDeletedBranchActions,
} from "../services/gitHelpers";
import { assertValidBranchName, assertValidRemoteName } from "../utils/gitRefs";

/**
 * Runtime services captured by branch context-menu command handlers.
 *
 * All callbacks must target the active repository for the branch tree being registered. The
 * generated handlers rely on the branch snapshot providers for current/upstream checks and use the
 * conflict callbacks only after merge/update operations leave unresolved files.
 */
export interface BranchCommandDeps {
    executor: GitExecutor;
    gitOps: GitOps;
    getCurrentBranchName: () => string | undefined;
    getCurrentBranches: () => Branch[];
    openConflictSession: (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }) => Promise<void>;
    refreshConflictUi: () => Promise<void>;
}

/**
 * VS Code command contribution paired with the branch tree item payload it expects.
 *
 * `id` must stay in sync with package command contributions and activation registration. Handlers
 * tolerate missing branch payloads because VS Code can invoke commands from palettes or stale menus.
 */
export interface BranchCommandEntry {
    id: string;
    handler: (item: { branch?: Branch }) => Promise<void>;
}

const PYCHARM_MERGE_CONFIG_ARGS = [
    "-c",
    "credential.helper=",
    "-c",
    "core.quotepath=false",
    "-c",
    "log.showSignature=false",
];

function buildTrackedRemoteRef(tracked: { remote: string; remoteBranch: string }): string {
    return `${tracked.remote}/${tracked.remoteBranch}`;
}

/**
 * Builds the merge invocation used by the PyCharm-style Update Branch action.
 *
 * The command intentionally disables credential helpers and Git quoting noise for this one merge so
 * update errors can be compacted into user-facing VS Code messages without changing repository
 * configuration.
 */
function buildPycharmMergeArgs(remoteRef: string): string[] {
    return [...PYCHARM_MERGE_CONFIG_ARGS, "merge", remoteRef, "--no-stat", "-v"];
}

/**
 * Normalizes Git update failures before they are shown in VS Code error notifications.
 *
 * Fast-forward divergence is rewritten to the actionable IntelliGit message; other Git stderr is
 * compacted so fetch progress and hints do not overwhelm the branch action error toast.
 */
function formatUpdateFailureMessage(error: unknown): string {
    const raw = getErrorMessage(error);
    if (isFastForwardDivergenceMessage(raw)) {
        return vscode.l10n.t(
            "The local and remote branches have diverged. Merge or rebase the tracked remote branch, then try again.",
        );
    }
    return compactGitErrorMessage(raw);
}

function isFastForwardDivergenceMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("diverging branches") ||
        lower.includes("not possible to fast-forward") ||
        lower.includes("non-fast-forward")
    );
}

function compactGitErrorMessage(message: string): string {
    const compact = message
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => {
            if (!line) return false;
            if (line.startsWith("hint:")) return false;
            if (line.startsWith("From ")) return false;
            if (/^\*\s+branch\s+.+->\s+FETCH_HEAD$/i.test(line)) return false;
            return true;
        })
        .map((line) => line.replace(/^(fatal|error):\s*/i, ""))
        .join(" ")
        .trim();
    return compact || message.trim();
}

/**
 * Validates a branch ref before a handler passes it to Git and reports failures through VS Code UI.
 *
 * Returning `false` is the handler contract: invalid context-menu data should cancel the action
 * without throwing past command registration.
 */
function validateBranchArg(name: string, label: string = "branch name"): boolean {
    try {
        assertValidBranchName(name, label);
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(getErrorMessage(err));
        return false;
    }
}

/**
 * Validates a remote/branch pair that will be interpolated into fetch, push, or delete arguments.
 *
 * Validation failures are shown to the user and converted to `false` so branch commands can stop
 * before mutating remotes or local refs.
 */
function validateTrackedRemote(tracked: { remote: string; remoteBranch: string }): boolean {
    try {
        assertValidRemoteName(tracked.remote);
        assertValidBranchName(tracked.remoteBranch, "remote branch name");
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(getErrorMessage(err));
        return false;
    }
}

/**
 * Extracts the trusted branch list from the bulk-delete command payload.
 *
 * The command is callable from webviews, tests, and command palette plumbing, so it treats
 * the payload as untrusted until the array shape, branch names, and current-branch invariants
 * are checked by the command handler.
 */
function assertBranchListPayload(payload: unknown): Branch[] {
    const rawBranches = Array.isArray(payload)
        ? payload
        : ((payload as { branches?: unknown; branchNames?: unknown } | undefined)?.branches ??
          (payload as { branchNames?: unknown } | undefined)?.branchNames);
    if (!Array.isArray(rawBranches)) return [];
    return rawBranches
        .map((branch): Branch | undefined => {
            if (typeof branch === "string") {
                return {
                    name: branch,
                    hash: "",
                    isRemote: false,
                    isCurrent: false,
                    ahead: 0,
                    behind: 0,
                };
            }
            if (!branch || typeof branch !== "object") return undefined;
            return typeof (branch as Branch).name === "string" ? (branch as Branch) : undefined;
        })
        .filter((branch): branch is Branch => Boolean(branch));
}

/** Removes duplicate branch rows while preserving the user's selection order. */
function uniqueBranchesByName(branches: Branch[]): Branch[] {
    const seen = new Set<string>();
    const unique: Branch[] = [];
    for (const branch of branches) {
        if (seen.has(branch.name)) continue;
        seen.add(branch.name);
        unique.push(branch);
    }
    return unique;
}

/**
 * Checks merge safety for every local branch before bulk deletion mutates refs.
 *
 * Git's `branch -d` also enforces this, but preflighting the whole selection avoids deleting
 * earlier branches before discovering a later branch is unmerged.
 */
async function assertBulkBranchesMerged(
    executor: GitExecutor,
    branches: Branch[],
): Promise<string[]> {
    const unmerged: string[] = [];
    for (const branch of branches) {
        if (branch.isRemote) continue;
        try {
            await executor.run(["merge-base", "--is-ancestor", branch.name, "HEAD"]);
        } catch {
            unmerged.push(branch.name);
        }
    }
    return unmerged;
}

async function deleteBranchRef(executor: GitExecutor, branch: Branch): Promise<void> {
    if (branch.isRemote) {
        const target = resolveRemoteDeleteTarget(branch);
        if (!target) {
            throw new Error(
                vscode.l10n.t("unable to determine remote target for '{branch}'", {
                    branch: branch.name,
                }),
            );
        }
        await executor.run(["push", target.remote, "--delete", target.remoteBranch]);
        return;
    }
    await executor.run(["branch", "-d", branch.name]);
}

/**
 * Creates the branch tree command handlers registered by repository activation.
 *
 * The returned entries wire `intelligit.checkout`, `intelligit.newBranchFrom`,
 * `intelligit.checkoutAndRebase`, `intelligit.rebaseCurrentOnto`,
 * `intelligit.mergeIntoCurrent`, `intelligit.updateBranch`, `intelligit.pushBranch`,
 * `intelligit.renameBranch`, and `intelligit.deleteBranch`. Handlers require a branch payload from
 * the branch view and otherwise no-op.
 *
 * Successful branch mutations refresh IntelliGit views through `intelligit.refresh`. Git failures
 * are caught and shown as VS Code messages; merge/update conflicts open the Conflicts session and
 * refresh conflict UI instead of surfacing the raw merge error. The handlers can modify checked-out
 * branch state, local branch refs, remote refs, and working tree/index state for checkout, merge,
 * rebase, update, push, rename, and delete actions.
 */
export function createBranchCommands(deps: BranchCommandDeps): BranchCommandEntry[] {
    const {
        executor,
        gitOps,
        getCurrentBranchName,
        getCurrentBranches,
        openConflictSession,
        refreshConflictUi,
    } = deps;

    /**
     * Opens conflict UI for update/merge failures after Git has already reported conflicts.
     *
     * Inspection or UI-launch failures are swallowed so the original Git command can still surface
     * its normal error message through the caller.
     */
    const showUpdateConflictSession = async (sourceBranch?: string): Promise<boolean> => {
        try {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) return false;

            await openConflictSession({
                sourceBranch,
                targetBranch: getCurrentBranchName() || undefined,
            });
            await refreshConflictUi();
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Merge produced {count} unresolved conflict file(s). Opened Conflicts session.",
                    { count: conflicts.length },
                ),
            );
            return true;
        } catch {
            return false;
        }
    };

    return [
        {
            id: "intelligit.checkout",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                try {
                    const checkedOut = await checkoutBranch(branch, getCurrentBranches(), executor);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Checked out {branch}", { branch: checkedOut }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Checkout failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.newBranchFrom",
            handler: async (item) => {
                const base = item.branch?.name;
                if (!base) return;
                if (!validateBranchArg(base, "base branch name")) return;
                const newName = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t("New branch from {branch}", { branch: base }),
                    placeHolder: "branch-name",
                });
                if (!newName) return;
                if (!isValidBranchName(newName)) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            "Invalid branch name '{branch}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.",
                            { branch: newName },
                        ),
                    );
                    return;
                }
                try {
                    await executor.run(["checkout", "-b", newName, base]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Created and checked out {branch}", { branch: newName }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Failed to create branch: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.checkoutAndRebase",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const onto = getCurrentBranchName();
                if (!onto) {
                    vscode.window.showErrorMessage(vscode.l10n.t("No current branch found."));
                    return;
                }
                if (!validateBranchArg(onto, "current branch name")) return;
                try {
                    const checkedOut = await checkoutBranch(branch, getCurrentBranches(), executor);
                    if (checkedOut === onto) {
                        vscode.window.showInformationMessage(
                            vscode.l10n.t("{branch} is already the current branch.", {
                                branch: checkedOut,
                            }),
                        );
                        return;
                    }
                    await executor.run(["rebase", onto]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Checked out {branch} and rebased onto {onto}", {
                            branch: checkedOut,
                            onto,
                        }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Checkout and rebase failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.rebaseCurrentOnto",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                if (!validateBranchArg(name)) return;
                const rebaseLabel = vscode.l10n.t("Rebase");
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t("Rebase current branch onto {branch}?", { branch: name }),
                    { modal: true },
                    rebaseLabel,
                );
                if (confirm !== rebaseLabel) return;
                try {
                    await executor.run(["rebase", name]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Rebased onto {branch}", { branch: name }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Rebase failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.mergeIntoCurrent",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                if (!validateBranchArg(name)) return;
                const mergeLabel = vscode.l10n.t("Merge");
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t("Merge {branch} into current branch?", { branch: name }),
                    { modal: true },
                    mergeLabel,
                );
                if (confirm !== mergeLabel) return;
                try {
                    await executor.run(["merge", name]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Merged {branch}", { branch: name }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    try {
                        const conflicts = await gitOps.getConflictFilesDetailed();
                        if (conflicts.length > 0) {
                            await openConflictSession({
                                sourceBranch: name,
                                targetBranch: getCurrentBranchName() || undefined,
                            });
                            await refreshConflictUi();
                            vscode.window.showWarningMessage(
                                vscode.l10n.t(
                                    "Merge produced {count} unresolved conflict file(s). Opened Conflicts session.",
                                    { count: conflicts.length },
                                ),
                            );
                            return;
                        }
                    } catch {
                        // Fall back to merge error if conflict inspection/session launch fails.
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Merge failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.updateBranch",
            handler: async (item) => {
                const branch = item.branch;
                const name = branch?.name;
                if (!name || branch?.isRemote) return;
                if (!validateBranchArg(name)) return;
                const tracked = resolveTrackedRemoteBranch(branch, getCurrentBranches());
                if (tracked && !validateTrackedRemote(tracked)) return;
                const currentBranchName = getCurrentBranchName();
                const isSelectedBranchCurrent = branch.isCurrent || currentBranchName === name;
                const trackedRemoteRef = tracked ? buildTrackedRemoteRef(tracked) : undefined;
                let mergeAttempted = false;
                try {
                    await runWithNotificationProgress(
                        vscode.l10n.t("Updating {branch}...", { branch: name }),
                        async () => {
                            if (!tracked) {
                                throw new Error(
                                    vscode.l10n.t(
                                        "No tracked remote branch configured for '{branch}'.",
                                        { branch: name },
                                    ),
                                );
                            }

                            if (isSelectedBranchCurrent) {
                                await executor.run([
                                    "fetch",
                                    tracked.remote,
                                    "--recurse-submodules=no",
                                    "--progress",
                                    "--prune",
                                ]);
                                mergeAttempted = true;
                                await executor.run(
                                    buildPycharmMergeArgs(buildTrackedRemoteRef(tracked)),
                                );
                                return;
                            }

                            await executor.run([
                                "fetch",
                                tracked.remote,
                                `${tracked.remoteBranch}:${name}`,
                                "--recurse-submodules=no",
                                "--progress",
                                "--prune",
                            ]);
                        },
                    );
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Updated {branch}", { branch: name }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    if (
                        isSelectedBranchCurrent &&
                        mergeAttempted &&
                        (await showUpdateConflictSession(trackedRemoteRef))
                    ) {
                        return;
                    }
                    const msg = formatUpdateFailureMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Update failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.pushBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch || branch.isRemote) return;
                if (!validateBranchArg(branch.name)) return;
                const pushBranch = async (): Promise<void> => {
                    const tracked = resolveTrackedRemoteBranch(branch, getCurrentBranches());
                    if (tracked) {
                        assertValidRemoteName(tracked.remote);
                        assertValidBranchName(tracked.remoteBranch, "remote branch name");
                    }
                    if (branch.isCurrent) {
                        if (tracked) {
                            await executor.run([
                                "push",
                                tracked.remote,
                                `${branch.name}:${tracked.remoteBranch}`,
                            ]);
                        } else {
                            await gitOps.push();
                        }
                    } else {
                        if (tracked) {
                            await executor.run([
                                "push",
                                tracked.remote,
                                `${branch.name}:${tracked.remoteBranch}`,
                            ]);
                        } else {
                            const remote = await resolveRemoteName(branch, executor);
                            if (!remote) {
                                throw new Error(
                                    vscode.l10n.t("No remote configured for branch {branch}.", {
                                        branch: branch.name,
                                    }),
                                );
                            }
                            assertValidRemoteName(remote);
                            await executor.run(["push", "-u", remote, branch.name]);
                        }
                    }
                };
                try {
                    await runWithNotificationProgress(
                        vscode.l10n.t("Pushing {branch}...", { branch: branch.name }),
                        async () => {
                            await pushBranch();
                        },
                    );
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Pushed {branch}", { branch: branch.name }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    if (err instanceof UpstreamPushDeclinedError) return;
                    if (
                        branch.isCurrent &&
                        (await promptRebaseAfterPushRejection(err, gitOps, pushBranch))
                    ) {
                        await vscode.commands.executeCommand("intelligit.refresh");
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Push failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.renameBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                if (!validateBranchArg(name)) return;
                const newName = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t("Rename {branch} to", { branch: name }),
                    value: name,
                });
                if (!newName || newName === name) return;
                if (!isValidBranchName(newName)) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            "Invalid branch name '{branch}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.",
                            { branch: newName },
                        ),
                    );
                    return;
                }
                try {
                    await executor.run(["branch", "-m", name, newName]);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Renamed {oldBranch} to {newBranch}", {
                            oldBranch: name,
                            newBranch: newName,
                        }),
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Rename failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.deleteBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const name = branch.name;
                if (!name) return;
                const isRemote = !!branch.isRemote;
                if (!isRemote && !validateBranchArg(name)) return;
                const checkedOutBranch = isRemote
                    ? null
                    : await getCheckedOutBranchName(executor, getCurrentBranches());

                if (!isRemote && checkedOutBranch && checkedOutBranch === name) {
                    await vscode.window.showWarningMessage(
                        vscode.l10n.t(
                            "Cannot delete '{branch}' because it is currently checked out. Switch to another branch and try again.",
                            { branch: name },
                        ),
                        { modal: true },
                        vscode.l10n.t("OK"),
                    );
                    return;
                }

                const deleteLabel = vscode.l10n.t("Delete");
                const deleteAnywayLabel = vscode.l10n.t("Delete Anyway");
                let confirmLabel = deleteLabel;
                let confirmMessage = vscode.l10n.t("Delete branch {branch}?", { branch: name });
                if (!isRemote) {
                    const mergeStatus = await getLocalBranchMergeStatusForDelete(
                        name,
                        checkedOutBranch,
                        executor,
                    );
                    if (!mergeStatus.merged) {
                        confirmLabel = deleteAnywayLabel;
                        confirmMessage =
                            mergeStatus.target === "HEAD"
                                ? vscode.l10n.t(
                                      "Branch {branch} has unmerged commits relative to the current branch. Delete anyway? This may permanently lose commits not reachable from the current branch.",
                                      { branch: name },
                                  )
                                : vscode.l10n.t(
                                      "Branch {branch} has unmerged commits relative to '{target}'. Delete anyway? This may permanently lose commits not reachable from '{target}'.",
                                      { branch: name, target: mergeStatus.target },
                                  );
                    }
                }

                const confirm = await vscode.window.showWarningMessage(
                    confirmMessage,
                    { modal: true },
                    confirmLabel,
                );
                if (confirm !== confirmLabel) return;
                try {
                    if (isRemote) {
                        const target = resolveRemoteDeleteTarget(branch);
                        if (!target) {
                            vscode.window.showErrorMessage(
                                vscode.l10n.t(
                                    "Delete failed: unable to determine remote target for '{branch}'.",
                                    { branch: name },
                                ),
                            );
                            return;
                        }
                        if (!validateTrackedRemote(target)) return;
                        await runWithNotificationProgress(
                            vscode.l10n.t("Deleting remote branch {remote}/{remoteBranch}...", {
                                remote: target.remote,
                                remoteBranch: target.remoteBranch,
                            }),
                            async () => {
                                await executor.run([
                                    "push",
                                    target.remote,
                                    "--delete",
                                    target.remoteBranch,
                                ]);
                            },
                        );
                        vscode.window.showInformationMessage(
                            vscode.l10n.t("Deleted {remote}/{remoteBranch}", {
                                remote: target.remote,
                                remoteBranch: target.remoteBranch,
                            }),
                        );
                        await vscode.commands.executeCommand("intelligit.refresh");
                    } else {
                        const forceDelete = confirmLabel === deleteAnywayLabel;
                        await executor.run(["branch", forceDelete ? "-D" : "-d", name]);
                        await vscode.commands.executeCommand("intelligit.refresh");
                        await showDeletedBranchActions(branch, getCurrentBranches(), executor);
                    }
                } catch (err) {
                    if (!isRemote && isBranchNotFullyMergedError(err)) {
                        const forceConfirm = await vscode.window.showWarningMessage(
                            vscode.l10n.t(
                                "Branch '{branch}' has unmerged commits. Do you still want to delete it? This may permanently lose commits not reachable from the current branch.",
                                { branch: name },
                            ),
                            { modal: true },
                            deleteAnywayLabel,
                        );
                        if (forceConfirm !== deleteAnywayLabel) return;
                        try {
                            await executor.run(["branch", "-D", name]);
                            await vscode.commands.executeCommand("intelligit.refresh");
                            await showDeletedBranchActions(branch, getCurrentBranches(), executor);
                        } catch (forceErr) {
                            const msg = getErrorMessage(forceErr);
                            vscode.window.showErrorMessage(
                                vscode.l10n.t("Delete failed: {message}", { message: msg }),
                            );
                        }
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Delete failed: {message}", { message: msg }),
                    );
                }
            },
        },
        {
            id: "intelligit.deleteBranches",
            handler: async (payload) => {
                const branches = uniqueBranchesByName(assertBranchListPayload(payload));
                if (branches.length === 0) return;

                try {
                    for (const branch of branches) {
                        assertValidBranchName(branch.name);
                    }

                    const currentName = getCurrentBranchName();
                    const current = branches.find(
                        (branch) =>
                            !branch.isRemote && (branch.isCurrent || branch.name === currentName),
                    );
                    if (current) {
                        vscode.window.showWarningMessage(
                            vscode.l10n.t("Cannot delete the current branch: {branch}", {
                                branch: current.name,
                            }),
                        );
                        return;
                    }

                    const unmerged = await assertBulkBranchesMerged(executor, branches);
                    if (unmerged.length > 0) {
                        vscode.window.showErrorMessage(
                            vscode.l10n.t("Cannot delete unmerged branches: {branches}", {
                                branches: unmerged.join(", "),
                            }),
                        );
                        return;
                    }

                    const deleted: string[] = [];
                    for (const branch of branches) {
                        try {
                            await deleteBranchRef(executor, branch);
                            deleted.push(branch.name);
                            if (!branch.isRemote) {
                                void showDeletedBranchActions(
                                    branch,
                                    getCurrentBranches(),
                                    executor,
                                );
                            }
                        } catch (err) {
                            const msg = getErrorMessage(err);
                            if (deleted.length > 0) {
                                await vscode.commands.executeCommand("intelligit.refresh");
                            }
                            const message =
                                deleted.length > 0
                                    ? vscode.l10n.t(
                                          "partially deleted {count} branch(es), but failed to delete {branch}: {message}",
                                          {
                                              count: deleted.length,
                                              branch: branch.name,
                                              message: msg,
                                          },
                                      )
                                    : vscode.l10n.t("failed to delete {branch}: {message}", {
                                          branch: branch.name,
                                          message: msg,
                                      });
                            vscode.window.showErrorMessage(message);
                            return;
                        }
                    }

                    await vscode.commands.executeCommand("intelligit.refresh");
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Deleted {count} branch(es).", { count: deleted.length }),
                    );
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Delete failed: {message}", { message: msg }),
                    );
                }
            },
        },
    ];
}
