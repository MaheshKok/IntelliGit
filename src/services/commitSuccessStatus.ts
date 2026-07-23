import * as vscode from "vscode";

const AUTO_HIDE_DELAY_MS = 5_000;

/**
 * Owns the native status-bar confirmation shown after a successful local commit.
 *
 * The setting is evaluated for every completion so a user can change retention without
 * recreating the extension-owned item. A later completion always replaces the pending timeout.
 */
export class CommitSuccessStatus implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    private hideTimer: ReturnType<typeof setTimeout> | undefined;

    /** Shows the localized successful-commit confirmation and applies the current retention setting. */
    showCommitted(): void {
        this.clearHideTimer();
        this.item.text = `$(check) ${vscode.l10n.t("Committed successfully.")}`;
        this.item.show();
        const retainStatus =
            vscode.workspace
                .getConfiguration("intelligit")
                .get<boolean>("keepLastCommitNotification", true) === false;
        if (!retainStatus) {
            this.hideTimer = setTimeout(() => {
                this.hideTimer = undefined;
                this.item.hide();
            }, AUTO_HIDE_DELAY_MS);
        }
    }

    /** Cancels any pending auto-hide timer and releases the extension-owned status-bar item. */
    dispose(): void {
        this.clearHideTimer();
        this.item.dispose();
    }

    /** Clears the outstanding auto-hide timer when a newer completion supersedes it. */
    private clearHideTimer(): void {
        if (this.hideTimer === undefined) return;
        clearTimeout(this.hideTimer);
        this.hideTimer = undefined;
    }
}
