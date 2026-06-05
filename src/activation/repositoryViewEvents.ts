import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import type { CommitAction } from "../webviews/protocol/commitGraphTypes";
import { handleCommitContextAction } from "../commands/commitCommands";
import { openCommitFileDiff } from "../services/diffService";
import { RefreshService } from "../views/RefreshService";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "../views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { getErrorMessage } from "../utils/errors";

interface CommitFileDiffDeps {
    executor: GitExecutor;
    gitOps: GitOps;
    getRepoRoot: () => string;
}

export type OpenCommitFileDiffHandler = (params: {
    commitHash: string;
    filePath: string;
}) => Promise<void>;

export function createOpenCommitFileDiffHandler(
    deps: CommitFileDiffDeps,
): OpenCommitFileDiffHandler {
    return async (params) => {
        try {
            await openCommitFileDiff(
                params.commitHash,
                params.filePath,
                deps.getRepoRoot(),
                deps.gitOps,
                deps.executor,
            );
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to open commit diff: {message}", { message }),
            );
        }
    };
}

export interface RepositoryViewEventDeps {
    context: vscode.ExtensionContext;
    executor: GitExecutor;
    gitOps: GitOps;
    commitGraph: CommitGraphViewProvider;
    sidebarGraph: CommitGraphViewProvider;
    commitPanel: CommitPanelViewProvider;
    commitInfo: CommitInfoViewProvider;
    getRepoRoot: () => string;
    getCurrentBranches: () => Branch[];
    refreshService: () => RefreshService;
}

export function registerRepositoryViewEvents(
    deps: RepositoryViewEventDeps,
    handleOpenCommitFileDiff: OpenCommitFileDiffHandler,
): void {
    let commitDetailRequestSeq = 0;
    const {
        context,
        executor,
        gitOps,
        commitGraph,
        sidebarGraph,
        commitPanel,
        commitInfo,
        getRepoRoot,
        getCurrentBranches,
        refreshService,
    } = deps;

    const loadCommitDetail = async (hash: string): Promise<void> => {
        const requestId = ++commitDetailRequestSeq;
        try {
            const detail = await gitOps.getCommitDetail(hash);
            if (requestId !== commitDetailRequestSeq) return;
            commitGraph.setCommitDetail(detail);
            sidebarGraph.setCommitDetail(detail);
            commitPanel.setCommitDetail(detail);
            commitInfo.setCommitDetail(detail);
        } catch (err) {
            const msg = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to load commit: {message}", { message: msg }),
            );
        }
    };

    const clearCommitDetail = (): void => {
        commitGraph.clearCommitDetail();
        sidebarGraph.clearCommitDetail();
        commitPanel.clearCommitDetail();
        commitInfo.clear();
    };

    const forwardBranchAction = ({
        action,
        branchName,
    }: {
        action: string;
        branchName: string;
    }): void => {
        const branch = getCurrentBranches().find((b) => b.name === branchName);
        if (!branch) return;
        const item: { branch: Branch } = { branch };
        void vscode.commands.executeCommand(`intelligit.${action}`, item);
    };

    const runCommitAction = async ({ action, hash }: { action: CommitAction; hash: string }) => {
        try {
            await handleCommitContextAction({
                action,
                hash,
                executor,
                gitOps,
                repoRoot: getRepoRoot(),
                currentBranches: getCurrentBranches(),
                refreshAll: () => refreshService().refreshAll(),
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.error(`Commit action '${action}' failed:`, error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit action failed: {message}", { message }),
            );
        }
    };

    context.subscriptions.push(
        commitGraph.onCommitSelected(loadCommitDetail),
        sidebarGraph.onCommitSelected(loadCommitDetail),
        commitPanel.onCommitSelected(loadCommitDetail),
        commitGraph.onBranchFilterChanged(clearCommitDetail),
        sidebarGraph.onBranchFilterChanged(clearCommitDetail),
        commitPanel.onBranchFilterChanged(clearCommitDetail),
        commitGraph.onBranchAction(forwardBranchAction),
        sidebarGraph.onBranchAction(forwardBranchAction),
        commitPanel.onBranchAction(forwardBranchAction),
        commitGraph.onCommitAction(runCommitAction),
        sidebarGraph.onCommitAction(runCommitAction),
        commitPanel.onCommitAction(runCommitAction),
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        sidebarGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitPanel.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );
}
