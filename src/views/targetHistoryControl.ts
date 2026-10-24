import * as vscode from "vscode";
import type { ChangelistStore } from "../changes/changelistStore";
import type { GitOps } from "../git/operations";
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

/** Return true whenever targeted control consumed the request, including cancellation and review. */
export async function controlTargetHistoryWithConfirmation(
    options: TargetHistoryControlOptions,
): Promise<boolean> {
    try {
        const result = await options.gitOps.controlTargetHistory(
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
        await options.onConflictStateChanged();
        return true;
    } catch (error) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Targeted history recovery requires review: {message}", {
                message: getErrorMessage(error),
            }),
        );
        return true;
    }
}
