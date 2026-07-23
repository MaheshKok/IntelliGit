import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";

/** Command callback shape captured by the VS Code command-registration mock. */
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
const showOpenDialog = vi.fn(async () => [{ fsPath: "/tmp", path: "/tmp" }]);
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
const activeTextEditorListeners: Array<(editor?: { document: { uri: unknown } }) => void> = [];
const workspaceFolderListeners: Array<() => Promise<void> | void> = [];
let activeTextEditor: { document: { uri: unknown } } | undefined;
const closeDocListeners: Array<
    (document: { uri: { scheme: string; toString: () => string } }) => void
> = [];
const saveDocListeners: Array<() => void> = [];
const createFileListeners: Array<() => void> = [];
const deleteFileListeners: Array<() => void> = [];
const renameFileListeners: Array<() => void> = [];
const authSessionListeners: Array<(event: { provider: { id: string } }) => void> = [];
const configurationValues = new Map<string, unknown>();
const configurationUpdate = vi.fn(async (key: string, value: unknown) => {
    configurationValues.set(key, value);
});
/** Node `fs.watch` callback shape used by refresh-service integration mocks. */
type FsWatchCallback = (...args: unknown[]) => void;
const fsWatchCallbacks: FsWatchCallback[] = [];
/** Minimal native tree-view shape needed for badge and description assertions. */
type MockTreeView = {
    badge?: { value: number; tooltip?: string };
    description?: string;
    dispose: ReturnType<typeof vi.fn>;
};
const createdTreeViews = new Map<string, MockTreeView>();
const initialTreeViewBadges = new Map<string, MockTreeView["badge"]>();
/** Built-in Git extension repository subset used by activation refresh tests. */
type MockGitRepository = {
    rootUri: { fsPath: string; path: string };
    onDidChangeState: ReturnType<typeof vi.fn>;
};
const gitRepositoryStateListeners: Array<() => void> = [];
const gitOpenRepositoryListeners: Array<(repository: MockGitRepository) => void> = [];
const gitCloseRepositoryListeners: Array<(repository: MockGitRepository) => void> = [];
const mockGitRepository: MockGitRepository = {
    rootUri: { fsPath: "/repo", path: "/repo" },
    onDidChangeState: vi.fn((listener: () => void) => {
        gitRepositoryStateListeners.push(listener);
        return { dispose: vi.fn() };
    }),
};
const mockGitApi = {
    repositories: [mockGitRepository],
    onDidOpenRepository: vi.fn((listener: (repository: MockGitRepository) => void) => {
        gitOpenRepositoryListeners.push(listener);
        return { dispose: vi.fn() };
    }),
    onDidCloseRepository: vi.fn((listener: (repository: MockGitRepository) => void) => {
        gitCloseRepositoryListeners.push(listener);
        return { dispose: vi.fn() };
    }),
};
const vscodeGitGetAPI = vi.fn(() => mockGitApi);
const vscodeGitActivate = vi.fn(async () => ({
    getAPI: vscodeGitGetAPI,
}));

let workspaceFolders: Array<{ uri: { fsPath: string; path: string } }> | undefined = [
    { uri: { fsPath: "/repo", path: "/repo" } },
];

/** Disposable mock that runs a provided cleanup callback. */
class MockDisposable {
    constructor(private readonly fn: () => void) {}
    /** Runs the captured cleanup callback used by VS Code disposable mocks. */
    dispose(): void {
        this.fn();
    }
}

/** Synchronous event emitter mock matching VS Code's listener registration contract. */
class MockEventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
    };
    /** Synchronously emits events so integration tests can assert immediate side effects. */
    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }
    dispose = vi.fn();
}

/** Provides deterministic Git command output for extension activation command tests. */
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
        {
            name: "main",
            hash: "feed1234",
            isRemote: false,
            isCurrent: true,
            upstream: "origin/main",
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
    stashSave: vi.fn(async () => "saved"),
    getFileHistory: vi.fn(async () => "history"),
    hasUncommittedChanges: vi.fn(async () => false),
    getStatus: vi.fn(async () => []),
    listStashes: vi.fn(async () => []),
    getStashFiles: vi.fn(async () => []),
    getConflictedFiles: vi.fn(async () => []),
    getConflictFilesDetailed: vi.fn(async () => []),
    acceptConflictSide: vi.fn(async () => undefined),
    abortMerge: vi.fn(async () => undefined),
    getConflictFileVersions: vi.fn(async () => ({ base: "", ours: "", theirs: "" })),
    stageFile: vi.fn(async () => undefined),
    push: vi.fn(async () => ""),
};

const deleteFileWithFallback = vi.fn(async () => true);
/** Extension context subset used by activation integration tests. */
type MockExtensionContext = {
    extensionUri: { fsPath: string; path: string };
    workspaceState?: {
        get: <T>(key: string, defaultValue?: T) => T | undefined;
        update: ReturnType<typeof vi.fn>;
    };
    subscriptions: Array<{ dispose: () => void }>;
};

let latestCommitGraphProvider: MockCommitGraphViewProvider | undefined;
let latestSidebarGraphProvider: MockCommitGraphViewProvider | undefined;
let latestCommitPanelProvider: MockCommitPanelViewProvider | undefined;
let latestUndockedProvider: MockUndockedViewProvider | undefined;
let commitPanelRefreshHook:
    | ((provider: MockCommitPanelViewProvider) => void | Promise<void>)
    | undefined;

/** Captures the most recently constructed undocked provider for cross-surface assertions. */
function updateLatestUndockedProvider(provider: MockUndockedViewProvider): void {
    latestUndockedProvider = provider;
}

/** Commit graph provider mock with event emitters exposed for host-command tests. */
class MockCommitGraphViewProvider {
    static readonly viewType = "intelligit.commitGraph";
    static readonly sidebarViewType = "intelligit.sidebarGraph";
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchFilterEmitter = new MockEventEmitter<string | null>();
    private branchActionEmitter = new MockEventEmitter<{ action: string; branchName: string }>();
    private deleteBranchesEmitter = new MockEventEmitter<Array<{ name: string } | string>>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();

    constructor(
        _uri: unknown,
        _gitOps: unknown,
        _credentialStore: unknown,
        options?: { scriptFile?: string; title?: string },
    ) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        if (options?.scriptFile === "webview-compactcommitgraph.js") {
            latestSidebarGraphProvider = this;
        } else {
            latestCommitGraphProvider = this;
        }
    }
    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchFilterChanged = this.branchFilterEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onDeleteBranches = this.deleteBranchesEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    setBranches = vi.fn();
    refresh = vi.fn(async () => undefined);
    clearChecksCache = vi.fn();
    filterByBranch = vi.fn(async () => undefined);
    resetFilters = vi.fn();
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
    setRepositoryLabel = vi.fn();
    setShowRepositoryLabel = vi.fn();
    dispose = vi.fn();

    /** Emits commit selection from the mocked graph provider. */
    emitCommitSelected(hash: string): void {
        this.commitSelectedEmitter.fire(hash);
    }
    /** Emits branch filter changes from the mocked graph provider. */
    emitBranchFilterChanged(value: string | null): void {
        this.branchFilterEmitter.fire(value);
    }
    /** Emits branch-menu actions from the mocked graph provider. */
    emitBranchAction(payload: { action: string; branchName: string }): void {
        this.branchActionEmitter.fire(payload);
    }
    /** Emits bulk branch deletion from the mocked graph provider. */
    emitDeleteBranches(branches: Array<{ name: string } | string>): void {
        this.deleteBranchesEmitter.fire(branches);
    }
    /** Emits commit-row actions from the mocked graph provider. */
    emitCommitAction(payload: { action: string; hash: string }): void {
        this.commitActionEmitter.fire(payload);
    }
    /** Emits file-diff requests from the mocked graph provider. */
    emitOpenCommitFileDiff(payload: { commitHash: string; filePath: string }): void {
        this.openCommitFileDiffEmitter.fire(payload);
    }
}

/** Commit info provider mock for file-diff event plumbing. */
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

/** Commit panel provider mock for selection, branch, file-count, and working-tree events. */
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
    refresh = vi.fn(async () => {
        await commitPanelRefreshHook?.(this);
    });
    refreshSilent = vi.fn(async () => {
        await commitPanelRefreshHook?.(this);
    });
    getLastKnownFileCount = vi.fn(() => 0);
    setRepositories = vi.fn();
    setRepositoryRootUri = vi.fn();
    setRepositoryLabel = vi.fn();
    setBranches = vi.fn();
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
    dispose = vi.fn();
    /** Emits changed-file counts from the mocked commit panel. */
    emitFileCount(count: number): void {
        this.fileCountEmitter.fire(count);
    }
    /** Emits working-tree changes from the mocked commit panel. */
    emitWorkingTreeChanged(): void {
        this.workingTreeEmitter.fire(undefined);
    }
    /** Emits commit selection from the mocked commit panel. */
    emitCommitSelected(hash: string): void {
        this.commitSelectedEmitter.fire(hash);
    }
    /** Emits branch filter changes from the mocked commit panel. */
    emitBranchFilterChanged(value: string | null): void {
        this.branchFilterEmitter.fire(value);
    }
    /** Emits branch actions from the mocked commit panel. */
    emitBranchAction(payload: { action: string; branchName: string }): void {
        this.branchActionEmitter.fire(payload);
    }
    /** Emits commit-row actions from the mocked commit panel. */
    emitCommitAction(payload: { action: string; hash: string }): void {
        this.commitActionEmitter.fire(payload);
    }
    /** Emits file-diff requests from the mocked commit panel. */
    emitOpenCommitFileDiff(payload: { commitHash: string; filePath: string }): void {
        this.openCommitFileDiffEmitter.fire(payload);
    }
}

/** Undocked provider mock for dock/open/refresh integration coverage. */
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

    constructor(_uri: unknown, _gitOps: unknown, _repoRootUri: unknown, _credentialStore: unknown) {
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
    setRepositories = vi.fn();
    setBranches = vi.fn();
    setCommitDetail = vi.fn();
    open = vi.fn(async () => undefined);
    refresh = vi.fn(async () => undefined);
    refreshSilent = vi.fn(async () => undefined);
    clearChecksCache = vi.fn();
    reveal = vi.fn();
    dispose = vi.fn(() => {
        this.disposeEmitter.fire(undefined);
    });
    /** Emits working-tree changes from the mocked undocked provider. */
    emitWorkingTreeChanged(): void {
        this.workingTreeEmitter.fire(undefined);
    }
    /** Emits changed-file counts from the mocked undocked provider. */
    emitFileCount(count: number): void {
        this.fileCountEmitter.fire(count);
    }
    /** Emits a request to dock the mocked undocked provider. */
    requestDock(): void {
        this.dockRequestedEmitter.fire(undefined);
    }
}

vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    return {
        ...actual,
        watch: vi.fn((...args: unknown[]) => {
            const callback = args[args.length - 1];
            if (typeof callback === "function") fsWatchCallbacks.push(callback);
            return { close: vi.fn() };
        }),
    };
});

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
    StatusBarAlignment: { Left: 1 },
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
        from: (components: { scheme: string; path: string; query?: string }) => {
            const query = components.query ?? "";
            const serializedPath = components.path.split("/").map(encodeURIComponent).join("/");
            return {
                fsPath: components.path,
                path: components.path,
                query,
                scheme: components.scheme,
                toString: () => `${components.scheme}:${serializedPath}${query ? `?${query}` : ""}`,
            };
        },
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
        get activeTextEditor() {
            return activeTextEditor;
        },
        onDidChangeActiveTextEditor: vi.fn(
            (listener: (editor?: { document: { uri: unknown } }) => void) => {
                activeTextEditorListeners.push(listener);
                return { dispose: vi.fn() };
            },
        ),
        createTreeView: vi.fn((id: string) => {
            const view: MockTreeView = {
                badge: initialTreeViewBadges.get(id),
                description: undefined,
                dispose: vi.fn(),
            };
            createdTreeViews.set(id, view);
            return view;
        }),
        createStatusBarItem: vi.fn(() => ({
            text: "",
            show: vi.fn(),
            hide: vi.fn(),
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
        showOpenDialog,
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
        onDidChangeWorkspaceFolders: vi.fn((listener: () => Promise<void> | void) => {
            workspaceFolderListeners.push(listener);
            return { dispose: vi.fn() };
        }),
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
    authentication: {
        onDidChangeSessions: vi.fn((listener: (event: { provider: { id: string } }) => void) => {
            authSessionListeners.push(listener);
            return { dispose: vi.fn() };
        }),
    },
    extensions: {
        getExtension: vi.fn((id: string) =>
            id === "vscode.git" ? { activate: vscodeGitActivate } : undefined,
        ),
    },
    env: {
        language: "en",
        clipboard: { writeText: clipboardWriteText },
    },
    l10n: {
        t: interpolateL10n,
    },
}));

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (_message: string, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
            withProgress(
                {
                    location: 15,
                    title: `IntelliGit: ${_message}`,
                    cancellable: false,
                },
                task,
            ),
    ),
    showTimedInformationMessage: showInformationMessage,
    showTimedWarningMessage: showWarningMessage,
}));

vi.mock("../../../src/git/executor", () => ({
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

vi.mock("../../../src/git/operations", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/git/operations")>();
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
            stashSave = gitOpsState.stashSave;
            getFileHistory = gitOpsState.getFileHistory;
            getStatus = gitOpsState.getStatus;
            listStashes = gitOpsState.listStashes;
            getStashFiles = gitOpsState.getStashFiles;
            getConflictedFiles = gitOpsState.getConflictedFiles;
            getConflictFilesDetailed = gitOpsState.getConflictFilesDetailed;
            acceptConflictSide = gitOpsState.acceptConflictSide;
            abortMerge = gitOpsState.abortMerge;
            getConflictFileVersions = gitOpsState.getConflictFileVersions;
            stageFile = gitOpsState.stageFile;
            push = gitOpsState.push;
            init = async (_repoPath: string) => executorRun(["init"]);
        },
    };
});

vi.mock("../../../src/views/CommitGraphViewProvider", () => ({
    CommitGraphViewProvider: MockCommitGraphViewProvider,
}));

vi.mock("../../../src/views/CommitInfoViewProvider", () => ({
    CommitInfoViewProvider: MockCommitInfoViewProvider,
}));

vi.mock("../../../src/views/CommitPanelViewProvider", () => ({
    CommitPanelViewProvider: MockCommitPanelViewProvider,
}));

vi.mock("../../../src/views/UndockedViewProvider", () => ({
    UndockedViewProvider: MockUndockedViewProvider,
}));

vi.mock("../../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});

/** Drains microtasks and mocked timers used by async extension activation handlers. */
async function waitForAsync(): Promise<void> {
    const maxPasses = 8;
    for (let i = 0; i < maxPasses; i++) {
        await Promise.resolve();
        try {
            await vi.advanceTimersByTimeAsync(0);
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

/** Fake webview view plus send helper used to drive registered webview providers. */
type FakeWebviewView = {
    view: {
        webview: {
            options: Record<string, unknown>;
            html: string;
            onDidReceiveMessage: ReturnType<typeof vi.fn>;
            asWebviewUri: (uri: { fsPath?: string; path?: string }) => {
                fsPath: string;
                path: string;
            };
        };
        onDidDispose: ReturnType<typeof vi.fn>;
    };
    send: (message: unknown) => Promise<void>;
};

/** Creates a fake webview view with a capturable message handler. */
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

/** Resolves and initializes a registered webview provider by view type. */
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

/** Extracts rendered button action IDs from static webview HTML. */
function renderedButtonActions(html: string): string[] {
    return Array.from(html.matchAll(/<button[^>]+data-action="([^"]+)"/g)).map((match) => match[1]);
}

/** Provides a minimal in-memory workspace state implementation for activation tests. */
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
        activeTextEditorListeners.length = 0;
        workspaceFolderListeners.length = 0;
        activeTextEditor = undefined;
        closeDocListeners.length = 0;
        saveDocListeners.length = 0;
        createFileListeners.length = 0;
        deleteFileListeners.length = 0;
        renameFileListeners.length = 0;
        authSessionListeners.length = 0;
        fsWatchCallbacks.length = 0;
        createdTreeViews.clear();
        initialTreeViewBadges.clear();
        gitRepositoryStateListeners.length = 0;
        gitOpenRepositoryListeners.length = 0;
        gitCloseRepositoryListeners.length = 0;
        mockGitApi.repositories = [mockGitRepository];
        configurationValues.clear();
        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        latestCommitGraphProvider = undefined;
        latestSidebarGraphProvider = undefined;
        latestCommitPanelProvider = undefined;
        latestUndockedProvider = undefined;
        commitPanelRefreshHook = undefined;

        showInformationMessage.mockImplementation(async () => undefined);
        showErrorMessage.mockImplementation(async () => undefined);
        showWarningMessage.mockImplementation(
            async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0],
        );
        executorRun.mockImplementation(defaultExecutorRunImpl);
        gitOpsState.isRepository.mockResolvedValue(true);
        gitOpsState.getRepositoryRoot.mockResolvedValue("/repo");
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
        gitOpsState.stashSave.mockResolvedValue("saved");
        gitOpsState.getFileHistory.mockResolvedValue("history");
        gitOpsState.getConflictedFiles.mockResolvedValue([]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.acceptConflictSide.mockResolvedValue(undefined);
        gitOpsState.abortMerge.mockResolvedValue(undefined);
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
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const graphWebview = resolveRegisteredWebviewProvider("intelligit.commitGraph");
        const sidebarGraphWebview = resolveRegisteredWebviewProvider("intelligit.sidebarGraph");
        const panelWebview = resolveRegisteredWebviewProvider("intelligit.commitPanel");
        await registeredCommands.get("intelligit.openUndocked")?.();
        await registeredCommands.get("intelligit.toggleUndocked")?.();

        expect(renderedButtonActions(graphWebview.view.webview.html)).toEqual([
            "cloneRepository",
            "openFolder",
        ]);
        expect(renderedButtonActions(sidebarGraphWebview.view.webview.html)).toEqual([]);
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

    it("activates onboarding with initialize action outside the graph view when a workspace is not a Git repository", async () => {
        gitOpsState.getRepositoryRoot.mockRejectedValue(new Error("not a repository"));
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const graphWebview = resolveRegisteredWebviewProvider("intelligit.commitGraph");
        const sidebarGraphWebview = resolveRegisteredWebviewProvider("intelligit.sidebarGraph");
        const panelWebview = resolveRegisteredWebviewProvider("intelligit.commitPanel");

        expect(renderedButtonActions(graphWebview.view.webview.html)).toEqual([
            "initializeRepository",
        ]);
        expect(renderedButtonActions(sidebarGraphWebview.view.webview.html)).toEqual([]);
        expect(renderedButtonActions(panelWebview.view.webview.html)).toEqual([
            "initializeRepository",
        ]);
        expect(registeredCommands.has("intelligit.initializeRepository")).toBe(true);
    });

    it("initializes Git in an uninitialized workspace and activates repository views without reload", async () => {
        let initialized = false;
        gitOpsState.getRepositoryRoot.mockImplementation(async () => {
            if (!initialized) throw new Error("not a repository");
            return "/repo";
        });
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "init") {
                initialized = true;
                return "Initialized empty Git repository";
            }
            return defaultExecutorRunImpl(args);
        });
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        await registeredCommands.get("intelligit.initializeRepository")?.();

        expect(executorRun).toHaveBeenCalledWith(["init"]);
        expect(gitOpsState.getRepositoryRoot).toHaveBeenCalledTimes(2);
        expect(showInformationMessage).toHaveBeenCalledWith("Repository initialized.");
        expect(executeCommandFallback).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
        expect(latestCommitGraphProvider).toBeDefined();
        expect(latestSidebarGraphProvider).toBeDefined();
        expect(latestCommitPanelProvider).toBeDefined();
        expect(latestCommitGraphProvider!.setRepositoryLabel).toHaveBeenCalledWith("repo");
        expect(latestCommitPanelProvider!.setRepositoryLabel).toHaveBeenCalledWith("repo");
    });

    it("refreshes commit-check badges when the GitHub auth session changes", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        expect(latestCommitGraphProvider).toBeDefined();
        expect(latestSidebarGraphProvider).toBeDefined();
        expect(authSessionListeners).toHaveLength(1);

        latestCommitGraphProvider!.clearChecksCache.mockClear();
        latestSidebarGraphProvider!.clearChecksCache.mockClear();
        latestCommitGraphProvider!.refresh.mockClear();
        latestSidebarGraphProvider!.refresh.mockClear();

        authSessionListeners[0]({ provider: { id: "gitlab" } });
        await Promise.resolve();

        expect(latestCommitGraphProvider!.clearChecksCache).not.toHaveBeenCalled();
        expect(latestSidebarGraphProvider!.clearChecksCache).not.toHaveBeenCalled();

        authSessionListeners[0]({ provider: { id: "github" } });
        await Promise.resolve();

        expect(latestCommitGraphProvider!.clearChecksCache).toHaveBeenCalledTimes(1);
        expect(latestSidebarGraphProvider!.clearChecksCache).toHaveBeenCalledTimes(1);
        expect(latestCommitGraphProvider!.refresh).toHaveBeenCalledTimes(1);
        expect(latestSidebarGraphProvider!.refresh).toHaveBeenCalledTimes(1);
    });

    it("clears the activity bar changed-files badge when the refreshed count reaches zero", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        expect(latestCommitPanelProvider).toBeDefined();

        const badgeView = createdTreeViews.get("intelligit.fileCountBadge");
        expect(badgeView).toBeDefined();

        latestCommitPanelProvider!.emitFileCount(2);
        expect(badgeView!.badge).toEqual({ tooltip: "2 changed files", value: 2 });

        latestCommitPanelProvider!.emitFileCount(0);
        expect(badgeView!.badge).toBeUndefined();
    });

    it("clears a stale activity bar changed-files badge during initial clean refresh", async () => {
        initialTreeViewBadges.set("intelligit.fileCountBadge", {
            tooltip: "1 changed file",
            value: 1,
        });
        commitPanelRefreshHook = (provider) => {
            provider.emitFileCount(0);
        };
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        await waitForAsync();

        const badgeView = createdTreeViews.get("intelligit.fileCountBadge");
        expect(badgeView).toBeDefined();
        expect(badgeView!.badge).toBeUndefined();
    });

    it("captures the file count emitted by the initial commit panel refresh", async () => {
        commitPanelRefreshHook = (provider) => {
            provider.emitFileCount(2);
        };
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        await waitForAsync();

        const badgeView = createdTreeViews.get("intelligit.fileCountBadge");
        expect(badgeView).toBeDefined();
        expect(badgeView!.badge).toEqual({ tooltip: "2 changed files", value: 2 });
    });

    it("updates the activity bar changed-files badge tooltip when refreshed counts change", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        expect(latestCommitPanelProvider).toBeDefined();

        const badgeView = createdTreeViews.get("intelligit.fileCountBadge");
        expect(badgeView).toBeDefined();

        latestCommitPanelProvider!.emitFileCount(1);
        expect(badgeView!.badge).toEqual({ tooltip: "1 changed file", value: 1 });

        latestCommitPanelProvider!.emitFileCount(3);
        expect(badgeView!.badge).toEqual({ tooltip: "3 changed files", value: 3 });

        latestCommitPanelProvider!.emitFileCount(0);
        expect(badgeView!.badge).toBeUndefined();
    });

    it("updates and clears the activity bar changed-files badge from undocked refresh events", async () => {
        showQuickPick.mockResolvedValueOnce({
            label: "Undock in Editor Tab",
            target: "editorTab",
        });
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        await registeredCommands.get("intelligit.openUndocked")?.();
        expect(latestUndockedProvider).toBeDefined();

        const badgeView = createdTreeViews.get("intelligit.fileCountBadge");
        expect(badgeView).toBeDefined();

        latestUndockedProvider!.emitFileCount(4);
        expect(badgeView!.badge).toEqual({ tooltip: "4 changed files", value: 4 });

        latestUndockedProvider!.emitFileCount(0);
        expect(badgeView!.badge).toBeUndefined();
    });

    it("disposes stale restored undocked panels instead of leaving an empty editor", async () => {
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;
        const worktreeListOutput = [
            "worktree /repo",
            "HEAD feed1234",
            "branch refs/heads/main",
            "",
            "worktree /repo-feature",
            "HEAD a1b2c3d4",
            "branch refs/heads/feature-worktree",
            "",
        ].join("\0");
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "worktree" && args[1] === "list") return worktreeListOutput;
            return defaultExecutorRunImpl(args);
        });

        await activate(context);

        expect(registeredCommands.has("intelligit.refresh")).toBe(true);
        expect(registeredCommands.has("intelligit.refresh.color")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.fetch")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.fetch.color")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.pull")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.pull.color")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.push")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.push.color")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.sync")).toBe(true);
        expect(registeredCommands.has("intelligit.graph.sync.color")).toBe(true);
        expect(registeredCommands.has("intelligit.selectRepository.color")).toBe(true);
        expect(registeredCommands.has("intelligit.openUndocked.color")).toBe(true);
        expect(registeredCommands.has("intelligit.openWorktree")).toBe(true);
        expect(registeredCommands.has("intelligit.createWorktreeFromBranch")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.create")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.delete")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.lock")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.unlock")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.move")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.prune")).toBe(true);
        expect(registeredCommands.has("intelligit.worktree.repair")).toBe(true);
        expect(registeredCommands.has("intelligit.checkout")).toBe(true);
        expect(registeredCommands.has("intelligit.fileDelete")).toBe(true);
        expect(registeredCommands.has("intelligit.openMergeConflict")).toBe(true);
        expect(registeredCommands.has("intelligit.openMergeConflictInVsCode")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptYours")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptTheirs")).toBe(true);
        expect(registeredCommands.has("intelligit.openConflictSession")).toBe(true);

        /** Fetches a registered command and fails the test with its command ID when missing. */
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
        executorRun.mockClear();
        const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        showOpenDialog.mockResolvedValueOnce([{ fsPath: worktreeParent, path: worktreeParent }]);
        showInputBox
            .mockResolvedValueOnce("feature-created")
            .mockResolvedValueOnce("feature-local");
        showErrorMessage.mockClear();
        await getCommand("intelligit.createWorktreeFromBranch")({
            branch: { name: "feature-local", isRemote: false },
        });
        expect(showErrorMessage).not.toHaveBeenCalled();
        expect(executorRun).toHaveBeenCalledWith([
            "worktree",
            "add",
            path.join(worktreeParent, "feature-created"),
            "feature-local",
        ]);
        await fs.rm(worktreeParent, { recursive: true, force: true });
        executeCommandFallback.mockClear();
        executorRun.mockClear();
        await getCommand("intelligit.openWorktree")({
            branch: {
                name: "feature-worktree",
                isRemote: false,
                worktreePath: "/repo-feature",
            },
        });
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.openFolder",
            { fsPath: "/repo-feature", path: "/repo-feature" },
            { forceNewWindow: false, forceReuseWindow: true },
        );

        executeCommandFallback.mockClear();
        executorRun.mockClear();
        await getCommand("intelligit.checkout")({
            branch: {
                name: "feature-worktree",
                isRemote: false,
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                worktreePath: "/repo-feature",
            },
        });
        expect(executorRun).not.toHaveBeenCalledWith(["checkout", "feature-worktree"]);
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.openFolder",
            { fsPath: "/repo-feature", path: "/repo-feature" },
            { forceNewWindow: false, forceReuseWindow: true },
        );
        executorRun.mockClear();
        showInformationMessage.mockClear();
        withProgress.mockClear();
        await getCommand("intelligit.worktree.delete")({
            path: "/repo-feature",
            branch: "feature-worktree",
            head: "a1b2c3d4",
            state: "linked",
            isMain: false,
            isCurrent: false,
            isLocked: false,
            isPrunable: false,
        });
        expect(executorRun).toHaveBeenCalledWith(["status", "--porcelain"]);
        expect(executorRun).toHaveBeenCalledWith(["worktree", "remove", "/repo-feature"]);
        expect(showInformationMessage).toHaveBeenCalledWith("Deleted worktree /repo-feature");
        await getCommand("intelligit.worktree.lock")({
            path: "/repo-feature",
            branch: "feature-worktree",
        });
        await getCommand("intelligit.worktree.move")({
            path: "/repo-feature",
            branch: "feature-worktree",
        });
        for (const title of [
            "Deleting worktree /repo-feature...",
            "Locking worktree /repo-feature...",
            "Moving worktree /repo-feature...",
        ]) {
            expect(withProgress).toHaveBeenCalledWith(
                expect.objectContaining({ location: 15, title: expect.stringContaining(title) }),
                expect.any(Function),
            );
        }
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
        await getCommand("intelligit.fileRefresh")();
        await getCommand("intelligit.openMergeConflict")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.openMergeConflictInVsCode")({
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

    /** Activates the extension with the shared mock context used by command-branch tests. */
    async function activateExtensionForCommandTests(): Promise<void> {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
    }

    /** Fetches a registered command for focused command tests. */
    function requireCommand(id: string): CommandHandler {
        const command = registeredCommands.get(id);
        if (!command) throw new Error(`Missing command registration: ${id}`);
        return command;
    }

    it("bulk branch delete rejects the current branch before mutating any branch", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                { name: "main", isRemote: false, isCurrent: true },
                { name: "feature-local", isRemote: false, isCurrent: false },
            ],
        });

        expect(executorRun).not.toHaveBeenCalledWith(
            expect.arrayContaining(["branch", "-d", "feature-local"]),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("current branch"));
    });

    it("bulk branch delete rejects branches checked out in another worktree before mutating any branch", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                {
                    name: "feature-worktree",
                    isRemote: false,
                    isCheckedOutInWorktree: true,
                    isCurrentWorktree: false,
                },
                { name: "feature-local", isRemote: false },
            ],
        });

        expect(executorRun).not.toHaveBeenCalledWith(
            expect.arrayContaining(["branch", "-d", "feature-local"]),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("feature-worktree"),
        );
    });

    it("rename warns instead of prompting for a branch checked out in another worktree", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();
        showInputBox.mockClear();
        showWarningMessage.mockClear();

        await requireCommand("intelligit.renameBranch")({
            branch: {
                name: "feature-worktree",
                isRemote: false,
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
            },
        });

        expect(showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("feature-worktree"),
            { modal: true },
            "OK",
        );
        expect(showInputBox).not.toHaveBeenCalled();
        expect(executorRun).not.toHaveBeenCalledWith(["branch", "-m", expect.anything()]);
    });

    it("rejects stale branch names from graph bulk delete without deleting a subset", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        latestCommitGraphProvider!.emitDeleteBranches(["feature-local", "missing-branch"]);
        await waitForAsync();

        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Cannot delete missing branch(es): missing-branch"),
        );
        expect(executorRun).not.toHaveBeenCalledWith(
            expect.arrayContaining(["branch", "-d", "feature-local"]),
        );
    });

    it("graph bulk branch delete preserves remote branch rows before command dispatch", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        latestCommitGraphProvider!.emitDeleteBranches([{ name: "origin/feature-remote" }]);
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "--delete", "feature-remote"]);
        expect(executorRun).not.toHaveBeenCalledWith(["branch", "-d", "origin/feature-remote"]);
    });

    it("bulk branch delete deletes branches sequentially, offers local delete actions, and refreshes once", async () => {
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
                upstream: "origin/feature-local",
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature-two",
                hash: "b2c3d4e5",
                isRemote: false,
                isCurrent: false,
                upstream: "origin/feature-two",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-local",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-two",
                hash: "b2c3d4e5",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        await activateExtensionForCommandTests();
        executorRun.mockClear();
        latestCommitPanelProvider?.refresh.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                { name: "feature-local", isRemote: false, isCurrent: false },
                { name: "feature-two", isRemote: false, isCurrent: false },
            ],
        });

        const deleteCalls = executorRun.mock.calls
            .map(([args]) => args)
            .filter((args) => args[0] === "branch" && args[1] === "-d")
            .map((args) => args.slice(0, 3));
        expect(deleteCalls).toEqual([
            ["branch", "-d", "feature-local"],
            ["branch", "-d", "feature-two"],
        ]);
        const deletedToasts = showInformationMessage.mock.calls
            .filter(([message]) => typeof message === "string" && message.startsWith("Deleted:"))
            .map(([message, ...actions]) => [message, ...actions]);
        expect(deletedToasts).toEqual([
            ["Deleted: feature-local", "Restore", "Delete Tracked Branch"],
            ["Deleted: feature-two", "Restore", "Delete Tracked Branch"],
        ]);
        expect(latestCommitPanelProvider?.refresh).toHaveBeenCalledTimes(1);
    });

    it("bulk branch delete runs push-delete for remote branch rows", async () => {
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                {
                    name: "origin/feature-remote",
                    isRemote: true,
                    isCurrent: false,
                    remote: "origin",
                },
            ],
        });

        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "--delete", "feature-remote"]);
        expect(executorRun).not.toHaveBeenCalledWith([
            "branch",
            "-d",
            "-r",
            "origin/feature-remote",
        ]);
    });

    it("bulk branch delete supports the tracked-remote delete action for local branches", async () => {
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
                upstream: "origin/feature-local",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-local",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        showInformationMessage.mockImplementation(async (message?: string) => {
            if (typeof message === "string" && message.startsWith("Deleted: feature-local")) {
                return "Delete Tracked Branch";
            }
            return undefined;
        });
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                {
                    name: "feature-local",
                    hash: "a1b2c3d4",
                    isRemote: false,
                    isCurrent: false,
                    upstream: "origin/feature-local",
                },
            ],
        });

        expect(executorRun).toHaveBeenCalledWith(["branch", "-d", "feature-local"]);
        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "--delete", "feature-local"]);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Deleted: feature-local",
            "Restore",
            "Delete Tracked Branch",
        );
    });

    it("bulk branch delete reports partial failures after earlier deletions succeed", async () => {
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
                name: "feature-fails",
                hash: "b2c3d4e5",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ]);
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-fails") {
                throw new Error("cannot delete feature-fails");
            }
            return defaultExecutorRunImpl(args);
        });
        await activateExtensionForCommandTests();
        executorRun.mockClear();
        gitOpsState.getBranches.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [
                { name: "feature-local", isRemote: false, isCurrent: false },
                { name: "feature-fails", isRemote: false, isCurrent: false },
            ],
        });

        expect(executorRun).toHaveBeenCalledWith(
            expect.arrayContaining(["branch", "-d", "feature-local"]),
        );
        expect(gitOpsState.getBranches).toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("partially deleted"));
    });

    it("bulk branch delete reports a direct failure when the first delete fails", async () => {
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
                name: "feature-fails",
                hash: "b2c3d4e5",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ]);
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-fails") {
                throw new Error("cannot delete feature-fails");
            }
            return defaultExecutorRunImpl(args);
        });
        await activateExtensionForCommandTests();
        executorRun.mockClear();

        await requireCommand("intelligit.deleteBranches")({
            branches: [{ name: "feature-fails", isRemote: false, isCurrent: false }],
        });

        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("failed to delete feature-fails"),
        );
        expect(showErrorMessage).not.toHaveBeenCalledWith(
            expect.stringContaining("partially deleted 0"),
        );
    });

    it("does not open the undocked editor tab on activation when undockableWindow is enabled", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
            const { activate } = await import("../../../src/extension");
            const context = {
                extensionUri: { fsPath: "/ext", path: "/ext" },
                subscriptions: [],
            } as unknown as MockExtensionContext;

            await activate(context);
            await registeredCommands.get("intelligit.showGitLog")?.();

            const undocked = latestUndockedProvider;
            expect(undocked).toBeDefined();
            latestCommitPanelProvider!.refresh.mockClear();
            latestCommitPanelProvider!.refreshSilent.mockClear();
            undocked!.refresh.mockClear();
            undocked!.refreshSilent.mockClear();

            latestCommitPanelProvider!.emitWorkingTreeChanged();
            await waitForAsync();

            expect(undocked!.refresh).not.toHaveBeenCalled();
            expect(undocked!.refreshSilent).toHaveBeenCalledTimes(1);
            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();

            undocked!.refresh.mockClear();
            undocked!.refreshSilent.mockClear();

            undocked!.emitWorkingTreeChanged();
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();
            expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalledTimes(1);
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalledTimes(1);

            latestCommitPanelProvider!.refresh.mockClear();
            latestCommitPanelProvider!.refreshSilent.mockClear();
            latestCommitGraphProvider!.refresh.mockClear();

            textDocListeners[0]?.();
            vi.advanceTimersByTime(300);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();
            expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalledTimes(1);
            expect(undocked!.refresh).not.toHaveBeenCalled();
            expect(undocked!.refreshSilent).toHaveBeenCalledTimes(1);

            latestCommitPanelProvider!.refresh.mockClear();
            latestCommitPanelProvider!.refreshSilent.mockClear();
            undocked!.refresh.mockClear();
            undocked!.refreshSilent.mockClear();

            fsWatchCallbacks[0]?.("change", "index");
            vi.advanceTimersByTime(300);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();
            expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalledTimes(1);
            expect(undocked!.refresh).not.toHaveBeenCalled();
            expect(undocked!.refreshSilent).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refreshes the commit panel from VS Code Git repository state changes", async () => {
        vi.useFakeTimers();
        try {
            const { activate } = await import("../../../src/extension");
            const context = {
                extensionUri: { fsPath: "/ext", path: "/ext" },
                subscriptions: [],
            } as unknown as MockExtensionContext;

            await activate(context);
            await waitForAsync();

            expect(vscodeGitActivate).toHaveBeenCalledTimes(1);
            expect(vscodeGitGetAPI).toHaveBeenCalledWith(1);
            expect(gitRepositoryStateListeners).toHaveLength(1);

            latestCommitPanelProvider!.refresh.mockClear();
            latestCommitPanelProvider!.refreshSilent.mockClear();

            gitRepositoryStateListeners[0]();
            vi.advanceTimersByTime(299);
            await Promise.resolve();

            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();
            expect(latestCommitPanelProvider!.refreshSilent).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).not.toHaveBeenCalled();
            expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores stale undocked restore state on activation and keeps docked providers registered", async () => {
        configurationValues.set("undockableWindow", true);
        const workspaceState = createWorkspaceState({
            "intelligit.restoreUndockedEditorOnActivation": true,
        });
        const { activate } = await import("../../../src/extension");
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
            { webviewOptions: { retainContextWhenHidden: true } },
        );
        expect(registeredCommands.has("intelligit.fileRollback")).toBe(true);
        expect(workspaceState?.update).not.toHaveBeenCalledWith(
            "intelligit.restoreUndockedEditorOnActivation",
            expect.anything(),
        );
    });

    it("docks the undocked editor from the command without reloading", async () => {
        configurationValues.set("undockableWindow", true);
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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

    it("openUndocked does not move the active editor when the undocked panel is already open", async () => {
        showQuickPick
            .mockResolvedValueOnce({ target: "newWindow" })
            .mockResolvedValueOnce({ target: "newWindow" });
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.openUndocked")?.();
        const opened = latestUndockedProvider;
        expect(opened?.open).toHaveBeenCalledTimes(1);
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "workbench.action.moveEditorToNewWindow",
        );

        executeCommandFallback.mockClear();
        await registeredCommands.get("intelligit.openUndocked")?.();

        expect(opened?.open).toHaveBeenCalledTimes(1);
        expect(opened?.reveal).toHaveBeenCalledTimes(1);
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "workbench.action.moveEditorToNewWindow",
        );
    });

    it("updates the current local branch by fetching then merging the tracked remote ref", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "main",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                remote: "origin",
            },
        });

        const calls = executorRun.mock.calls.map(([args]) => args);
        const fetchCallIndex = calls.findIndex(
            (args) =>
                Array.isArray(args) &&
                args[0] === "fetch" &&
                args[1] === "origin" &&
                args.includes("--prune"),
        );
        const mergeCallIndex = calls.findIndex(
            (args) => Array.isArray(args) && args.includes("merge") && args.includes("origin/main"),
        );

        expect(fetchCallIndex).toBeGreaterThanOrEqual(0);
        expect(mergeCallIndex).toBeGreaterThanOrEqual(0);
        expect(fetchCallIndex).toBeLessThan(mergeCallIndex);
        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).toHaveBeenCalledWith([
            "-c",
            "credential.helper=",
            "-c",
            "core.quotepath=false",
            "-c",
            "log.showSignature=false",
            "merge",
            "origin/main",
            "--no-stat",
            "-v",
        ]);
        expect(executorRun).not.toHaveBeenCalledWith(["pull", "--ff-only"]);
        expect(executorRun).not.toHaveBeenCalledWith(["pull", "--ff-only", "origin", "main"]);
    });

    it("uses the current-branch merge path when cached branch metadata misses the current flag", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "main",
                isRemote: false,
                isCurrent: false,
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).toHaveBeenCalledWith([
            "-c",
            "credential.helper=",
            "-c",
            "core.quotepath=false",
            "-c",
            "log.showSignature=false",
            "merge",
            "origin/main",
            "--no-stat",
            "-v",
        ]);
        expect(executorRun).not.toHaveBeenCalledWith([
            "fetch",
            "origin",
            "main:main",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
    });

    it("shows a concise professional update error for fast-forward divergence output", async () => {
        const divergentError = [
            "From github.com:MaheshKok/IntelliGit",
            " * branch            main       -> FETCH_HEAD",
            "hint: Diverging branches can't be fast-forwarded, you need to either:",
            "hint:",
            "hint: \tgit merge --no-ff",
            "hint:",
            "hint: or:",
            "hint:",
            "hint: \tgit rebase",
            "hint:",
            'hint: Disable this message with "git config set advice.diverging false"',
            "fatal: Not possible to fast-forward, aborting.",
        ].join("\n");
        executorRun.mockImplementation(async (args: string[]) => {
            if (
                args[0] === "fetch" &&
                args[1] === "origin" &&
                args[2] === "feature-remote:feature-remote"
            ) {
                throw new Error(divergentError);
            }
            return defaultExecutorRunImpl(args);
        });

        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "feature-remote",
                isRemote: false,
                isCurrent: false,
                remote: "origin",
            },
        });

        expect(showErrorMessage).toHaveBeenCalledWith(
            "Update failed: The local and remote branches have diverged. Merge or rebase the tracked remote branch, then try again.",
        );
    });

    it("opens conflict session when current-branch update merge fails with unresolved conflicts", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args.includes("merge") && args.includes("origin/main")) {
                throw new Error("merge conflict");
            }
            return defaultExecutorRunImpl(args);
        });
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "main",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                remote: "origin",
            },
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
        expect(showErrorMessage).not.toHaveBeenCalledWith(
            expect.stringContaining("Update failed:"),
        );
        const panelResult = createWebviewPanelMock.mock.results[0]?.value as
            | { dispose?: () => void }
            | undefined;
        panelResult?.dispose?.();
    });

    it("refreshes conflict UI after opening the VS Code merge editor", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        expect(latestCommitPanelProvider).toBeDefined();

        executeCommandFallback.mockClear();
        latestCommitPanelProvider!.refreshSilent.mockClear();
        gitOpsState.getConflictFilesDetailed.mockClear();

        await registeredCommands.get("intelligit.openMergeConflictInVsCode")?.({
            filePath: "src/conflicted.ts",
        });

        expect(executeCommandFallback).toHaveBeenCalledWith("git.openMergeEditor", {
            fsPath: "/repo/src/conflicted.ts",
            path: "/repo/src/conflicted.ts",
        });
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "vscode.open",
            expect.anything(),
        );
        expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalledTimes(1);
    });

    it("rejects unsafe conflict-session accept paths before git operations", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.openConflictSession")?.();

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        /** Webview panel subset captured from `createWebviewPanel` calls. */
        type CreatedPanel = {
            webview: {
                onDidReceiveMessage: ReturnType<typeof vi.fn>;
            };
            dispose?: () => void;
        };
        const panelResult = createWebviewPanelMock.mock.results[0]?.value as
            | CreatedPanel
            | undefined;
        const handler = panelResult?.webview.onDidReceiveMessage.mock.calls[0]?.[0] as
            | ((msg: unknown) => Promise<void>)
            | undefined;
        expect(handler).toBeDefined();

        gitOpsState.acceptConflictSide.mockClear();
        showErrorMessage.mockClear();
        await handler?.({ type: "acceptYours", filePath: "../secret.txt" });
        await handler?.({ type: "acceptTheirs", filePath: "/tmp/secret.txt" });

        expect(gitOpsState.acceptConflictSide).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Rejected path escaping repo root: ../secret.txt",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Rejected non-relative path: /tmp/secret.txt",
        );

        gitOpsState.acceptConflictSide.mockClear();
        showErrorMessage.mockClear();
        await handler?.({ type: "acceptYours", filePath: "   " });

        expect(gitOpsState.acceptConflictSide).not.toHaveBeenCalled();
        expect(showErrorMessage).not.toHaveBeenCalled();

        gitOpsState.acceptConflictSide.mockClear();
        showErrorMessage.mockClear();
        await handler?.({ type: "acceptYours", filePath: "src/conflicted.ts " });

        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/conflicted.ts ", "ours");
        expect(showErrorMessage).not.toHaveBeenCalled();
        panelResult?.dispose?.();
    });

    it("aborts merge from conflict session after confirmation", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.openConflictSession")?.();

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        type CreatedPanel = {
            webview: {
                onDidReceiveMessage: ReturnType<typeof vi.fn>;
            };
            dispose: ReturnType<typeof vi.fn>;
        };
        const panelResult = createWebviewPanelMock.mock.results[0]?.value as
            | CreatedPanel
            | undefined;
        const handler = panelResult?.webview.onDidReceiveMessage.mock.calls[0]?.[0] as
            | ((msg: unknown) => Promise<void>)
            | undefined;
        expect(handler).toBeDefined();

        gitOpsState.abortMerge.mockClear();
        await handler?.({ type: "abortMerge" });

        expect(gitOpsState.abortMerge).toHaveBeenCalledTimes(1);
        expect(panelResult?.dispose).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalledWith("Merge aborted.");
    });

    it("does not open conflict session for current-branch update fetch failures", async () => {
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "fetch" && args[1] === "origin") {
                throw new Error("fetch failed");
            }
            return defaultExecutorRunImpl(args);
        });
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "main",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                remote: "origin",
            },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).not.toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(showErrorMessage).toHaveBeenCalledWith("Update failed: fetch failed");
    });

    it("updates non-current local branch via fetch refspec without checkout", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: {
                name: "feature-remote",
                isRemote: false,
                isCurrent: false,
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "feature-remote:feature-remote",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).not.toHaveBeenCalledWith(["checkout", "feature-remote"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Updating feature-remote"),
            }),
            expect.any(Function),
        );
    });

    it("opens conflict session when merge fails with unresolved conflicts", async () => {
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        /** Emits graph commit actions and drains async handlers for command assertions. */
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate } = await import("../../../src/extension");
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
        const { activate, deactivate } = await import("../../../src/extension");
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
            showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[2]);
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

            expect(latestCommitPanelProvider!.refreshSilent).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalled();
            deactivate();
        } finally {
            vi.useRealTimers();
        }
    });

    it("activates when the workspace contains a nested git repository", async () => {
        const { activate } = await import("../../../src/extension");
        const workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-workspace-")),
        );
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
        const { SELECTED_REPOSITORY_KEY } = await import("../../../src/activation/common");
        const { activate } = await import("../../../src/extension");
        const workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-workspace-")),
        );
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
                workspaceState: createWorkspaceState(),
            } as unknown as MockExtensionContext;
            await activate(context);
            await registeredCommands.get("intelligit.selectRepository")?.();

            expect(context.workspaceState?.update).toHaveBeenCalledWith(
                SELECTED_REPOSITORY_KEY,
                secondRepo,
            );
            expect(latestCommitGraphProvider!.setRepositoryLabel).toHaveBeenCalledWith("app-b");
            expect(latestCommitPanelProvider!.setRepositoryRootUri).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: secondRepo }),
            );
            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.resetFilters).toHaveBeenCalled();
            expect(latestSidebarGraphProvider!.resetFilters).toHaveBeenCalled();

            showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[0]);
            await registeredCommands.get("intelligit.selectRepository")?.();

            expect(context.workspaceState?.update).toHaveBeenCalledWith(
                SELECTED_REPOSITORY_KEY,
                firstRepo,
            );
            expect(latestCommitGraphProvider!.setRepositoryLabel).toHaveBeenCalledWith("app-a");
            expect(latestCommitPanelProvider!.setRepositoryRootUri).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: firstRepo }),
            );
        } finally {
            await fs.rm(workspace, { recursive: true, force: true });
        }
    });

    it("covers commit-context guarded/error branches", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        /** Emits graph commit actions and drains async handlers for guarded action assertions. */
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

    it("preserves selected commit details during explicit repository refresh", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);
        await waitForAsync();

        if (!latestCommitGraphProvider) throw new Error("Expected commit graph provider");
        if (!latestSidebarGraphProvider) throw new Error("Expected sidebar graph provider");
        if (!latestCommitPanelProvider) throw new Error("Expected commit panel provider");

        latestCommitGraphProvider.emitCommitSelected("a1b2c3d4");
        await waitForAsync();

        latestCommitGraphProvider.clearCommitDetail.mockClear();
        latestSidebarGraphProvider.clearCommitDetail.mockClear();
        latestCommitPanelProvider.clearCommitDetail.mockClear();

        const refresh = registeredCommands.get("intelligit.refresh");
        if (!refresh) throw new Error("Missing intelligit.refresh command");
        await refresh();

        expect(latestCommitGraphProvider.clearCommitDetail).not.toHaveBeenCalled();
        expect(latestSidebarGraphProvider.clearCommitDetail).not.toHaveBeenCalled();
        expect(latestCommitPanelProvider.clearCommitDetail).not.toHaveBeenCalled();
        expect(latestCommitPanelProvider.setCommitDetail).toHaveBeenCalledWith(
            expect.objectContaining({ hash: "a1b2c3d4" }),
        );
    });

    it("clears selected commit details before applying a branch filter command", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);
        await waitForAsync();

        if (!latestCommitGraphProvider) throw new Error("Expected commit graph provider");
        if (!latestSidebarGraphProvider) throw new Error("Expected sidebar graph provider");
        const filterByBranch = registeredCommands.get("intelligit.filterByBranch");
        if (!filterByBranch) throw new Error("Missing intelligit.filterByBranch command");

        await filterByBranch("main");

        expect(latestCommitGraphProvider.clearCommitDetail).toHaveBeenCalledWith({
            loading: true,
        });
        expect(latestSidebarGraphProvider.clearCommitDetail).toHaveBeenCalledWith({
            loading: true,
        });
        expect(latestCommitGraphProvider.filterByBranch).toHaveBeenCalledWith("main");
        expect(latestSidebarGraphProvider.filterByBranch).toHaveBeenCalledWith("main");
        expect(
            latestCommitGraphProvider.clearCommitDetail.mock.invocationCallOrder[0],
        ).toBeLessThan(latestCommitGraphProvider.filterByBranch.mock.invocationCallOrder[0]);
        expect(
            latestSidebarGraphProvider.clearCommitDetail.mock.invocationCallOrder[0],
        ).toBeLessThan(latestSidebarGraphProvider.filterByBranch.mock.invocationCallOrder[0]);
    });

    it("suppresses stale commit detail errors after the selection is cleared", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;
        let rejectDetail!: (error: Error) => void;
        gitOpsState.getCommitDetail.mockReturnValueOnce(
            new Promise((_resolve, reject) => {
                rejectDetail = reject;
            }),
        );

        await activate(context);
        await waitForAsync();
        showErrorMessage.mockClear();

        latestCommitGraphProvider!.emitCommitSelected("a1b2c3d4");
        latestCommitGraphProvider!.emitBranchFilterChanged(null);
        rejectDetail(new Error("detail failed after clear"));
        await waitForAsync();

        expect(showErrorMessage).not.toHaveBeenCalledWith(
            expect.stringContaining("Failed to load commit: detail failed after clear"),
        );
    });

    it("opens interactive rebase terminals with git shell arguments instead of sent shell text", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;
        const terminal = { show: vi.fn(), sendText: vi.fn() };
        createTerminal.mockReturnValueOnce(terminal);

        await activate(context);
        await waitForAsync();

        if (!latestCommitGraphProvider) throw new Error("Expected commit graph provider");
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["a1b2c3d4"]);
        latestCommitGraphProvider.emitCommitAction({
            action: "interactiveRebaseFromHere",
            hash: "a1b2c3d4",
        });
        await waitForAsync();

        expect(createTerminal).toHaveBeenCalledWith(
            expect.objectContaining({
                name: expect.any(String),
                cwd: "/repo",
                shellPath: "git",
                shellArgs: ["rebase", "-i", "a1b2c3d4^"],
            }),
        );
        expect(terminal.show).toHaveBeenCalledTimes(1);
        expect(terminal.sendText).not.toHaveBeenCalled();
    });

    it("rejects invalid file context command paths before Git operations", async () => {
        const { activate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);

        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "../secret.txt" });
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "../secret.txt" });
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "../secret.txt" });

        expect(gitOpsState.rollbackFiles).not.toHaveBeenCalled();
        expect(gitOpsState.stashSave).not.toHaveBeenCalled();
        expect(deleteFileWithFallback).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rollback failed: Rejected path escaping repo root"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Stash failed: Rejected path escaping repo root"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining(
                "Delete failed for '../secret.txt': Rejected path escaping repo root",
            ),
        );
    });

    it("covers branch/file command failure and fallback branches", async () => {
        const { activate } = await import("../../../src/extension");
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
        gitOpsState.stashSave.mockRejectedValueOnce(new Error("stash failed"));
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "src/a.ts" });
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
        expect(showWarningMessage).not.toHaveBeenCalledWith("The repo has not been published yet.");
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
            expect.stringContaining("Stash failed: stash failed"),
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

        const { activate, deactivate } = await import("../../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        deactivate();
        expect(watchMock).toHaveBeenCalled();
    });
});
