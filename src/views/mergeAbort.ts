import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";

/** Dependencies for the shared merge-abort confirmation flow. */
export interface AbortMergeOptions {
    gitOps: GitOps;
    onConflictStateChanged: () => Promise<void>;
    disposePanel?: () => void;
}

/**
 * Confirms and aborts the active merge, then refreshes conflict state and closes any owning panel.
 */
export async function abortMergeWithConfirmation(options: AbortMergeOptions): Promise<void> {
    const abortAction = vscode.l10n.t("Abort Merge");
    const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Abort the current merge? Local conflict resolutions will be discarded."),
        { modal: true },
        abortAction,
    );
    if (confirmed !== abortAction) return;

    await runWithNotificationProgress(vscode.l10n.t("Aborting merge..."), async () => {
        await options.gitOps.abortMerge();
    });
    showTimedInformationMessage(vscode.l10n.t("Merge aborted."));
    await options.onConflictStateChanged();
    options.disposePanel?.();
}
