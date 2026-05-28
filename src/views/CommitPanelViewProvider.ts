// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeFolderIconMap, WorkingFile, StashEntry } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { runWithNotificationProgress } from "../utils/notifications";
import { promptRebaseAfterPushRejection, isValidGitHash } from "../services/gitHelpers";
import type { InboundMessage } from "../webviews/react/commit-panel/types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/react/commitGraphTypes";
import { isBranchAction, isCommitAction } from "../webviews/react/commitGraphTypes";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";
    private static readonly COMMIT_DRAFT_KEY_PREFIX = "commitDraft:";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private lastFileCount = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;
    private repositoryLabel = "";

    // Embedded commit graph state
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;
    private branches: Branch[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private commitDetailFolderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;

    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;

    private readonly _onDidChangeWorkingTree = new vscode.EventEmitter<void>();
    readonly onDidChangeWorkingTree = this._onDidChangeWorkingTree.event;

    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;

    private readonly _onBranchFilterChanged = new vscode.EventEmitter<string | null>();
    readonly onBranchFilterChanged = this._onBranchFilterChanged.event;

    private readonly _onBranchAction = new vscode.EventEmitter<{
        action: BranchAction;
        branchName: string;
    }>();
    readonly onBranchAction = this._onBranchAction.event;

    private readonly _onCommitAction = new vscode.EventEmitter<{
        action: CommitAction;
        hash: string;
    }>();
    readonly onCommitAction = this._onCommitAction.event;

    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private repoRootUri?: vscode.Uri,
        private readonly workspaceState?: vscode.Memento,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        this.repoRootUri = repoRootUri;
        this.selectedShelfIndex = null;
        this.files = [];
        this.stashes = [];
        this.shelfFiles = [];
        this.currentBranch = null;
        this.filterText = "";
        this.offset = 0;
        this.loadingMore = false;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.branchFolderIconsByName = {};
        // Bump request sequences so in-flight async responses from the old repo are ignored.
        this.requestSeq += 1;
        this.commitDetailSeq += 1;
        this.updateViewCount(0);
        this.postToWebview({
            type: "restoreCommitDraft",
            message: this.getStoredCommitDraft(),
        });
    }

    setRepositoryLabel(label: string): void {
        this.repositoryLabel = label;
        this.updateViewCount(this.lastFileCount);
    }

    setBranches(branches: Branch[]): void {
        this.branches = branches;
        this.sendGraphBranches().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Branch update error: ${message}`);
        });
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.commitDetailFolderIconsByName = {};
        this.postGraphCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Commit detail error: ${message}`);
        });
    }

    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.postToWebview({ type: "clearCommitDetail" });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.disposeThemeChangeDisposables();
        this.iconTheme.dispose();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();
        const thisView = webviewView;
        webviewView.onDidDispose(() => {
            if (this.view === thisView) {
                this.view = undefined;
                this.iconTheme.dispose();
                this.disposeThemeChangeDisposables();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.updateViewCount(this.lastFileCount);
        this.refreshDataWithErrorHandling();
    }

    async refresh(): Promise<void> {
        await this.refreshData();
        await this.refreshGraphData();
    }

    private async refreshData(): Promise<void> {
        this.postToWebview({ type: "refreshing", active: true });
        void Promise.resolve(
            vscode.commands.executeCommand("setContext", "intelligit.commitPanel.refreshing", true),
        ).catch(() => {});
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateWorkingFiles(await this.gitOps.getStatus());
            const stashes = await this.gitOps.listShelved();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();

            const hasSelected =
                this.selectedShelfIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedShelfIndex);
            let selectedShelfIndex: number | null;
            if (hasSelected) {
                selectedShelfIndex = this.selectedShelfIndex;
            } else {
                selectedShelfIndex = stashes.length > 0 ? stashes[0].index : null;
            }

            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex),
                      )
                    : [];
            this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);

            this.files = files;
            this.stashes = stashes;
            this.selectedShelfIndex = selectedShelfIndex;
            this.shelfFiles = shelfFiles;

            const uniquePaths = new Set(files.map((f) => f.path));
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.updateViewCount(count);
            this.postToWebview({
                type: "update",
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
            });
        } finally {
            this.postToWebview({ type: "refreshing", active: false });
            void Promise.resolve(
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.commitPanel.refreshing",
                    false,
                ),
            ).catch(() => {});
        }
    }

    private async refreshGraphData(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendGraphBranches();
        await this.loadInitialGraphCommits();
        this.postGraphCommitDetailState();
    }

    private async sendGraphBranches(): Promise<void> {
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
            iconFonts,
        });
    }

    private async loadInitialGraphCommits(): Promise<void> {
        const requestId = ++this.requestSeq;
        this.offset = 0;
        this.loadingMore = false;

        if (this.currentBranch && !this.branches.some((b) => b.name === this.currentBranch)) {
            this.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
        }

        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    0,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        }
    }

    private async loadMoreGraphCommits(): Promise<void> {
        if (this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    this.offset,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset += commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: true,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        } finally {
            if (requestId === this.requestSeq) {
                this.loadingMore = false;
            }
        }
    }

    private async filterGraphByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitialGraphCommits();
    }

    private assertStringArray(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string[] for '${field}', got ${typeof value}`);
        }
        if (!value.every((item): item is string => typeof item === "string")) {
            throw new Error(`Expected all elements of '${field}' to be strings`);
        }
        return value;
    }

    private assertRepoPathArray(value: unknown, field: string): string[] {
        const strings = this.assertStringArray(value, field);
        return strings.map((s) => assertRepoRelativePath(s));
    }

    private assertString(value: unknown, field: string): string {
        if (typeof value !== "string") {
            throw new Error(`Expected string for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertNullableString(value: unknown, field: string): string | null {
        if (value === null) return null;
        return this.assertString(value, field);
    }

    private assertGitHash(value: unknown, field: string): string {
        const hash = this.assertString(value, field).trim();
        if (!isValidGitHash(hash)) {
            throw new Error(`Invalid git hash for '${field}'.`);
        }
        return hash;
    }

    private assertNumber(value: unknown, field: string): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Expected number for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.refreshData();
                await this.refreshGraphData();
                this.postToWebview({
                    type: "restoreCommitDraft",
                    message: this.getStoredCommitDraft(),
                });
                break;

            case "refresh":
                await this.refreshData();
                await this.refreshGraphData();
                break;

            case "selectCommit":
                this._onCommitSelected.fire(this.assertGitHash(msg.hash, "hash"));
                break;

            case "loadMore":
                await this.loadMoreGraphCommits();
                break;

            case "filterText":
                await this.filterGraphByText(this.assertString(msg.text, "text"));
                break;

            case "filterBranch":
                this.currentBranch = this.assertNullableString(msg.branch, "branch");
                this.filterText = "";
                this._onBranchFilterChanged.fire(this.currentBranch);
                this.postToWebview({
                    type: "setSelectedBranch",
                    branch: this.currentBranch,
                });
                await this.loadInitialGraphCommits();
                break;

            case "branchAction": {
                const branchAction = this.assertString(msg.action, "action");
                if (!isBranchAction(branchAction)) {
                    throw new Error("Invalid branch action received from webview.");
                }
                this._onBranchAction.fire({
                    action: branchAction,
                    branchName: this.assertString(msg.branchName, "branchName"),
                });
                break;
            }

            case "commitAction": {
                const commitAction = this.assertString(msg.action, "action");
                if (!isCommitAction(commitAction)) {
                    throw new Error("Invalid commit action received from webview.");
                }
                this._onCommitAction.fire({
                    action: commitAction,
                    hash: this.assertGitHash(msg.hash, "hash"),
                });
                break;
            }

            case "openCommitFileDiff":
                this._onOpenCommitFileDiff.fire({
                    commitHash: this.assertGitHash(msg.commitHash, "commitHash"),
                    filePath: assertRepoRelativePath(this.assertString(msg.filePath, "filePath")),
                });
                break;

            case "saveCommitDraft": {
                const message = this.assertString(msg.message, "message");
                await this.workspaceState?.update(
                    this.getCommitDraftStorageKey(),
                    message || undefined,
                );
                break;
            }

            case "stageFiles": {
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                await this.gitOps.stageFiles(paths);
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "unstageFiles": {
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                await this.gitOps.unstageFiles(paths);
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "commitSelected": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                const push = msg.push === true;
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                if (paths.length === 0 && !amend) {
                    vscode.window.showWarningMessage("Select files to commit.");
                    return;
                }
                if (paths.length > 0) {
                    await this.gitOps.stageFiles(paths);
                }
                try {
                    await runWithNotificationProgress(
                        push ? "Committing and pushing..." : "Committing...",
                        async () => {
                            if (push) {
                                await this.gitOps.commitAndPush(message, amend);
                            } else {
                                await this.gitOps.commit(message, amend);
                            }
                        },
                    );
                } catch (err) {
                    if (
                        push &&
                        (await promptRebaseAfterPushRejection(err, this.gitOps, async () => {
                            await this.gitOps.push();
                        }))
                    ) {
                        this.postToWebview({ type: "committed" });
                        await this.refreshData();
                        this._onDidChangeWorkingTree.fire();
                        return;
                    }
                    throw err;
                }
                vscode.window.showInformationMessage(
                    push ? "Committed and pushed successfully." : "Committed successfully.",
                );
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                if (!push) {
                    void this.maybeOfferPublishBranch();
                }
                break;
            }

            case "commit": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                await runWithNotificationProgress("Committing...", async () => {
                    await this.gitOps.commit(message, amend);
                });
                vscode.window.showInformationMessage("Committed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                void this.maybeOfferPublishBranch();
                break;
            }

            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                try {
                    await runWithNotificationProgress("Committing and pushing...", async () => {
                        await this.gitOps.commitAndPush(message, amend);
                    });
                } catch (err) {
                    if (
                        await promptRebaseAfterPushRejection(err, this.gitOps, async () => {
                            await this.gitOps.push();
                        })
                    ) {
                        this.postToWebview({ type: "committed" });
                        await this.refreshData();
                        this._onDidChangeWorkingTree.fire();
                        return;
                    }
                    throw err;
                }
                vscode.window.showInformationMessage("Committed and pushed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "getLastCommitMessage": {
                const lastMsg = await this.gitOps.getLastCommitMessage();
                this.postToWebview({ type: "lastCommitMessage", message: lastMsg });
                break;
            }

            case "getAmendBranchCommits": {
                const commits = await this.gitOps.getAmendBranchCommits();
                this.postToWebview({ type: "amendBranchCommits", commits });
                break;
            }

            case "rollback": {
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                if (paths.length === 0) {
                    const confirm = await vscode.window.showWarningMessage(
                        "Rollback all changes?",
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackAll();
                } else {
                    const confirm = await vscode.window.showWarningMessage(
                        `Rollback ${paths.length} file(s)?`,
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackFiles(paths);
                }
                vscode.window.showInformationMessage("Changes rolled back.");
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "showDiff": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const workspaceRoot = this.getWorkspaceRoot();
                const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
                await vscode.commands.executeCommand("git.openChange", uri);
                break;
            }

            case "shelveSave": {
                const name = typeof msg.name === "string" ? msg.name : "Shelved changes";
                let paths: string[] | undefined;
                if (msg.paths !== undefined) {
                    paths = this.assertRepoPathArray(msg.paths, "paths");
                }
                await this.gitOps.shelveSave(paths, name);
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfPop": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelvePop(index);
                vscode.window.showInformationMessage("Unshelved changes.");
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfApply": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelveApply(index);
                vscode.window.showInformationMessage("Applied shelved changes.");
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfDelete": {
                const index = this.assertNumber(msg.index, "index");
                const confirm = await vscode.window.showWarningMessage(
                    "Delete this shelved change?",
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                await this.gitOps.shelveDelete(index);
                vscode.window.showInformationMessage("Shelved change deleted.");
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfSelect": {
                this.selectedShelfIndex = this.assertNumber(msg.index, "index");
                this.shelfFiles = await this.iconTheme.decorateWorkingFiles(
                    await this.gitOps.getShelvedFiles(this.selectedShelfIndex),
                );
                this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                    ...this.files,
                    ...this.shelfFiles,
                ]);
                const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
                this.postToWebview({
                    type: "update",
                    files: this.files,
                    stashes: this.stashes,
                    shelfFiles: this.shelfFiles,
                    selectedShelfIndex: this.selectedShelfIndex,
                    folderIcon: folderIcons.folderIcon,
                    folderExpandedIcon: folderIcons.folderExpandedIcon,
                    folderIconsByName: this.folderIconsByName,
                    iconFonts,
                });
                break;
            }

            case "showShelfDiff": {
                const index = this.assertNumber(msg.index, "index");
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const patch = await this.gitOps.getShelvedFilePatch(index, filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: patch || `No shelved diff found for ${filePath}.`,
                    language: "diff",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }

            case "openFile": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const workspaceRoot = this.getWorkspaceRoot();
                const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
                await vscode.window.showTextDocument(uri);
                break;
            }

            case "deleteFile": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${filePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                const workspaceRoot = this.getWorkspaceRoot();
                const deleted = await deleteFileWithFallback(this.gitOps, workspaceRoot, filePath);
                if (!deleted) return;
                vscode.window.showInformationMessage(`Deleted ${filePath}`);
                await this.refreshData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "showHistory": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const history = await this.gitOps.getFileHistory(filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: history || "No history found.",
                    language: "git-commit",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }
        }
    }

    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        const countText = count > 0 ? ` (${count})` : "";
        this.view.description = this.repositoryLabel
            ? `${this.repositoryLabel}${countText}`
            : count > 0
              ? String(count)
              : "";
    }

    private postGraphCommitDetailState(): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        if (this.selectedCommitDetail) {
            this.postToWebview({
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.commitDetailFolderIconsByName,
                iconFonts,
            });
            return;
        }
        this.postToWebview({ type: "clearCommitDetail" });
    }

    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated.detail;
        this.commitDetailFolderIconsByName = decorated.folderIconsByName;
        this.postGraphCommitDetailState();
    }

    private postToWebview(msg: InboundMessage | CommitGraphInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private getWorkspaceRoot(): vscode.Uri {
        if (this.repoRootUri) return this.repoRootUri;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder is open.");
        }
        return workspaceRoot;
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitpanel.js",
            title: "Commit",
            backgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        });
    }

    private getCommitDraftStorageKey(): string {
        const storageRoot =
            this.repoRootUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!storageRoot) {
            throw new Error("No workspace folder is open.");
        }
        return `${CommitPanelViewProvider.COMMIT_DRAFT_KEY_PREFIX}${storageRoot}`;
    }

    private getStoredCommitDraft(): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey()) ?? "";
    }
    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onDidChangeFileCount.dispose();
        this._onDidChangeWorkingTree.dispose();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
    }

    private async maybeOfferPublishBranch(): Promise<void> {
        try {
            const hasCommits = await this.gitOps.hasAnyCommits();
            if (!hasCommits) return;

            const branches = await this.gitOps.getBranches();
            const currentBranch = branches.find((b) => b.isCurrent);
            if (!currentBranch) return;

            // Already published — nothing to do
            if (currentBranch.upstream) return;

            const publish = await vscode.window.showInformationMessage(
                `Branch "${currentBranch.name}" has not been published.`,
                "Publish Branch...",
            );
            if (publish === "Publish Branch...") {
                await vscode.commands.executeCommand("intelligit.publishBranch");
            }
        } catch {
            // Silently ignore — publish is optional, don't block the user
        }
    }

    private refreshDataWithErrorHandling(): void {
        this.refreshData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }

    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() => this.refreshDataWithErrorHandling()),
        );
    }

    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
