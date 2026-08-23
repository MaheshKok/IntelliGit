import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePath } from "../../helpers/fixturePaths";

// Every root here is resolved through `fixturePath` rather than written as a POSIX-shaped
// literal. `/repo-a` is not an absolute path on Windows: production joins it with `.git`
// and gets a driveless `\repo-a\.git`, while an expectation built from `fixturePath` gets
// `D:\repo-a\.git`. Both sides have to come from the same place or the test compares two
// different spellings of a path neither the provider nor git ever disagreed about (#223).
const REPO_A = fixturePath("/repo-a");
const REPO_B = fixturePath("/repo-b");
const EXTENSION_DIR = fixturePath("/extension");

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
const commitOnlyFromPanel = vi.hoisted(() => vi.fn(async () => undefined));
const commitAndPushFromPanel = vi.hoisted(() => vi.fn(async () => undefined));
const showCommitMessageGenerationNotification = vi.hoisted(() => vi.fn(async () => undefined));
const liveManifest = vi.hoisted(() => ({ sessionId: "extension-owned-rebase" }));
const deriveRebaseControl = vi.hoisted(() =>
    vi.fn(async ({ liveManifest: manifest }: { liveManifest?: unknown }) =>
        manifest ? "owned" : "foreign",
    ),
);
const readLiveRebaseManifest = vi.hoisted(() => vi.fn(async () => liveManifest));

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
        getFolderIconsByBranches = vi.fn(async () => ({}));
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
    commitOnlyFromPanel,
    commitAndPushFromPanel,
}));

vi.mock("../../../src/ai/commitMessageGenerationNotifications", () => ({
    showCommitMessageGenerationNotification,
}));

vi.mock("../../../src/git/interactiveRebase/rebaseControl", () => ({
    deriveRebaseControl,
}));

vi.mock("../../../src/git/interactiveRebase/storage", () => ({
    readLiveRebaseManifest,
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
        getActiveOperation: vi.fn(async () => "none"),
        // Platform-native, because the consumer resolves these before handing them on and real
        // git emits drive-rooted paths on Windows. See tests/helpers/fixturePaths.ts.
        getGitDirectories: vi.fn(async () => ({
            root: REPO_A,
            gitDir: fixturePath("/repo-a/.git"),
            commonDir: fixturePath("/repo-a/.git"),
        })),
        getLastCommitMessage: vi.fn(async () => "feat: previous commit"),
        getAmendBranchCommits: vi.fn(async () => []),
        getBranches: vi.fn(async () => []),
        getRemotes: vi.fn(async () => []),
        listStashes: vi.fn(async () => []),
        getStashFiles: vi.fn(async () => []),
    };
}

function createGitOps() {
    const rootGitOpsByRoot = {
        [REPO_A]: createRootGitOps(),
        [REPO_B]: createRootGitOps(),
    };
    const rootGitOps = rootGitOpsByRoot[REPO_A];
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
    const workspaceState = {
        get: vi.fn(() => undefined),
        update: vi.fn(async () => undefined),
    };
    const provider = new UndockedViewProvider(
        { fsPath: EXTENSION_DIR, path: EXTENSION_DIR } as never,
        gitOps as never,
        { fsPath: REPO_A, path: REPO_A } as never,
        {} as never,
        workspaceState as never,
        {},
        undefined,
        {
            repositories: [
                { root: REPO_A, label: "repo-a" },
                { root: REPO_B, label: "repo-b" },
            ],
            selectedRepositoryRoot: REPO_A,
            commitMessageGenerationCoordinator: coordinator,
        } as never,
    );
    provider.open();
    return { coordinator, gitOps, provider, workspaceState };
}

async function send(message: unknown): Promise<void> {
    await messageHandler?.(message);
}

describe("UndockedViewProvider commit-message generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deriveRebaseControl.mockReset();
        deriveRebaseControl.mockImplementation(async ({ liveManifest: manifest }) =>
            manifest ? "owned" : "foreign",
        );
        readLiveRebaseManifest.mockReset();
        readLiveRebaseManifest.mockResolvedValue(liveManifest);
        messageHandler = undefined;
        panelDisposeHandler = undefined;
        commitSelectedFromPanel.mockClear();
        commitOnlyFromPanel.mockClear();
        commitAndPushFromPanel.mockClear();
        showCommitMessageGenerationNotification.mockReset();
        showCommitMessageGenerationNotification.mockResolvedValue(undefined);
    });

    it("registers a valid request with the injected coordinator and one fresh status snapshot", async () => {
        const { coordinator, gitOps, provider } = await createProvider();

        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
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
        expect(submission.repositoryRoot).toBe(REPO_A);
        expect(submission.requestId).toBe("generate-1");
        await expect(submission.validate({ isActive: () => true })).resolves.toEqual({
            paths: ["src/a.ts"],
            amend: false,
            validatedStatusSnapshot: [
                { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
            ],
        });
        expect(gitOps.deriveFor).toHaveBeenCalledWith(REPO_A);
        expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledTimes(1);
        expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledWith({ withStats: false });
        provider.dispose();
    });

    it("emits correlated lifecycle events, rejects malformed input, and preserves a valid submission", async () => {
        const { coordinator, provider } = await createProvider();
        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
            requestId: "valid",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            host: { emit: (event: unknown) => void };
        };

        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
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
            repositoryRoot: REPO_A,
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
            repositoryRoot: REPO_A,
            requestId: "valid",
            kind: "chunk",
            text: "feat: generated",
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "commitMessageGeneration",
            repositoryRoot: REPO_A,
            requestId: "valid",
            kind: "chunk",
            text: "feat: generated",
        });
        provider.dispose();
    });

    it("forwards late cross-host superseded terminals verbatim so the webview can discard them", async () => {
        const { coordinator, provider } = await createProvider();
        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
            requestId: "late",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            host: { emit: (event: unknown) => void };
        };
        postMessage.mockClear();

        submission.host.emit({
            repositoryRoot: REPO_A,
            requestId: "late",
            kind: "cancelled",
            superseded: true,
        });
        submission.host.emit({
            repositoryRoot: REPO_A,
            requestId: "late",
            kind: "done",
            superseded: true,
        });

        expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
            {
                type: "commitMessageGeneration",
                repositoryRoot: REPO_A,
                requestId: "late",
                kind: "cancelled",
                superseded: true,
            },
            {
                type: "commitMessageGeneration",
                repositoryRoot: REPO_A,
                requestId: "late",
                kind: "done",
                superseded: true,
            },
        ]);
        expect(showCommitMessageGenerationNotification).not.toHaveBeenCalled();
        provider.dispose();
    });

    it("rejects oversized raw generation paths before deduplication or Git validation", async () => {
        const { coordinator, gitOps, provider } = await createProvider();
        const paths = Array.from({ length: 201 }, () => "src/a.ts");

        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
            requestId: "oversized",
            paths,
            amend: false,
        });

        expect(coordinator.submit).not.toHaveBeenCalled();
        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(gitOps.rootGitOps.getStatus).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith({
            type: "commitMessageGeneration",
            repositoryRoot: REPO_A,
            requestId: "oversized",
            kind: "error",
            errorKind: "invalidRequest",
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
            repositoryRoot: REPO_A,
            requestId: "rename-source",
            paths: ["source.ts"],
            amend: false,
        });
        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
            requestId: "ignored",
            paths: ["ignored.log"],
            amend: false,
        });
        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
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
            repositoryRoot: REPO_A,
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
            repositoryRoot: REPO_A,
            requestId: "cancelled",
        });
        resolveStatus([{ path: "destination.ts", status: "M", staged: false }]);
        await expect(validation).resolves.toBeUndefined();
        expect(coordinator.cancel).toHaveBeenCalledWith({
            repositoryRoot: REPO_A,
            requestId: "cancelled",
            host: cancelledSubmission.host,
        });
        provider.dispose();
    });

    it("rejects amend generation while the repository is unborn and allows it once commits exist", async () => {
        const { coordinator, gitOps, provider } = await createProvider();
        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
            requestId: "amend-unborn",
            paths: ["src/a.ts"],
            amend: true,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            validate: (control: { isActive: () => boolean }) => Promise<unknown>;
        };
        gitOps.rootGitOps.hasAnyCommits.mockResolvedValue(false);
        await expect(submission.validate({ isActive: () => true })).resolves.toBeUndefined();

        gitOps.rootGitOps.hasAnyCommits.mockResolvedValue(true);
        await expect(submission.validate({ isActive: () => true })).resolves.toEqual({
            paths: ["src/a.ts"],
            amend: true,
            validatedStatusSnapshot: [
                { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
            ],
        });
        provider.dispose();
    });

    it("drops submitted work synchronously when the panel closes", async () => {
        const { coordinator, provider } = await createProvider();

        await send({
            type: "generateCommitMessage",
            repositoryRoot: REPO_A,
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
        const pendingOperation = createDeferred<"none">();
        gitOps.rootGitOps.getActiveOperation.mockImplementationOnce(() => pendingOperation.promise);

        const refresh = (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        await vi.waitFor(() =>
            expect(gitOps.rootGitOps.getActiveOperation).toHaveBeenCalledTimes(1),
        );

        provider.setRepositories([]);
        expect(coordinator.dropHostRoot).toHaveBeenCalledWith(expect.any(Object), REPO_A);
        expect(
            (provider as unknown as { selectedRepositoryRoot: string }).selectedRepositoryRoot,
        ).toBe(REPO_A);

        pendingOperation.resolve("none");
        await refresh;

        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        expect(
            provider as unknown as { files: unknown[]; stashes: unknown[]; stashFiles: unknown[] },
        ).toMatchObject({ files: [], stashes: [], stashFiles: [] });
        provider.dispose();
    });

    it("publishes the rebase operation snapshot with an undocked commit-panel update", async () => {
        const { gitOps, provider } = await createProvider();
        gitOps.rootGitOps.getActiveOperation.mockResolvedValueOnce("rebase");
        (
            provider as unknown as { interactiveRebaseStorageRoot?: string }
        ).interactiveRebaseStorageRoot = "/storage";

        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();

        expect(readLiveRebaseManifest).toHaveBeenCalledWith("/storage", REPO_A);
        expect(deriveRebaseControl).toHaveBeenCalledWith({
            gitDir: fixturePath("/repo-a/.git"),
            liveManifest,
        });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                activeOperation: "rebase",
                rebaseControl: "owned",
            }),
        );
        provider.dispose();
    });

    it.each([
        ["foreign", "foreign"],
        ["unowned", "unowned"],
    ] as const)(
        "preserves the undocked %s rebase classification without an owned manifest",
        async (rebaseControl, expectedControl) => {
            const { gitOps, provider } = await createProvider();
            gitOps.rootGitOps.getActiveOperation.mockResolvedValueOnce("rebase");
            readLiveRebaseManifest.mockResolvedValueOnce(undefined);
            deriveRebaseControl.mockResolvedValueOnce(rebaseControl);

            await (
                provider as unknown as { refreshCommitPanelData: () => Promise<void> }
            ).refreshCommitPanelData();

            expect(postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "update",
                    activeOperation: "rebase",
                    rebaseControl: expectedControl,
                }),
            );
            provider.dispose();
        },
    );

    it.each([
        ["with a live manifest", liveManifest, "foreign"],
        ["without a live manifest", undefined, "unowned"],
    ] as const)(
        "reports %s as the uncorrelated classification when rebase ends between probes",
        async (_scenario, manifest, expectedControl) => {
            const { gitOps, provider } = await createProvider();
            gitOps.rootGitOps.getActiveOperation.mockResolvedValueOnce("rebase");
            readLiveRebaseManifest.mockResolvedValueOnce(manifest);
            deriveRebaseControl.mockResolvedValueOnce("none");

            await (
                provider as unknown as { refreshCommitPanelData: () => Promise<void> }
            ).refreshCommitPanelData();

            expect(postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "update",
                    activeOperation: "rebase",
                    rebaseControl: expectedControl,
                }),
            );
            provider.dispose();
        },
    );

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

        expect(coordinator.acquireCommitLease).toHaveBeenCalledWith(REPO_A);
        expect(rejectedRelease).toHaveBeenCalledTimes(1);
        provider.dispose();
    });

    it("scopes direct commit routes to the selected root and releases each lease", async () => {
        const { coordinator, gitOps, provider } = await createProvider();
        const repoBGitOps = gitOps.rootGitOpsByRoot[REPO_B];
        const commitRelease = vi.fn();
        const pushRelease = vi.fn();
        coordinator.acquireCommitLease
            .mockReturnValueOnce(commitRelease)
            .mockReturnValueOnce(pushRelease);
        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        gitOps.deriveFor.mockClear();

        commitOnlyFromPanel.mockImplementationOnce(
            async (deps: { gitOps: unknown }, message: string, amend: boolean) => {
                expect(deps.gitOps).toBe(repoBGitOps);
                expect(message).toBe("feat: direct commit");
                expect(amend).toBe(true);
                throw new Error("commit rejected");
            },
        );
        await send({ type: "commit", message: "  feat: direct commit  ", amend: true });

        commitAndPushFromPanel.mockImplementationOnce(
            async (deps: { gitOps: unknown }, message: string, amend: boolean) => {
                expect(deps.gitOps).toBe(repoBGitOps);
                expect(message).toBe("feat: direct push");
                expect(amend).toBe(false);
            },
        );
        await send({ type: "commitAndPush", message: "  feat: direct push  ", amend: false });

        expect(commitOnlyFromPanel).toHaveBeenCalledOnce();
        expect(commitAndPushFromPanel).toHaveBeenCalledOnce();
        expect(gitOps.deriveFor).toHaveBeenNthCalledWith(1, REPO_B);
        expect(gitOps.deriveFor).toHaveBeenNthCalledWith(2, REPO_B);
        expect(coordinator.acquireCommitLease).toHaveBeenNthCalledWith(1, REPO_B);
        expect(coordinator.acquireCommitLease).toHaveBeenNthCalledWith(2, REPO_B);
        expect(commitRelease).toHaveBeenCalledOnce();
        expect(pushRelease).toHaveBeenCalledOnce();
        provider.dispose();
    });

    it("refreshes hasCommits through one root-bound GitOps facade and rejects ABA repository switches", async () => {
        const { gitOps, provider } = await createProvider();
        const repoBGitOps = gitOps.rootGitOpsByRoot[REPO_B];
        repoBGitOps.listStashes.mockResolvedValue([{ index: 3 }]);
        repoBGitOps.getStashFiles.mockResolvedValue([{ path: "stash/b.ts", status: "M" }]);
        repoBGitOps.hasAnyCommits.mockResolvedValue(false);
        repoBGitOps.getActiveOperation.mockResolvedValue("merge");

        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();

        expect(gitOps.deriveFor).toHaveBeenCalledTimes(1);
        expect(gitOps.deriveFor).toHaveBeenCalledWith(REPO_B);
        expect(repoBGitOps.getStatus).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.listStashes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getRemotes).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getStashFiles).toHaveBeenCalledWith(3);
        expect(repoBGitOps.hasAnyCommits).toHaveBeenCalledTimes(1);
        expect(repoBGitOps.getActiveOperation).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "update",
                hasCommits: false,
                wholeIndexOperationInProgress: true,
            }),
        );

        postMessage.mockClear();
        const pendingStatus = createDeferred<unknown[]>();
        gitOps.rootGitOps.getStatus.mockImplementationOnce(() => pendingStatus.promise);
        provider.setRepositoryRootUri({ fsPath: REPO_A, path: REPO_A } as never);
        const refresh = (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        await vi.waitFor(() => expect(gitOps.rootGitOps.getStatus).toHaveBeenCalledTimes(1));
        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        provider.setRepositoryRootUri({ fsPath: REPO_A, path: REPO_A } as never);
        pendingStatus.resolve([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]);
        await refresh;

        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        provider.dispose();
    });

    it("awaits the operation snapshot for refresh and successful stash updates, surfacing a snapshot failure", async () => {
        const { gitOps, provider } = await createProvider();
        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        expect(gitOps.rootGitOps.getActiveOperation).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: false }),
        );

        postMessage.mockClear();
        const pendingOperation = createDeferred<"merge">();
        gitOps.rootGitOps.getActiveOperation.mockImplementationOnce(() => pendingOperation.promise);
        const selectStash = send({ type: "stashSelect", index: 0 });
        await vi.waitFor(() =>
            expect(gitOps.rootGitOps.getActiveOperation).toHaveBeenCalledTimes(2),
        );
        expect(postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: true }),
        );
        pendingOperation.resolve("merge");
        await selectStash;
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", wholeIndexOperationInProgress: true }),
        );

        gitOps.rootGitOps.getActiveOperation.mockRejectedValueOnce(new Error("whole-index failed"));
        await send({ type: "stashSelect", index: 0 });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "error", message: "whole-index failed" }),
        );
        provider.dispose();
    });

    it("drops a stale stash update when the repository switches away and back mid-select", async () => {
        const { gitOps, provider } = await createProvider();
        postMessage.mockClear();
        const pendingOperation = createDeferred<"none">();
        gitOps.rootGitOps.getActiveOperation.mockImplementationOnce(() => pendingOperation.promise);
        const selectStash = send({ type: "stashSelect", index: 0 });
        await vi.waitFor(() =>
            expect(gitOps.rootGitOps.getActiveOperation).toHaveBeenCalledTimes(1),
        );
        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        provider.setRepositoryRootUri({ fsPath: REPO_A, path: REPO_A } as never);
        pendingOperation.resolve("none");
        await selectStash;
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
        provider.dispose();
    });

    it("posts captured roots for the undocked UI's exact-root filtered commit-panel events", async () => {
        const { provider } = await createProvider();

        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        await (
            provider as unknown as { refreshCommitPanelData: () => Promise<void> }
        ).refreshCommitPanelData();
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "update", repositoryRoot: REPO_B }),
        );

        postMessage.mockClear();
        await send({ type: "ready" });
        expect(postMessage).toHaveBeenCalledWith({
            type: "restoreCommitDraft",
            repositoryRoot: REPO_B,
            message: "",
        });

        postMessage.mockClear();
        await send({ type: "getLastCommitMessage" });
        await send({ type: "getAmendBranchCommits" });
        commitSelectedFromPanel.mockImplementationOnce(
            async (deps: { postCommitted: () => Promise<void> }) => deps.postCommitted(),
        );
        await send({
            type: "commitSelected",
            message: "feat: root scoped",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "lastCommitMessage",
            repositoryRoot: REPO_B,
            message: "feat: previous commit",
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "amendBranchCommits",
            repositoryRoot: REPO_B,
            commits: [],
        });
        expect(postMessage).toHaveBeenCalledWith({
            type: "committed",
            repositoryRoot: REPO_B,
            clearCommitMessage: true,
        });
        provider.dispose();
    });

    it("persists a terminal draft to its accepted root after the selected root switches", async () => {
        const { provider, workspaceState } = await createProvider();

        provider.setRepositoryRootUri({ fsPath: REPO_B, path: REPO_B } as never);
        await send({
            type: "saveCommitDraft",
            repositoryRoot: REPO_A,
            message: "generated for repo a",
        });

        expect(workspaceState.update).toHaveBeenCalledWith(
            expect.stringContaining(REPO_A),
            "generated for repo a",
        );
        await send({
            type: "saveCommitDraft",
            repositoryRoot: "/unknown",
            message: "must not persist",
        });
        expect(workspaceState.update).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                message: "Unknown repository root received from webview.",
            }),
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
            repositoryRoot: REPO_A,
            requestId: "error",
            paths: ["src/a.ts"],
            amend: false,
        });
        const submission = coordinator.submit.mock.calls[0]?.[0] as {
            host: { emit: (event: unknown) => void };
        };
        submission.host.emit({
            repositoryRoot: REPO_A,
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
