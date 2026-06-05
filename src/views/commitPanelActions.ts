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

export async function shelveSaveFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    options: { name: string; paths?: string[] },
): Promise<void> {
    await deps.gitOps.shelveSave(options.paths, options.name);
    vscode.window.showInformationMessage(vscode.l10n.t("Changes shelved."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

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
