import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { promptRebaseAfterPushRejection } from "../services/gitHelpers";
import { runWithNotificationProgress } from "../utils/notifications";

interface CommitPanelActionDeps {
    gitOps: GitOps;
    refreshData: () => Promise<void>;
    fireWorkingTreeChanged: () => void;
    postCommitted: () => void;
    maybeOfferPublishBranch: () => Promise<void>;
}

/**
 * Commits the validated subset of selected Changes-panel files and optionally pushes it.
 *
 * Callers must pass repository-relative paths that have already crossed the webview validation
 * boundary. The action stages those paths, warns on missing commit input, retries push rejection via
 * the rebase prompt, and refreshes panel/working-tree state only after a successful commit path.
 */
export async function commitSelectedFromPanel(
    deps: CommitPanelActionDeps,
    options: { message: string; amend: boolean; push: boolean; paths: string[] },
): Promise<void> {
    const { gitOps, refreshData, fireWorkingTreeChanged, postCommitted, maybeOfferPublishBranch } =
        deps;
    const { message, amend, push, paths } = options;
    if (!message && !amend) {
        vscode.window.showWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    if (paths.length === 0 && !amend) {
        vscode.window.showWarningMessage(vscode.l10n.t("Select files to commit."));
        return;
    }
    if (paths.length > 0) {
        await gitOps.stageFiles(paths);
    }
    try {
        const progressTitle = push
            ? vscode.l10n.t("Committing and pushing...")
            : vscode.l10n.t("Committing...");
        await runWithNotificationProgress(progressTitle, async () => {
            if (push) {
                await gitOps.commitAndPush(message, amend);
            } else {
                await gitOps.commit(message, amend);
            }
        });
    } catch (err) {
        if (
            push &&
            (await promptRebaseAfterPushRejection(err, gitOps, async () => {
                await gitOps.push();
            }))
        ) {
            postCommitted();
            await refreshData();
            fireWorkingTreeChanged();
            return;
        }
        throw err;
    }
    vscode.window.showInformationMessage(
        push
            ? vscode.l10n.t("Committed and pushed successfully.")
            : vscode.l10n.t("Committed successfully."),
    );
    postCommitted();
    await refreshData();
    fireWorkingTreeChanged();
    if (!push) {
        void maybeOfferPublishBranch();
    }
}

/**
 * Runs the commit-only button action for the current Changes-panel repository.
 *
 * The helper owns user-facing validation for empty messages, progress notification, success UI,
 * draft reset signaling, panel refresh, and the optional publish-branch prompt after local commits.
 */
export async function commitOnlyFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        vscode.window.showWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    await runWithNotificationProgress(vscode.l10n.t("Committing..."), async () => {
        await deps.gitOps.commit(message, amend);
    });
    vscode.window.showInformationMessage(vscode.l10n.t("Committed successfully."));
    deps.postCommitted();
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
    void deps.maybeOfferPublishBranch();
}

/**
 * Commits the current panel changes and pushes the active branch with push-rejection recovery.
 *
 * Rebase retry prompts are handled here so both docked and undocked panels surface the same UX;
 * unrecovered errors are rethrown for the provider message handler to report to the webview.
 */
export async function commitAndPushFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        vscode.window.showWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    try {
        await runWithNotificationProgress(vscode.l10n.t("Committing and pushing..."), async () => {
            await deps.gitOps.commitAndPush(message, amend);
        });
    } catch (err) {
        if (
            await promptRebaseAfterPushRejection(err, deps.gitOps, async () => {
                await deps.gitOps.push();
            })
        ) {
            deps.postCommitted();
            await deps.refreshData();
            deps.fireWorkingTreeChanged();
            return;
        }
        throw err;
    }
    vscode.window.showInformationMessage(vscode.l10n.t("Committed and pushed successfully."));
    deps.postCommitted();
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Prompts before rolling back selected paths or the entire working tree from the panel.
 *
 * An empty path list intentionally means “rollback all changes.” Path values must already be
 * validated by the caller before this destructive Git operation is offered to the user.
 */
export async function rollbackFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    paths: string[],
): Promise<void> {
    const rollbackAction = vscode.l10n.t("Rollback");
    if (paths.length === 0) {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback all changes?"),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackAll();
    } else {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback {count} file(s)?", { count: paths.length }),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackFiles(paths);
    }
    vscode.window.showInformationMessage(vscode.l10n.t("Changes rolled back."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Saves the current or selected working-tree changes to a shelf entry from the panel.
 *
 * The caller supplies the UI-derived shelf name and already validated optional paths; this helper
 * owns the success notification plus follow-up refresh/change events after Git mutates the shelf.
 */
export async function shelveSaveFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    options: { name: string; paths?: string[] },
): Promise<void> {
    await deps.gitOps.shelveSave(options.paths, options.name);
    vscode.window.showInformationMessage(vscode.l10n.t("Changes shelved."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Applies, pops, or deletes a shelf entry selected in the panel.
 *
 * Delete requests require a modal confirmation because they discard the saved shelf entry, while
 * apply/pop immediately mutate the working tree and then refresh both panel and host state.
 */
export async function shelfMutationFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    action: "pop" | "apply" | "delete",
    index: number,
): Promise<void> {
    if (action === "delete") {
        const deleteAction = vscode.l10n.t("Delete");
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Delete this shelved change?"),
            { modal: true },
            deleteAction,
        );
        if (confirm !== deleteAction) return;
        await deps.gitOps.shelveDelete(index);
        vscode.window.showInformationMessage(vscode.l10n.t("Shelved change deleted."));
    } else if (action === "pop") {
        await deps.gitOps.shelvePop(index);
        vscode.window.showInformationMessage(vscode.l10n.t("Unshelved changes."));
    } else {
        await deps.gitOps.shelveApply(index);
        vscode.window.showInformationMessage(vscode.l10n.t("Applied shelved changes."));
    }
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}
