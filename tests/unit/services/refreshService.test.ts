import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { RefreshService, type RefreshServiceDeps } from "../../../src/views/RefreshService";
import type { Branch } from "../../../src/types";
import type { CommitGraphViewProvider } from "../../../src/views/CommitGraphViewProvider";
import type { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";
import type { MergeConflictsTreeProvider } from "../../../src/views/MergeConflictsTreeProvider";

vi.mock("vscode", () => {
    /** Creates disposable mocks for VS Code watcher/listener registrations. */
    const disposable = () => ({ dispose: vi.fn() });
    const fileSystemWatcher = {
        onDidChange: vi.fn(() => disposable()),
        onDidCreate: vi.fn(() => disposable()),
        onDidDelete: vi.fn(() => disposable()),
        dispose: vi.fn(),
    };

    return {
        commands: {
            executeCommand: vi.fn(),
        },
        extensions: {
            getExtension: vi.fn(() => undefined),
        },
        workspace: {
            onDidChangeTextDocument: vi.fn(() => disposable()),
            onDidSaveTextDocument: vi.fn(() => disposable()),
            onDidCreateFiles: vi.fn(() => disposable()),
            onDidDeleteFiles: vi.fn(() => disposable()),
            onDidRenameFiles: vi.fn(() => disposable()),
            createFileSystemWatcher: vi.fn(() => fileSystemWatcher),
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
        },
        RelativePattern: class RelativePattern {
            readonly baseUri: { fsPath: string };
            readonly pattern: string;

            constructor(baseUri: { fsPath: string }, pattern: string) {
                this.baseUri = baseUri;
                this.pattern = pattern;
            }
        },
    };
});

/** Refresh source labels used to reach the private scheduler in tests. */
type RefreshEventType =
    | "workspace-file"
    | "git-index"
    | "git-state"
    | "git-refs"
    | "git-repository-state";

/** Narrow test-only view of the refresh service scheduler method. */
interface RefreshServiceSchedulerAccess {
    scheduleRefreshEvent(eventType: RefreshEventType): void;
}

/** Builds the current-branch fixture used by refresh propagation tests. */
function makeBranch(): Branch {
    return {
        name: "main",
        hash: "abc1234",
        isRemote: false,
        isCurrent: true,
        ahead: 0,
        behind: 0,
    };
}

/** Creates a refresh service with mocked downstream providers and scheduler access. */
function makeService(): {
    service: RefreshService;
    scheduler: RefreshServiceSchedulerAccess;
    deps: RefreshServiceDeps;
} {
    const branches = [makeBranch()];
    const commitGraph = {
        setBranches: vi.fn(),
        refresh: vi.fn(async () => undefined),
    } as unknown as CommitGraphViewProvider;
    const commitPanel = {
        setBranches: vi.fn(),
        refresh: vi.fn(async () => undefined),
        refreshSilent: vi.fn(async () => undefined),
    } as unknown as CommitPanelViewProvider;
    const mergeConflicts = {
        refresh: vi.fn(async () => 0),
    } as unknown as MergeConflictsTreeProvider;

    const deps: RefreshServiceDeps = {
        gitOps: {
            getBranches: vi.fn(async () => branches),
        } as unknown as GitOps,
        commitGraph,
        commitPanel,
        mergeConflicts,
        mergeConflictsView: { description: "" },
        onBranchesUpdated: vi.fn(),
    };
    const service = new RefreshService(deps, "/tmp/intelligit-refresh-test");

    return {
        service,
        scheduler: service as unknown as RefreshServiceSchedulerAccess,
        deps,
    };
}

describe("RefreshService refresh scheduling", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(0));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it("suppresses light refresh events while a full refresh is freshly scheduled", async () => {
        const { service, scheduler, deps } = makeService();

        scheduler.scheduleRefreshEvent("git-refs");
        scheduler.scheduleRefreshEvent("git-repository-state");

        await vi.advanceTimersByTimeAsync(300);
        expect(deps.commitPanel.refreshSilent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(200);
        expect(deps.gitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    it("runs one trailing light refresh for light events suppressed by a full refresh", async () => {
        const { service, scheduler, deps } = makeService();

        scheduler.scheduleRefreshEvent("git-refs");
        await vi.advanceTimersByTimeAsync(100);
        scheduler.scheduleRefreshEvent("git-index");

        await vi.advanceTimersByTimeAsync(400);
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(600);
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(2);

        service.dispose();
    });

    it("cancels a pending light refresh when a full refresh is scheduled", async () => {
        const { service, scheduler, deps } = makeService();

        scheduler.scheduleRefreshEvent("git-index");
        await vi.advanceTimersByTimeAsync(100);
        scheduler.scheduleRefreshEvent("git-state");

        await vi.advanceTimersByTimeAsync(300);
        expect(deps.commitPanel.refreshSilent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(200);
        expect(deps.gitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    it("refreshes when repository file watcher sees external file changes", async () => {
        const vscode = await import("vscode");
        const { service, deps } = makeService();
        service.registerFileWatchers();

        const createFileSystemWatcher = vscode.workspace
            .createFileSystemWatcher as unknown as ReturnType<typeof vi.fn>;
        const watcher = createFileSystemWatcher.mock.results[0].value as {
            onDidCreate: ReturnType<typeof vi.fn>;
        };
        const onDidCreate = watcher.onDidCreate.mock.calls[0][0] as (uri: {
            fsPath: string;
        }) => void;

        onDidCreate({ fsPath: "/tmp/intelligit-refresh-test/.git/index" });
        await vi.advanceTimersByTimeAsync(300);
        expect(deps.commitPanel.refreshSilent).not.toHaveBeenCalled();

        onDidCreate({ fsPath: "/tmp/intelligit-refresh-test/src/generated.ts" });
        await vi.advanceTimersByTimeAsync(300);
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    it("polls commit panels every five seconds as a fallback", async () => {
        const { service, deps } = makeService();
        service.registerFileWatchers();

        await vi.advanceTimersByTimeAsync(4_999);
        expect(deps.commitPanel.refreshSilent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(2);

        service.dispose();
    });

    it("decorates full-refresh branches before storing provider state", async () => {
        const { service, scheduler, deps } = makeService();
        const rawBranches = [makeBranch()];
        const decoratedBranches = [
            {
                ...rawBranches[0],
                isCheckedOutInWorktree: true,
                isCurrentWorktree: true,
                worktreePath: "/tmp/intelligit-refresh-test",
            },
        ];
        deps.gitOps.getBranches = vi.fn(async () => rawBranches) as never;
        deps.worktrees = {
            refresh: vi.fn(async () => []),
            decorateBranches: vi.fn(() => decoratedBranches),
        } as never;

        scheduler.scheduleRefreshEvent("git-refs");
        await vi.advanceTimersByTimeAsync(500);

        expect(deps.worktrees.refresh).toHaveBeenCalledTimes(1);
        expect(deps.worktrees.decorateBranches).toHaveBeenCalledWith(rawBranches);
        expect(deps.onBranchesUpdated).toHaveBeenCalledWith(decoratedBranches);
        expect(deps.commitGraph.setBranches).toHaveBeenCalledWith(decoratedBranches, []);
        expect(deps.commitPanel.setBranches).toHaveBeenCalledWith(decoratedBranches);
        service.dispose();
    });

    it("allows light refresh events after the full-refresh suppression window expires", async () => {
        const { service, scheduler, deps } = makeService();

        scheduler.scheduleRefreshEvent("git-state");
        await vi.advanceTimersByTimeAsync(500);
        expect(deps.gitOps.getBranches).toHaveBeenCalledTimes(1);

        vi.clearAllMocks();
        await vi.advanceTimersByTimeAsync(1_000);
        scheduler.scheduleRefreshEvent("workspace-file");
        await vi.advanceTimersByTimeAsync(300);

        expect(deps.gitOps.getBranches).not.toHaveBeenCalled();
        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    it("refreshes docked and undocked commit panels silently for implicit updates", async () => {
        const { service, deps } = makeService();
        const undocked = {
            refresh: vi.fn(async () => undefined),
            refreshSilent: vi.fn(async () => undefined),
        };
        deps.getUndocked = vi.fn(() => undocked as never);

        await service.refreshCommitPanels();

        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();
        expect(deps.commitPanel.refreshSilent).toHaveBeenCalledTimes(1);
        expect(undocked.refresh).not.toHaveBeenCalled();
        expect(undocked.refreshSilent).toHaveBeenCalledTimes(1);
        service.dispose();
    });
});
