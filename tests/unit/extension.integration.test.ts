import { beforeEach, describe, expect, it, vi } from "vitest";

type CommandHandler = (...args: unknown[]) => unknown;

const registeredCommands = new Map<string, CommandHandler>();
const mockDisposables: Array<{ dispose: () => void }> = [];
const executeCommandFallback = vi.fn(async () => undefined);
const showInformationMessage = vi.fn(async () => undefined);
const showErrorMessage = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0]);
const showInputBox = vi.fn(async (opts?: { prompt?: string; value?: string }) => {
    if (!opts?.prompt) return "input";
    if (opts.prompt.includes("New branch")) return "feature/new";
    if (opts.prompt.includes("New tag")) return "v1.0.0";
    if (opts.prompt.includes("Rename")) return "renamed-branch";
    if (opts.prompt.includes("Edit commit message")) return "edited message";
    return "input";
});
const showSaveDialog = vi.fn(async () => ({ fsPath: "/tmp/patch.diff", path: "/tmp/patch.diff" }));
const showQuickPick = vi.fn(async (items: Array<{ parentNumber: number }>) => items[0]);
const showTextDocument = vi.fn(async () => undefined);
const openTextDocument = vi.fn(async (arg: unknown) => arg);
const writeFile = vi.fn(async () => undefined);
const clipboardWriteText = vi.fn(async () => undefined);
const createOutputChannel = vi.fn(() => ({ appendLine: vi.fn() }));
const withProgress = vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task());
const registerWebviewViewProvider = vi.fn(() => ({ dispose: vi.fn() }));
const createTerminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() }));
const textDocListeners: Array<() => void> = [];
const saveDocListeners: Array<() => void> = [];
const createFileListeners: Array<() => void> = [];
const deleteFileListeners: Array<() => void> = [];
const renameFileListeners: Array<() => void> = [];
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
    if (args[0] === "log" && args.includes("--format=%B")) return "current commit body";
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
            name: "origin/feature-remote",
            hash: "a1b2c3d4",
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
    rollbackFiles: vi.fn(async () => undefined),
    shelveSave: vi.fn(async () => "saved"),
    getFileHistory: vi.fn(async () => "history"),
    getStatus: vi.fn(async () => []),
    listShelved: vi.fn(async () => []),
    getShelvedFiles: vi.fn(async () => []),
};

const deleteFileWithFallback = vi.fn(async () => true);
type MockExtensionContext = {
    extensionUri: { fsPath: string; path: string };
    subscriptions: Array<{ dispose: () => void }>;
};

let latestCommitGraphProvider: MockCommitGraphViewProvider | undefined;
let latestCommitPanelProvider: MockCommitPanelViewProvider | undefined;

class MockCommitGraphViewProvider {
    static readonly viewType = "intelligit.commitGraph";
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchFilterEmitter = new MockEventEmitter<string | null>();
    private branchActionEmitter = new MockEventEmitter<{ action: string; branchName: string }>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();

    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitGraphProvider = this;
    }
    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchFilterChanged = this.branchFilterEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    setBranches = vi.fn();
    refresh = vi.fn(async () => undefined);
    filterByBranch = vi.fn(async () => undefined);
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
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
}

class MockCommitInfoViewProvider {
    static readonly viewType = "intelligit.commitFiles";
    setCommitDetail = vi.fn();
    clear = vi.fn();
    dispose = vi.fn();
}

class MockCommitPanelViewProvider {
    static readonly viewType = "intelligit.commitPanel";
    private fileCountEmitter = new MockEventEmitter<number>();
    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitPanelProvider = this;
    }
    onDidChangeFileCount = this.fileCountEmitter.event;
    refresh = vi.fn(async () => undefined);
    dispose = vi.fn();
    emitFileCount(count: number): void {
        this.fileCountEmitter.fire(count);
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
    ProgressLocation: { Notification: 15 },
    Uri: {
        file: (value: string) => ({ fsPath: value, path: value }),
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
        createTreeView: vi.fn(() => ({
            badge: undefined,
            dispose: vi.fn(),
        })),
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
        fs: { writeFile },
        openTextDocument,
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
        run = executorRun;
    },
}));

vi.mock("../../src/git/operations", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/git/operations")>();
    return {
        UpstreamPushDeclinedError: actual.UpstreamPushDeclinedError,
        GitOps: class {
            isRepository = gitOpsState.isRepository;
            getBranches = gitOpsState.getBranches;
            getCommitDetail = gitOpsState.getCommitDetail;
            getUnpushedCommitHashes = gitOpsState.getUnpushedCommitHashes;
            rollbackFiles = gitOpsState.rollbackFiles;
            shelveSave = gitOpsState.shelveSave;
            getFileHistory = gitOpsState.getFileHistory;
            getStatus = gitOpsState.getStatus;
            listShelved = gitOpsState.listShelved;
            getShelvedFiles = gitOpsState.getShelvedFiles;
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

vi.mock("../../src/utils/fileOps", () => ({
    deleteFileWithFallback,
}));

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

describe("extension integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        registeredCommands.clear();
        mockDisposables.length = 0;
        textDocListeners.length = 0;
        saveDocListeners.length = 0;
        createFileListeners.length = 0;
        deleteFileListeners.length = 0;
        renameFileListeners.length = 0;
        fsWatchCallbacks.length = 0;
        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        latestCommitGraphProvider = undefined;
        latestCommitPanelProvider = undefined;

        executorRun.mockImplementation(defaultExecutorRunImpl);
        gitOpsState.isRepository.mockResolvedValue(true);
        gitOpsState.getBranches.mockResolvedValue([
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
                name: "origin/feature-remote",
                hash: "a1b2c3d4",
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
        gitOpsState.rollbackFiles.mockResolvedValue(undefined);
        gitOpsState.shelveSave.mockResolvedValue("saved");
        gitOpsState.getFileHistory.mockResolvedValue("history");
        deleteFileWithFallback.mockResolvedValue(true);

        showWarningMessage.mockImplementation(async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0]);
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
        showQuickPick.mockImplementation(async (items: Array<{ parentNumber: number }>) => items[0]);
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

        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands.get("intelligit.filterByBranch")?.("main");
        await registeredCommands.get("intelligit.showGitLog")?.();

        await registeredCommands
            .get("intelligit.checkout")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.newBranchFrom")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.checkoutAndRebase")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.rebaseCurrentOnto")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.mergeIntoCurrent")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.updateBranch")
            ?.({ branch: { name: "main", isRemote: false, isCurrent: true } });
        await registeredCommands
            .get("intelligit.pushBranch")
            ?.({ branch: { name: "main", isRemote: false, isCurrent: true, remote: "origin" } });
        await registeredCommands
            .get("intelligit.renameBranch")
            ?.({ branch: { name: "feature-local", isRemote: false } });
        await registeredCommands
            .get("intelligit.deleteBranch")
            ?.({ branch: { name: "feature-unmerged", isRemote: false } });
        await registeredCommands
            .get("intelligit.deleteBranch")
            ?.({ branch: { name: "feature-force", isRemote: false } });
        await registeredCommands
            .get("intelligit.deleteBranch")
            ?.({ branch: { name: "origin/feature-remote", isRemote: true, remote: "origin" } });

        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "src/a.ts" });
        await registeredCommands.get("intelligit.fileJumpToSource")?.({ filePath: "src/a.ts" });
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "src/a.ts" });
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "src/a.ts" });
        await registeredCommands.get("intelligit.fileShowHistory")?.({ filePath: "src/a.ts" });
        await registeredCommands.get("intelligit.fileRefresh")?.();

        expect(executorRun).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalled();
        expect(showWarningMessage).toHaveBeenCalled();
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.stringContaining("Deleting remote branch origin/feature-remote"),
            }),
            expect.any(Function),
        );
        expect(deleteFileWithFallback).toHaveBeenCalled();
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
            expect.objectContaining({ title: expect.stringContaining("Updating main") }),
            expect.any(Function),
        );
    });

    it("offers restore action after deleting local branch", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInformationMessage.mockResolvedValueOnce("Restore");
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

        showInformationMessage.mockResolvedValueOnce("Delete Tracked Branch");
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

        const emitCommitAction = async (payload: {
            action: string;
            hash: string;
        }) => {
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
        expect(showErrorMessage).not.toHaveBeenCalledWith(
            "Invalid commit hash received for commit action.",
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
        expect(registeredCommands.size).toBe(0);

        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        gitOpsState.isRepository.mockResolvedValueOnce(false);
        await activate(context);
        expect(registeredCommands.size).toBe(0);

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
                expect.stringContaining("Commit action failed: reset failed"),
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

    it("covers commit-context guarded/error branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const emitCommitAction = async (payload: {
            action: string;
            hash: string;
        }) => {
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
        showInputBox.mockResolvedValueOnce("-bad-tag-name");
        await emitCommitAction({ action: "newTag", hash: "a1b2c3d4" });

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
            expect.stringContaining("Invalid tag name '-bad-tag-name'"),
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
            "Interactive Rebase from Here is available only for unpushed commits.",
        );
        expect(createTerminal).toHaveBeenCalled();
    });

    it("covers branch/file command failure and fallback branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "checkout" && args[1] === "broken-branch") throw new Error("checkout boom");
            if (args[0] === "rebase" && args[1] === "fail-rebase") throw new Error("rebase boom");
            if (args[0] === "merge" && args[1] === "fail-merge") throw new Error("merge boom");
            if (args[0] === "fetch") throw new Error("fetch boom");
            if (args[0] === "push" && args[2] === "force-fail") throw new Error("push boom");
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

        await registeredCommands
            .get("intelligit.checkout")
            ?.({ branch: { name: "origin/feature-local", isRemote: true } });
        await registeredCommands
            .get("intelligit.checkout")
            ?.({ branch: { name: "origin/topic/new", isRemote: true } });
        await registeredCommands
            .get("intelligit.checkout")
            ?.({ branch: { name: "broken-branch", isRemote: false } });

        gitOpsState.getBranches.mockResolvedValueOnce([
            { name: "topic", hash: "a1", isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands
            .get("intelligit.checkoutAndRebase")
            ?.({ branch: { name: "topic", isRemote: false } });

        gitOpsState.getBranches.mockResolvedValueOnce([
            { name: "main", hash: "feed1234", isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands
            .get("intelligit.checkoutAndRebase")
            ?.({ branch: { name: "main", isRemote: false } });

        await registeredCommands
            .get("intelligit.rebaseCurrentOnto")
            ?.({ branch: { name: "fail-rebase", isRemote: false } });
        await registeredCommands
            .get("intelligit.mergeIntoCurrent")
            ?.({ branch: { name: "fail-merge", isRemote: false } });
        await registeredCommands
            .get("intelligit.updateBranch")
            ?.({ branch: { name: "main", isRemote: false, isCurrent: false, remote: "origin" } });

        await registeredCommands
            .get("intelligit.pushBranch")
            ?.({ branch: { name: "main", isRemote: false, isCurrent: true } });
        await registeredCommands
            .get("intelligit.pushBranch")
            ?.({ branch: { name: "topic", isRemote: false, isCurrent: false } });
        await registeredCommands
            .get("intelligit.pushBranch")
            ?.({
                branch: { name: "force-fail", isRemote: false, isCurrent: true, remote: "origin" },
            });

        showInputBox.mockResolvedValueOnce("renamed-branch");
        await registeredCommands
            .get("intelligit.renameBranch")
            ?.({ branch: { name: "fail-rename", isRemote: false } });

        await registeredCommands
            .get("intelligit.deleteBranch")
            ?.({ branch: { name: "main", isRemote: false } });
        await registeredCommands
            .get("intelligit.deleteBranch")
            ?.({ branch: { name: "feature-force-fail", isRemote: false } });

        gitOpsState.rollbackFiles.mockRejectedValueOnce(new Error("rollback failed"));
        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "src/a.ts" });
        gitOpsState.shelveSave.mockRejectedValueOnce(new Error("shelve failed"));
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "src/a.ts" });
        gitOpsState.getFileHistory.mockRejectedValueOnce(new Error("history failed"));
        await registeredCommands.get("intelligit.fileShowHistory")?.({ filePath: "src/a.ts" });
        deleteFileWithFallback.mockResolvedValueOnce(false);
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "src/a.ts" });

        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Checkout failed: checkout boom"));
        expect(showErrorMessage).toHaveBeenCalledWith("No current branch found.");
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Merge failed: merge boom"));
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Update failed: fetch boom"));
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Push failed: No remote configured for branch topic.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Push failed: push boom"));
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Rename failed: rename boom"));
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
