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

export interface BranchCommandEntry {
    id: string;
    handler: (item: { branch?: Branch }) => Promise<void>;
}

export function createBranchCommands(deps: BranchCommandDeps): BranchCommandEntry[] {
    const {
        executor,
        gitOps,
        getCurrentBranchName,
        getCurrentBranches,
        openConflictSession,
        refreshConflictUi,
    } = deps;

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
                try {
                    await runWithNotificationProgress(
                        vscode.l10n.t("Updating {branch}...", { branch: name }),
                        async () => {
                            const tracked = resolveTrackedRemoteBranch(
                                branch,
                                getCurrentBranches(),
                            );
                            if (branch.isCurrent) {
                                if (tracked) {
                                    await executor.run([
                                        "pull",
                                        "--ff-only",
                                        tracked.remote,
                                        tracked.remoteBranch,
                                    ]);
                                } else {
                                    await executor.run(["pull", "--ff-only"]);
                                }
                                return;
                            }

                            if (!tracked) {
                                throw new Error(
                                    vscode.l10n.t(
                                        "No tracked remote branch configured for '{branch}'.",
                                        { branch: name },
                                    ),
                                );
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
                    const msg = getErrorMessage(err);
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
                const pushBranch = async (): Promise<void> => {
                    const tracked = resolveTrackedRemoteBranch(branch, getCurrentBranches());
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
    ];
}
