import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { showTimedInformationMessage, showTimedWarningMessage } from "../utils/notifications";
import type { MergeLabels } from "./mergeCommand";

/** Repository-bound actions that can outlive Rebase confirmation and retain its captured root. */
interface RebaseCommandOptions {
    currentBranch: string;
    rebase: (branch: string) => Promise<void>;
    refresh: () => Promise<void>;
    refreshConflicts: () => Promise<void>;
    openConflictSession: (labels: MergeLabels) => Promise<void>;
    beforeRebase: () => Promise<boolean>;
}

/**
 * Confirms a target and runs Rebase. Git's error survives failed conflict recovery; a completed
 * operation is reported as successful even when a later view refresh fails.
 */
export async function runRebaseCommand(
    branch: string,
    gitOps: Pick<GitOps, "getConflictFilesDetailed">,
    options: RebaseCommandOptions,
): Promise<void> {
    const action = vscode.l10n.t("Rebase");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Rebase current branch {currentBranch} onto {branch}?", {
            currentBranch: options.currentBranch,
            branch,
        }),
        { modal: true },
        action,
    );
    if (confirm !== action || !(await options.beforeRebase())) return;
    try {
        await options.rebase(branch);
    } catch (error) {
        try {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length > 0) {
                await options.openConflictSession({
                    sourceBranch: options.currentBranch,
                    targetBranch: branch,
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
                        "Rebase produced {count} unresolved conflict file(s). Opened Conflicts session.",
                        { count: conflicts.length },
                    ),
                );
                return;
            }
        } catch {
            // Preserve the original Git error when inspecting or opening recovery fails.
        }
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Rebase failed: {message}", { message: getErrorMessage(error) }),
        );
        return;
    }
    showTimedInformationMessage(vscode.l10n.t("Rebased onto {branch}", { branch }));
    try {
        await options.refresh();
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Rebase succeeded, but refresh failed: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
