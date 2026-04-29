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
                    vscode.window.showInformationMessage(`Checked out ${checkedOut}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.newBranchFrom",
            handler: async (item) => {
                const base = item.branch?.name;
                if (!base) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `New branch from ${base}`,
                    placeHolder: "branch-name",
                });
                if (!newName) return;
                if (!isValidBranchName(newName)) {
                    vscode.window.showErrorMessage(
                        `Invalid branch name '${newName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                    );
                    return;
                }
                try {
                    await executor.run(["checkout", "-b", newName, base]);
                    vscode.window.showInformationMessage(`Created and checked out ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
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
                    vscode.window.showErrorMessage("No current branch found.");
                    return;
                }
                try {
                    const checkedOut = await checkoutBranch(branch, getCurrentBranches(), executor);
                    if (checkedOut === onto) {
                        vscode.window.showInformationMessage(
                            `${checkedOut} is already the current branch.`,
                        );
                        return;
                    }
                    await executor.run(["rebase", onto]);
                    vscode.window.showInformationMessage(
                        `Checked out ${checkedOut} and rebased onto ${onto}`,
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout and rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.rebaseCurrentOnto",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rebase current branch onto ${name}?`,
                    { modal: true },
                    "Rebase",
                );
                if (confirm !== "Rebase") return;
                try {
                    await executor.run(["rebase", name]);
                    vscode.window.showInformationMessage(`Rebased onto ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.mergeIntoCurrent",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Merge ${name} into current branch?`,
                    { modal: true },
                    "Merge",
                );
                if (confirm !== "Merge") return;
                try {
                    await executor.run(["merge", name]);
                    vscode.window.showInformationMessage(`Merged ${name}`);
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
                                `Merge produced ${conflicts.length} unresolved conflict file${conflicts.length === 1 ? "" : "s"}. Opened Conflicts session.`,
                            );
                            return;
                        }
                    } catch {
                        // Fall back to merge error if conflict inspection/session launch fails.
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Merge failed: ${msg}`);
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
                    await runWithNotificationProgress(`Updating ${name}...`, async () => {
                        const tracked = resolveTrackedRemoteBranch(branch, getCurrentBranches());
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
                            throw new Error(`No tracked remote branch configured for '${name}'.`);
                        }

                        await executor.run([
                            "fetch",
                            tracked.remote,
                            `${tracked.remoteBranch}:${name}`,
                            "--recurse-submodules=no",
                            "--progress",
                            "--prune",
                        ]);
                    });
                    vscode.window.showInformationMessage(`Updated ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Update failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.pushBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch || branch.isRemote) return;
                try {
                    await runWithNotificationProgress(`Pushing ${branch.name}...`, async () => {
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
                                        `No remote configured for branch ${branch.name}.`,
                                    );
                                }
                                await executor.run(["push", "-u", remote, branch.name]);
                            }
                        }
                    });
                    vscode.window.showInformationMessage(`Pushed ${branch.name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    if (err instanceof UpstreamPushDeclinedError) return;
                    if (branch.isCurrent && (await promptRebaseAfterPushRejection(err, gitOps))) {
                        await vscode.commands.executeCommand("intelligit.refresh");
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Push failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.renameBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `Rename ${name} to`,
                    value: name,
                });
                if (!newName || newName === name) return;
                if (!isValidBranchName(newName)) {
                    vscode.window.showErrorMessage(
                        `Invalid branch name '${newName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                    );
                    return;
                }
                try {
                    await executor.run(["branch", "-m", name, newName]);
                    vscode.window.showInformationMessage(`Renamed ${name} to ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rename failed: ${msg}`);
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
                        `Cannot delete '${name}' because it is currently checked out. Switch to another branch and try again.`,
                        { modal: true },
                        "OK",
                    );
                    return;
                }

                let confirmLabel = "Delete";
                let confirmMessage = `Delete branch ${name}?`;
                if (!isRemote) {
                    const mergeStatus = await getLocalBranchMergeStatusForDelete(
                        name,
                        checkedOutBranch,
                        executor,
                    );
                    if (!mergeStatus.merged) {
                        const targetLabel =
                            mergeStatus.target === "HEAD"
                                ? "the current branch"
                                : `'${mergeStatus.target}'`;
                        confirmLabel = "Delete Anyway";
                        confirmMessage =
                            `Branch ${name} has unmerged commits relative to ${targetLabel}. Delete anyway?\n` +
                            `This may permanently lose commits not reachable from ${targetLabel}.`;
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
                                `Delete failed: unable to determine remote target for '${name}'.`,
                            );
                            return;
                        }
                        await runWithNotificationProgress(
                            `Deleting remote branch ${target.remote}/${target.remoteBranch}...`,
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
                            `Deleted ${target.remote}/${target.remoteBranch}`,
                        );
                        await vscode.commands.executeCommand("intelligit.refresh");
                    } else {
                        const forceDelete = confirmLabel === "Delete Anyway";
                        await executor.run(["branch", forceDelete ? "-D" : "-d", name]);
                        await vscode.commands.executeCommand("intelligit.refresh");
                        await showDeletedBranchActions(branch, getCurrentBranches(), executor);
                    }
                } catch (err) {
                    if (!isRemote && isBranchNotFullyMergedError(err)) {
                        const forceConfirm = await vscode.window.showWarningMessage(
                            `Branch '${name}' has unmerged commits. Do you still want to delete it?\nThis may permanently lose commits not reachable from the current branch.`,
                            { modal: true },
                            "Delete Anyway",
                        );
                        if (forceConfirm !== "Delete Anyway") return;
                        try {
                            await executor.run(["branch", "-D", name]);
                            await vscode.commands.executeCommand("intelligit.refresh");
                            await showDeletedBranchActions(branch, getCurrentBranches(), executor);
                        } catch (forceErr) {
                            const msg = getErrorMessage(forceErr);
                            vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                        }
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                }
            },
        },
    ];
}
