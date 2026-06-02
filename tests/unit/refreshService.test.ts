import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../src/git/operations";
import { RefreshService, type RefreshServiceDeps } from "../../src/services/refreshService";
import type { Branch } from "../../src/types";
import type { CommitGraphViewProvider } from "../../src/views/CommitGraphViewProvider";
import type { CommitPanelViewProvider } from "../../src/views/CommitPanelViewProvider";
import type { MergeConflictsTreeProvider } from "../../src/views/MergeConflictsTreeProvider";

vi.mock("vscode", () => {
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

type RefreshEventType =
    | "workspace-file"
    | "git-index"
    | "git-state"
    | "git-refs"
    | "git-repository-state";

interface RefreshServiceSchedulerAccess {
    scheduleRefreshEvent(eventType: RefreshEventType): void;
}

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
        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(200);
        expect(deps.gitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(deps.commitPanel.refresh).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    it("cancels a pending light refresh when a full refresh is scheduled", async () => {
        const { service, scheduler, deps } = makeService();

        scheduler.scheduleRefreshEvent("git-index");
        await vi.advanceTimersByTimeAsync(100);
        scheduler.scheduleRefreshEvent("git-state");

        await vi.advanceTimersByTimeAsync(300);
        expect(deps.commitPanel.refresh).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(200);
        expect(deps.gitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(deps.commitPanel.refresh).toHaveBeenCalledTimes(1);

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
        expect(deps.commitPanel.refresh).toHaveBeenCalledTimes(1);

        service.dispose();
    });
});
