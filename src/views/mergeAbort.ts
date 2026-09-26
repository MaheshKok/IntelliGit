import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";

/** Dependencies for the shared merge-abort confirmation flow. */
export interface AbortMergeOptions {
    gitOps: GitOps;
    /** Uses Rebase copy only for a session known to be rebasing; Merge remains the default. */
    operation?: "merge" | "rebase";
    onConflictStateChanged: () => Promise<void>;
    disposePanel?: () => void;
}

/**
 * Confirms and aborts the captured repository's active merge or rebase, then refreshes its
 * conflict state and closes any owning panel. Callers omitting operation retain Merge copy.
 */
export async function abortMergeWithConfirmation(options: AbortMergeOptions): Promise<void> {
    const rebase = options.operation === "rebase";
    const abortAction = rebase ? vscode.l10n.t("Abort Rebase") : vscode.l10n.t("Abort Merge");
    const confirmMessage = rebase
        ? vscode.l10n.t("Abort the current rebase? Local conflict resolutions will be discarded.")
        : vscode.l10n.t("Abort the current merge? Local conflict resolutions will be discarded.");
    const confirmed = await vscode.window.showWarningMessage(
        confirmMessage,
        { modal: true },
        abortAction,
    );
    if (confirmed !== abortAction) return;

    try {
        await runWithNotificationProgress(
            rebase ? vscode.l10n.t("Aborting rebase...") : vscode.l10n.t("Aborting merge..."),
            async () => {
                await options.gitOps.abortMerge();
            },
        );
    } catch (error) {
        vscode.window.showErrorMessage(
            rebase
                ? vscode.l10n.t("Abort rebase failed: {message}", {
                      message: getErrorMessage(error),
                  })
                : vscode.l10n.t("Abort merge failed: {message}", {
                      message: getErrorMessage(error),
                  }),
        );
        return;
    }

    showTimedInformationMessage(
        rebase ? vscode.l10n.t("Rebase aborted.") : vscode.l10n.t("Merge aborted."),
    );
    await options.onConflictStateChanged();
    options.disposePanel?.();
}
