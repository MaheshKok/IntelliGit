import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (message: unknown) => void | Promise<void>;

class FakeEventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
    };
    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }
    dispose = vi.fn();
}

class FakeTreeItem {
    public iconPath?: unknown;
    public contextValue?: string;
    public description?: string;
    public command?: unknown;
    constructor(
        public readonly label: string,
        public readonly collapsibleState: number = 0,
    ) {}
}

class FakeThemeIcon {
    constructor(
        public readonly id: string,
        public readonly color?: unknown,
    ) {}
}

class FakeThemeColor {
    constructor(public readonly id: string) {}
}

const showErrorMessage = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(async () => undefined);
const showInformationMessage = vi.fn(async () => undefined);
const showTextDocument = vi.fn(async () => undefined);
const executeCommand = vi.fn(async () => undefined);
const openTextDocument = vi.fn(async (arg) => arg);
const postMessageSpy = vi.fn();
const withProgress = vi.fn(
    async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() },
        ),
);

const workspaceState: {
    workspaceFolders: Array<{ uri: { fsPath: string; path: string } }> | undefined;
} = {
    workspaceFolders: [{ uri: { fsPath: "/repo", path: "/repo" } }],
};

function createMemento(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
        get: vi.fn((key: string) => store.get(key)),
        update: vi.fn(async (key: string, value: string | undefined) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        }),
    };
}

const vscodeMock = {
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
        joinPath: (
            base: { fsPath?: string; path?: string },
            ...segments: string[]
        ): { fsPath: string; path: string } => {
            const basePath = base.fsPath ?? base.path;
            if (!basePath) {
                throw new Error("joinPath base must provide fsPath or path");
            }
            for (const segment of segments) {
                if (typeof segment !== "string") {
                    throw new Error("joinPath segments must be strings");
                }
            }
            const joined = [basePath, ...segments].join("/").replace(/\/+/g, "/");
            return { fsPath: joined, path: joined };
        },
    },
    window: {
        showErrorMessage,
        showWarningMessage,
        showInformationMessage,
        showTextDocument,
        withProgress,
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
        executeCommand,
    },
    workspace: {
        get workspaceFolders() {
            return workspaceState.workspaceFolders as
                | Array<{ uri: { fsPath: string; path: string } }>
                | undefined;
        },
        set workspaceFolders(value: Array<{ uri: { fsPath: string; path: string } }> | undefined) {
            workspaceState.workspaceFolders = value;
        },
        openTextDocument,
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
};

const deleteFileWithFallback = vi.fn(async () => true);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: vi.fn(() => "<html></html>"),
}));
vi.mock("../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});

function createWebviewView() {
    let messageHandler: MessageHandler | undefined;
    let disposeHandler: (() => void) | undefined;

    const webview = {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { fsPath?: string; path?: string }) => ({
            fsPath: `webview:${uri.fsPath ?? uri.path ?? ""}`,
            path: `webview:${uri.path ?? uri.fsPath ?? ""}`,
        }),
        postMessage: postMessageSpy,
        onDidReceiveMessage: vi.fn((cb: MessageHandler) => {
            messageHandler = cb;
            return { dispose: vi.fn() };
        }),
    };

    const view: Record<string, unknown> = {
        webview,
        badge: undefined as { tooltip: string; value: number } | undefined,
        description: undefined as string | undefined,
        onDidDispose: vi.fn((cb: () => void) => {
            disposeHandler = cb;
            return { dispose: vi.fn() };
        }),
    };

    return {
        view,
        send: async (msg: unknown) => {
            if (messageHandler) {
                await messageHandler(msg);
            }
        },
        dispose: () => disposeHandler?.(),
    };
}

function renderedButtonActions(html: string): string[] {
    return Array.from(html.matchAll(/<button[^>]+data-action="([^"]+)"/g)).map((match) => match[1]);
}

function makeGitOpsMock() {
    return {
        getLog: vi.fn(async () => [
            {
                hash: "abc1234",
                shortHash: "abc1234",
                message: "feat: test",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: [],
                refs: [],
            },
        ]),
        getBranches: vi.fn(async () => [
            {
                name: "main",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                ahead: 0,
                behind: 0,
            },
        ]),
        getUnpushedCommitHashes: vi.fn(async () => ["abc1234"]),
        getStatus: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]),
        listShelved: vi.fn(async () => [
            { index: 0, message: "On main: save", date: "2026-02-19T00:00:00Z", hash: "stashhash" },
        ]),
        getShelvedFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 2, deletions: 1 },
        ]),
        stageFiles: vi.fn(async () => undefined),
        unstageFiles: vi.fn(async () => undefined),
        commit: vi.fn(async () => "ok"),
        commitAndPush: vi.fn(async () => "ok"),
        getLastCommitMessage: vi.fn(async () => "last message"),
        getAmendBranchCommits: vi.fn(async () => [
            { shortHash: "abc1234", subject: "feat: amend ctx", date: "2026-02-19T00:00:00Z" },
        ]),
        rollbackAll: vi.fn(async () => undefined),
        rollbackFiles: vi.fn(async () => undefined),
        shelveSave: vi.fn(async () => "saved"),
        shelvePop: vi.fn(async () => "popped"),
        shelveApply: vi.fn(async () => "applied"),
        shelveDelete: vi.fn(async () => "deleted"),
        getShelvedFilePatch: vi.fn(async () => "diff --git a b"),
        getFileHistory: vi.fn(async () => "history line"),
    };
}

async function setupCommitPanelProvider() {
    const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
    const gitOps = makeGitOpsMock();
    const draftStore = createMemento();
    const provider = new CommitPanelViewProvider(
        { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
        gitOps as unknown as object,
        { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
        draftStore as unknown as object,
    );
    const webview = createWebviewView();
    provider.resolveWebviewView(
        webview.view as unknown as object,
        {} as unknown as object,
        {} as unknown as object,
    );
    await webview.send({ type: "ready" });
    return { provider, gitOps, webview, draftStore };
}

describe("view providers integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workspaceState.workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        showWarningMessage.mockResolvedValue(undefined);
    });

    it("OnboardingViewProvider renders clone and open-folder actions when no workspace is open", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-workspace",
            "IntelliGit",
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        const html = (webview.view.webview as { html: string }).html;
        expect(renderedButtonActions(html)).toEqual(["cloneRepository", "openFolder"]);
    });

    it("OnboardingViewProvider can hide empty-workspace actions for the graph view", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-workspace",
            "Graph",
            false,
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        const html = (webview.view.webview as { html: string }).html;
        expect(renderedButtonActions(html)).toEqual([]);
        expect(html).not.toContain("No Folder Open");
        expect(html).not.toContain("Open a folder to get started with IntelliGit.");
        expect(html).not.toContain('alt="IntelliGit"');
    });

    it("OnboardingViewProvider can hide initialize action for the graph view", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-git-repo",
            "Graph",
            false,
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        const html = (webview.view.webview as { html: string }).html;
        expect(renderedButtonActions(html)).toEqual([]);
        expect(html).not.toContain("No Git Repository");
        expect(html).not.toContain(
            "Initialize a Git repository or open an existing one to get started.",
        );
        expect(html).not.toContain('alt="IntelliGit"');
    });

    it("OnboardingViewProvider renders only initialize for an uninitialized workspace", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-git-repo",
            "Commit",
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        const html = (webview.view.webview as { html: string }).html;
        expect(renderedButtonActions(html)).toEqual(["initializeRepository"]);
        expect(html).toContain("btn-primary");
    });

    it("OnboardingViewProvider uses nonce-based CSP for inline style and script blocks", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-git-repo",
            "Commit",
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        const html = (webview.view.webview as { html: string }).html;
        const nonceMatch = html.match(/script-src 'nonce-([^']+)'/);
        expect(nonceMatch?.[1]).toBeTruthy();
        expect(html).not.toContain("'unsafe-inline'");
        expect(html).toContain(`style-src 'nonce-${nonceMatch?.[1]}' vscode-resource:`);
        expect(html).toContain(`<style nonce="${nonceMatch?.[1]}">`);
        expect(html).toContain(`<script nonce="${nonceMatch?.[1]}">`);
    });

    it("OnboardingViewProvider forwards button messages to extension commands", async () => {
        const { OnboardingViewProvider } = await import("../../src/views/OnboardingViewProvider");
        const provider = new OnboardingViewProvider(
            { fsPath: "/ext", path: "/ext" },
            "no-git-repo",
            "Commit",
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "initializeRepository" });
        await webview.send({ type: "cloneRepository" });
        await webview.send({ type: "openFolder" });

        expect(executeCommand).toHaveBeenCalledWith("intelligit.initializeRepository");
        expect(executeCommand).toHaveBeenCalledWith("intelligit.cloneRepository");
        expect(executeCommand).toHaveBeenCalledWith("intelligit.openFolder");
    });

    it("CommitInfoViewProvider handles ready/set/clear lifecycle", async () => {
        const { CommitInfoViewProvider } = await import("../../src/views/CommitInfoViewProvider");
        const provider = new CommitInfoViewProvider({ fsPath: "/ext", path: "/ext" } as unknown as {
            fsPath: string;
            path: string;
        });
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        provider.setCommitDetail({
            hash: "abc",
            shortHash: "abc",
            message: "msg",
            body: "",
            author: "a",
            email: "e",
            date: "d",
            parentHashes: [],
            refs: [],
            files: [],
        });
        expect(postMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "setCommitDetail" }),
        );

        await webview.send({ type: "ready" });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "setCommitDetail" }),
        );

        provider.clear();
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "clear" });

        webview.dispose();
        provider.dispose();
    });

    it("CommitGraphViewProvider handles webview events and refresh/load flows", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        const webview = createWebviewView();

        const selected = vi.fn();
        const branchFilter = vi.fn();
        const branchAction = vi.fn();
        const commitAction = vi.fn();
        const openCommitFileDiff = vi.fn();

        provider.onCommitSelected(selected);
        provider.onBranchFilterChanged(branchFilter);
        provider.onBranchAction(branchAction);
        provider.onCommitAction(commitAction);
        provider.onOpenCommitFileDiff(openCommitFileDiff);

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        provider.setRepositoryLabel("pycharm-git-for-vscode");
        expect(webview.view.description).toBeUndefined();
        await webview.send({ type: "ready" });
        expect(gitOps.getLog).toHaveBeenCalled();

        provider.setBranches([
            {
                name: "main",
                hash: "abc",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "setBranches" }),
        );

        await webview.send({ type: "selectCommit", hash: "abc1234" });
        expect(selected).toHaveBeenCalledWith("abc1234");

        await webview.send({ type: "filterBranch", branch: "main" });
        expect(branchFilter).toHaveBeenCalledWith("main");

        await webview.send({ type: "branchAction", action: "checkout", branchName: "main" });
        expect(branchAction).toHaveBeenCalledWith({ action: "checkout", branchName: "main" });

        await webview.send({ type: "commitAction", action: "copyRevision", hash: "abc1234" });
        expect(commitAction).toHaveBeenCalledWith({
            action: "copyRevision",
            hash: "abc1234",
        });

        await webview.send({
            type: "openCommitFileDiff",
            commitHash: "abc1234",
            filePath: "src/file.ts",
        });
        expect(openCommitFileDiff).toHaveBeenCalledWith({
            commitHash: "abc1234",
            filePath: "src/file.ts",
        });

        const logCallsBeforePagedFetch = gitOps.getLog.mock.calls.length;
        await webview.send({ type: "filterText", text: "feat" });
        await webview.send({ type: "loadMore" });
        expect(gitOps.getLog.mock.calls.length - logCallsBeforePagedFetch).toBe(2);

        gitOps.getLog.mockRejectedValueOnce(new Error("git failed"));
        await provider.refresh();
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Git log error"));

        provider.dispose();
    });

    it("CommitGraphViewProvider rejects invalid webview command payloads", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        const webview = createWebviewView();
        const selected = vi.fn();
        const branchAction = vi.fn();
        const commitAction = vi.fn();
        const openCommitFileDiff = vi.fn();

        provider.onCommitSelected(selected);
        provider.onBranchAction(branchAction);
        provider.onCommitAction(commitAction);
        provider.onOpenCommitFileDiff(openCommitFileDiff);

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "selectCommit", hash: "../not-a-hash" });
        await webview.send({ type: "branchAction", action: "runShell", branchName: "main" });
        await webview.send({ type: "commitAction", action: "resetCurrentToHere", hash: "--bad" });
        await webview.send({
            type: "openCommitFileDiff",
            commitHash: "abc1234",
            filePath: "../secret.txt",
        });

        expect(selected).not.toHaveBeenCalled();
        expect(branchAction).not.toHaveBeenCalled();
        expect(commitAction).not.toHaveBeenCalled();
        expect(openCommitFileDiff).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Commit graph error"),
        );

        provider.dispose();
    });

    it("CommitInfoViewProvider rejects invalid open-file-diff payloads", async () => {
        const { CommitInfoViewProvider } = await import("../../src/views/CommitInfoViewProvider");
        const provider = new CommitInfoViewProvider({ fsPath: "/ext", path: "/ext" } as unknown as {
            fsPath: string;
            path: string;
        });
        const webview = createWebviewView();
        const openCommitFileDiff = vi.fn();

        provider.onOpenCommitFileDiff(openCommitFileDiff);
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({
            type: "openCommitFileDiff",
            commitHash: "abc1234",
            filePath: "../secret.txt",
        });
        await webview.send({
            type: "openCommitFileDiff",
            commitHash: "--bad",
            filePath: "src/a.ts",
        });

        expect(openCommitFileDiff).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Commit file action error"),
        );

        provider.dispose();
    });

    it("CommitPanelViewProvider handles staging and unstaging", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        expect(gitOps.getStatus).toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));

        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        await webview.send({ type: "unstageFiles", paths: ["src/a.ts"] });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.unstageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider marks unpublished branches and routes publish action", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getBranches.mockResolvedValue([
            {
                name: "main",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);

        await webview.send({ type: "refresh" });
        await webview.send({ type: "publishBranch" });

        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                currentBranchHasUpstream: false,
            }),
        );
        expect(executeCommand).toHaveBeenCalledWith("intelligit.publishBranch");
        provider.dispose();
    });

    it("CommitPanelViewProvider preserves stored commit text after successful commit flows", async () => {
        const { provider, gitOps, webview, draftStore } = await setupCommitPanelProvider();
        await webview.send({ type: "saveCommitDraft", message: "feat: keep draft" });
        await webview.send({ type: "commit", message: "", amend: false });
        expect(showWarningMessage).toHaveBeenCalledWith("Enter a commit message.");

        await webview.send({
            type: "commitSelected",
            message: "feat: selected",
            amend: false,
            push: false,
            paths: [],
        });
        expect(showWarningMessage).toHaveBeenCalledWith("Select files to commit.");
        expect(gitOps.stageFiles).not.toHaveBeenCalled();

        await webview.send({ type: "commit", message: "feat: ok", amend: false });
        await webview.send({
            type: "commitSelected",
            message: "feat: selected",
            amend: false,
            push: true,
            paths: ["src/a.ts"],
        });
        await webview.send({ type: "commitAndPush", message: "feat: push", amend: false });
        expect(gitOps.commit).toHaveBeenCalled();
        expect(gitOps.commitAndPush).toHaveBeenCalled();
        expect(withProgress).toHaveBeenCalled();
        expect(draftStore.update).toHaveBeenCalledWith("commitDraft:/repo", "feat: keep draft");
        expect(
            draftStore.update.mock.calls.some(
                ([key, value]: [string, string | undefined]) =>
                    key === "commitDraft:/repo" && value === undefined,
            ),
        ).toBe(false);

        await webview.send({ type: "getLastCommitMessage" });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "lastCommitMessage",
            message: "last message",
        });

        await webview.send({ type: "getAmendBranchCommits" });
        expect(gitOps.getAmendBranchCommits).toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "amendBranchCommits",
            commits: [
                { shortHash: "abc1234", subject: "feat: amend ctx", date: "2026-02-19T00:00:00Z" },
            ],
        });
        provider.dispose();
    });

    it("CommitPanelViewProvider restores and saves commit draft text per repo", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const draftStore = createMemento({ "commitDraft:/repo": "draft from storage" });
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            draftStore as unknown as object,
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "restoreCommitDraft",
            message: "draft from storage",
        });

        await webview.send({ type: "saveCommitDraft", message: "draft changed" });
        expect(draftStore.update).toHaveBeenCalledWith("commitDraft:/repo", "draft changed");

        provider.dispose();
    });

    it("CommitPanelViewProvider validates malformed commit payloads defensively", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        // Each payload exercises a single validation guard independently:
        // 1. Non-string message with valid paths → message guard
        await webview.send({
            type: "commitSelected",
            message: undefined,
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        // 2. Valid message with empty paths → paths guard
        await webview.send({
            type: "commitSelected",
            message: "valid msg",
            amend: false,
            push: false,
            paths: [],
        });
        // 3. Null message on commitAndPush → message guard
        await webview.send({ type: "commitAndPush", message: null, amend: false });

        expect(showWarningMessage).toHaveBeenCalledTimes(3);
        expect(showWarningMessage).toHaveBeenNthCalledWith(1, "Enter a commit message.");
        expect(showWarningMessage).toHaveBeenNthCalledWith(2, "Select files to commit.");
        expect(showWarningMessage).toHaveBeenNthCalledWith(3, "Enter a commit message.");
        expect(gitOps.stageFiles).not.toHaveBeenCalled();
        expect(gitOps.commit).not.toHaveBeenCalled();
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();

        provider.dispose();
    });

    it("CommitPanelViewProvider updates count badges and fires file count after commit", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const draftStore = createMemento();
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            draftStore as unknown as object,
        );
        const webview = createWebviewView();

        // Register event listener BEFORE resolving the view (which triggers refreshData)
        const counts: number[] = [];
        provider.onDidChangeFileCount((n: number) => counts.push(n));

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        provider.setRepositoryLabel("pycharm-git-for-vscode");
        await webview.send({ type: "ready" });

        const view = (provider as unknown as { view: Record<string, unknown> }).view;

        // Initial state: getStatus returns 1 file -> numeric description,
        // and onDidChangeFileCount fires with count 1 (badge managed externally by badgeView).
        expect(view.description).toBe("1");
        expect(counts).toContain(1);

        // After commit, getStatus returns 0 files -> description cleared and count fires 0.
        gitOps.getStatus.mockResolvedValueOnce([]);
        await webview.send({ type: "commit", message: "feat: clear", amend: false });
        expect(view.description).toBe("");
        expect(counts).toContain(0);

        provider.dispose();
    });

    it("CommitPanelViewProvider handles rollback actions", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: [] });
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: ["src/a.ts"] });
        expect(gitOps.rollbackAll).toHaveBeenCalled();
        expect(gitOps.rollbackFiles).toHaveBeenCalledWith(["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider handles diff/open/history actions", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(executeCommand).toHaveBeenCalledWith("git.openChange", expect.any(Object));
        await webview.send({ type: "openFile", path: "src/a.ts" });
        await webview.send({ type: "showHistory", path: "src/a.ts" });
        expect(openTextDocument).toHaveBeenCalled();
        expect(showTextDocument).toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider handles shelf operations", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "shelveSave", name: "work", paths: ["src/a.ts"] });
        await webview.send({ type: "shelfPop", index: 0 });
        await webview.send({ type: "shelfApply", index: 0 });
        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "shelfDelete", index: 0 });
        expect(gitOps.shelveSave).toHaveBeenCalled();
        expect(gitOps.shelvePop).toHaveBeenCalledWith(0);
        expect(gitOps.shelveApply).toHaveBeenCalledWith(0);
        expect(gitOps.shelveDelete).toHaveBeenCalledWith(0);

        await webview.send({ type: "shelfSelect", index: Number.NaN });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Expected number"),
            }),
        );

        await webview.send({ type: "showShelfDiff", index: 0, path: "src/a.ts" });
        expect(gitOps.getShelvedFilePatch).toHaveBeenCalledWith(0, "src/a.ts");
        expect(openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                content: "diff --git a b",
                language: "diff",
            }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider handles file delete with confirmation", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "deleteFile", path: "src/a.ts" });
        expect(deleteFileWithFallback).toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider rejects malformed array payloads strictly", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        // Mixed array with non-string elements should fail, not silently filter
        await webview.send({ type: "stageFiles", paths: ["src/a.ts", 42] });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("all elements"));
        // Non-array should also fail
        await webview.send({ type: "unstageFiles", paths: "not-an-array" });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Expected string[]"));
        provider.dispose();
    });

    it("CommitPanelViewProvider rejects path traversal in file operations", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "showDiff", path: "../etc/passwd" });
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("escaping repo root"),
        );
        await webview.send({ type: "openFile", path: "/etc/passwd" });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("non-relative"));
        provider.dispose();
    });

    it("CommitPanelViewProvider validates commitSelected paths before staging", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        await webview.send({
            type: "commitSelected",
            message: "feat: guarded",
            amend: false,
            push: false,
            paths: ["../etc/passwd"],
        });

        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("escaping repo root"),
        );
        expect(gitOps.stageFiles).not.toHaveBeenCalled();
        expect(gitOps.commit).not.toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider surfaces operation errors", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.stageFiles.mockRejectedValueOnce(new Error("stage failed"));
        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        expect(showErrorMessage).toHaveBeenCalledWith("stage failed");
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "error", message: "stage failed" });
        provider.dispose();
    });

    it("CommitPanelViewProvider guards workspace-dependent actions", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        workspaceState.workspaceFolders = undefined;
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(showErrorMessage).toHaveBeenCalledWith("No workspace folder is open.");

        provider.dispose();
    });
});
