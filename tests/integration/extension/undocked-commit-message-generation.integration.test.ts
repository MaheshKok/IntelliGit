import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (message: unknown) => Promise<void> | void;

class FakeEventEmitter<T> {
    readonly event = vi.fn(() => ({ dispose: vi.fn() }));
    fire = vi.fn((_value: T) => undefined);
    dispose = vi.fn();
}

const postMessage = vi.fn();
let messageHandler: MessageHandler | undefined;
let panelDisposeHandler: (() => void) | undefined;
const commitSelectedFromPanel = vi.hoisted(() => vi.fn(async () => undefined));
const showCommitMessageGenerationNotification = vi.hoisted(() => vi.fn(async () => undefined));

const webview = {
    html: "",
    options: {},
    postMessage,
    onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
    }),
};

const panel = {
    webview,
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn((handler: () => void) => {
        panelDisposeHandler = handler;
        return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
};

vi.mock("vscode", () => ({
    EventEmitter: FakeEventEmitter,
    ViewColumn: { One: 1 },
    Uri: {
        file: (fsPath: string) => ({
            fsPath,
            path: fsPath,
            scheme: "file",
            toString: () => fsPath,
        }),
        joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
            fsPath: [base.fsPath, ...segments].join("/"),
            path: [base.fsPath, ...segments].join("/"),
        }),
        parse: (value: string) => ({ fsPath: value, path: value, scheme: "https" }),
    },
    l10n: { t: (message: string) => message },
    window: {
        createWebviewPanel: vi.fn(() => panel),
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
        showErrorMessage: vi.fn(async () => undefined),
        showInformationMessage: vi.fn(async () => undefined),
    },
    workspace: {
        getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
}));

vi.mock("../../../src/views/shared/IconThemeService", () => ({
    IconThemeService: class {
        attachWebview = vi.fn();
        dispose = vi.fn();
        initIconThemeData = vi.fn(async () => undefined);
        decorateWorkingFiles = vi.fn(async <T>(files: T[]) => files);
        getFolderIconsByPaths = vi.fn(async () => ({}));
        getThemeData = vi.fn(() => ({ folderIcons: {}, iconFonts: [] }));
    },
}));

vi.mock("../../../src/views/shared/themeListeners", () => ({
    registerThemeChangeListeners: vi.fn(() => []),
    disposeAll: vi.fn(),
}));

vi.mock("../../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: vi.fn(() => "<html></html>"),
}));

vi.mock("../../../src/views/commitPanelActions", () => ({
    commitSelectedFromPanel,
}));

vi.mock("../../../src/ai/commitMessageGenerationNotifications", () => ({
    showCommitMessageGenerationNotification,
}));

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createRootGitOps() {
    return {
        getStatus: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]),
        hasAnyCommits: vi.fn(async () => true),
        hasWholeIndexOperationInProgress: vi.fn(async () => false),
        getBranches: vi.fn(async () => []),
        getRemotes: vi.fn(async () => []),
        listStashes: vi.fn(async () => []),
        getStashFiles: vi.fn(async () => []),
    };
}

function createGitOps() {
    const rootGitOpsByRoot = {
        "/repo-a": createRootGitOps(),
        "/repo-b": createRootGitOps(),
    };
    const rootGitOps = rootGitOpsByRoot["/repo-a"];
    return {
        ...rootGitOps,
        deriveFor: vi.fn(
            (root: keyof typeof rootGitOpsByRoot) => rootGitOpsByRoot[root] ?? rootGitOps,
        ),
        rootGitOps,
        rootGitOpsByRoot,
    };
}

function createCoordinator() {
    return {
        submit: vi.fn(),
        cancel: vi.fn(),
        dropHost: vi.fn(),
        dropHostRoot: vi.fn(),
        acquireCommitLease: vi.fn(() => vi.fn()),
    };
}

async function createProvider() {
    const { UndockedViewProvider } = await import("../../../src/views/UndockedViewProvider");
    const gitOps = createGitOps();
    const coordinator = createCoordinator();
    const provider = new UndockedViewProvider(
        { fsPath: "/extension", path: "/extension" } as never,
        gitOps as never,
        { fsPath: "/repo-a", path: "/repo-a" } as never,
        {} as never,
        undefined,
        {},
        undefined,
        {
            repositories: [
                { root: "/repo-a", label: "repo-a" },
                { root: "/repo-b", label: "repo-b" },
            ],
            selectedRepositoryRoot: "/repo-a",
            commitMessageGenerationCoordinator: coordinator,
        } as never,
    );
    provider.open();
    return { coordinator, gitOps, provider };
}

async function send(message: unknown): Promise<void> {
    await messageHandler?.(message);
}

describe("UndockedViewProvider commit-message generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        messageHandler = undefined;
        panelDisposeHandler = undefined;
        commitSelectedFromPanel.mockClear();
        showCommitMessageGenerationNotification.mockReset();
        showCommitMessageGenerationNotification.mockResolvedValue(undefined);
    });

    it("registers a valid request with the injected coordinator and one fresh status snapshot", async () => {
        const { coordinator, gitOps, provider } = await createProvider();

        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "generate-1",
            paths: ["src/a.ts", "src/a.ts"],
            amend: false,
        });

        expect(coordinator.submit).toHaveBeenCalledTimes(1);
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            repositoryRoot: string;
            requestId: string;
            validate: (control: { isActive: () => boolean }) => Promise<unknown>;
        };
        expect(submission.repositoryRoot).toBe("/repo-a");
        expect(submission.requestId).toBe("generate-1");
        await expect(submission.validate({ isActive: () => true })).resolves.toEqual({
            paths: ["src/a.ts"],
            amend: false,
            validatedStatusSnapshot: [
                { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
            ],
        });
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-a");
        expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledTimes(1);
        expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledWith({ withStats: false });
        provider.dispose();
    });

    it("emits correlated lifecycle events, rejects malformed input, and preserves a valid submission", async () => {
        const { coordinator, provider } = await createProvider();
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "valid",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            host: { emit: (event: unknown) => void };
        };

        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "invalid",
            paths: ["src/a.ts"],
            amend: "false",
        });
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/missing",
            requestId: "unknown",
            paths: ["src/a.ts"],
            amend: false,
        });

        expect(coordinator.submit).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "invalid",
            kind: "error",
            errorKind: "invalidRequest",
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "commitMessageGeneration",
            repositoryRoot: "/missing",
            requestId: "unknown",
            kind: "error",
            errorKind: "invalidRequest",
        });

        submission.host.emit({
            repositoryRoot: "/repo-a",
            requestId: "valid",
            kind: "chunk",
            text: "feat: generated",
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "valid",
            kind: "chunk",
            text: "feat: generated",
        });
        provider.dispose();
    });

    it("validates ignored, rename-source, empty, and cancelled requests without promotion", async () => {
        const { coordinator, gitOps, provider } = await createProvider();
        gitOps.rootGitOps.getStatus.mockResolvedValue([
            { path: "destination.ts", sourcePath: "source.ts", status: "R", staged: false },
            { path: "ignored.log", status: "!", staged: false },
        ]);
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "rename-source",
            paths: ["source.ts"],
            amend: false,
        });
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "ignored",
            paths: ["ignored.log"],
            amend: false,
        });
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "empty",
            paths: [],
            amend: false,
        });
        const submissions = coordinator.submit.mock.calls.map(
            ([submission]) =>
                submission as {
                    validate: (control: { isActive: () => boolean }) => Promise<unknown>;
                },
        );
        await expect(submissions[0]?.validate({ isActive: () => true })).resolves.toBeUndefined();
        await expect(submissions[1]?.validate({ isActive: () => true })).resolves.toBeUndefined();
        await expect(submissions[2]?.validate({ isActive: () => true })).resolves.toBeUndefined();

        let resolveStatus!: (value: unknown[]) => void;
        gitOps.rootGitOps.getStatus.mockImplementationOnce(
            () => new Promise<unknown[]>((resolve) => (resolveStatus = resolve)),
        );
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "cancelled",
            paths: ["destination.ts"],
            amend: false,
        });
        const cancelledSubmission = coordinator.submit.mock.calls.at(-1)?.[0] as {
            host: unknown;
            validate: (control: { isActive: () => boolean }) => Promise<unknown>;
        };
        const validation = cancelledSubmission.validate({ isActive: () => false });
        await send({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "cancelled",
        });
        resolveStatus([{ path: "destination.ts", status: "M", staged: false }]);
        await expect(validation).resolves.toBeUndefined();
        expect(coordinator.cancel).toHaveBeenCalledWith({
            repositoryRoot: "/repo-a",
            requestId: "cancelled",
            host: cancelledSubmission.host,
        });
        provider.dispose();
    });

    it("drops submitted work synchronously when the panel closes", async () => {
        const { coordinator, provider } = await createProvider();

        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "panel-close",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as { host: unknown };

        panelDisposeHandler?.();

        expect(coordinator.dropHost).toHaveBeenCalledWith(submission.host);
        provider.dispose();
    });

    it("invalidates a selected root removed from the repository catalog", async () => {
        const { coordinator, gitOps, provider } = await createProvider();
        const pendingWholeIndexState = createDeferred<boolean>();
        gitOps.rootGitOps.hasWholeIndexOperationInProgress.mockImplementationOnce(
            () => pendingWholeIndexState.promise,
        );

        const refresh = (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        await vi.waitFor(() =>
            expect(gitOps.rootGitOps.hasWholeIndexOperationInProgress).toHaveBeenCalledTimes(1),
        );

        provider.setRepositories([]);
        expect(coordinator.dropHostRoot).toHaveBeenCalledWith(expect.any(Object), "/repo-a");
        expect(
            (provider as unknown as { selectedRepositoryRoot: string }).selectedRepositoryRoot,
        ).toBe("/repo-a");

        pendingWholeIndexState.resolve(false);
        await refresh;

        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        expect(
            provider as unknown as { files: unknown[]; stashes: unknown[]; stashFiles: unknown[] },
        ).toMatchObject({ files: [], stashes: [], stashFiles: [] });
        provider.dispose();
    });

    it("keeps a lease for deferred success and releases it after action rejection", async () => {
        const { coordinator, provider } = await createProvider();
        const successfulRelease = vi.fn();
        const completed = createDeferred<void>();
        coordinator.acquireCommitLease.mockReturnValueOnce(successfulRelease);
        commitSelectedFromPanel.mockImplementationOnce(() => completed.promise);

        const successfulCommit = send({
            type: "commitSelected",
            message: "feat: commit",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        await vi.waitFor(() => expect(commitSelectedFromPanel).toHaveBeenCalledTimes(1));
        expect(successfulRelease).not.toHaveBeenCalled();
        completed.resolve();
        await successfulCommit;
        expect(successfulRelease).toHaveBeenCalledTimes(1);

        const rejectedRelease = vi.fn();
        coordinator.acquireCommitLease.mockReturnValueOnce(rejectedRelease);
        commitSelectedFromPanel.mockRejectedValueOnce(new Error("commit rejected"));

        await send({
            type: "commitSelected",
            message: "feat: commit",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });

        expect(coordinator.acquireCommitLease).toHaveBeenCalledWith("/repo-a");
        expect(rejectedRelease).toHaveBeenCalledTimes(1);
        provider.dispose();
    });

    it("refreshes through one root-bound GitOps facade and rejects ABA repository switches", async () => {
        const { gitOps, provider } = await createProvider();
        const repoBGitOps = gitOps.rootGitOpsByRoot["/repo-b"];
        repoBGitOps.listStashes.mockResolvedValue([{ index: 3 }]);
        repoBGitOps.getStashFiles.mockResolvedValue([{ path: "stash/b.ts", status: "M" }]);
        repoBGitOps.hasWholeIndexOperationInProgress.mockResolvedValue(true);

        provider.setRepositoryRootUri({ fsPath: "/repo-b", path: "/repo-b" } as never);
        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();

        expect(gitOps.deriveFor).toHaveBeenCalledTimes(1);
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(repoBGitOps.getStatus).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.listStashes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getRemotes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getStashFiles).toHaveBeenCalledWith(3);
        expect(repoBGitOps.hasWholeIndexOperationInProgress).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: true }),
        );

        postMessage.mockClear();
        const pendingStatus = createDeferred<unknown[]>();
        gitOps.rootGitOps.getStatus.mockImplementationOnce(() => pendingStatus.promise);
        provider.setRepositoryRootUri({ fsPath: "/repo-a", path: "/repo-a" } as never);
        const refresh = (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        await vi.waitFor(() => expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledTimes(1));
        provider.setRepositoryRootUri({ fsPath: "/repo-b", path: "/repo-b" } as never);
        provider.setRepositoryRootUri({ fsPath: "/repo-a", path: "/repo-a" } as never);
        pendingStatus.resolve([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]);
        await refresh;

        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        provider.dispose();
    });

    it("awaits whole-index state for refresh and successful stash updates, surfacing a stash predicate failure", async () => {
        const { gitOps, provider } = await createProvider();
        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        expect(gitOps.rootGitOps.hasWholeIndexOperationInProgress).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: false }),
        );

        postMessage.mockClear();
        const pendingWholeIndexState = createDeferred<boolean>();
        gitOps.rootGitOps.hasWholeIndexOperationInProgress.mockImplementationOnce(
            () => pendingWholeIndexState.promise,
        );
        const selectStash = send({ type: "stashSelect", index: 0 });
        await vi.waitFor(() =>
            expect(gitOps.rootGitOps.hasWholeIndexOperationInProgress).toHaveBeenCalledTimes(1),
        );
        expect(postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: true }),
        );
        pendingWholeIndexState.resolve(true);
        await selectStash;
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: true }),
        );

        gitOps.rootGitOps.hasWholeIndexOperationInProgress.mockRejectedValueOnce(
            new Error("whole-index failed"),
        );
        await send({ type: "stashSelect", index: 0 });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "error", message: "whole-index failed" }),
        );
        provider.dispose();
    });

    it("contains notification failures at the host boundary", async () => {
        const error = new Error("notification failed");
        showCommitMessageGenerationNotification.mockRejectedValueOnce(error);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { coordinator, provider } = await createProvider();
        await send({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: "error",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            host: { emit: (event: unknown) => void };
        };
        submission.host.emit({
            repositoryRoot: "/repo-a",
            requestId: "error",
            kind: "error",
            errorKind: "blocked",
        });
        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                "[IntelliGit] Commit-message generation notification failed:",
                error,
            );
        });
        consoleError.mockRestore();
        provider.dispose();
    });
});
