import * as vscode from "vscode";
import type { ChangelistStore } from "../changes/changelistStore";
import type { GitOps } from "../git/operations";
import { RepositoryLockBusyError } from "../git/repositoryLock";
import { PendingTargetOperationKindError } from "../git/targetHistoryRecovery";
import { getErrorMessage } from "../utils/errors";
import { showTimedInformationMessage } from "../utils/notifications";

/** Root and metadata collaborators are captured before any confirmation or native marker lookup. */
export interface TargetHistoryControlOptions {
    gitOps: GitOps;
    root: string;
    changelists: ChangelistStore;
    action: "continue" | "abort";
    onConflictStateChanged: () => Promise<void>;
}

function controlFailureMessage(error: unknown): string {
    if (error instanceof RepositoryLockBusyError)
        return vscode.l10n.t(
            "Another IntelliGit operation is using this repository. Nothing was changed. Try again in a moment.",
        );
    // The pending record is known here, so no terminal advice: native Git would bypass its recovery.
    if (error instanceof PendingTargetOperationKindError) {
        if (error.kind === "shelfRestore")
            return vscode.l10n.t(
                "Git was not changed because an IntelliGit Unshelve is still unfinished in this repository. Continue and Abort cannot finish it.",
            );
        if (error.kind === "undoCommit")
            return vscode.l10n.t(
                "Git was not changed because an IntelliGit Undo Commit is still unfinished in this repository. Continue and Abort cannot finish it.",
            );
        return vscode.l10n.t(
            "Git was not changed because another IntelliGit operation is still unfinished in this repository. Continue and Abort cannot finish it.",
        );
    }
    return vscode.l10n.t(
        "Git was not changed because IntelliGit cannot confirm that no targeted history operation is pending. To go ahead without IntelliGit, run the Git command in a terminal; that skips IntelliGit's targeted recovery. Details: {message}",
        { message: getErrorMessage(error) },
    );
}

/** Return true whenever targeted control consumed the request, including cancellation and review. */
export async function controlTargetHistoryWithConfirmation(
    options: TargetHistoryControlOptions,
): Promise<boolean> {
    let result: Awaited<ReturnType<GitOps["controlTargetHistory"]>>;
    try {
        result = await options.gitOps.controlTargetHistory(
            options.root,
            options.changelists,
            options.action,
            async (review) => {
                const action =
                    options.action === "abort"
                        ? vscode.l10n.t("Discard Targeted Changes")
                        : vscode.l10n.t("Complete Without Commit");
                const message =
                    options.action === "abort"
                        ? vscode.l10n.t(
                              "Discard the reviewed changes from targeted history operation {id}?",
                              { id: review.id },
                          )
                        : vscode.l10n.t(
                              "Complete targeted history operation {id} without creating a commit?",
                              { id: review.id },
                          );
                return (
                    (await vscode.window.showWarningMessage(
                        message,
                        { modal: true, detail: review.paths.join("\n") },
                        action,
                    )) === action
                );
            },
        );
    } catch (error) {
        // Still consumed: busy, known-pending or unreadable metadata never proves no markerless operation is pending.
        vscode.window.showErrorMessage(controlFailureMessage(error));
        return true;
    }
    if (result.status === "noPending") return false;
    if (result.status === "cancelled") return true;
    if (result.result.outcome === "applied" || result.result.outcome === "notApplied") {
        showTimedInformationMessage(
            options.action === "abort"
                ? vscode.l10n.t("Targeted history changes discarded.")
                : vscode.l10n.t("Targeted history completed without a commit."),
        );
    } else {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Targeted history operation {id} requires review: {message}", {
                id: result.result.id,
                message: result.result.reason ?? result.result.outcome,
            }),
        );
    }
    try {
        await options.onConflictStateChanged();
    } catch (error) {
        // The targeted step already ran, so the control-failure message above would be untrue here.
        vscode.window.showErrorMessage(
            vscode.l10n.t("The view could not refresh after the targeted history step: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
    return true;
}
