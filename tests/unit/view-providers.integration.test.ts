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

const workspaceState = {
    workspaceFolders: [{ uri: { fsPath: "/repo", path: "/repo" } }],
};

const vscodeMock = {
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
        joinPath: (...parts: unknown[]) => ({
            fsPath: parts
                .map((part) => (typeof part === "string" ? part : (part as { fsPath?: string; path?: string }).fsPath ?? (part as { path?: string }).path ?? ""))
                .join("/")
                .replace(/\/+/g, "/"),
            path: parts
                .map((part) => (typeof part === "string" ? part : (part as { path?: string; fsPath?: string }).path ?? (part as { fsPath?: string }).fsPath ?? ""))
                .join("/")
                .replace(/\/+/g, "/"),
        }),
    },
    window: {
        showErrorMessage,
        showWarningMessage,
        showInformationMessage,
        showTextDocument,
    },
    commands: {
        executeCommand,
    },
    workspace: {
        get workspaceFolders() {
            return workspaceState.workspaceFolders as Array<{ uri: { fsPath: string; path: string } }> | undefined;
        },
        set workspaceFolders(value: Array<{ uri: { fsPath: string; path: string } }> | undefined) {
            workspaceState.workspaceFolders = value;
        },
        openTextDocument,
    },
};

const deleteFileWithFallback = vi.fn(async () => true);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: vi.fn(() => "<html></html>"),
}));
vi.mock("../../src/utils/fileOps", () => ({
    deleteFileWithFallback,
}));

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

    const view = {
        webview,
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
        getUnpushedCommitHashes: vi.fn(async () => ["abc1234"]),
        getStatus: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]),
        listShelved: vi.fn(async () => [{ index: 0, message: "On main: save", date: "2026-02-19T00:00:00Z", hash: "stashhash" }]),
        getShelvedFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 2, deletions: 1 },
        ]),
        stageFiles: vi.fn(async () => undefined),
        unstageFiles: vi.fn(async () => undefined),
        commit: vi.fn(async () => "ok"),
        commitAndPush: vi.fn(async () => "ok"),
        getLastCommitMessage: vi.fn(async () => "last message"),
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

describe("view providers integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workspaceState.workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        showWarningMessage.mockResolvedValue(undefined);
    });

    it("BranchTreeProvider builds sections, local and remote children", async () => {
        const { BranchTreeProvider, BranchItem } = await import("../../src/views/BranchTreeProvider");
        const provider = new BranchTreeProvider();

        provider.refresh([
            {
                name: "main",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                ahead: 1,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "abc1234",
                isRemote: true,
                isCurrent: false,
                ahead: 0,
                behind: 0,
                remote: "origin",
            },
        ]);

        const root = provider.getChildren();
        expect(root.length).toBeGreaterThanOrEqual(3);
        expect((root[0] as BranchItem).label).toContain("HEAD");

        const localSection = root.find((item) => item.label === "Local")!;
        const remoteSection = root.find((item) => item.label === "Remote")!;
        const locals = provider.getChildren(localSection);
        const remoteGroups = provider.getChildren(remoteSection);
        const remoteBranches = provider.getChildren(remoteGroups[0]);

        expect(locals.map((b) => b.label)).toContain("main");
        expect(remoteGroups.map((g) => g.label)).toContain("origin");
        expect(remoteBranches.map((b) => b.label)).toContain("main");
        provider.dispose();
    });

    it("CommitInfoViewProvider handles ready/set/clear lifecycle", async () => {
        const { CommitInfoViewProvider } = await import("../../src/views/CommitInfoViewProvider");
        const provider = new CommitInfoViewProvider({ fsPath: "/ext", path: "/ext" } as any);
        const webview = createWebviewView();

        provider.resolveWebviewView(webview.view as any, {} as any, {} as any);
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
        expect(postMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setCommitDetail" }));

        await webview.send({ type: "ready" });
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "setCommitDetail" }));

        provider.clear();
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "clear" });

        webview.dispose();
        provider.dispose();
    });

    it("CommitGraphViewProvider handles webview events and refresh/load flows", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider({ fsPath: "/ext", path: "/ext" } as any, gitOps as any);
        const webview = createWebviewView();

        const selected = vi.fn();
        const branchFilter = vi.fn();
        const branchAction = vi.fn();
        const commitAction = vi.fn();

        provider.onCommitSelected(selected);
        provider.onBranchFilterChanged(branchFilter);
        provider.onBranchAction(branchAction);
        provider.onCommitAction(commitAction);

        provider.resolveWebviewView(webview.view as any, {} as any, {} as any);
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
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "setBranches" }));

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
            targetBranch: undefined,
        });

        await webview.send({ type: "filterText", text: "feat" });
        await webview.send({ type: "loadMore" });
        expect(gitOps.getLog.mock.calls.length).toBeGreaterThanOrEqual(3);

        gitOps.getLog.mockRejectedValueOnce(new Error("git failed"));
        await provider.refresh();
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Git log error"));

        provider.dispose();
    });

    it("CommitPanelViewProvider handles commit/shelf/file actions and errors", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitPanelViewProvider({ fsPath: "/ext", path: "/ext" } as any, gitOps as any);
        const webview = createWebviewView();

        provider.resolveWebviewView(webview.view as any, {} as any, {} as any);
        await webview.send({ type: "ready" });
        expect(gitOps.getStatus).toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));

        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        await webview.send({ type: "unstageFiles", paths: ["src/a.ts"] });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.unstageFiles).toHaveBeenCalledWith(["src/a.ts"]);

        await webview.send({ type: "commit", message: "", amend: false });
        expect(showWarningMessage).toHaveBeenCalledWith("Commit message cannot be empty.");

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

        await webview.send({ type: "getLastCommitMessage" });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "lastCommitMessage",
            message: "last message",
        });

        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: [] });
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: ["src/a.ts"] });
        expect(gitOps.rollbackAll).toHaveBeenCalled();
        expect(gitOps.rollbackFiles).toHaveBeenCalledWith(["src/a.ts"]);

        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(executeCommand).toHaveBeenCalledWith("git.openChange", expect.any(Object));

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
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ selectedShelfIndex: null }));

        await webview.send({ type: "showShelfDiff", index: 0, path: "src/a.ts" });
        await webview.send({ type: "openFile", path: "src/a.ts" });
        await webview.send({ type: "showHistory", path: "src/a.ts" });
        expect(openTextDocument).toHaveBeenCalled();
        expect(showTextDocument).toHaveBeenCalled();

        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "deleteFile", path: "src/a.ts" });
        expect(deleteFileWithFallback).toHaveBeenCalled();

        gitOps.stageFiles.mockRejectedValueOnce(new Error("stage failed"));
        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        expect(showErrorMessage).toHaveBeenCalledWith("stage failed");
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "error", message: "stage failed" });

        workspaceState.workspaceFolders = undefined;
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(showErrorMessage).toHaveBeenCalledWith("No workspace folder is open.");

        provider.dispose();
    });
});
