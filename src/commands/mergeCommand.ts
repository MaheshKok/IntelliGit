import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { showTimedInformationMessage, showTimedWarningMessage } from "../utils/notifications";

/** Captured branch labels for the repository whose merge produced conflicts. */
export interface MergeLabels {
    sourceBranch?: string;
    targetBranch?: string;
}

/** Repository-scoped callbacks shared by native and branch-tree Merge commands. */
interface MergeCommandOptions {
    targetBranch?: string;
    merge: (branch: string) => Promise<unknown>;
    refresh: () => Promise<void>;
    refreshConflicts: () => Promise<void>;
    openConflictSession: (labels: MergeLabels) => Promise<void>;
    /** Rechecks native dialog-time preconditions after confirmation; false cancels dispatch. */
    beforeMerge?: () => Promise<boolean>;
}

/**
 * Confirms and merges one validated branch, preserving the original Git error if conflict recovery
 * fails. Refresh errors after a successful merge are reported separately from Git failures.
 */
export async function runMergeCommand(
    branch: string,
    gitOps: Pick<GitOps, "getConflictFilesDetailed">,
    options: MergeCommandOptions,
): Promise<void> {
    const mergeLabel = vscode.l10n.t("Merge");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Merge {branch} into current branch?", { branch }),
        { modal: true },
        mergeLabel,
    );
    if (confirm !== mergeLabel || (options.beforeMerge && !(await options.beforeMerge()))) return;
    try {
        await options.merge(branch);
    } catch (error) {
        try {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length > 0) {
                await options.openConflictSession({
                    sourceBranch: branch,
                    targetBranch: options.targetBranch,
                });
                try {
                    await options.refreshConflicts();
                } catch (refreshError) {
                    showTimedWarningMessage(
                        vscode.l10n.t("Failed to refresh conflict UI: {message}", {
                            message: getErrorMessage(refreshError),
                        }),
                    );
                }
                showTimedWarningMessage(
                    vscode.l10n.t(
                        "Merge produced {count} unresolved conflict file(s). Opened Conflicts session.",
                        { count: conflicts.length },
                    ),
                );
                return;
            }
        } catch {
            // The original merge error remains actionable if conflict inspection or opening fails.
        }
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Merge failed: {message}", { message: getErrorMessage(error) }),
        );
        return;
    }
    showTimedInformationMessage(vscode.l10n.t("Merged {branch}", { branch }));
    try {
        await options.refresh();
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Merge succeeded, but refresh failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
