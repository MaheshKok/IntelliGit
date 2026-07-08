import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (message: unknown) => void | Promise<void>;
type CommandHandler = (...args: unknown[]) => unknown;

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
const registeredCommands = new Map<string, CommandHandler>();
const activeTextEditorListeners: Array<(editor?: { document: { uri: unknown } }) => void> = [];
let activeTextEditor: { document: { uri: unknown } } | undefined;
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

function createMemento(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        get: vi.fn((key: string) => store.get(key)),
        update: vi.fn(async (key: string, value: unknown | undefined) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        }),
    };
}

function createControlledMemento(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    const pendingUpdates: Array<{
        key: string;
        value: unknown | undefined;
        resolved?: boolean;
        resolve: () => void;
    }> = [];
    return {
        memento: {
            get: vi.fn((key: string) => store.get(key)),
            update: vi.fn(
                (key: string, value: unknown | undefined) =>
                    new Promise<void>((resolve) => {
                        pendingUpdates.push({
                            key,
                            value,
                            resolve: () => {
                                if (value === undefined) {
                                    store.delete(key);
                                } else {
                                    store.set(key, value);
                                }
                                resolve();
                            },
                        });
                    }),
            ),
        },
        pendingUpdates,
    };
}

const vscodeMock = {
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    env: {
        language: "en",
    },
    l10n: {
        t: (message: string, _placeholders?: unknown) => message,
    },
    ProgressLocation: { Notification: 15 },
    Disposable: class {
        constructor(private readonly disposeCallback: () => void) {}
        dispose(): void {
            this.disposeCallback();
        }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
        file: (
            value: string,
        ): { fsPath: string; path: string; scheme: string; toString: () => string } => ({
            fsPath: value,
            path: value,
            scheme: "file",
            toString: () => value,
        }),
        parse: (
            value: string,
        ): { fsPath: string; path: string; scheme: string; toString: () => string } => ({
            fsPath: value,
            path: value,
            scheme: value.split(":", 1)[0],
            toString: () => value,
        }),
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
        get activeTextEditor() {
            return activeTextEditor;
        },
        registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
        createTreeView: vi.fn(() => ({
            dispose: vi.fn(),
            badge: undefined,
            description: undefined,
        })),
        onDidChangeActiveTextEditor: vi.fn(
            (listener: (editor?: { document: { uri: unknown } }) => void) => {
                activeTextEditorListeners.push(listener);
                return { dispose: vi.fn() };
            },
        ),
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
        registerCommand: vi.fn((id: string, handler: CommandHandler) => {
            registeredCommands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
            const handler = registeredCommands.get(id);
            if (handler) return handler(...args);
            return executeCommand(id, ...args);
        }),
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
        getConfiguration: vi.fn(() => ({
            get: vi.fn((key: string) => {
                if (key === "workbench.sideBar.location") return "left";
                return undefined;
            }),
        })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    authentication: {
        onDidChangeSessions: vi.fn(() => ({ dispose: vi.fn() })),
    },
};

const deleteFileWithFallback = vi.fn(async () => true);
// Spy on the GitHub provider's network boundary so the real CommitChecksCoordinator
// runs inside the view provider (exercising its cache/re-fetch logic end-to-end).
const providerGetChecks = vi.hoisted(() => vi.fn());
// Network boundary for the real GitLabProvider. Mocked so self-hosted-routing tests
// never touch the network; defaults are set per test. GitHub-remote tests never reach
// the GitLab path (GitHub matches first), so this stays uninvoked there.
const httpGetJsonSpy = vi.hoisted(() => vi.fn());
const runPublishBranchFlowSpy = vi.hoisted(() => vi.fn(async () => undefined));
const gitExecutorSetRoot = vi.hoisted(() => vi.fn());
const activeGitRoot = vi.hoisted(() => ({ value: "" }));
const deferBranchRefreshes = vi.hoisted(() => ({ active: false }));
const branchRefreshControls = vi.hoisted(
    () =>
        [] as Array<{
            root: string;
            resolved?: boolean;
            resolve: (branches: unknown[]) => void;
        }>,
);
const refreshServiceInstances = vi.hoisted(
    () =>
        [] as Array<{
            root: string;
            registerFileWatchers: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }>,
);
const makeBranchesForRoot = vi.hoisted(() => (root: string) => [
    {
        name: `branch-${root.split(/[\\/]/).pop() ?? root}`,
        hash: "abc1234",
        isRemote: false,
        isCurrent: true,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
    },
]);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        constructor(public readonly root: string) {
            activeGitRoot.value = root;
        }
        setRoot = vi.fn((root: string) => {
            activeGitRoot.value = root;
            gitExecutorSetRoot(root);
        });
    },
}));
vi.mock("../../../src/git/operations", () => ({
    GitOps: class {
        getBranches = vi.fn(async () => {
            const root = activeGitRoot.value;
            if (!deferBranchRefreshes.active) return makeBranchesForRoot(root);
            return new Promise<unknown[]>((resolve) => {
                branchRefreshControls.push({ root, resolve });
            });
        });
        getLog = vi.fn(async () => []);
        getRemotes = vi.fn(async () => ["origin"]);
        getRemoteUrl = vi.fn(async () => "https://github.com/owner/repo.git");
        getUnpushedCommitHashes = vi.fn(async () => []);
        hasUncommittedChanges = vi.fn(async () => false);
        getStatus = vi.fn(async () => []);
        listStashes = vi.fn(async () => []);
        getConflictFilesDetailed = vi.fn(async () => []);
    },
}));
vi.mock("../../../src/services/worktreeService", () => ({
    WorktreeService: class {
        refresh = vi.fn(async () => []);
        decorateBranches = vi.fn((branches: unknown[]) => branches);
        dispose = vi.fn();
    },
}));
vi.mock("../../../src/views/RefreshService", () => ({
    RefreshService: class {
        constructor(
            _deps: unknown,
            public readonly root: string,
        ) {
            refreshServiceInstances.push(this);
        }
        refreshMergeConflicts = vi.fn(async () => undefined);
        refreshConflictUi = vi.fn(async () => undefined);
        refreshAll = vi.fn(async () => undefined);
        registerFileWatchers = vi.fn();
        dispose = vi.fn();
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
vi.mock("../../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: vi.fn(() => "<html></html>"),
    escapeHtmlAttr: (value: string) =>
        value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;"),
    escapeHtmlText: (value: string) =>
        value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
}));
vi.mock("../../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});
vi.mock("../../../src/services/commitChecks/githubProvider", () => ({
    GitHubProvider: class {
        // URL-aware so a self-hosted (non-github.com) remote falls through to the real
        // GitLabProvider in the coordinator. github.com remotes still match first, so the
        // existing github commit-check tests are unaffected.
        match(remoteUrl: string): { host: string; owner: string; repo: string } | null {
            return remoteUrl.includes("github.com")
                ? { host: "github.com", owner: "owner", repo: "repo" }
                : null;
        }
        getChecks(_ref: unknown, hash: string): unknown {
            return providerGetChecks(hash);
        }
    },
}));
// Mock the GitLabProvider's network boundary (the view providers inject this exact
// module-level function). Self-hosted-routing tests set a per-test resolved value.
vi.mock("../../../src/services/commitChecks/http", () => ({
    httpGetJson: httpGetJsonSpy,
}));
vi.mock("../../../src/services/publishService", () => ({
    runPublishBranchFlow: runPublishBranchFlowSpy,
}));

function createWebviewView() {
    let messageHandler: MessageHandler | undefined;
    let disposeHandler: (() => void) | undefined;
    let visibilityHandler: (() => void) | undefined;

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
        visible: true,
        badge: undefined as { tooltip: string; value: number } | undefined,
        description: undefined as string | undefined,
        onDidChangeVisibility: vi.fn((cb: () => void) => {
            visibilityHandler = cb;
            return { dispose: vi.fn() };
        }),
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
        setVisible: (visible: boolean) => {
            view.visible = visible;
            visibilityHandler?.();
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
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/owner/repo.git"),
        getUnpushedCommitHashes: vi.fn(async () => ["abc1234"]),
        hasAnyCommits: vi.fn(async () => true),
        hasUncommittedChanges: vi.fn(async () => false),
        getStatus: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]),
        listStashes: vi.fn(async () => [
            { index: 0, message: "On main: save", date: "2026-02-19T00:00:00Z", hash: "stashhash" },
        ]),
        getStashFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 2, deletions: 1 },
        ]),
        stageFiles: vi.fn(async () => undefined),
        intentToAddFiles: vi.fn(async () => undefined),
        unstageFiles: vi.fn(async () => undefined),
        commit: vi.fn(async () => "ok"),
        commitAndPush: vi.fn(async () => "ok"),
        fetch: vi.fn(async () => "ok"),
        pullRebase: vi.fn(async () => "ok"),
        push: vi.fn(async () => "ok"),
        getLastCommitMessage: vi.fn(async () => "last message"),
        getAmendBranchCommits: vi.fn(async () => [
            { shortHash: "abc1234", subject: "feat: amend ctx", date: "2026-02-19T00:00:00Z" },
        ]),
        rollbackAll: vi.fn(async () => undefined),
        rollbackFiles: vi.fn(async () => undefined),
        stashSave: vi.fn(async () => "saved"),
        stashPop: vi.fn(async () => "popped"),
        stashApply: vi.fn(async () => "applied"),
        stashDelete: vi.fn(async () => "deleted"),
        getConflictFilesDetailed: vi.fn(async () => []),
        abortMerge: vi.fn(async () => undefined),
        getStashFilePatch: vi.fn(async () => "diff --git a b"),
        getFileHistory: vi.fn(async () => "history line"),
    };
}

// Minimal CredentialStore double for the view providers' GitLab provider. The github
// remote matches first in these tests, so GitLabProvider.getChecks (the only path that
// reads a token) is never invoked; get() returning undefined keeps it inert if it were.
function makeCredentialStore() {
    return {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };
}

// CredentialStore double that returns a stored token for any host. Used by the
// self-hosted GitLab routing test that exercises the full fetch path.
function makeCredentialStoreWithToken(token: string) {
    return {
        get: vi.fn(async () => token),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };
}

function makeSecretStorage() {
    return {
        get: vi.fn(async () => undefined),
        store: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };
}

async function flushVisibleRefresh<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(1_000);
    return promise;
}

async function flushInitialVisibleRefresh(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function refreshingStates(): boolean[] {
    return postMessageSpy.mock.calls
        .map(([message]) => message)
        .filter(
            (message): message is { type: "refreshing"; active: boolean } =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "refreshing" &&
                "active" in message &&
                typeof message.active === "boolean",
        )
        .map((message) => message.active);
}

// Returns the snapshot from the most recent setCommitChecks postMessage, or undefined
// if the view never emitted one. Used by the self-hosted GitLab routing tests to assert
// on the snapshot's state and error text.
function lastCommitChecksSnapshot():
    | { state: string; summary?: string; error?: string; items?: unknown[] }
    | undefined {
    const snapshots = postMessageSpy.mock.calls
        .map(([message]) => message)
        .filter(
            (
                message,
            ): message is {
                type: "setCommitChecks";
                snapshot: { state: string; summary?: string; error?: string; items?: unknown[] };
            } =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "setCommitChecks",
        )
        .map((message) => message.snapshot);
    return snapshots[snapshots.length - 1];
}

async function setupCommitPanelProvider(
    configure?: (gitOps: ReturnType<typeof makeGitOpsMock>) => void,
    options: { secrets?: ReturnType<typeof makeSecretStorage> } = {},
) {
    const { CommitPanelViewProvider } = await import("../../../src/views/CommitPanelViewProvider");
    const gitOps = makeGitOpsMock();
    configure?.(gitOps);
    const draftStore = createMemento();
    const provider = new CommitPanelViewProvider(
        { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
        gitOps as unknown as object,
        { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
        draftStore as unknown as object,
        options.secrets as unknown as object,
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
        registeredCommands.clear();
        activeTextEditorListeners.length = 0;
        activeTextEditor = undefined;
        activeGitRoot.value = "";
        deferBranchRefreshes.active = false;
        branchRefreshControls.length = 0;
        refreshServiceInstances.length = 0;
        workspaceState.workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        showWarningMessage.mockResolvedValue(undefined);
        providerGetChecks.mockImplementation(async (hash: string) => ({
            hash,
            state: "success",
            summary: "All checks passed",
            items: [],
        }));
    });

    it("active editor switches providers to the deepest matching repository", async () => {
        const { activateRepositoryMode } = await import("../../../src/activation/repositoryMode");
        const repoA = "/workspace";
        const repoB = "/workspace/packages/app";
        const captured: {
            commitGraph?: { setRepositoryLabel: (label: string) => void };
            sidebarGraph?: { setRepositoryLabel: (label: string) => void };
            commitPanel?: {
                activeRepositoryRoot: string | null;
                repositories: Array<{ root: string; label: string }>;
                runtimes: Map<string, unknown>;
                setRepositoryLabel: (label: string) => void;
                setRepositoryRootUri: (uri: { fsPath: string }) => void;
            };
        } = {};
        const context = {
            extensionUri: vscodeMock.Uri.file("/ext"),
            subscriptions: [],
            workspaceState: createMemento(),
            secrets: {},
        };

        await activateRepositoryMode(
            context as never,
            [
                { root: repoA, label: "workspace" },
                { root: repoB, label: "app" },
            ],
            {
                commitGraph: {
                    setProvider: (provider: unknown) => (captured.commitGraph = provider as never),
                },
                sidebarGraph: {
                    setProvider: (provider: unknown) => (captured.sidebarGraph = provider as never),
                },
                commitPanel: {
                    setProvider: (provider: unknown) => (captured.commitPanel = provider as never),
                },
            } as never,
        );
        expect(activeTextEditorListeners).toHaveLength(1);
        expect(captured.commitPanel!.repositories).toEqual([
            { root: repoA, label: "workspace" },
            { root: repoB, label: "app" },
        ]);
        expect(captured.commitPanel!.activeRepositoryRoot).toBe(repoA);
        expect(captured.commitPanel!.runtimes.has(repoA)).toBe(true);
        expect(captured.commitPanel!.runtimes.has(repoB)).toBe(true);

        const commitGraphLabelSpy = vi.spyOn(captured.commitGraph!, "setRepositoryLabel");
        const sidebarGraphLabelSpy = vi.spyOn(captured.sidebarGraph!, "setRepositoryLabel");
        const commitPanelRootSpy = vi.spyOn(captured.commitPanel!, "setRepositoryRootUri");
        const commitPanelLabelSpy = vi.spyOn(captured.commitPanel!, "setRepositoryLabel");
        gitExecutorSetRoot.mockClear();

        const fireActiveEditor = async (uri: unknown): Promise<void> => {
            activeTextEditorListeners.forEach((listener) => listener({ document: { uri } }));
            await flushMicrotasks();
            await flushMicrotasks();
        };

        await fireActiveEditor({ scheme: "untitled", fsPath: `${repoB}/src/file.ts` });
        await fireActiveEditor(vscodeMock.Uri.file("/other/src/file.ts"));

        expect(gitExecutorSetRoot).not.toHaveBeenCalledWith(repoB);
        expect(commitPanelRootSpy).not.toHaveBeenCalled();

        await fireActiveEditor(vscodeMock.Uri.file(`${repoB}/src/file.ts`));

        expect(gitExecutorSetRoot).toHaveBeenCalledWith(repoB);
        expect(commitGraphLabelSpy).toHaveBeenCalledWith("app");
        expect(sidebarGraphLabelSpy).toHaveBeenCalledWith("app");
        expect(commitPanelRootSpy).toHaveBeenCalledWith(expect.objectContaining({ fsPath: repoB }));
        expect(commitPanelLabelSpy).toHaveBeenCalledWith("app");
        expect(captured.commitPanel!.activeRepositoryRoot).toBe(repoB);
        expect(captured.commitPanel!.runtimes.has(repoA)).toBe(true);
        expect(captured.commitPanel!.runtimes.has(repoB)).toBe(true);
    });

    it("registers startup active-editor repository watchers once", async () => {
        const { activateRepositoryMode } = await import("../../../src/activation/repositoryMode");
        const repoA = "/workspace/app-a";
        const repoB = "/workspace/app-b";
        activeTextEditor = {
            document: { uri: vscodeMock.Uri.file(`${repoB}/src/file.ts`) },
        };

        await activateRepositoryMode(
            {
                extensionUri: vscodeMock.Uri.file("/ext"),
                subscriptions: [],
                workspaceState: createMemento(),
                secrets: {},
            } as never,
            [
                { root: repoA, label: "app-a" },
                { root: repoB, label: "app-b" },
            ],
        );

        const repoBRefreshServices = refreshServiceInstances.filter(
            (instance) => instance.root === repoB,
        );
        expect(repoBRefreshServices).toHaveLength(1);
        expect(repoBRefreshServices[0].registerFileWatchers).toHaveBeenCalledTimes(1);
    });

    it("keeps the latest active-editor repository when earlier refreshes finish last", async () => {
        const { SELECTED_REPOSITORY_KEY } = await import("../../../src/activation/common");
        const { activateRepositoryMode } = await import("../../../src/activation/repositoryMode");
        const initialRepo = "/workspace/app-c";
        const repoA = "/workspace/app-a";
        const repoB = "/workspace/app-b";
        const captured: {
            commitGraph?: { setBranches: (branches: unknown[], worktrees: unknown[]) => void };
            commitPanel?: { setRepositoryRootUri: (uri: { fsPath: string }) => void };
        } = {};
        const controlledWorkspaceStore = createControlledMemento();
        const context = {
            extensionUri: vscodeMock.Uri.file("/ext"),
            subscriptions: [],
            workspaceState: controlledWorkspaceStore.memento,
            secrets: {},
        };

        await activateRepositoryMode(
            context as never,
            [
                { root: initialRepo, label: "app-c" },
                { root: repoA, label: "app-a" },
                { root: repoB, label: "app-b" },
            ],
            {
                commitGraph: {
                    setProvider: (provider: unknown) => (captured.commitGraph = provider as never),
                },
                commitPanel: {
                    setProvider: (provider: unknown) => (captured.commitPanel = provider as never),
                },
            } as never,
        );

        const commitGraphBranchesSpy = vi.spyOn(captured.commitGraph!, "setBranches");
        const commitPanelRootSpy = vi.spyOn(captured.commitPanel!, "setRepositoryRootUri");
        deferBranchRefreshes.active = true;
        const resolvePendingUpdatesFor = async (root: string): Promise<void> => {
            let resolvedAny = true;
            while (resolvedAny) {
                resolvedAny = false;
                for (const update of controlledWorkspaceStore.pendingUpdates.filter(
                    (candidate) => !candidate.resolved && candidate.value === root,
                )) {
                    update.resolved = true;
                    update.resolve();
                    resolvedAny = true;
                }
                await flushMicrotasks();
            }
        };
        const resolveBranchRefreshesFor = async (root: string): Promise<void> => {
            let resolvedAny = true;
            while (resolvedAny) {
                resolvedAny = false;
                for (const control of branchRefreshControls.filter(
                    (candidate) => !candidate.resolved && candidate.root === root,
                )) {
                    control.resolved = true;
                    control.resolve(makeBranchesForRoot(root));
                    resolvedAny = true;
                }
                await flushMicrotasks();
            }
        };

        activeTextEditorListeners.forEach((listener) =>
            listener({ document: { uri: vscodeMock.Uri.file(`${repoA}/src/a.ts`) } }),
        );
        await flushMicrotasks();
        await resolveBranchRefreshesFor(repoA);
        expect(
            controlledWorkspaceStore.pendingUpdates.some(
                (update) => !update.resolved && update.value === repoA,
            ),
        ).toBe(true);

        activeTextEditorListeners.forEach((listener) =>
            listener({ document: { uri: vscodeMock.Uri.file(`${repoB}/src/b.ts`) } }),
        );
        await flushMicrotasks();

        await resolveBranchRefreshesFor(repoB);
        await resolvePendingUpdatesFor(repoB);
        await resolvePendingUpdatesFor(repoA);
        await resolvePendingUpdatesFor(repoB);

        const latestBranches = commitGraphBranchesSpy.mock.calls.at(-1)?.[0] as
            | Array<{ name: string }>
            | undefined;
        expect(commitPanelRootSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ fsPath: repoB }),
        );
        expect(latestBranches?.[0]?.name).toBe("branch-app-b");
        expect(controlledWorkspaceStore.memento.get(SELECTED_REPOSITORY_KEY)).toBe(repoB);
    });

    it("OnboardingViewProvider renders clone and open-folder actions when no workspace is open", async () => {
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { OnboardingViewProvider } =
            await import("../../../src/views/OnboardingViewProvider");
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
        const { CommitInfoViewProvider } =
            await import("../../../src/views/CommitInfoViewProvider");
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

    it("UndockedViewProvider migrates legacy persisted column widths", async () => {
        const { UndockedViewProvider } = await import("../../../src/views/UndockedViewProvider");
        const provider = new UndockedViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            makeGitOpsMock() as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            makeCredentialStore() as unknown as object,
            createMemento({
                "intelligit.undockedColumnWidths": {
                    branchWidth: 400,
                    infoWidth: 300,
                    commitPanelWidth: 200,
                },
            }) as unknown as object,
        );
        const testProvider = provider as unknown as {
            panel: {
                webview: { postMessage: typeof postMessageSpy };
                dispose: ReturnType<typeof vi.fn>;
            };
            sendPersistedColumnWidths: () => void;
        };
        testProvider.panel = {
            webview: { postMessage: postMessageSpy },
            dispose: vi.fn(),
        };

        testProvider.sendPersistedColumnWidths();

        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "columnWidths",
            branchWidth: 400,
            graphWidth: 300,
            infoWidth: 300,
            commitPanelWidth: 200,
        });
    });

    it("UndockedViewProvider handles graph and commit-panel message protocols", async () => {
        const { UndockedViewProvider } = await import("../../../src/views/UndockedViewProvider");
        const gitOps = makeGitOpsMock();
        const workspaceStore = createMemento({ "commitDraft:/repo": "stored draft" });
        const provider = new UndockedViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            makeCredentialStore() as unknown as object,
            workspaceStore as unknown as object,
        );
        const selected: string[] = [];
        const branchActions: unknown[] = [];
        const commitActions: unknown[] = [];
        const fileDiffs: unknown[] = [];
        const fileCounts: number[] = [];
        const workingTreeEvents: void[] = [];
        const dockRequests: void[] = [];
        provider.onCommitSelected((hash) => selected.push(hash));
        provider.onBranchAction((action) => branchActions.push(action));
        provider.onCommitAction((action) => commitActions.push(action));
        provider.onOpenCommitFileDiff((payload) => fileDiffs.push(payload));
        provider.onDidChangeFileCount((count) => fileCounts.push(count));
        provider.onDidChangeWorkingTree(() => workingTreeEvents.push(undefined));
        provider.onDockRequested(() => dockRequests.push(undefined));

        const testProvider = provider as unknown as {
            panel: {
                webview: { postMessage: typeof postMessageSpy };
                dispose: ReturnType<typeof vi.fn>;
            };
            iconTheme: {
                initIconThemeData: ReturnType<typeof vi.fn>;
                getFolderIconsByBranches: ReturnType<typeof vi.fn>;
                getThemeData: ReturnType<typeof vi.fn>;
                decorateWorkingFiles: ReturnType<typeof vi.fn>;
                getFolderIconsByWorkingFiles: ReturnType<typeof vi.fn>;
                decorateCommitDetailWithFolderIcons: ReturnType<typeof vi.fn>;
                dispose: ReturnType<typeof vi.fn>;
            };
            handleMessage: (msg: unknown) => Promise<void>;
        };
        testProvider.panel = {
            webview: { postMessage: postMessageSpy },
            dispose: vi.fn(),
        };
        testProvider.iconTheme = {
            initIconThemeData: vi.fn(async () => undefined),
            getFolderIconsByBranches: vi.fn(async () => ({})),
            getThemeData: vi.fn(() => ({
                folderIcons: { folderIcon: "folder", folderExpandedIcon: "folder-open" },
                iconFonts: [],
            })),
            decorateWorkingFiles: vi.fn(async (files: unknown) => files),
            getFolderIconsByWorkingFiles: vi.fn(async () => ({})),
            decorateCommitDetailWithFolderIcons: vi.fn(async (detail: unknown) => ({
                detail,
                folderIconsByName: {},
            })),
            dispose: vi.fn(),
        };
        provider.setBranches([
            {
                name: "main",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                ahead: 0,
                behind: 0,
            },
        ]);
        const send = (msg: unknown) => testProvider.handleMessage.call(provider, msg);
        postMessageSpy.mockClear();

        await send({ type: "ready" });
        expect(gitOps.getLog).toHaveBeenCalledWith(500, undefined, undefined, 0);
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "restoreCommitDraft",
            message: "stored draft",
        });

        postMessageSpy.mockClear();
        await send({ type: "stashSelect", index: 0 });
        expect(gitOps.getStashFiles).toHaveBeenLastCalledWith(0);
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                selectedStashIndex: 0,
                stashFiles: [expect.objectContaining({ path: "src/a.ts" })],
            }),
        );

        await send({
            type: "columnWidths",
            branchWidth: 410,
            graphWidth: 510,
            infoWidth: 310,
            commitPanelWidth: 210,
        });
        expect(workspaceStore.update).toHaveBeenCalledWith("intelligit.undockedColumnWidths", {
            branchWidth: 410,
            graphWidth: 510,
            infoWidth: 310,
            commitPanelWidth: 210,
        });

        await send({ type: "selectCommit", hash: "abc1234" });
        await send({ type: "filterText", text: "fix" });
        await send({ type: "filterBranch", branch: "main" });
        await send({ type: "loadMore" });
        await send({ type: "branchAction", action: "checkout", branchName: "main" });
        await send({ type: "commitAction", action: "copyRevision", hash: "abc1234" });
        await send({ type: "openCommitFileDiff", commitHash: "abc1234", filePath: "src/a.ts" });
        await send({ type: "dock" });
        expect(selected).toEqual(["abc1234"]);
        expect(branchActions).toEqual([{ action: "checkout", branchName: "main" }]);
        expect(commitActions).toEqual([{ action: "copyRevision", hash: "abc1234" }]);
        expect(fileDiffs).toEqual([{ commitHash: "abc1234", filePath: "src/a.ts" }]);
        expect(dockRequests).toHaveLength(1);
        expect(gitOps.getLog).toHaveBeenCalledWith(500, undefined, "fix", 0);
        expect(gitOps.getLog).toHaveBeenCalledWith(500, "main", undefined, 0);
        expect(gitOps.getLog).toHaveBeenCalledWith(500, "main", undefined, 1);

        await send({ type: "saveCommitDraft", message: "new draft" });
        expect(workspaceStore.update).toHaveBeenCalledWith("commitDraft:/repo", "new draft");

        await send({ type: "stageFiles", paths: ["src/a.ts"] });
        await send({ type: "unstageFiles", paths: ["src/a.ts"] });
        gitOps.getStatus.mockResolvedValue([]);
        await send({
            type: "commitSelected",
            message: "feat: selected",
            amend: false,
            push: true,
            paths: ["src/a.ts"],
        });
        await send({ type: "commit", message: "feat: commit", amend: false });
        await send({ type: "commitAndPush", message: "feat: push", amend: false });
        await send({ type: "publishBranch" });
        await send({ type: "getLastCommitMessage" });
        await send({ type: "getAmendBranchCommits" });
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await send({ type: "rollback", paths: ["src/a.ts"] });
        await send({ type: "showDiff", path: "src/a.ts" });
        await send({ type: "stashSave", name: "work", paths: ["src/a.ts"] });
        await send({ type: "stashPop", index: 0 });
        await send({ type: "stashApply", index: 0 });
        showWarningMessage.mockResolvedValueOnce("Delete");
        await send({ type: "stashDelete", index: 0 });
        await send({ type: "showStashDiff", index: 0, path: "src/a.ts" });
        await send({ type: "openFile", path: "src/a.ts" });
        showWarningMessage.mockResolvedValueOnce("Delete");
        await send({ type: "deleteFile", path: "src/a.ts" });

        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.unstageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: selected", false);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: commit", false);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: push", false);
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalled();
        expect(executeCommand).toHaveBeenCalledWith("intelligit.publishBranch");
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "lastCommitMessage",
            message: "last message",
        });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "amendBranchCommits",
            commits: [
                { shortHash: "abc1234", subject: "feat: amend ctx", date: "2026-02-19T00:00:00Z" },
            ],
        });
        expect(gitOps.rollbackFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(executeCommand).toHaveBeenCalledWith("git.openChange", expect.any(Object));
        expect(gitOps.stashSave).toHaveBeenCalledWith(["src/a.ts"], "work");
        expect(gitOps.stashPop).toHaveBeenCalledWith(0);
        expect(gitOps.stashApply).toHaveBeenCalledWith(0);
        expect(gitOps.stashDelete).toHaveBeenCalledWith(0);
        expect(gitOps.getStashFilePatch).toHaveBeenCalledWith(0, "src/a.ts");
        expect(deleteFileWithFallback).toHaveBeenCalledWith(gitOps, expect.any(Object), "src/a.ts");
        expect(workingTreeEvents.length).toBeGreaterThanOrEqual(9);
        expect(fileCounts.length).toBeGreaterThan(0);
    });

    it("UndockedViewProvider drops stale commit-check replies after cache scope changes", async () => {
        const { UndockedViewProvider } = await import("../../../src/views/UndockedViewProvider");
        const provider = new UndockedViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            makeGitOpsMock() as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            makeCredentialStore() as unknown as object,
            createMemento() as unknown as object,
        );
        const testProvider = provider as unknown as {
            panel: {
                webview: { postMessage: typeof postMessageSpy };
                dispose: ReturnType<typeof vi.fn>;
            };
            handleMessage: (msg: unknown) => Promise<void>;
        };
        testProvider.panel = {
            webview: { postMessage: postMessageSpy },
            dispose: vi.fn(),
        };
        let resolveFirst!: (value: unknown) => void;
        providerGetChecks.mockReset();
        providerGetChecks
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveFirst = resolve;
                }),
            )
            .mockResolvedValueOnce({
                hash: "abc1234",
                state: "success",
                summary: "All checks passed",
                items: [],
            });
        postMessageSpy.mockClear();

        const staleRequest = testProvider.handleMessage.call(provider, {
            type: "requestCommitChecks",
            hash: "abc1234",
        });
        provider.clearChecksCache();
        resolveFirst({
            hash: "abc1234",
            state: "pending",
            summary: "Checks pending",
            items: [],
        });
        await staleRequest;

        expect(lastCommitChecksSnapshot()).toBeUndefined();

        await testProvider.handleMessage.call(provider, {
            type: "requestCommitChecks",
            hash: "abc1234",
        });
        expect(lastCommitChecksSnapshot()).toEqual(expect.objectContaining({ state: "success" }));
        expect(providerGetChecks).toHaveBeenCalledTimes(2);
        provider.dispose();
    });

    it("CommitGraphViewProvider handles webview events and refresh/load flows", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
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

    it("CommitGraphViewProvider serves a cached pending snapshot for a sub-poll burst (TTL throttle)", async () => {
        // Production wiring uses a non-zero TTL (DEFAULT_COMMIT_CHECKS_TTL_MS ~15s), so two
        // back-to-back requests for the same hash within that window serve cache rather than
        // re-fetching on every webview re-render. The after-TTL re-fetch is covered by the
        // coordinator unit tests with a fake clock; here we guard the throttle end-to-end.
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        // Drop the shared beforeEach impl and any once-values a prior test left unconsumed
        // (clearAllMocks does not drain the mockResolvedValueOnce queue, and the TTL means
        // each test now makes a single call, so an unused second value would leak forward).
        // A second mock value proves the cache is what suppresses the re-fetch: if the TTL
        // were ignored, the second send would consume it and post "success".
        providerGetChecks.mockReset();
        providerGetChecks
            .mockResolvedValueOnce({
                hash: "abc1234",
                state: "pending",
                summary: "Checks pending",
                items: [],
            })
            .mockResolvedValueOnce({
                hash: "abc1234",
                state: "success",
                summary: "All checks passed",
                items: [],
            });

        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });
        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });

        expect(providerGetChecks).toHaveBeenCalledTimes(1);
        expect(postMessageSpy).toHaveBeenLastCalledWith({
            type: "setCommitChecks",
            snapshot: expect.objectContaining({ state: "pending" }),
        });
        provider.dispose();
    });

    it("CommitGraphViewProvider serves a cached none snapshot for a sub-poll burst (TTL throttle)", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        // See the pending test above: reset the shared spy so a leftover once-value cannot
        // satisfy this test's first fetch.
        providerGetChecks.mockReset();
        providerGetChecks
            .mockResolvedValueOnce({
                hash: "abc1234",
                state: "none",
                summary: "No checks found",
                items: [],
            })
            .mockResolvedValueOnce({
                hash: "abc1234",
                state: "pending",
                summary: "Checks pending",
                items: [],
            });

        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });
        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });

        expect(providerGetChecks).toHaveBeenCalledTimes(1);
        expect(postMessageSpy).toHaveBeenLastCalledWith({
            type: "setCommitChecks",
            snapshot: expect.objectContaining({ state: "none" }),
        });
        provider.dispose();
    });

    it("CommitGraphViewProvider rejects invalid webview command payloads", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
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

    it("CommitGraphViewProvider emits validated bulk branch delete messages", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
        );
        const webview = createWebviewView();
        const deleteBranches = vi.fn();

        (
            provider as unknown as {
                onDeleteBranches(listener: (branches: unknown[]) => void): void;
            }
        ).onDeleteBranches(deleteBranches);
        const branchRows = [
            {
                name: "feature-one",
                hash: "abc1234",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-two",
                hash: "def5678",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ];
        provider.setBranches(branchRows);
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({
            type: "deleteBranches",
            branches: [{ name: "feature-one" }, { name: "origin/feature-two", isRemote: false }],
        });

        expect(deleteBranches).toHaveBeenCalledWith(branchRows);

        provider.dispose();
    });

    it("CommitGraphViewProvider rejects invalid bulk branch delete payloads", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
        );
        const webview = createWebviewView();
        const deleteBranches = vi.fn();

        (
            provider as unknown as {
                onDeleteBranches(listener: (branches: unknown[]) => void): void;
            }
        ).onDeleteBranches(deleteBranches);
        provider.setBranches([
            {
                name: "feature-one",
                hash: "abc1234",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ]);
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "deleteBranches", branches: [{ name: "feature-one" }, {}] });
        await webview.send({ type: "deleteBranches", branches: [] });

        expect(deleteBranches).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Branch action error"),
        );

        provider.dispose();
    });

    it("CommitInfoViewProvider rejects invalid open-file-diff payloads", async () => {
        const { CommitInfoViewProvider } =
            await import("../../../src/views/CommitInfoViewProvider");
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

    it("CommitPanelViewProvider resolveWebviewView replays no Git data until ready or visible", async () => {
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            createMemento() as unknown as object,
        );
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        expect(gitOps.getStatus).not.toHaveBeenCalled();
        expect(postMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "update" }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes retain unchanged roots and drop removed roots", async () => {
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            makeGitOpsMock() as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            createMemento() as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        const repoA = { root: "/repo-a", label: "Repo A" };
        const repoB = { root: "/repo-b", label: "Repo B" };
        postMessageSpy.mockClear();

        provider.setRepositories([repoA, repoB], repoA.root);
        const testProvider = provider as unknown as {
            activeRepositoryRoot: string | null;
            repositories: Array<{ root: string; label: string }>;
            runtimes: Map<
                string,
                {
                    files: Array<{
                        path: string;
                        status: string;
                        staged: boolean;
                        additions: number;
                        deletions: number;
                    }>;
                }
            >;
        };
        const runtimeA = testProvider.runtimes.get(repoA.root);
        const runtimeB = testProvider.runtimes.get(repoB.root);
        expect(runtimeA).toBeDefined();
        expect(runtimeB).toBeDefined();
        runtimeB!.files = [
            { path: "src/b.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ];

        provider.setRepositories([repoB]);

        expect(testProvider.runtimes.has(repoA.root)).toBe(false);
        expect(testProvider.runtimes.get(repoB.root)).toBe(runtimeB);
        expect(testProvider.activeRepositoryRoot).toBe(repoB.root);
        expect(testProvider.repositories).toEqual([repoB]);
        expect(postMessageSpy).toHaveBeenLastCalledWith({
            type: "setRepositories",
            repositories: [repoB],
            activeRepositoryRoot: repoB.root,
        });
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes preserve hydrated roots when active root changes", async () => {
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            makeGitOpsMock() as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            createMemento() as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        const repoA = { root: "/repo-a", label: "Repo A" };
        const repoB = { root: "/repo-b", label: "Repo B" };
        provider.setRepositories([repoA, repoB], repoA.root);
        const testProvider = provider as unknown as {
            activeRepositoryRoot: string | null;
            runtimes: Map<string, unknown>;
        };
        const runtimeA = testProvider.runtimes.get(repoA.root);
        const runtimeB = testProvider.runtimes.get(repoB.root);
        expect(runtimeA).toBeDefined();
        expect(runtimeB).toBeDefined();
        postMessageSpy.mockClear();

        provider.setRepositoryRootUri({ fsPath: repoB.root, path: repoB.root } as unknown as {
            fsPath: string;
            path: string;
        });

        expect(testProvider.runtimes.get(repoA.root)).toBe(runtimeA);
        expect(testProvider.runtimes.get(repoB.root)).toBe(runtimeB);
        expect(testProvider.activeRepositoryRoot).toBe(repoB.root);
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "restoreCommitDraft",
            repositoryRoot: repoB.root,
            message: "",
        });
        expect(postMessageSpy).toHaveBeenLastCalledWith({
            type: "setRepositories",
            repositories: [repoA, repoB],
            activeRepositoryRoot: repoB.root,
        });
        provider.dispose();
    });

    it("Unknown repository showDiff is rejected before Git or git.openChange", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockClear();
        executeCommand.mockClear();
        showErrorMessage.mockClear();
        postMessageSpy.mockClear();

        await webview.send({ type: "showDiff", repositoryRoot: "/unknown", path: "src/a.ts" });

        expect(gitOps.getStatus).not.toHaveBeenCalled();
        expect(executeCommand).not.toHaveBeenCalledWith("git.openChange", expect.anything());
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Unknown repository root received from webview.",
        );
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "error",
            message: "Unknown repository root received from webview.",
        });
        provider.dispose();
    });

    it("Unknown repository openCommitFileDiff is rejected before firing the graph event", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        const openCommitFileDiff = vi.fn();
        const disposable = provider.onOpenCommitFileDiff(openCommitFileDiff);
        showErrorMessage.mockClear();
        postMessageSpy.mockClear();

        await webview.send({
            type: "openCommitFileDiff",
            repositoryRoot: "/unknown",
            commitHash: "abc1234",
            filePath: "src/a.ts",
        });

        expect(openCommitFileDiff).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Unknown repository root received from webview.",
        );
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "error",
            message: "Unknown repository root received from webview.",
        });
        disposable.dispose();
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes route scoped actions through selected runtime GitOps and root", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getStatus.mockResolvedValue([
            { path: "src/b.ts", status: "M", staged: false, additions: 2, deletions: 0 },
        ]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const runtimeB = (
            provider as unknown as {
                runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
            }
        ).runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        gitOps.stageFiles.mockClear();
        repoBGitOps.stageFiles.mockClear();
        postMessageSpy.mockClear();

        await webview.send({
            type: "stageFiles",
            repositoryRoot: "/repo-b",
            paths: ["src/b.ts"],
        });

        expect(repoBGitOps.stageFiles).toHaveBeenCalledWith(["src/b.ts"]);
        expect(gitOps.stageFiles).not.toHaveBeenCalled();
        expect(repoBGitOps.getStatus).toHaveBeenCalledWith({ includeIgnored: false });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                repositoryRoot: "/repo-b",
                files: [expect.objectContaining({ path: "src/b.ts" })],
            }),
        );

        executeCommand.mockClear();
        await webview.send({
            type: "showDiff",
            repositoryRoot: "/repo-b",
            path: "src/b.ts",
        });
        expect(executeCommand).toHaveBeenCalledWith(
            "git.openChange",
            expect.objectContaining({ fsPath: "/repo-b/src/b.ts" }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes skip graph refresh for non-active scoped actions", async () => {
        vi.useFakeTimers();
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getStatus.mockResolvedValue([
            { path: "src/b.ts", status: "M", staged: false, additions: 2, deletions: 0 },
        ]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const runtimeB = (
            provider as unknown as {
                runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
            }
        ).runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        gitOps.getLog.mockClear();
        repoBGitOps.fetch.mockClear();
        repoBGitOps.getStatus.mockClear();
        repoBGitOps.listStashes.mockClear();
        repoBGitOps.getLog.mockClear();
        postMessageSpy.mockClear();

        try {
            const fetch = webview.send({ type: "fetch", repositoryRoot: "/repo-b" });
            await vi.advanceTimersByTimeAsync(1_000);
            await fetch;
        } finally {
            vi.useRealTimers();
        }

        expect(repoBGitOps.fetch).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getStatus).toHaveBeenCalledWith({ includeIgnored: false });
        expect(repoBGitOps.listStashes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getLog).not.toHaveBeenCalled();
        expect(gitOps.getLog).not.toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                repositoryRoot: "/repo-b",
                files: [expect.objectContaining({ path: "src/b.ts" })],
            }),
        );
        expect(postMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "loadCommits" }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes skip graph refresh for non-active abortMerge", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getStatus.mockResolvedValue([
            { path: "src/b.ts", status: "M", staged: false, additions: 2, deletions: 0 },
        ]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const runtimeB = (
            provider as unknown as {
                runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
            }
        ).runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        const workingTreeChanged = vi.fn();
        const disposable = provider.onDidChangeWorkingTree(workingTreeChanged);
        gitOps.getLog.mockClear();
        repoBGitOps.abortMerge.mockClear();
        repoBGitOps.getStatus.mockClear();
        repoBGitOps.listStashes.mockClear();
        repoBGitOps.getLog.mockClear();
        executeCommand.mockClear();
        postMessageSpy.mockClear();
        showWarningMessage.mockResolvedValueOnce("Abort Merge");

        await webview.send({ type: "abortMerge", repositoryRoot: "/repo-b" });

        expect(repoBGitOps.abortMerge).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getStatus).toHaveBeenCalledWith({ includeIgnored: false });
        expect(repoBGitOps.listStashes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getLog).not.toHaveBeenCalled();
        expect(gitOps.getLog).not.toHaveBeenCalled();
        expect(workingTreeChanged).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenCalledWith("intelligit.mergeConflictsRefresh");
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                repositoryRoot: "/repo-b",
                files: [expect.objectContaining({ path: "src/b.ts" })],
            }),
        );
        expect(postMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "loadCommits" }),
        );
        disposable.dispose();
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes route scoped publishBranch through selected runtime", async () => {
        const secrets = makeSecretStorage();
        const { provider, gitOps, webview } = await setupCommitPanelProvider(undefined, {
            secrets,
        });
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getBranches.mockResolvedValue([
            {
                name: "feature-b",
                hash: "def5678",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const runtimeB = (
            provider as unknown as {
                runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
            }
        ).runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        gitOps.hasAnyCommits.mockClear();
        gitOps.getBranches.mockClear();
        repoBGitOps.hasAnyCommits.mockClear();
        repoBGitOps.getBranches.mockClear();
        executeCommand.mockClear();
        runPublishBranchFlowSpy.mockClear();

        await webview.send({ type: "publishBranch", repositoryRoot: "/repo-b" });

        expect(repoBGitOps.hasAnyCommits).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(gitOps.hasAnyCommits).not.toHaveBeenCalled();
        expect(gitOps.getBranches).not.toHaveBeenCalled();
        expect(runPublishBranchFlowSpy).toHaveBeenCalledWith(
            repoBGitOps,
            "feature-b",
            "/repo-b",
            secrets,
        );
        expect(executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes route unpublished push publish through selected runtime", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getBranches.mockResolvedValue([
            {
                name: "feature-b",
                hash: "def5678",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);
        repoBGitOps.getStatus.mockResolvedValue([]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const runtimeB = (
            provider as unknown as {
                runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
            }
        ).runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        gitOps.hasAnyCommits.mockClear();
        gitOps.getBranches.mockClear();
        gitOps.push.mockClear();
        repoBGitOps.hasAnyCommits.mockClear();
        repoBGitOps.getBranches.mockClear();
        repoBGitOps.push.mockClear();
        executeCommand.mockClear();
        runPublishBranchFlowSpy.mockClear();

        await webview.send({ type: "push", repositoryRoot: "/repo-b" });

        expect(repoBGitOps.hasAnyCommits).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getBranches).toHaveBeenCalled();
        expect(repoBGitOps.push).not.toHaveBeenCalled();
        expect(gitOps.hasAnyCommits).not.toHaveBeenCalled();
        expect(gitOps.getBranches).not.toHaveBeenCalled();
        expect(gitOps.push).not.toHaveBeenCalled();
        expect(runPublishBranchFlowSpy).toHaveBeenCalledWith(
            repoBGitOps,
            "feature-b",
            "/repo-b",
            undefined,
        );
        expect(executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
        provider.dispose();
    });

    it("CommitPanelViewProvider repository runtimes route post-commit publish prompt through selected runtime", async () => {
        const { provider, gitOps } = await setupCommitPanelProvider();
        const repoBGitOps = makeGitOpsMock();
        repoBGitOps.getBranches.mockResolvedValue([
            {
                name: "feature-b",
                hash: "def5678",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);
        provider.setRepositories(
            [
                { root: "/repo", label: "Repo A" },
                { root: "/repo-b", label: "Repo B" },
            ],
            "/repo",
        );
        const testProvider = provider as unknown as {
            maybeOfferPublishBranch(runtime: unknown): Promise<void>;
            runtimes: Map<string, { gitOps: ReturnType<typeof makeGitOpsMock> }>;
        };
        const runtimeB = testProvider.runtimes.get("/repo-b");
        expect(runtimeB).toBeDefined();
        runtimeB!.gitOps = repoBGitOps;
        showInformationMessage.mockResolvedValueOnce("Publish Branch...");
        gitOps.hasAnyCommits.mockClear();
        gitOps.getBranches.mockClear();
        repoBGitOps.hasAnyCommits.mockClear();
        repoBGitOps.getBranches.mockClear();
        executeCommand.mockClear();
        runPublishBranchFlowSpy.mockClear();

        await testProvider.maybeOfferPublishBranch(runtimeB);

        expect(showInformationMessage).toHaveBeenCalledWith(
            'Branch "{branch}" has not been published.',
            "Publish Branch...",
        );
        expect(repoBGitOps.hasAnyCommits).toHaveBeenCalledTimes(2);
        expect(repoBGitOps.getBranches).toHaveBeenCalledTimes(2);
        expect(gitOps.hasAnyCommits).not.toHaveBeenCalled();
        expect(gitOps.getBranches).not.toHaveBeenCalled();
        expect(runPublishBranchFlowSpy).toHaveBeenCalledWith(
            repoBGitOps,
            "feature-b",
            "/repo-b",
            undefined,
        );
        expect(executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
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

    it("CommitPanelViewProvider tracks unversioned files with intent-to-add and a silent refresh", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        const workingTreeChanged = vi.fn();
        const disposable = provider.onDidChangeWorkingTree(workingTreeChanged);
        gitOps.getStatus.mockResolvedValue([
            { path: "new-file.txt", status: "?", staged: false, additions: 0, deletions: 0 },
        ]);
        postMessageSpy.mockClear();
        executeCommand.mockClear();

        await webview.send({ type: "trackUnversionedFiles", paths: ["new-file.txt"] });

        expect(gitOps.intentToAddFiles).toHaveBeenCalledWith(["new-file.txt"]);
        expect(workingTreeChanged).toHaveBeenCalledTimes(1);
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        expect(refreshingStates()).toEqual([]);
        expect(executeCommand).not.toHaveBeenCalledWith(
            "setContext",
            "intelligit.commitPanel.refreshing",
            true,
        );
        disposable.dispose();
        provider.dispose();
    });

    it("CommitPanelViewProvider accepts already intent-to-add files from stale drop checks", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockResolvedValue([
            { path: "new-file.txt", status: "A", staged: false, additions: 0, deletions: 0 },
        ]);

        await webview.send({ type: "trackUnversionedFiles", paths: ["new-file.txt"] });

        expect(gitOps.intentToAddFiles).toHaveBeenCalledWith(["new-file.txt"]);
        expect(showErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining("unversioned"));
        provider.dispose();
    });

    it("CommitPanelViewProvider rejects stale track-unversioned requests before intent-to-add", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockResolvedValue([
            { path: "new-file.txt", status: "M", staged: false, additions: 1, deletions: 0 },
        ]);

        await webview.send({ type: "trackUnversionedFiles", paths: ["new-file.txt"] });

        expect(gitOps.intentToAddFiles).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("unversioned"));
        provider.dispose();
    });

    it("CommitPanelViewProvider silently refreshes when a resolved view becomes visible", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockResolvedValue([
            { path: "visible.ts", status: "M", staged: false, additions: 2, deletions: 0 },
        ]);
        gitOps.getStatus.mockClear();
        postMessageSpy.mockClear();
        executeCommand.mockClear();

        webview.setVisible(false);
        await flushMicrotasks();
        expect(gitOps.getStatus).not.toHaveBeenCalled();

        webview.setVisible(true);
        for (let i = 0; i < 10; i += 1) {
            await flushMicrotasks();
            const hasVisibleUpdate = postMessageSpy.mock.calls.some(([message]) => {
                if (
                    typeof message !== "object" ||
                    message === null ||
                    !("type" in message) ||
                    message.type !== "update" ||
                    !("files" in message) ||
                    !Array.isArray(message.files)
                ) {
                    return false;
                }
                return message.files.some(
                    (file) =>
                        typeof file === "object" &&
                        file !== null &&
                        "path" in file &&
                        file.path === "visible.ts",
                );
            });
            if (hasVisibleUpdate) break;
        }

        expect(gitOps.getStatus).toHaveBeenCalled();
        expect(refreshingStates()).toEqual([]);
        expect(executeCommand).not.toHaveBeenCalledWith(
            "setContext",
            "intelligit.commitPanel.refreshing",
            true,
        );
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                files: expect.arrayContaining([expect.objectContaining({ path: "visible.ts" })]),
            }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider refreshSilent updates without showing refreshing state", async () => {
        const { provider } = await setupCommitPanelProvider();
        postMessageSpy.mockClear();
        executeCommand.mockClear();

        await (provider as typeof provider & { refreshSilent(): Promise<void> }).refreshSilent();

        const messages = postMessageSpy.mock.calls.map(([message]) => message);
        const updateIndex = messages.findIndex(
            (message) =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "update",
        );

        expect(updateIndex).toBeGreaterThanOrEqual(0);
        expect(refreshingStates()).toEqual([]);
        expect(executeCommand).not.toHaveBeenCalledWith(
            "setContext",
            "intelligit.commitPanel.refreshing",
            true,
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider replays the cached file snapshot when the webview becomes ready", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockResolvedValue([
            { path: "later.ts", status: "M", staged: false, additions: 2, deletions: 0 },
        ]);
        postMessageSpy.mockClear();

        await webview.send({ type: "ready" });

        const updates = postMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(
                (message): message is { type: "update"; files: Array<{ path: string }> } =>
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    message.type === "update" &&
                    "files" in message,
            );
        expect(updates[0]?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider still updates files when stash metadata refresh fails", async () => {
        const { provider } = await setupCommitPanelProvider((gitOps) => {
            gitOps.getStatus.mockResolvedValueOnce([
                { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
                { path: "src/b.ts", status: "?", staged: false, additions: 0, deletions: 0 },
            ]);
            gitOps.listStashes.mockRejectedValueOnce(new Error("stash metadata failed"));
        });

        const updates = postMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(
                (message): message is { type: "update"; files: Array<{ path: string }> } =>
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    message.type === "update" &&
                    "files" in message,
            );

        expect(updates.at(-1)?.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider clears stash files when a new selected stash fails to load", async () => {
        const { provider, gitOps } = await setupCommitPanelProvider();
        gitOps.listStashes.mockResolvedValueOnce([
            { index: 1, message: "On main: next", date: "2026-02-20T00:00:00Z", hash: "next" },
        ]);
        gitOps.getStashFiles.mockRejectedValueOnce(new Error("stash files failed"));
        postMessageSpy.mockClear();

        await (provider as typeof provider & { refreshSilent(): Promise<void> }).refreshSilent();

        const updates = postMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(
                (
                    message,
                ): message is {
                    type: "update";
                    selectedStashIndex: number | null;
                    stashFiles: Array<{ path: string }>;
                } =>
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    message.type === "update" &&
                    "stashFiles" in message,
            );
        expect(updates.at(-1)).toEqual(
            expect.objectContaining({
                selectedStashIndex: 1,
                stashFiles: [],
            }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider ignores stale refresh results from older requests", async () => {
        const { provider, gitOps } = await setupCommitPanelProvider();
        let resolveSlowStatus: (
            files: Array<{
                path: string;
                status: "M";
                staged: false;
                additions: number;
                deletions: number;
            }>,
        ) => void = () => {};
        const slowStatus = new Promise<
            Array<{
                path: string;
                status: "M";
                staged: false;
                additions: number;
                deletions: number;
            }>
        >((resolve) => {
            resolveSlowStatus = resolve;
        });
        gitOps.getStatus
            .mockImplementationOnce(async () => slowStatus)
            .mockResolvedValueOnce([
                { path: "newer.ts", status: "M", staged: false, additions: 3, deletions: 0 },
            ]);
        postMessageSpy.mockClear();

        const slowRefresh = (
            provider as typeof provider & { refreshSilent(): Promise<void> }
        ).refreshSilent();
        const fastRefresh = (
            provider as typeof provider & { refreshSilent(): Promise<void> }
        ).refreshSilent();
        resolveSlowStatus([
            { path: "stale.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]);
        await Promise.all([slowRefresh, fastRefresh]);

        const updates = postMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(
                (message): message is { type: "update"; files: Array<{ path: string }> } =>
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    message.type === "update" &&
                    "files" in message,
            );
        expect(updates.at(-1)?.files.map((file) => file.path)).toEqual(["newer.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider keeps the blue refresh indicator visible long enough to be seen", async () => {
        const { provider } = await setupCommitPanelProvider();
        await provider.refresh();
        postMessageSpy.mockClear();
        executeCommand.mockClear();

        vi.useFakeTimers();
        try {
            const refresh = provider.refresh();
            await vi.advanceTimersByTimeAsync(0);

            expect(refreshingStates()).toEqual([true]);
            expect(executeCommand).toHaveBeenCalledWith(
                "setContext",
                "intelligit.commitPanel.refreshing",
                true,
            );

            await vi.advanceTimersByTimeAsync(599);
            expect(refreshingStates()).toEqual([true]);
            expect(executeCommand).not.toHaveBeenCalledWith(
                "setContext",
                "intelligit.commitPanel.refreshing",
                false,
            );

            await vi.advanceTimersByTimeAsync(1);
            await refresh;

            expect(refreshingStates()).toEqual([true, false]);
            expect(executeCommand).toHaveBeenCalledWith(
                "setContext",
                "intelligit.commitPanel.refreshing",
                false,
            );
        } finally {
            vi.useRealTimers();
        }
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

        withProgress.mockClear();
        await webview.send({ type: "refresh" });
        const view = (provider as unknown as { view: Record<string, unknown> }).view;
        expect(view.description).toBe("");
        expect(withProgress).toHaveBeenCalledWith(
            { location: { viewId: "intelligit.commitPanel" } },
            expect.any(Function),
        );
        await webview.send({ type: "publishBranch" });

        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                currentBranchHasUpstream: false,
            }),
        );
        expect(runPublishBranchFlowSpy).toHaveBeenCalledWith(gitOps, "main", "/repo", undefined);
        expect(executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
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

        gitOps.getStatus.mockResolvedValue([]);
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
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalled();
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
            repositoryRoot: "/repo",
            message: "last message",
        });

        await webview.send({ type: "getAmendBranchCommits" });
        expect(gitOps.getAmendBranchCommits).toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "amendBranchCommits",
            repositoryRoot: "/repo",
            commits: [
                { shortHash: "abc1234", subject: "feat: amend ctx", date: "2026-02-19T00:00:00Z" },
            ],
        });
        provider.dispose();
    });

    it("CommitPanelViewProvider restores and saves commit draft text per repo", async () => {
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
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
            repositoryRoot: "/repo",
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

    it("CommitPanelViewProvider keeps branch out of the header and fires file count after commit", async () => {
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
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

        // Initial state: getStatus returns 1 file -> no duplicated header branch and file-count event.
        // The activity bar count is carried by the hidden fileCountBadge view to avoid double counting.
        expect(view.description).toBe("");
        expect(view.badge).toBeUndefined();
        expect(counts).toContain(1);

        // After commit, getStatus returns 0 files -> header stays branch-free and count fires 0.
        gitOps.getStatus.mockResolvedValueOnce([]);
        await webview.send({ type: "commit", message: "feat: clear", amend: false });
        expect(view.description).toBe("");
        expect(view.badge).toBeUndefined();
        expect(counts).toContain(0);

        provider.dispose();
    });

    it("CommitPanelViewProvider dedupes status rows and updates file count after working-tree actions", async () => {
        vi.useFakeTimers();
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getStatus
            .mockResolvedValueOnce([
                { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
                { path: "src/a.ts", status: "M", staged: true, additions: 2, deletions: 0 },
                { path: "src/b.ts", status: "A", staged: false, additions: 3, deletions: 0 },
            ])
            .mockResolvedValueOnce([
                { path: "src/b.ts", status: "A", staged: true, additions: 3, deletions: 0 },
            ])
            .mockResolvedValueOnce([
                { path: "src/b.ts", status: "A", staged: false, additions: 3, deletions: 0 },
                { path: "src/c.ts", status: "M", staged: false, additions: 1, deletions: 1 },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { path: "src/d.ts", status: "M", staged: false, additions: 4, deletions: 0 },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { path: "src/e.ts", status: "D", staged: false, additions: 0, deletions: 5 },
            ])
            .mockResolvedValueOnce([]);
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            { fsPath: "/repo", path: "/repo" } as unknown as { fsPath: string; path: string },
            createMemento() as unknown as object,
        );
        const webview = createWebviewView();
        const counts: number[] = [];
        const workingTreeEvents: void[] = [];
        provider.onDidChangeFileCount((count) => counts.push(count));
        provider.onDidChangeWorkingTree(() => workingTreeEvents.push(undefined));

        try {
            provider.resolveWebviewView(
                webview.view as unknown as object,
                {} as unknown as object,
                {} as unknown as object,
            );
            await webview.send({ type: "ready" });

            const view = (provider as unknown as { view: Record<string, unknown> }).view;
            expect(view.description).toBe("");
            expect(view.badge).toBeUndefined();

            await flushVisibleRefresh(webview.send({ type: "stageFiles", paths: ["src/a.ts"] }));
            expect(view.description).toBe("");

            await flushVisibleRefresh(webview.send({ type: "unstageFiles", paths: ["src/b.ts"] }));
            expect(view.description).toBe("");

            await flushVisibleRefresh(
                webview.send({ type: "commit", message: "feat: commit", amend: false }),
            );
            expect(view.description).toBe("");

            await flushVisibleRefresh(
                webview.send({
                    type: "commitSelected",
                    message: "feat: selected",
                    amend: false,
                    push: true,
                    paths: ["src/d.ts"],
                }),
            );
            expect(view.description).toBe("");

            showWarningMessage.mockResolvedValueOnce("Rollback");
            await flushVisibleRefresh(webview.send({ type: "rollback", paths: [] }));
            expect(view.description).toBe("");

            showWarningMessage.mockResolvedValueOnce("Delete");
            await flushVisibleRefresh(webview.send({ type: "deleteFile", path: "src/e.ts" }));
            expect(view.description).toBe("");

            await flushVisibleRefresh(
                webview.send({ type: "stashSave", name: "work", paths: ["src/e.ts"] }),
            );
            expect(view.description).toBe("");

            expect(counts).toEqual([2, 1, 2, 0, 1, 0, 1, 0]);
            expect(workingTreeEvents).toHaveLength(7);
            expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
            expect(gitOps.unstageFiles).toHaveBeenCalledWith(["src/b.ts"]);
            expect(gitOps.commit).toHaveBeenCalledWith("feat: commit", false);
            expect(gitOps.commit).toHaveBeenCalledWith("feat: selected", false);
            expect(gitOps.commitAndPush).not.toHaveBeenCalled();
            expect(gitOps.push).toHaveBeenCalled();
            expect(gitOps.rollbackAll).toHaveBeenCalled();
            expect(deleteFileWithFallback).toHaveBeenCalledWith(
                gitOps,
                expect.any(Object),
                "src/e.ts",
            );
            expect(gitOps.stashSave).toHaveBeenCalledWith(["src/e.ts"], "work");
        } finally {
            provider.dispose();
            vi.useRealTimers();
        }
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

    it("CommitPanelViewProvider handles diff/open actions", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(executeCommand).toHaveBeenCalledWith("git.openChange", expect.any(Object));
        await webview.send({ type: "openFile", path: "src/a.ts" });
        expect(showTextDocument).toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider handles stash operations", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "stashSave", name: "work", paths: ["src/a.ts"] });
        await webview.send({ type: "stashPop", index: 0 });
        await webview.send({ type: "stashApply", index: 0 });
        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "stashDelete", index: 0 });
        expect(gitOps.stashSave).toHaveBeenCalled();
        expect(gitOps.stashPop).toHaveBeenCalledWith(0);
        expect(gitOps.stashApply).toHaveBeenCalledWith(0);
        expect(gitOps.stashDelete).toHaveBeenCalledWith(0);

        await webview.send({ type: "stashSelect", index: Number.NaN });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Expected number"),
            }),
        );

        await webview.send({ type: "showStashDiff", index: 0, path: "src/a.ts" });
        expect(gitOps.getStashFilePatch).toHaveBeenCalledWith(0, "src/a.ts");
        expect(openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "intelligit-diff",
            }),
        );
        expect(openTextDocument).not.toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.any(String) }),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider opens conflicts after stash pop conflict", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.stashPop.mockRejectedValueOnce(new Error("stash pop failed"));
        gitOps.getConflictFilesDetailed.mockResolvedValueOnce([
            { path: "src/a.ts", code: "UU", ours: "Modified", theirs: "Modified" },
        ]);

        await webview.send({ type: "stashPop", index: 0 });

        expect(executeCommand).toHaveBeenCalledWith("intelligit.openConflictSession");
        expect(postMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
        provider.dispose();
    });

    it("CommitPanelViewProvider opens conflicts after stash apply conflict", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.stashApply.mockRejectedValueOnce(new Error("stash apply failed"));
        gitOps.getConflictFilesDetailed.mockResolvedValueOnce([
            { path: "src/a.ts", code: "UU", ours: "Modified", theirs: "Modified" },
        ]);

        await webview.send({ type: "stashApply", index: 0 });

        expect(executeCommand).toHaveBeenCalledWith("intelligit.openConflictSession");
        expect(postMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
        provider.dispose();
    });

    it("CommitPanelViewProvider surfaces stash failures without conflicts", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.stashApply.mockRejectedValueOnce(new Error("stash apply failed"));
        gitOps.getConflictFilesDetailed.mockResolvedValueOnce([]);

        await webview.send({ type: "stashApply", index: 0 });

        expect(executeCommand).not.toHaveBeenCalledWith("intelligit.openConflictSession");
        expect(showErrorMessage).toHaveBeenCalledWith("stash apply failed");
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "error",
            message: "stash apply failed",
        });
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
        const { CommitPanelViewProvider } =
            await import("../../../src/views/CommitPanelViewProvider");
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

    it("commitSelectedFromPanel stages only checked files when some are unchecked", async () => {
        // Scenario: 4 changed files, 2 unversioned files — only 2 changed files checked.
        // Unchecked files must not be staged or committed.
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        gitOps.stageFiles.mockClear();
        gitOps.commit.mockClear();

        await webview.send({
            type: "commitSelected",
            message: "feat: selective",
            amend: false,
            push: false,
            paths: ["src/changed1.ts", "src/changed2.ts"],
        });

        // Only the 2 checked paths staged — no extra paths leaked.
        expect(gitOps.stageFiles).toHaveBeenCalledTimes(1);
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/changed1.ts", "src/changed2.ts"]);
        expect(gitOps.commit).toHaveBeenCalledTimes(1);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: selective", false);
        expect(showInformationMessage).toHaveBeenCalledWith("Committed successfully.");
        provider.dispose();
    });

    it("commitSelectedFromPanel stages checked changed + unversioned files together", async () => {
        // Scenario: 1 changed file + 1 unversioned file, both checked.
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        gitOps.stageFiles.mockClear();
        gitOps.commit.mockClear();

        await webview.send({
            type: "commitSelected",
            message: "feat: mixed",
            amend: false,
            push: false,
            paths: ["src/changed.ts", "src/new-unversioned.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledTimes(1);
        expect(gitOps.stageFiles).toHaveBeenCalledWith([
            "src/changed.ts",
            "src/new-unversioned.ts",
        ]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: mixed", false);
        expect(showInformationMessage).toHaveBeenCalledWith("Committed successfully.");
        provider.dispose();
    });

    it("commitSelectedFromPanel stages only selected subset and pushes when requested", async () => {
        // Scenario: 6 files total, 2 checked, push=true.
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        gitOps.stageFiles.mockClear();
        gitOps.commitAndPush.mockClear();
        gitOps.push.mockClear();
        gitOps.getStatus.mockResolvedValue([]);

        await webview.send({
            type: "commitSelected",
            message: "feat: subset push",
            amend: false,
            push: true,
            paths: ["src/a.ts", "src/b.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledTimes(1);
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts", "src/b.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: subset push", false);
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalledTimes(1);
        expect(showInformationMessage).toHaveBeenCalledWith("Pushed successfully.");
        provider.dispose();
    });

    it("commitSelectedFromPanel stages all checked files from large mixed set", async () => {
        // Scenario: 10 changed + 3 unversioned files, 5 checked across both groups.
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        gitOps.stageFiles.mockClear();
        gitOps.commit.mockClear();

        const checkedPaths = [
            "src/a.ts",
            "src/b.ts",
            "docs/readme.md",
            "newfile.txt",
            "scripts/deploy.sh",
        ];

        await webview.send({
            type: "commitSelected",
            message: "feat: large subset",
            amend: false,
            push: false,
            paths: checkedPaths,
        });

        expect(gitOps.stageFiles).toHaveBeenCalledTimes(1);
        expect(gitOps.stageFiles).toHaveBeenCalledWith(checkedPaths);
        // The staged paths array must match exactly — no extra paths from the
        // 8 unchecked files must appear.
        const stagedCall = gitOps.stageFiles.mock.calls[0] as [string[]];
        expect(stagedCall[0]).toHaveLength(checkedPaths.length);
        expect(stagedCall[0].sort()).toEqual([...checkedPaths].sort());
        expect(gitOps.commit).toHaveBeenCalledTimes(1);
        provider.dispose();
    });

    it("CommitGraphViewProvider routes a configured self-hosted GitLab remote to the GitLab provider", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getRemoteUrl.mockResolvedValue("https://git.acme.com/group/repo.git");
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
            { hostMap: { "git.acme.com": "gitlab" } },
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });

        // GitHub did not claim the self-hosted remote, so the real GitLab provider handled it.
        expect(providerGetChecks).not.toHaveBeenCalled();
        // No token is stored, so the provider short-circuits before any network call.
        expect(httpGetJsonSpy).not.toHaveBeenCalled();
        const snapshot = lastCommitChecksSnapshot();
        expect(snapshot?.state).toBe("unavailable");
        // The error is the GitLab sign-in hint (l10n mock returns the raw template), proving
        // the host mapped to gitlab rather than the coordinator's no-supported-remote path.
        expect(snapshot?.error).toMatch(/sign in/i);
        expect(snapshot?.error).not.toMatch(/no supported remote/i);
        provider.dispose();
    });

    it("CommitGraphViewProvider does not route a self-hosted remote without a host mapping", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getRemoteUrl.mockResolvedValue("https://git.acme.com/group/repo.git");
        // No hostMap: neither provider claims the remote.
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStore() as unknown as object,
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });

        expect(providerGetChecks).not.toHaveBeenCalled();
        expect(httpGetJsonSpy).not.toHaveBeenCalled();
        const snapshot = lastCommitChecksSnapshot();
        // No provider claims the remote, so the coordinator yields no badge (state "none"),
        // NOT an "unavailable" error badge. Contrast the prior test, where the host maps to
        // GitLab and an absent token surfaces a recoverable sign-in hint — that is what makes
        // the host mapping necessary.
        expect(snapshot?.state).toBe("none");
        expect(snapshot?.error).toBeUndefined();
        provider.dispose();
    });

    it("CommitGraphViewProvider fetches GitLab statuses for a configured self-hosted remote with a token", async () => {
        const { CommitGraphViewProvider } =
            await import("../../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getRemoteUrl.mockResolvedValue("https://git.acme.com/group/repo.git");
        httpGetJsonSpy.mockResolvedValueOnce([{ name: "build", status: "success" }]);
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            makeCredentialStoreWithToken("glpat-test-token") as unknown as object,
            { hostMap: { "git.acme.com": "gitlab" } },
        );
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );

        await webview.send({ type: "requestCommitChecks", hash: "abc1234" });

        // The self-hosted host produced the correct GitLab API URL on its own domain.
        expect(httpGetJsonSpy).toHaveBeenCalledTimes(1);
        const [requestedUrl] = httpGetJsonSpy.mock.calls[0] as [string, Record<string, string>];
        expect(requestedUrl).toContain("https://git.acme.com/api/v4/projects/");
        expect(requestedUrl).toContain(encodeURIComponent("group/repo"));
        expect(requestedUrl).toContain("/repository/commits/abc1234/statuses");
        const snapshot = lastCommitChecksSnapshot();
        expect(snapshot?.state).toBe("success");
        expect(providerGetChecks).not.toHaveBeenCalled();
        provider.dispose();
    });
});
