import { describe, expect, it, vi } from "vitest";

const coordinatorInstances = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const commitPanelArguments = vi.hoisted(() => [] as unknown[][]);
const undockedOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const gitOpsDeriveFor = vi.hoisted(() => vi.fn((root: string) => ({ root })));
const watchWholeIndexOperation = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const repositoryCommandDeps = vi.hoisted(() => ({
    value: undefined as Record<string, unknown> | undefined,
}));

const disposable = () => ({ dispose: vi.fn() });
const event = () => vi.fn(() => disposable());

vi.mock("vscode", () => ({
    Uri: {
        file: (fsPath: string) => ({
            fsPath,
            path: fsPath,
            scheme: "file",
            toString: () => fsPath,
        }),
    },
    TreeItem: class {
        constructor(_label: string) {}
    },
    l10n: { t: (message: string) => message },
    commands: {
        executeCommand: vi.fn(async () => undefined),
        registerCommand: vi.fn(() => disposable()),
    },
    authentication: { onDidChangeSessions: vi.fn(() => disposable()) },
    workspace: {
        workspaceFolders: undefined,
        getWorkspaceFolder: vi.fn(() => undefined),
        getConfiguration: vi.fn(() => ({
            get: vi.fn(() => undefined),
            update: vi.fn(async () => undefined),
        })),
        onDidChangeWorkspaceFolders: vi.fn(() => disposable()),
    },
    window: {
        activeTextEditor: undefined,
        createTreeView: vi.fn(() => ({ ...disposable(), badge: undefined })),
        registerWebviewViewProvider: vi.fn(() => disposable()),
        onDidChangeActiveTextEditor: vi.fn(() => disposable()),
        showWarningMessage: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
        showQuickPick: vi.fn(async () => undefined),
    },
}));

vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        setRoot = vi.fn();
        constructor(_root: string) {}
    },
}));

vi.mock("../../../src/git/operations", () => ({
    GitOps: class {
        deriveFor = gitOpsDeriveFor;
        getBranches = vi.fn(async () => []);
        constructor(_executor: unknown) {}
    },
}));

vi.mock("../../../src/git/wholeIndexOperationWatcher", () => ({ watchWholeIndexOperation }));

vi.mock("../../../src/ai/commitMessageGenerationCoordinator", () => ({
    CommitMessageGenerationCoordinator: class {
        dispose = vi.fn();
        constructor(public readonly dependencies: { resolveRoot: (root: string) => unknown }) {
            coordinatorInstances.push(this as unknown as Record<string, unknown>);
        }
    },
}));

vi.mock("../../../src/views/CommitPanelViewProvider", () => ({
    CommitPanelViewProvider: class {
        static readonly viewType = "intelligit.commitPanel";
        onDidChangeFileCount = event();
        onDidChangeWorkingTree = event();
        getLastKnownFileCount = vi.fn(() => 0);
        setRepositoryLabel = vi.fn();
        setRepositories = vi.fn();
        setBranches = vi.fn();
        setRepositoryRootUri = vi.fn();
        clearCommitDetail = vi.fn();
        refresh = vi.fn(async () => undefined);
        refreshSilent = vi.fn(async () => undefined);
        dispose = vi.fn();
        constructor(...args: unknown[]) {
            commitPanelArguments.push(args);
        }
    },
}));

vi.mock("../../../src/views/UndockedViewProvider", () => ({
    UndockedViewProvider: class {
        onDidDispose = event();
        onDockRequested = event();
        onCommitSelected = event();
        onBranchAction = event();
        onWorktreeAction = event();
        onDeleteBranches = event();
        onCommitAction = event();
        onOpenCommitFileDiff = event();
        onDidChangeWorkingTree = event();
        onDidChangeFileCount = event();
        setRepositoryLabel = vi.fn();
        setRepositories = vi.fn();
        setBranches = vi.fn();
        open = vi.fn();
        reveal = vi.fn();
        refresh = vi.fn(async () => undefined);
        refreshSilent = vi.fn(async () => undefined);
        clearChecksCache = vi.fn();
        dispose = vi.fn();
        constructor(...args: unknown[]) {
            undockedOptions.push(args.at(-1) as Record<string, unknown>);
        }
    },
}));

vi.mock("../../../src/views/CommitGraphViewProvider", () => ({
    CommitGraphViewProvider: class {
        static readonly viewType = "intelligit.commitGraph";
        static readonly sidebarViewType = "intelligit.sidebarGraph";
        setRepositoryLabel = vi.fn();
        setShowRepositoryLabel = vi.fn();
        setBranches = vi.fn();
        resetFilters = vi.fn();
        clearCommitDetail = vi.fn();
        clearChecksCache = vi.fn();
        refresh = vi.fn(async () => undefined);
        dispose = vi.fn();
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/views/CommitInfoViewProvider", () => ({
    CommitInfoViewProvider: class {
        static readonly viewType = "intelligit.commitInfo";
        clear = vi.fn();
        dispose = vi.fn();
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/views/MergeConflictsTreeProvider", () => ({
    MergeConflictsTreeProvider: class {
        setWorkspaceRoot = vi.fn();
        dispose = vi.fn();
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/views/RefreshService", () => ({
    RefreshService: class {
        registerFileWatchers = vi.fn();
        dispose = vi.fn();
        refreshMergeConflicts = vi.fn(async () => undefined);
        refreshConflictUi = vi.fn(async () => undefined);
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/worktreeService", () => ({
    WorktreeService: class {
        refresh = vi.fn(async () => []);
        decorateBranches = vi.fn((branches: unknown[]) => branches);
        dispose = vi.fn();
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/commitChecks/credentialStore", () => ({
    CredentialStore: class {
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/commitChecks/service", () => ({
    CommitChecksService: class {
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/commitChecks/persistentCache", () => ({
    CommitChecksPersistentCache: class {
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/commitChecks/requestGate", () => ({
    CommitChecksRequestGateRegistry: class {
        reset = vi.fn();
        run = vi.fn((_provider: string, _url: string, action: (generation: number) => unknown) =>
            action(0),
        );
        constructor(..._args: unknown[]) {}
    },
}));

vi.mock("../../../src/services/commitChecks/githubProvider", () => ({ GitHubProvider: class {} }));
vi.mock("../../../src/services/commitChecks/gitlabProvider", () => ({ GitLabProvider: class {} }));
vi.mock("../../../src/services/commitChecks/bitbucketCloudProvider", () => ({
    BitbucketCloudProvider: class {},
}));
vi.mock("../../../src/services/commitChecks/bitbucketServerProvider", () => ({
    BitbucketServerProvider: class {},
}));
vi.mock("../../../src/services/commitChecks/http", () => ({ createHttpGetJson: vi.fn() }));
vi.mock("../../../src/services/commitChecks/hostConfig", () => ({
    normalizeHostMap: vi.fn(() => ({})),
}));
vi.mock("../../../src/services/commitChecks/settingsConfig", () => ({
    normalizeCommitChecksSettings: vi.fn(() => ({
        ciCdPattern: undefined,
        ciCdFilterInvalid: false,
    })),
}));
vi.mock("../../../src/activation/shelfSettings", () => ({
    readShelfSettings: vi.fn(() => ({ removeOnUnshelve: true, cleanupAfterDays: 30 })),
}));
vi.mock("../../../src/activation/repositoryCommands", () => ({
    registerRepositoryCommands: vi.fn(
        (deps: Record<string, unknown>) => (repositoryCommandDeps.value = deps),
    ),
}));
vi.mock("../../../src/activation/shelfCommands", () => ({ registerShelfCommands: vi.fn() }));
vi.mock("../../../src/activation/repositoryViewEvents", () => ({
    createOpenCommitFileDiffHandler: vi.fn(() => vi.fn()),
    registerRepositoryViewEvents: vi.fn(),
}));

describe("commit-message generation host wiring", () => {
    it("constructs one coordinator, injects it into both hosts, binds known roots, and disposes once", async () => {
        const { activateRepositoryMode } = await import("../../../src/activation/repositoryMode");
        const context = {
            extensionUri: { fsPath: "/extension", path: "/extension" },
            subscriptions: [] as Array<{ dispose: () => void }>,
            workspaceState: { get: vi.fn(), update: vi.fn(async () => undefined) },
            secrets: {},
        };

        await activateRepositoryMode(context as never, [
            { root: "/repo-a", label: "repo-a" },
            { root: "/repo-b", label: "repo-b" },
        ]);
        await (repositoryCommandDeps.value?.showUndockedGitLog as () => Promise<void>)();

        expect(coordinatorInstances).toHaveLength(1);
        const coordinator = coordinatorInstances[0] as {
            dependencies: { resolveRoot: (root: string) => Record<string, unknown> };
            dispose: ReturnType<typeof vi.fn>;
        };
        expect(commitPanelArguments[0]?.at(-1)).toBe(coordinator);
        expect(undockedOptions[0]?.commitMessageGenerationCoordinator).toBe(coordinator);

        const rootContext = coordinator.dependencies.resolveRoot("/repo-b");
        expect(rootContext.workspaceFolder).toEqual({
            uri: expect.objectContaining({ fsPath: "/repo-b" }),
            name: "repo-b",
            index: 0,
        });
        expect(gitOpsDeriveFor).toHaveBeenCalledWith("/repo-b");
        rootContext.watchWholeIndexOperation?.(vi.fn());
        expect(watchWholeIndexOperation).toHaveBeenCalledWith("/repo-b", expect.any(Function));
        expect(() => coordinator.dependencies.resolveRoot("/unknown")).toThrow(
            "Unknown repository root for commit-message generation.",
        );

        expect(context.subscriptions.filter((entry) => entry === coordinator)).toHaveLength(1);
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    });
});
