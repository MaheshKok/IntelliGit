import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CommandHandler = (...args: unknown[]) => unknown;

const registeredCommands = new Map<string, CommandHandler>();
const mockDisposables: Array<{ dispose: () => void }> = [];
const executeCommandFallback = vi.fn(async () => undefined);
const showInformationMessage = vi.fn(async () => undefined);
const showErrorMessage = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(
    async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0],
);
const showInputBox = vi.fn(async (opts?: { prompt?: string; value?: string }) => {
    if (!opts?.prompt) return "input";
    if (opts.prompt.includes("New branch")) return "feature/new";
    if (opts.prompt.includes("New tag")) return "v1.0.0";
    if (opts.prompt.includes("Rename")) return "renamed-branch";
    if (opts.prompt.includes("Edit commit message")) return "edited message";
    return "input";
});
const showSaveDialog = vi.fn(async () => ({ fsPath: "/tmp/patch.diff", path: "/tmp/patch.diff" }));
const showQuickPick = vi.fn(async (items: unknown[]) => items[0]);
const showTextDocument = vi.fn(async () => undefined);
const openTextDocument = vi.fn(async (arg: unknown) => arg);
const writeFile = vi.fn(async () => undefined);
const clipboardWriteText = vi.fn(async () => undefined);
const createOutputChannel = vi.fn(() => ({ appendLine: vi.fn() }));
const withProgress = vi.fn(
    async (
        _options: unknown,
        task: (
            progress: { report: ReturnType<typeof vi.fn> },
            token: {
                isCancellationRequested: boolean;
                onCancellationRequested: ReturnType<typeof vi.fn>;
            },
        ) => Promise<unknown>,
    ) =>
        task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() },
        ),
);
const registerWebviewViewProvider = vi.fn(() => ({ dispose: vi.fn() }));
const registerWebviewPanelSerializer = vi.fn(() => ({ dispose: vi.fn() }));
const registerTextDocumentContentProvider = vi.fn(() => ({ dispose: vi.fn() }));
const createTerminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() }));
const textDocListeners: Array<() => void> = [];
const closeDocListeners: Array<
    (document: { uri: { scheme: string; toString: () => string } }) => void
> = [];
const saveDocListeners: Array<() => void> = [];
const createFileListeners: Array<() => void> = [];
const deleteFileListeners: Array<() => void> = [];
const renameFileListeners: Array<() => void> = [];
const configurationValues = new Map<string, unknown>();
const configurationUpdate = vi.fn(async (key: string, value: unknown) => {
    configurationValues.set(key, value);
});
type FsWatchCallback = (...args: unknown[]) => void;
const fsWatchCallbacks: FsWatchCallback[] = [];

let workspaceFolders: Array<{ uri: { fsPath: string; path: string } }> | undefined = [
    { uri: { fsPath: "/repo", path: "/repo" } },
];

class MockDisposable {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
        this.fn();
    }
}

class MockEventEmitter<T> {
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

const defaultExecutorRunImpl = async (args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "feed1234";
    if (args[0] === "format-patch") return "patch-content";
    if (args[0] === "status" && args[1] === "--porcelain") return "";
    if (args[0] === "rev-list" && args[1] === "--reverse" && args[2] === "--parents") {
        return ["a1b2c3d4 parent0", "feed1234 a1b2c3d4"].join("\n");
    }
    if (args[0] === "log" && args.includes("--format=%B")) return "current commit body";
    if (args[0] === "log" && args.includes("--format=%s")) return "first commit\nsecond commit";
    if (args[0] === "rev-list" && args[1] === "--count") return "2";
    if (args[0] === "rev-list" && args[1] === "--parents") {
        const hash = args[args.length - 1];
        if (hash === "deadbee") return `${hash} parent1 parent2`;
        return `${hash} parent1`;
    }
    if (args[0] === "merge-base" && args.includes("feature-unmerged")) {
        throw new Error("not ancestor");
    }
    if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-force") {
        throw new Error("not fully merged");
    }
    return "";
};
const executorRun = vi.fn(defaultExecutorRunImpl);

const gitOpsState = {
    isRepository: vi.fn(async () => true),
    getRepositoryRoot: vi.fn(async () => "/repo"),
    getBranches: vi.fn(async () => [
        { name: "main", hash: "feed1234", isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
        {
            name: "feature-local",
            hash: "a1b2c3d4",
            isRemote: false,
            isCurrent: false,
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/main",
            hash: "feed1234",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/feature-remote",
            hash: "a1b2c3d4",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/force-fail",
            hash: "abc123",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
    ]),
    getCommitDetail: vi.fn(async (hash: string) => ({
        hash,
        shortHash: hash.slice(0, 7),
        message: "msg",
        body: "",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: [],
        refs: [],
        files: [],
    })),
    getUnpushedCommitHashes: vi.fn(async () => ["a1b2c3d4", "feed1234", "deadbee"]),
    getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) => `content:${ref}`),
    rollbackFiles: vi.fn(async () => undefined),
    shelveSave: vi.fn(async () => "saved"),
    getFileHistory: vi.fn(async () => "history"),
    getStatus: vi.fn(async () => []),
    listShelved: vi.fn(async () => []),
    getShelvedFiles: vi.fn(async () => []),
    getConflictedFiles: vi.fn(async () => []),
    getConflictFilesDetailed: vi.fn(async () => []),
    acceptConflictSide: vi.fn(async () => undefined),
    getConflictFileVersions: vi.fn(async () => ({ base: "", ours: "", theirs: "" })),
    stageFile: vi.fn(async () => undefined),
    push: vi.fn(async () => ""),
};

const deleteFileWithFallback = vi.fn(async () => true);
type MockExtensionContext = {
    extensionUri: { fsPath: string; path: string };
    workspaceState?: {
        get: <T>(key: string, defaultValue?: T) => T | undefined;
        update: ReturnType<typeof vi.fn>;
    };
    subscriptions: Array<{ dispose: () => void }>;
};

let latestCommitGraphProvider: MockCommitGraphViewProvider | undefined;
let latestCommitPanelProvider: MockCommitPanelViewProvider | undefined;
let latestUndockedProvider: MockUndockedViewProvider | undefined;

function updateLatestUndockedProvider(provider: MockUndockedViewProvider): void {
    latestUndockedProvider = provider;
}

class MockCommitGraphViewProvider {
    static readonly viewType = "intelligit.commitGraph";
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchFilterEmitter = new MockEventEmitter<string | null>();
    private branchActionEmitter = new MockEventEmitter<{ action: string; branchName: string }>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();

    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitGraphProvider = this;
    }
    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchFilterChanged = this.branchFilterEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    setBranches = vi.fn();
    refresh = vi.fn(async () => undefined);
    filterByBranch = vi.fn(async () => undefined);
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
    setRepositoryLabel = vi.fn();
    dispose = vi.fn();

    emitCommitSelected(hash: string): void {
        this.commitSelectedEmitter.fire(hash);
    }
    emitBranchFilterChanged(value: string | null): void {
        this.branchFilterEmitter.fire(value);
    }
    emitBranchAction(payload: { action: string; branchName: string }): void {
        this.branchActionEmitter.fire(payload);
    }
    emitCommitAction(payload: { action: string; hash: string }): void {
        this.commitActionEmitter.fire(payload);
    }
    emitOpenCommitFileDiff(payload: { commitHash: string; filePath: string }): void {
        this.openCommitFileDiffEmitter.fire(payload);
    }
}

class MockCommitInfoViewProvider {
    static readonly viewType = "intelligit.commitFiles";
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    setCommitDetail = vi.fn();
    clear = vi.fn();
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    dispose = vi.fn();
}

class MockCommitPanelViewProvider {
    static readonly viewType = "intelligit.commitPanel";
    private fileCountEmitter = new MockEventEmitter<number>();
    private workingTreeEmitter = new MockEventEmitter<void>();
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchFilterEmitter = new MockEventEmitter<string | null>();
    private branchActionEmitter = new MockEventEmitter<{ action: string; branchName: string }>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitPanelProvider = this;
    }
    onDidChangeFileCount = this.fileCountEmitter.event;
    onDidChangeWorkingTree = this.workingTreeEmitter.event;
    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchFilterChanged = this.branchFilterEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    refresh = vi.fn(async () => undefined);
    setRepositoryRootUri = vi.fn();
    setRepositoryLabel = vi.fn();
    setBranches = vi.fn();
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
    dispose = vi.fn();
    emitFileCount(count: number): void {
        this.fileCountEmitter.fire(count);
    }
    emitWorkingTreeChanged(): void {
        this.workingTreeEmitter.fire(undefined);
    }
    emitCommitSelected(hash: string): void {
        this.commitSelectedEmitter.fire(hash);
    }
    emitBranchFilterChanged(value: string | null): void {
        this.branchFilterEmitter.fire(value);
    }
    emitBranchAction(payload: { action: string; branchName: string }): void {
        this.branchActionEmitter.fire(payload);
    }
    emitCommitAction(payload: { action: string; hash: string }): void {
        this.commitActionEmitter.fire(payload);
    }
    emitOpenCommitFileDiff(payload: { commitHash: string; filePath: string }): void {
        this.openCommitFileDiffEmitter.fire(payload);
    }
}

class MockUndockedViewProvider {
    static readonly viewType = "intelligit.undocked";
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchActionEmitter = new MockEventEmitter<{ action: string; branchName: string }>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    private fileCountEmitter = new MockEventEmitter<number>();
    private workingTreeEmitter = new MockEventEmitter<void>();
    private dockRequestedEmitter = new MockEventEmitter<void>();
    private disposeEmitter = new MockEventEmitter<void>();

    constructor(_uri: unknown, _gitOps: unknown, _repoRootUri: unknown) {
        updateLatestUndockedProvider(this);
    }

    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    onDidChangeFileCount = this.fileCountEmitter.event;
    onDidChangeWorkingTree = this.workingTreeEmitter.event;
    onDockRequested = this.dockRequestedEmitter.event;
    onDidDispose = this.disposeEmitter.event;
    setRepositoryLabel = vi.fn();
    setRepositoryRootUri = vi.fn();
    setBranches = vi.fn();
    setCommitDetail = vi.fn();
    open = vi.fn(async () => undefined);
    refresh = vi.fn(async () => undefined);
    reveal = vi.fn();
    dispose = vi.fn(() => {
        this.disposeEmitter.fire(undefined);
    });
    emitWorkingTreeChanged(): void {
        this.workingTreeEmitter.fire(undefined);
    }
    requestDock(): void {
        this.dockRequestedEmitter.fire(undefined);
    }
}

vi.mock("fs", () => ({
    watch: vi.fn((...args: unknown[]) => {
        const callback = args[args.length - 1];
        if (typeof callback === "function") fsWatchCallbacks.push(callback);
        return { close: vi.fn() };
    }),
}));

vi.mock("vscode", () => ({
    Disposable: MockDisposable,
    EventEmitter: MockEventEmitter,
    ThemeIcon: class {
        constructor(_id: string, _color?: unknown) {}
    },
    ThemeColor: class {
        constructor(_id: string) {}
    },
    TreeItem: class {
        constructor(_label: string, _state?: unknown) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
    ProgressLocation: { Notification: 15 },
    Uri: {
        file: (value: string) => ({ fsPath: value, path: value }),
        parse: (value: string) => ({
            fsPath: value,
            path: value,
            scheme: value.split(":", 1)[0],
            toString: () => value,
        }),
        joinPath: (base: { fsPath?: string; path?: string }, ...parts: string[]) => {
            const prefix = base.fsPath ?? base.path ?? "";
            const joined = [prefix, ...parts].join("/").replace(/\/+/g, "/");
            return { fsPath: joined, path: joined };
        },
    },
    commands: {
        registerCommand: vi.fn((id: string, handler: CommandHandler) => {
            registeredCommands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
            const handler = registeredCommands.get(id);
            if (handler) return handler(...args);
            return executeCommandFallback(id, ...args);
        }),
    },
    window: {
        registerWebviewViewProvider,
        registerWebviewPanelSerializer,
        createTreeView: vi.fn(() => ({
            badge: undefined,
            dispose: vi.fn(),
        })),
        createWebviewPanel: vi.fn(() => {
            const msgListeners: Array<(msg: unknown) => void> = [];
            const disposeListeners: Array<() => void> = [];
            return {
                webview: {
                    options: {},
                    html: "",
                    onDidReceiveMessage: vi.fn((listener: (msg: unknown) => void) => {
                        msgListeners.push(listener);
                        return { dispose: vi.fn() };
                    }),
                    postMessage: vi.fn(async () => true),
                    asWebviewUri: vi.fn((uri: { path?: string }) => uri),
                    cspSource: "https://test.csp",
                },
                onDidDispose: vi.fn((listener: () => void) => {
                    disposeListeners.push(listener);
                    return { dispose: vi.fn() };
                }),
                reveal: vi.fn(),
                dispose: vi.fn(() => {
                    for (const listener of disposeListeners) listener();
                }),
            };
        }),
        showInformationMessage,
        showErrorMessage,
        showWarningMessage,
        showInputBox,
        showSaveDialog,
        showQuickPick,
        showTextDocument,
        createTerminal,
        createOutputChannel,
        withProgress,
    },
    workspace: {
        get workspaceFolders() {
            return workspaceFolders;
        },
        getConfiguration: vi.fn((_section?: string) => ({
            get: <T>(key: string, defaultValue: T) =>
                configurationValues.has(key) ? (configurationValues.get(key) as T) : defaultValue,
            update: configurationUpdate,
        })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        fs: { writeFile },
        openTextDocument,
        registerTextDocumentContentProvider,
        onDidCloseTextDocument: vi.fn(
            (listener: (document: { uri: { scheme: string; toString: () => string } }) => void) => {
                closeDocListeners.push(listener);
                return { dispose: vi.fn() };
            },
        ),
        onDidChangeTextDocument: vi.fn((listener: () => void) => {
            textDocListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidSaveTextDocument: vi.fn((listener: () => void) => {
            saveDocListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidCreateFiles: vi.fn((listener: () => void) => {
            createFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidDeleteFiles: vi.fn((listener: () => void) => {
            deleteFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidRenameFiles: vi.fn((listener: () => void) => {
            renameFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
    },
    env: {
        clipboard: { writeText: clipboardWriteText },
    },
}));

vi.mock("../../src/git/executor", () => ({
    GitExecutor: class {
        repoRoot: string;
        constructor(repoRoot: string) {
            this.repoRoot = repoRoot;
        }
        run = executorRun;
        setRoot = vi.fn((repoRoot: string) => {
            this.repoRoot = repoRoot;
        });
    },
}));

vi.mock("../../src/git/operations", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/git/operations")>();
    return {
        UpstreamPushDeclinedError: actual.UpstreamPushDeclinedError,
        GitOps: class {
            constructor(private readonly executor: { repoRoot: string }) {}
            isRepository = () => gitOpsState.isRepository(this.executor.repoRoot);
            getRepositoryRoot = () => gitOpsState.getRepositoryRoot(this.executor.repoRoot);
            getBranches = gitOpsState.getBranches;
            getCommitDetail = gitOpsState.getCommitDetail;
            getUnpushedCommitHashes = gitOpsState.getUnpushedCommitHashes;
            getFileContentAtRef = gitOpsState.getFileContentAtRef;
            rollbackFiles = gitOpsState.rollbackFiles;
            shelveSave = gitOpsState.shelveSave;
            getFileHistory = gitOpsState.getFileHistory;
            getStatus = gitOpsState.getStatus;
            listShelved = gitOpsState.listShelved;
            getShelvedFiles = gitOpsState.getShelvedFiles;
            getConflictedFiles = gitOpsState.getConflictedFiles;
            getConflictFilesDetailed = gitOpsState.getConflictFilesDetailed;
            acceptConflictSide = gitOpsState.acceptConflictSide;
            getConflictFileVersions = gitOpsState.getConflictFileVersions;
            stageFile = gitOpsState.stageFile;
            push = gitOpsState.push;
            init = async (_repoPath: string) => executorRun(["init"]);
        },
    };
});

vi.mock("../../src/views/CommitGraphViewProvider", () => ({
    CommitGraphViewProvider: MockCommitGraphViewProvider,
}));

vi.mock("../../src/views/CommitInfoViewProvider", () => ({
    CommitInfoViewProvider: MockCommitInfoViewProvider,
}));

vi.mock("../../src/views/CommitPanelViewProvider", () => ({
    CommitPanelViewProvider: MockCommitPanelViewProvider,
}));

vi.mock("../../src/views/UndockedViewProvider", () => ({
    UndockedViewProvider: MockUndockedViewProvider,
}));

vi.mock("../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});

async function waitForAsync(): Promise<void> {
    const maxPasses = 8;
    for (let i = 0; i < maxPasses; i++) {
        await Promise.resolve();
        try {
            await vi.runAllTimersAsync();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isExpectedTimerError =
                message.includes("Timers are not mocked") ||
                message.includes("Cannot call") ||
                message.includes("runAllTimers");
            if (!isExpectedTimerError) throw error;
        }
    }
    await Promise.resolve();
}

type FakeWebviewView = {
    view: {
        webview: {
            options: Record<string, unknown>;
            html: string;
            onDidReceiveMessage: ReturnType<typeof vi.fn>;
            asWebviewUri: (uri: { fsPath?: string; path?: string }) => { fsPath: string; path: string };
        };
        onDidDispose: ReturnType<typeof vi.fn>;
    };
    send: (message: unknown) => Promise<void>;
};

function createFakeWebviewView(): FakeWebviewView {
    let messageHandler: ((message: unknown) => void | Promise<void>) | undefined;
    const webview = {
        options: {},
        html: "",
        asWebviewUri: (uri: { fsPath?: string; path?: string }) => ({
            fsPath: `webview:${uri.fsPath ?? uri.path ?? ""}`,
            path: `webview:${uri.path ?? uri.fsPath ?? ""}`,
        }),
        onDidReceiveMessage: vi.fn((handler: (message: unknown) => void | Promise<void>) => {
            messageHandler = handler;
            return { dispose: vi.fn() };
        }),
    };
    return {
        view: {
            webview,
            onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        },
        send: async (message: unknown) => {
            await messageHandler?.(message);
        },
    };
}

function resolveRegisteredWebviewProvider(viewType: string): FakeWebviewView {
    const provider = registerWebviewViewProvider.mock.calls.find(([id]) => id === viewType)?.[1] as
        | {
              resolveWebviewView: (
                  view: unknown,
                  context: unknown,
                  token: unknown,
              ) => void | Promise<void>;
          }
        | undefined;
    if (!provider) {
        throw new Error(`No provider registered for ${viewType}`);
    }
    const webview = createFakeWebviewView();
    provider.resolveWebviewView(webview.view, {}, {});
    return webview;
}

function renderedButtonActions(html: string): string[] {
    return Array.from(html.matchAll(/<button[^>]+data-action="([^"]+)"/g)).map((match) => match[1]);
}

function createWorkspaceState(
    initial: Record<string, unknown> = {},
): MockExtensionContext["workspaceState"] {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
        get: vi.fn(<T>(key: string, defaultValue?: T) =>
            values.has(key) ? (values.get(key) as T) : defaultValue,
        ),
        update: vi.fn(async (key: string, value: unknown) => {
            values.set(key, value);
        }),
    };
}

describe("extension integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        registeredCommands.clear();
        mockDisposables.length = 0;
        textDocListeners.length = 0;
        closeDocListeners.length = 0;
        saveDocListeners.length = 0;
        createFileListeners.length = 0;
        deleteFileListeners.length = 0;
        renameFileListeners.length = 0;
        fsWatchCallbacks.length = 0;
        configurationValues.clear();
        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        latestCommitGraphProvider = undefined;
        latestCommitPanelProvider = undefined;
        latestUndockedProvider = undefined;

        executorRun.mockImplementation(defaultExecutorRunImpl);
        gitOpsState.isRepository.mockResolvedValue(true);
        gitOpsState.getBranches.mockResolvedValue([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-remote",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/force-fail",
                hash: "abc123",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        gitOpsState.getCommitDetail.mockImplementation(async (hash: string) => ({
            hash,
            shortHash: hash.slice(0, 7),
            message: "msg",
            body: "",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
            files: [],
        }));
        gitOpsState.getUnpushedCommitHashes.mockResolvedValue(["a1b2c3d4", "feed1234", "deadbee"]);
        gitOpsState.getFileContentAtRef.mockImplementation(
            async (_filePath: string, ref: string) => `content:${ref}`,
        );
        gitOpsState.rollbackFiles.mockResolvedValue(undefined);
        gitOpsState.shelveSave.mockResolvedValue("saved");
        gitOpsState.getFileHistory.mockResolvedValue("history");
        gitOpsState.getConflictedFiles.mockResolvedValue([]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.acceptConflictSide.mockResolvedValue(undefined);
        deleteFileWithFallback.mockResolvedValue(true);

        showWarningMessage.mockImplementation(
            async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0],
        );
        showInputBox.mockImplementation(async (opts?: { prompt?: string; value?: string }) => {
            if (!opts?.prompt) return "input";
            if (opts.prompt.includes("New branch")) return "feature/new";
            if (opts.prompt.includes("New tag")) return "v1.0.0";
            if (opts.prompt.includes("Rename")) return "renamed-branch";
            if (opts.prompt.includes("Edit commit message")) return "edited message";
            return "input";
        });
        showSaveDialog.mockResolvedValue({
            fsPath: "/tmp/patch.diff",
            path: "/tmp/patch.diff",
        } as unknown as { fsPath: string; path: string });
        showQuickPick.mockImplementation(
            async (items: Array<{ parentNumber: number }>) => items[0],
        );
    });

    it("activates onboarding with clone and open-folder actions when no workspace is open", async () => {
        workspaceFolders = undefined;
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const graphWebview = resolveRegisteredWebviewProvider("intelligit.commitGraph");
        const panelWebview = resolveRegisteredWebviewProvider("intelligit.commitPanel");
        await registeredCommands.get("intelligit.openUndocked")?.();
        await registeredCommands.get("intelligit.toggleUndocked")?.();

        expect(renderedButtonActions(graphWebview.view.webview.html)).toEqual([
            "cloneRepository",
            "openFolder",
        ]);
        expect(renderedButtonActions(panelWebview.view.webview.html)).toEqual([
            "cloneRepository",
            "openFolder",
        ]);
        expect(registeredCommands.has("intelligit.cloneRepository")).toBe(true);
        expect(registeredCommands.has("intelligit.openFolder")).toBe(true);
        expect(registeredCommands.has("intelligit.openUndocked")).toBe(true);
        expect(registeredCommands.has("intelligit.dockWindow")).toBe(true);
        expect(registeredCommands.has("intelligit.toggleUndocked")).toBe(true);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "No Git repositories found in this workspace.",
        );
        expect(latestUndockedProvider).toBeUndefined();
    });

    it("activates onboarding with initialize action when a workspace is not a Git repository", async () => {
        gitOpsState.isRepository.mockResolvedValue(false);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const graphWebview = resolveRegisteredWebviewProvider("intelligit.commitGraph");
        const panelWebview = resolveRegisteredWebviewProvider("intelligit.commitPanel");

        expect(renderedButtonActions(graphWebview.view.webview.html)).toEqual([
            "initializeRepository",
            "cloneRepository",
            "openFolder",
        ]);
        expect(renderedButtonActions(panelWebview.view.webview.html)).toEqual([
            "initializeRepository",
            "cloneRepository",
            "openFolder",
        ]);
        expect(registeredCommands.has("intelligit.initializeRepository")).toBe(true);
    });

    it("initializes Git in an uninitialized workspace and prompts reload after rediscovery", async () => {
        let initialized = false;
        gitOpsState.isRepository.mockImplementation(async () => initialized);
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "init") {
                initialized = true;
                return "Initialized empty Git repository";
            }
            return defaultExecutorRunImpl(args);
        });
        showInformationMessage.mockImplementation(async (_message: string, ...items: string[]) =>
            items.includes("Reload Now") ? "Reload Now" : undefined,
        );
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        await registeredCommands.get("intelligit.initializeRepository")?.();

        expect(executorRun).toHaveBeenCalledWith(["init"]);
        expect(gitOpsState.isRepository).toHaveBeenCalledTimes(2);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Repository initialized. Reload window to activate IntelliGit?",
            "Reload Now",
        );
        expect(executeCommandFallback).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("disposes stale restored undocked panels instead of leaving an empty editor", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const serializer = registerWebviewPanelSerializer.mock.calls.find(
            ([viewType]) => viewType === "intelligit.undocked",
        )?.[1] as
            | {
                  deserializeWebviewPanel: (
                      panel: { dispose: () => void },
                      state: unknown,
                  ) => Promise<void>;
              }
            | undefined;
        const restoredPanel = { dispose: vi.fn() };

        await serializer?.deserializeWebviewPanel(restoredPanel, {});

        expect(serializer).toBeDefined();
        expect(restoredPanel.dispose).toHaveBeenCalledTimes(1);
        expect(latestUndockedProvider).toBeUndefined();
    });

    it("activates and executes branch/file command handlers", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);

        expect(registeredCommands.has("intelligit.refresh")).toBe(true);
        expect(registeredCommands.has("intelligit.checkout")).toBe(true);
        expect(registeredCommands.has("intelligit.fileDelete")).toBe(true);
        expect(registeredCommands.has("intelligit.openMergeConflict")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptYours")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptTheirs")).toBe(true);
        expect(registeredCommands.has("intelligit.openConflictSession")).toBe(true);

        function getCommand(id: string): CommandHandler {
            const cmd = registeredCommands.get(id);
            if (!cmd) throw new Error(`Missing command registration: ${id}`);
            return cmd;
        }

        await getCommand("intelligit.refresh")();
        await getCommand("intelligit.filterByBranch")("main");
        await getCommand("intelligit.showGitLog")();

        await getCommand("intelligit.checkout")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.newBranchFrom")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.checkoutAndRebase")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.rebaseCurrentOnto")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.mergeIntoCurrent")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.updateBranch")({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });
        await getCommand("intelligit.pushBranch")({
            branch: { name: "main", isRemote: false, isCurrent: true, remote: "origin" },
        });
        await getCommand("intelligit.renameBranch")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "feature-unmerged", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "feature-force", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "origin/feature-remote", isRemote: true, remote: "origin" },
        });

        await getCommand("intelligit.fileRollback")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileJumpToSource")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileDelete")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileShelve")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileShowHistory")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileRefresh")();
        await getCommand("intelligit.openMergeConflict")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.conflictAcceptYours")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.conflictAcceptTheirs")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.mergeConflictsRefresh")();
        await getCommand("intelligit.openConflictSession")();

        expect(executorRun).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalled();
        expect(showWarningMessage).toHaveBeenCalled();
        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/conflicted.ts", "ours");
        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/conflicted.ts", "theirs");
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting remote branch origin/feature-remote"),
            }),
            expect.any(Function),
        );
        expect(deleteFileWithFallback).toHaveBeenCalled();
    });

    it("does not open the undocked editor tab on activation when undockableWindow is enabled", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        expect(latestUndockedProvider).toBeUndefined();
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("opens and reopens the undocked editor tab only from showGitLog without changing settings or reloading on close", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.showGitLog")?.();

        const firstUndocked = latestUndockedProvider;
        expect(firstUndocked?.open).toHaveBeenCalledTimes(1);
        expect(firstUndocked?.refresh).toHaveBeenCalledTimes(1);
        expect(configurationUpdate).not.toHaveBeenCalled();
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");

        firstUndocked?.dispose();

        expect(configurationUpdate).not.toHaveBeenCalled();
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");

        await registeredCommands.get("intelligit.showGitLog")?.();

        expect(latestUndockedProvider).not.toBe(firstUndocked);
        expect(latestUndockedProvider?.open).toHaveBeenCalledTimes(1);
    });

    it("refreshes the undocked commit panel when docked commit state changes", async () => {
        vi.useFakeTimers();
        try {
            configurationValues.set("undockableWindow", true);
            const { activate } = await import("../../src/extension");
            const context = {
                extensionUri: { fsPath: "/ext", path: "/ext" },
                subscriptions: [],
            } as unknown as MockExtensionContext;

            await activate(context);
            await registeredCommands.get("intelligit.showGitLog")?.();

            const undocked = latestUndockedProvider;
            expect(undocked).toBeDefined();
            latestCommitPanelProvider!.refresh.mockClear();
            undocked!.refresh.mockClear();

            latestCommitPanelProvider!.emitWorkingTreeChanged();
            await waitForAsync();

            expect(undocked!.refresh).toHaveBeenCalledTimes(1);
            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();

            undocked!.refresh.mockClear();

            undocked!.emitWorkingTreeChanged();
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalledTimes(1);
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalledTimes(1);

            latestCommitPanelProvider!.refresh.mockClear();
            latestCommitGraphProvider!.refresh.mockClear();

            textDocListeners[0]?.();
            vi.advanceTimersByTime(300);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalledTimes(1);
            expect(undocked!.refresh).toHaveBeenCalledTimes(1);

            latestCommitPanelProvider!.refresh.mockClear();
            undocked!.refresh.mockClear();

            fsWatchCallbacks[0]?.("change", "index");
            vi.advanceTimersByTime(300);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalledTimes(1);
            expect(undocked!.refresh).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores stale undocked restore state on activation and keeps docked providers registered", async () => {
        configurationValues.set("undockableWindow", true);
        const workspaceState = createWorkspaceState({
            "intelligit.restoreUndockedEditorOnActivation": true,
        });
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            workspaceState,
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        expect(latestUndockedProvider).toBeUndefined();
        expect(registerWebviewViewProvider).toHaveBeenCalledWith(
            "intelligit.commitGraph",
            expect.any(MockCommitGraphViewProvider),
        );
        expect(registerWebviewViewProvider).toHaveBeenCalledWith(
            "intelligit.commitPanel",
            expect.any(MockCommitPanelViewProvider),
        );
        expect(registeredCommands.has("intelligit.fileRollback")).toBe(true);
        expect(workspaceState?.update).not.toHaveBeenCalledWith(
            "intelligit.restoreUndockedEditorOnActivation",
            expect.anything(),
        );
    });

    it("docks the undocked editor from the command without reloading", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        await registeredCommands.get("intelligit.showGitLog")?.();

        const opened = latestUndockedProvider;
        await registeredCommands.get("intelligit.dockWindow")?.();

        expect(opened?.dispose).toHaveBeenCalled();
        expect(configurationUpdate).toHaveBeenCalledWith("undockableWindow", false, true);
        expect(executeCommandFallback).toHaveBeenCalledWith("intelligit.commitPanel.focus");
        expect(executeCommandFallback).toHaveBeenCalledWith("intelligit.commitGraph.focus");
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("docks the undocked editor from the webview button without reloading", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        await registeredCommands.get("intelligit.showGitLog")?.();

        const opened = latestUndockedProvider;
        opened?.requestDock();
        await waitForAsync();

        expect(opened?.dispose).toHaveBeenCalled();
        expect(configurationUpdate).toHaveBeenCalledWith("undockableWindow", false, true);
        expect(executeCommandFallback).toHaveBeenCalledWith("intelligit.commitPanel.focus");
        expect(executeCommandFallback).toHaveBeenCalledWith("intelligit.commitGraph.focus");
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("openUndocked shows undock options and opens the unified editor tab", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.openUndocked")?.();

        expect(showQuickPick).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ label: "Undock in Editor Tab", target: "editorTab" }),
                expect.objectContaining({ label: "Undock in New Window", target: "newWindow" }),
            ]),
            expect.objectContaining({ placeHolder: "Choose how to undock IntelliGit" }),
        );
        expect(configurationUpdate).toHaveBeenCalledWith("undockableWindow", true, true);
        expect(latestUndockedProvider?.open).toHaveBeenCalledTimes(1);
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("openUndocked can move the unified editor to a new VS Code window", async () => {
        showQuickPick.mockResolvedValueOnce({ target: "newWindow" });
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.openUndocked")?.();

        expect(configurationUpdate).toHaveBeenCalledWith("undockableWindow", true, true);
        expect(latestUndockedProvider?.open).toHaveBeenCalledTimes(1);
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "workbench.action.moveEditorToNewWindow",
        );
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("updates non-current local branch via fetch refspec without checkout", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: false, remote: "origin" },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "main:main",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).not.toHaveBeenCalledWith(["checkout", "main"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Updating main"),
            }),
            expect.any(Function),
        );
    });

    it("opens conflict session when merge fails with unresolved conflicts", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "merge" && args[1] === "feature-local") {
                throw new Error("merge conflict");
            }
            return defaultExecutorRunImpl(args);
        });
        gitOpsState.getConflictedFiles.mockResolvedValue(["src/conflicted.ts"]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "feature-local", isRemote: false },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("unresolved conflict file"),
        );
        expect(showErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining("Merge failed:"));
    });

    it("offers restore action after deleting local branch", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInformationMessage.mockImplementation(async (message?: string) => {
            if (typeof message === "string" && message.startsWith("Deleted: feature-local")) {
                return "Restore";
            }
            return undefined;
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                upstream: "origin/feature-local",
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith(["branch", "-d", "feature-local"]);
        expect(executorRun).toHaveBeenCalledWith(["branch", "feature-local", "a1b2c3d4"]);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Deleted: feature-local",
            "Restore",
            "Delete Tracked Branch",
        );
    });

    it("supports delete tracked branch action after deleting local branch", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInformationMessage.mockImplementation(async (message?: string) => {
            if (typeof message === "string" && message.startsWith("Deleted: feature-local")) {
                return "Delete Tracked Branch";
            }
            return undefined;
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                upstream: "origin/feature-local",
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith(["branch", "-d", "feature-local"]);
        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "--delete", "feature-local"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting tracked branch origin/feature-local"),
            }),
            expect.any(Function),
        );
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Deleted: feature-local",
            "Restore",
            "Delete Tracked Branch",
        );
    });

    it("deletes remote branch even when remote field is missing", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "origin/feature-fallback",
                isRemote: true,
            },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "push",
            "origin",
            "--delete",
            "feature-fallback",
        ]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting remote branch origin/feature-fallback"),
            }),
            expect.any(Function),
        );
    });

    it("handles commit context actions forwarded from commit graph", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const emitCommitAction = async (payload: { action: string; hash: string }) => {
            latestCommitGraphProvider!.emitCommitAction(payload);
            await waitForAsync();
        };
        await emitCommitAction({ action: "copyRevision", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "createPatch", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "cherryPick", hash: "deadbee" });
        await emitCommitAction({ action: "checkoutRevision", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "resetCurrentToHere", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "revertCommit", hash: "deadbee" });
        await emitCommitAction({ action: "newBranch", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "newTag", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "undoCommit", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "editCommitMessage", hash: "feed1234" });
        await emitCommitAction({ action: "squashCommits", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "dropCommit", hash: "a1b2c3d4" });
        await emitCommitAction({
            action: "interactiveRebaseFromHere",
            hash: "a1b2c3d4",
        });
        latestCommitGraphProvider!.emitBranchAction({
            action: "checkout",
            branchName: "main",
        });
        await waitForAsync();
        latestCommitGraphProvider!.emitCommitSelected("a1b2c3d4");
        await waitForAsync();
        latestCommitGraphProvider!.emitBranchFilterChanged("main");
        await waitForAsync();

        expect(clipboardWriteText).toHaveBeenCalledWith("a1b2c3d4");
        expect(showSaveDialog).toHaveBeenCalled();
        expect(executorRun).toHaveBeenCalledWith(
            expect.arrayContaining(["format-patch", "-1", "--stdout", "a1b2c3d4"]),
        );
        expect(executorRun).toHaveBeenCalledWith(["reset", "--soft", "a1b2c3d4^"]);
        expect(executorRun).toHaveBeenCalledWith(["commit", "-m", "input"]);
        expect(showErrorMessage).not.toHaveBeenCalledWith(
            "Invalid commit hash received for commit action.",
        );
    });

    it("pushes commits up to selected revision from commit context action", async () => {
        const { activate } = await import("../../src/extension");
        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                remote: "origin",
                ahead: 2,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        latestCommitGraphProvider!.emitCommitAction({
            action: "pushAllUpToHere",
            hash: "a1b2c3d4",
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "merge-base",
            "--is-ancestor",
            "a1b2c3d4",
            "HEAD",
        ]);
        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "a1b2c3d4:refs/heads/main"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Pushing commits up to a1b2c3d4"),
            }),
            expect.any(Function),
        );
        expect(showInformationMessage).toHaveBeenCalledWith("Pushed commits up to a1b2c3d4.");
    });

    it("rolls back to the original HEAD when squash commit creation fails", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "rev-parse" && args[1] === "HEAD") return "0123456789abcdef";
            if (args[0] === "commit" && args[1] === "-m") throw new Error("commit boom");
            if (args[0] === "reset" && args[1] === "--hard" && args[2] === "0123456789abcdef") {
                throw new Error("rollback boom");
            }
            return defaultExecutorRunImpl(args);
        });

        latestCommitGraphProvider!.emitCommitAction({
            action: "squashCommits",
            hash: "a1b2c3d4",
        });
        await waitForAsync();
        await waitForAsync();
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith(["reset", "--soft", "a1b2c3d4^"]);
        expect(executorRun).toHaveBeenCalledWith(["commit", "-m", "input"]);
        expect(executorRun).toHaveBeenCalledWith(["reset", "--hard", "0123456789abcdef"]);
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("commit boom; rollback to 01234567 failed: rollback boom"),
        );
    });

    it("opens commit diff when commit graph requests file diff", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        openTextDocument.mockImplementation(async (arg: unknown) => {
            if (arg && typeof arg === "object" && "content" in (arg as Record<string, unknown>)) {
                const contentDoc = arg as { content: string };
                return {
                    uri: {
                        toString: () => `untitled:${contentDoc.content}`,
                    },
                    languageId: "typescript",
                };
            }
            return {
                uri: {
                    toString: () => JSON.stringify(arg),
                },
                languageId: "typescript",
            };
        });

        await activate(context);

        executeCommandFallback.mockClear();
        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "a1b2c3d4",
            filePath: "src/feature.ts",
        });
        await waitForAsync();

        expect(gitOpsState.getFileContentAtRef).toHaveBeenNthCalledWith(
            1,
            "src/feature.ts",
            "parent1",
        );
        expect(gitOpsState.getFileContentAtRef).toHaveBeenNthCalledWith(
            2,
            "src/feature.ts",
            "a1b2c3d4",
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.diff",
            expect.anything(),
            expect.anything(),
            "src/feature.ts (parent1 ↔ a1b2c3d4)",
        );
        expect(registerTextDocumentContentProvider).toHaveBeenCalledWith(
            "intelligit-diff",
            expect.objectContaining({ provideTextDocumentContent: expect.any(Function) }),
        );
        const diffCall = executeCommandFallback.mock.calls.find(
            ([command]) => command === "vscode.diff",
        );
        const leftUri = diffCall?.[1] as { scheme?: string; toString: () => string };
        const rightUri = diffCall?.[2] as { scheme?: string; toString: () => string };
        expect(leftUri.scheme).toBe("intelligit-diff");
        expect(rightUri.scheme).toBe("intelligit-diff");

        const provider = registerTextDocumentContentProvider.mock.calls.at(-1)?.[1] as {
            provideTextDocumentContent: (uri: unknown) => string;
            dispose: () => void;
        };
        expect(provider.provideTextDocumentContent(leftUri)).toBe("content:parent1");
        expect(provider.provideTextDocumentContent(rightUri)).toBe("content:a1b2c3d4");

        closeDocListeners.forEach((listener) => listener({ uri: leftUri }));
        expect(provider.provideTextDocumentContent(leftUri)).toBe("");
        expect(provider.provideTextDocumentContent(rightUri)).toBe("content:a1b2c3d4");

        provider.dispose();
        expect(provider.provideTextDocumentContent(rightUri)).toBe("");
    });

    it("prompts merge parent selection before opening commit file diff", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        showQuickPick.mockResolvedValueOnce({ parentNumber: 2 });
        openTextDocument.mockImplementation(async (arg: unknown) => {
            if (arg && typeof arg === "object" && "content" in (arg as Record<string, unknown>)) {
                const contentDoc = arg as { content: string };
                return {
                    uri: {
                        toString: () => `untitled:${contentDoc.content}`,
                    },
                    languageId: "typescript",
                };
            }
            return {
                uri: {
                    toString: () => JSON.stringify(arg),
                },
                languageId: "typescript",
            };
        });

        await activate(context);

        executeCommandFallback.mockClear();
        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "deadbee",
            filePath: "src/feature.ts",
        });
        await waitForAsync();

        expect(showQuickPick).toHaveBeenCalled();
        expect(gitOpsState.getFileContentAtRef).toHaveBeenNthCalledWith(
            1,
            "src/feature.ts",
            "deadbee^2",
        );
        expect(gitOpsState.getFileContentAtRef).toHaveBeenNthCalledWith(
            2,
            "src/feature.ts",
            "deadbee",
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.diff",
            expect.anything(),
            expect.anything(),
            "src/feature.ts (parent2 ↔ deadbee)",
        );
    });

    it("covers activation guards and debounced refresh sources", async () => {
        const { activate, deactivate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        workspaceFolders = undefined;
        await activate(context);
        expect(registeredCommands.has("intelligit.openUndocked")).toBe(true);
        expect(registeredCommands.has("intelligit.toggleUndocked")).toBe(true);
        registeredCommands.clear();

        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        gitOpsState.isRepository.mockResolvedValueOnce(false);
        await activate(context);
        expect(registeredCommands.has("intelligit.selectRepository")).toBe(true);
        registeredCommands.clear();

        vi.useFakeTimers();
        try {
            await activate(context);

            gitOpsState.getCommitDetail.mockRejectedValueOnce(new Error("detail failed"));
            latestCommitGraphProvider!.emitCommitSelected("a1b2c3d4");
            await waitForAsync();
            expect(showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("Failed to load commit: detail failed"),
            );

            executorRun.mockImplementation(async (args: string[]) => {
                if (args[0] === "reset" && args[1] === "--hard") throw new Error("reset failed");
                return defaultExecutorRunImpl(args);
            });
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            try {
                latestCommitGraphProvider!.emitCommitAction({
                    action: "resetCurrentToHere",
                    hash: "a1b2c3d4",
                });
                await waitForAsync();
            } finally {
                consoleErrorSpy.mockRestore();
            }
            expect(showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("Reset failed: reset failed"),
            );

            latestCommitGraphProvider!.emitBranchAction({
                action: "checkout",
                branchName: "missing-branch",
            });

            textDocListeners.forEach((listener) => listener());
            saveDocListeners.forEach((listener) => listener());
            createFileListeners.forEach((listener) => listener());
            deleteFileListeners.forEach((listener) => listener());
            renameFileListeners.forEach((listener) => listener());
            fsWatchCallbacks[0]?.("change", "HEAD");
            fsWatchCallbacks[0]?.("change", "FETCH_HEAD");
            fsWatchCallbacks[1]?.();

            vi.advanceTimersByTime(1200);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalled();
            deactivate();
        } finally {
            vi.useRealTimers();
        }
    });

    it("activates when the workspace contains a nested git repository", async () => {
        const { activate } = await import("../../src/extension");
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-workspace-"));
        const nestedRepo = path.join(workspace, "app");
        try {
            await fs.mkdir(path.join(nestedRepo, ".git"), { recursive: true });
            workspaceFolders = [{ uri: { fsPath: workspace, path: workspace } }];
            gitOpsState.isRepository.mockImplementation(
                async (root: string) => root === nestedRepo,
            );
            gitOpsState.getRepositoryRoot.mockImplementation(async (root: string) => root);

            const context = {
                extensionUri: { fsPath: "/ext", path: "/ext" },
                subscriptions: [],
            } as unknown as MockExtensionContext;
            await activate(context);

            expect(latestCommitGraphProvider).toBeDefined();
            expect(latestCommitPanelProvider).toBeDefined();
            expect(latestCommitGraphProvider!.setRepositoryLabel).toHaveBeenCalledWith("app");
            expect(latestCommitPanelProvider!.setRepositoryLabel).toHaveBeenCalledWith("app");
            expect(gitOpsState.getBranches).toHaveBeenCalled();
        } finally {
            await fs.rm(workspace, { recursive: true, force: true });
        }
    });

    it("switches the active repository from the selector", async () => {
        const { activate } = await import("../../src/extension");
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-workspace-"));
        const firstRepo = path.join(workspace, "app-a");
        const secondRepo = path.join(workspace, "app-b");
        try {
            await fs.mkdir(path.join(firstRepo, ".git"), { recursive: true });
            await fs.mkdir(path.join(secondRepo, ".git"), { recursive: true });
            workspaceFolders = [{ uri: { fsPath: workspace, path: workspace } }];
            gitOpsState.isRepository.mockImplementation(async (root: string) =>
                [firstRepo, secondRepo].includes(root),
            );
            gitOpsState.getRepositoryRoot.mockImplementation(async (root: string) => root);
            showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[1]);

            const context = {
                extensionUri: { fsPath: "/ext", path: "/ext" },
                subscriptions: [],
            } as unknown as MockExtensionContext;
            await activate(context);
            await registeredCommands.get("intelligit.selectRepository")?.();

            expect(latestCommitGraphProvider!.setRepositoryLabel).toHaveBeenCalledWith("app-b");
            expect(latestCommitPanelProvider!.setRepositoryRootUri).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: secondRepo }),
            );
            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalled();
        } finally {
            await fs.rm(workspace, { recursive: true, force: true });
        }
    });

    it("covers commit-context guarded/error branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const emitCommitAction = async (payload: { action: string; hash: string }) => {
            latestCommitGraphProvider!.emitCommitAction(payload);
            await waitForAsync();
        };

        await emitCommitAction({ action: "copyRevision", hash: "not-a-hash" });

        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();

        showWarningMessage.mockResolvedValueOnce("Cherry-pick");
        showQuickPick.mockResolvedValueOnce(undefined);
        await emitCommitAction({ action: "cherryPick", hash: "deadbee" });

        showInputBox.mockResolvedValueOnce("-bad-branch-name");
        await emitCommitAction({ action: "newBranch", hash: "a1b2c3d4" });
        showInputBox.mockResolvedValueOnce("bad..tag");
        await emitCommitAction({ action: "newTag", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "pushAllUpToHere", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "undoCommit", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "undoCommit", hash: "deadbee" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "editCommitMessage", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "editCommitMessage", hash: "deadbee" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["a1b2c3d4"]);
        await emitCommitAction({ action: "editCommitMessage", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "dropCommit", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "dropCommit", hash: "deadbee" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "squashCommits", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "squashCommits", hash: "deadbee" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "interactiveRebaseFromHere", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "interactiveRebaseFromHere", hash: "deadbee" });

        expect(showErrorMessage).toHaveBeenCalledWith(
            "Invalid commit hash received for commit action.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Invalid branch name '-bad-branch-name'"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Invalid tag name 'bad..tag'"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Push All up to Here is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Undo Commit is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Undo Commit is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Edit Commit Message is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Edit Commit Message is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Drop Commit is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Drop Commit is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Squash Commits is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Squash Commits is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Interactive Rebase from Here is available only for unpushed commits.",
        );
        expect(createTerminal).toHaveBeenCalled();
    });

    it("rejects invalid file context command paths before Git operations", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);

        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "../secret.txt" });
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "../secret.txt" });
        await registeredCommands.get("intelligit.fileShowHistory")?.({
            filePath: "../secret.txt",
        });
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "../secret.txt" });

        expect(gitOpsState.rollbackFiles).not.toHaveBeenCalled();
        expect(gitOpsState.shelveSave).not.toHaveBeenCalled();
        expect(gitOpsState.getFileHistory).not.toHaveBeenCalled();
        expect(deleteFileWithFallback).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rollback failed: Rejected path escaping repo root"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Shelve failed: Rejected path escaping repo root"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Show history failed: Rejected path escaping repo root"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining(
                "Delete failed for '../secret.txt': Rejected path escaping repo root",
            ),
        );
    });

    it("covers branch/file command failure and fallback branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "checkout" && args[1] === "broken-branch")
                throw new Error("checkout boom");
            if (args[0] === "rebase" && args[1] === "fail-rebase") throw new Error("rebase boom");
            if (args[0] === "merge" && args[1] === "fail-merge") throw new Error("merge boom");
            if (args[0] === "fetch") throw new Error("fetch boom");
            if (args[0] === "push" && args[2]?.startsWith("force-fail"))
                throw new Error("push boom");
            if (args[0] === "branch" && args[1] === "-m" && args[2] === "fail-rename") {
                throw new Error("rename boom");
            }
            if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-force-fail") {
                throw new Error("branch is not fully merged");
            }
            if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature-force-fail") {
                throw new Error("force delete failed");
            }
            if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
                throw new Error("rev-parse failed");
            }
            return defaultExecutorRunImpl(args);
        });

        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "origin/feature-local", isRemote: true },
        });
        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "origin/topic/new", isRemote: true },
        });
        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "broken-branch", isRemote: false },
        });

        gitOpsState.getBranches.mockResolvedValueOnce([
            { name: "topic", hash: "a1", isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands.get("intelligit.checkoutAndRebase")?.({
            branch: { name: "topic", isRemote: false },
        });

        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/force-fail",
                hash: "abc123",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands.get("intelligit.checkoutAndRebase")?.({
            branch: { name: "main", isRemote: false },
        });

        await registeredCommands.get("intelligit.rebaseCurrentOnto")?.({
            branch: { name: "fail-rebase", isRemote: false },
        });
        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "fail-merge", isRemote: false },
        });
        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: false, remote: "origin" },
        });

        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });
        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "topic", isRemote: false, isCurrent: false },
        });
        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "force-fail", isRemote: false, isCurrent: true, remote: "origin" },
        });

        showInputBox.mockResolvedValueOnce("renamed-branch");
        await registeredCommands.get("intelligit.renameBranch")?.({
            branch: { name: "fail-rename", isRemote: false },
        });

        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: { name: "main", isRemote: false },
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: { name: "feature-force-fail", isRemote: false },
        });

        gitOpsState.rollbackFiles.mockRejectedValueOnce(new Error("rollback failed"));
        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "src/a.ts" });
        gitOpsState.shelveSave.mockRejectedValueOnce(new Error("shelve failed"));
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "src/a.ts" });
        gitOpsState.getFileHistory.mockRejectedValueOnce(new Error("history failed"));
        await registeredCommands.get("intelligit.fileShowHistory")?.({ filePath: "src/a.ts" });
        deleteFileWithFallback.mockResolvedValueOnce(false);
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "src/a.ts" });

        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Checkout failed: checkout boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith("No current branch found.");
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Merge failed: merge boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Update failed: fetch boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Push failed: No remote configured for branch topic.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Push failed: push boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rename failed: rename boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Delete failed: force delete failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rollback failed: rollback failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Shelve failed: shelve failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Show history failed: history failed"),
        );
    });

    it("handles fs.watch setup failures and exposes deactivate", async () => {
        const fs = await import("fs");
        const watchMock = vi.mocked(fs.watch as unknown as (...args: unknown[]) => unknown);
        watchMock
            .mockImplementationOnce(() => {
                throw new Error("watch .git failed");
            })
            .mockImplementationOnce(() => {
                throw new Error("watch refs failed");
            });

        const { activate, deactivate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        deactivate();
        expect(watchMock).toHaveBeenCalled();
    });
});
