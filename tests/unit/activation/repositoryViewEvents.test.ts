import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const vscodeMock = vi.hoisted(() => ({
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            args
                ? Object.entries(args).reduce(
                      (text, [key, value]) => text.replaceAll(`{${key}}`, value),
                      message,
                  )
                : message,
    },
    window: { showErrorMessage: vi.fn() },
    Disposable: class {
        constructor(private readonly onDispose: () => void) {}
        dispose(): void {
            this.onDispose();
        }
    },
}));

vi.mock("vscode", () => vscodeMock);

const diffServiceMock = vi.hoisted(() => ({
    openCommitFileDiff: vi.fn(async () => undefined),
}));

// Cross-module mock: repositoryViewEvents.ts imports openCommitFileDiff from diffService.ts, so
// unlike diffService.ts's own internal callers, vi.mock can intercept this reference cleanly.
vi.mock("../../../src/services/diffService", () => diffServiceMock);

import {
    createOpenCommitFileDiffHandler,
    registerRepositoryViewEvents,
    registerUndockedCommitFileDiffHandler,
    type RepositoryViewEventDeps,
} from "../../../src/activation/repositoryViewEvents";
import type { GitExecutor } from "../../../src/git/executor";
import type { GitOps } from "../../../src/git/operations";
import type { PendingRebaseDialogRequests } from "../../../src/git/interactiveRebase/types";
import type { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import type { CommitGraphViewProvider } from "../../../src/views/CommitGraphViewProvider";
import type { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";
import type { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";
import type { RefreshService } from "../../../src/views/RefreshService";
import type { CommitDetail } from "../../../src/types";

beforeEach(() => {
    vi.clearAllMocks();
});

/** Minimal double for vscode.EventEmitter<T>, capturing listeners so a test can fire them directly. */
function fakeEmitter<T>() {
    const listeners: Array<(value: T) => void> = [];
    return {
        event: (listener: (value: T) => void) => {
            listeners.push(listener);
            return { dispose: vi.fn() };
        },
        fire: (value: T) => listeners.forEach((listener) => listener(value)),
    };
}

describe("createOpenCommitFileDiffHandler", () => {
    const executor = {} as unknown as GitExecutor;
    const gitOps = {} as unknown as GitOps;

    // Exercised with both a docked-shaped repo-root accessor and an undocked-shaped one (a
    // selected-root accessor instead of the active-repository accessor) because these are the
    // exact two deps shapes the two real call sites (repositoryMode.ts's `activateRepositoryMode`
    // and `ensureUndockedPanel`) build this same factory with -- see the wiring test below.
    it.each([
        ["docked-shaped deps", "/repo"],
        ["undocked-shaped deps", "/other-repo"],
    ])("opens a commit file diff via openCommitFileDiff for %s", async (_name, repoRoot) => {
        const handler = createOpenCommitFileDiffHandler({
            executor,
            gitOps,
            getRepoRoot: () => repoRoot,
        });

        await handler({ commitHash: "abc123", filePath: "src/example.ts" });

        expect(diffServiceMock.openCommitFileDiff).toHaveBeenCalledWith(
            "abc123",
            "src/example.ts",
            repoRoot,
            gitOps,
            executor,
        );
    });

    it("reports a failure from openCommitFileDiff as an error notification instead of throwing", async () => {
        diffServiceMock.openCommitFileDiff.mockRejectedValueOnce(new Error("cat-file failed"));
        const handler = createOpenCommitFileDiffHandler({
            executor,
            gitOps,
            getRepoRoot: () => "/repo",
        });

        await expect(
            handler({ commitHash: "abc123", filePath: "src/example.ts" }),
        ).resolves.toBeUndefined();

        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            "Failed to open commit diff: cat-file failed",
        );
    });
});

describe("registerRepositoryViewEvents commit-file-diff wiring (spec 3.7)", () => {
    it("routes commitGraph, sidebarGraph, commitPanel, and commitInfo through the exact same handler reference", () => {
        const commitGraphDiff = fakeEmitter<{ commitHash: string; filePath: string }>();
        const sidebarGraphDiff = fakeEmitter<{ commitHash: string; filePath: string }>();
        const commitPanelDiff = fakeEmitter<{ commitHash: string; filePath: string }>();
        const commitInfoDiff = fakeEmitter<{ commitHash: string; filePath: string }>();

        const fakeGraphLikeProvider = (diffEmitter: typeof commitGraphDiff) => ({
            onCommitSelected: fakeEmitter<string>().event,
            onBranchFilterChanged: fakeEmitter<string | null>().event,
            onBranchAction: fakeEmitter<unknown>().event,
            onCommitAction: fakeEmitter<unknown>().event,
            onRebaseDialogSubmit: fakeEmitter<unknown>().event,
            onRebaseDialogCancel: fakeEmitter<unknown>().event,
            onOpenCommitFileDiff: diffEmitter.event,
        });

        const fakeCommitPanel = {
            ...fakeGraphLikeProvider(commitPanelDiff),
            onRebaseControl: fakeEmitter<unknown>().event,
        };
        const fakeCommitInfo = {
            onOpenCommitFileDiff: commitInfoDiff.event,
            setCommitDetail: vi.fn(),
            clear: vi.fn(),
        };

        const handleOpenCommitFileDiff = vi.fn(async () => undefined);
        const deps: RepositoryViewEventDeps = {
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            executor: {} as unknown as GitExecutor,
            gitOps: {} as unknown as GitOps,
            commitGraph: fakeGraphLikeProvider(
                commitGraphDiff,
            ) as unknown as CommitGraphViewProvider,
            sidebarGraph: fakeGraphLikeProvider(
                sidebarGraphDiff,
            ) as unknown as CommitGraphViewProvider,
            commitPanel: fakeCommitPanel as unknown as CommitPanelViewProvider,
            commitInfo: fakeCommitInfo as unknown as CommitInfoViewProvider,
            getRepoRoot: () => "/repo",
            getCurrentBranches: () => [],
            getCurrentWorktrees: () => [],
            refreshService: () => ({ refreshAll: vi.fn() }) as unknown as RefreshService,
            pendingRebaseDialogRequests: {} as unknown as PendingRebaseDialogRequests,
            mutationGate: {} as unknown as RepositoryMutationGate,
        };

        registerRepositoryViewEvents(deps, handleOpenCommitFileDiff);

        commitGraphDiff.fire({ commitHash: "a1", filePath: "graph.ts" });
        sidebarGraphDiff.fire({ commitHash: "a2", filePath: "sidebar.ts" });
        commitPanelDiff.fire({ commitHash: "a3", filePath: "panel.ts" });
        commitInfoDiff.fire({ commitHash: "a4", filePath: "info.ts" });

        // Same function reference receiving all four calls -- not four independently-wired
        // look-alike handlers -- is what proves commit-info needs no webview changes: its message
        // lands in the identical host handler the docked graph/panel surfaces already use.
        expect(handleOpenCommitFileDiff).toHaveBeenCalledTimes(4);
        expect(handleOpenCommitFileDiff).toHaveBeenNthCalledWith(1, {
            commitHash: "a1",
            filePath: "graph.ts",
        });
        expect(handleOpenCommitFileDiff).toHaveBeenNthCalledWith(2, {
            commitHash: "a2",
            filePath: "sidebar.ts",
        });
        expect(handleOpenCommitFileDiff).toHaveBeenNthCalledWith(3, {
            commitHash: "a3",
            filePath: "panel.ts",
        });
        expect(handleOpenCommitFileDiff).toHaveBeenNthCalledWith(4, {
            commitHash: "a4",
            filePath: "info.ts",
        });
    });
});

describe("registerUndockedCommitFileDiffHandler wiring (spec 3.7)", () => {
    /**
     * `ensureUndockedPanel` (src/activation/repositoryMode.ts) wires the undocked panel's
     * commit-file-diff event through this exact seam, extracted specifically so the wiring can
     * run in a test without constructing the rest of that factory's large, mostly-unrelated
     * dependency graph (WorktreeService, rebase submission handlers, workspace-state
     * persistence, ...). This fires a real event through the real seam and observes the shared
     * factory's handler actually run -- not a source-text stand-in for that claim -- which is
     * what proves spec 3.7's "same host handler" claim for the undocked surface: the deps this
     * call is given reach openCommitFileDiff, via the identical createOpenCommitFileDiffHandler
     * the docked providers above are wired through.
     */
    it("routes a fired onOpenCommitFileDiff event through createOpenCommitFileDiffHandler with the given deps", () => {
        const executor = {} as unknown as GitExecutor;
        const gitOps = {} as unknown as GitOps;
        const undockedDiff = fakeEmitter<{ commitHash: string; filePath: string }>();

        registerUndockedCommitFileDiffHandler(
            { executor, gitOps, getRepoRoot: () => "/other-repo" },
            { onOpenCommitFileDiff: undockedDiff.event },
        );

        undockedDiff.fire({ commitHash: "u1", filePath: "undocked.ts" });

        expect(diffServiceMock.openCommitFileDiff).toHaveBeenCalledWith(
            "u1",
            "undocked.ts",
            "/other-repo",
            gitOps,
            executor,
        );
    });
});

/**
 * Regression cover for #226.
 *
 * The sidebar and bottom graphs are two instances of the same class. Each draws its own
 * selected-row ring, but they share the details panes: whichever pick's load lands last fills
 * them. So once one graph's commit is on show, the other graph must drop its ring, or two rows
 * stay outlined and only one of them owns the changed files. And the sidebar always draws the
 * checked-out branch, so a branch picked in one graph must stay in that graph.
 */
describe("registerRepositoryViewEvents across the two graphs (#226)", () => {
    function wireTwoGraphs() {
        const pendingDetails = new Map<string, (detail: CommitDetail) => void>();
        const fakeGraph = () => {
            const commitSelected = fakeEmitter<string>();
            const branchFilter = fakeEmitter<string | null>();
            return {
                commitSelected,
                branchFilter,
                onCommitSelected: commitSelected.event,
                onBranchFilterChanged: branchFilter.event,
                onBranchAction: fakeEmitter<unknown>().event,
                onCommitAction: fakeEmitter<unknown>().event,
                onRebaseDialogSubmit: fakeEmitter<unknown>().event,
                onRebaseDialogCancel: fakeEmitter<unknown>().event,
                onOpenCommitFileDiff: fakeEmitter<{ commitHash: string; filePath: string }>().event,
                filterByBranch: vi.fn(async () => undefined),
                clearCommitDetail: vi.fn(),
                setCommitDetail: vi.fn(),
                deselectCommit: vi.fn(),
            };
        };

        const commitGraph = fakeGraph();
        const sidebarGraph = fakeGraph();
        const commitPanel = { ...fakeGraph(), onRebaseControl: fakeEmitter<unknown>().event };
        const commitInfo = {
            onOpenCommitFileDiff: fakeEmitter<{ commitHash: string; filePath: string }>().event,
            setCommitDetail: vi.fn(),
            clear: vi.fn(),
        };
        // Every load waits until the test settles it, so a test can land two picks' responses in
        // the order a slow `git show` would.
        const gitOps = {
            getCommitDetail: vi.fn(
                (hash: string) =>
                    new Promise<CommitDetail>((resolve) => pendingDetails.set(hash, resolve)),
            ),
        };

        const deps: RepositoryViewEventDeps = {
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            executor: {} as unknown as GitExecutor,
            gitOps: gitOps as unknown as GitOps,
            commitGraph: commitGraph as unknown as CommitGraphViewProvider,
            sidebarGraph: sidebarGraph as unknown as CommitGraphViewProvider,
            commitPanel: commitPanel as unknown as CommitPanelViewProvider,
            commitInfo: commitInfo as unknown as CommitInfoViewProvider,
            getRepoRoot: () => "/repo",
            getCurrentBranches: () => [],
            getCurrentWorktrees: () => [],
            refreshService: () => ({ refreshAll: vi.fn() }) as unknown as RefreshService,
            pendingRebaseDialogRequests: {} as unknown as PendingRebaseDialogRequests,
            mutationGate: {} as unknown as RepositoryMutationGate,
        };

        registerRepositoryViewEvents(
            deps,
            vi.fn(async () => undefined),
        );

        /** Lands `hash`'s detail load, then lets the host's handler finish with it. */
        async function settle(hash: string): Promise<void> {
            pendingDetails.get(hash)?.({ hash } as unknown as CommitDetail);
            await new Promise((resolve) => setImmediate(resolve));
        }

        return { commitGraph, sidebarGraph, commitPanel, settle };
    }

    it("leaves the other graph's branch alone when a branch is picked in either graph", () => {
        const { commitGraph, sidebarGraph } = wireTwoGraphs();

        commitGraph.branchFilter.fire("feature/awesome");
        sidebarGraph.branchFilter.fire(null);

        expect(
            sidebarGraph.filterByBranch,
            "a branch picked in the bottom graph re-scoped the sidebar graph, which must always " +
                "show the checked-out branch",
        ).not.toHaveBeenCalled();
        expect(
            commitGraph.filterByBranch,
            "a branch pick in the sidebar graph re-scoped the bottom graph",
        ).not.toHaveBeenCalled();
    });

    it("takes the ring off the sidebar graph once a commit picked in the bottom graph fills the details", async () => {
        const { commitGraph, sidebarGraph, settle } = wireTwoGraphs();

        commitGraph.commitSelected.fire("b1");
        await settle("b1");

        expect(
            commitGraph.setCommitDetail,
            "the control: the bottom graph's pick must have reached the details panes",
        ).toHaveBeenCalledWith({ hash: "b1" });
        expect(
            sidebarGraph.deselectCommit,
            "the bottom graph's commit fills the details, but the sidebar graph kept its own row " +
                "outlined, so two commits looked selected",
        ).toHaveBeenCalledTimes(1);
        expect(
            commitGraph.deselectCommit,
            "the graph whose commit is on show lost its own ring",
        ).not.toHaveBeenCalled();
    });

    it("takes the ring off the bottom graph once a commit picked in the sidebar graph fills the details", async () => {
        const { commitGraph, sidebarGraph, settle } = wireTwoGraphs();

        sidebarGraph.commitSelected.fire("s1");
        await settle("s1");

        expect(
            sidebarGraph.setCommitDetail,
            "the control: the sidebar graph's pick must have reached the details panes",
        ).toHaveBeenCalledWith({ hash: "s1" });
        expect(
            commitGraph.deselectCommit,
            "the sidebar graph's commit fills the details, but the bottom graph kept its own row " +
                "outlined, so two commits looked selected",
        ).toHaveBeenCalledTimes(1);
        expect(
            sidebarGraph.deselectCommit,
            "the graph whose commit is on show lost its own ring",
        ).not.toHaveBeenCalled();
    });

    it("moves the ring only for the pick whose details land, not for one a newer pick overtook", async () => {
        const { commitGraph, sidebarGraph, settle } = wireTwoGraphs();

        // The sidebar pick's load is still running when a bottom-graph pick replaces it.
        sidebarGraph.commitSelected.fire("s1");
        commitGraph.commitSelected.fire("b1");
        await settle("b1");
        await settle("s1");

        expect(
            commitGraph.deselectCommit,
            "the overtaken sidebar pick took the ring off the bottom graph, whose commit is the " +
                "one on show",
        ).not.toHaveBeenCalled();
        expect(
            sidebarGraph.deselectCommit,
            "the bottom graph's newer pick fills the details, but the sidebar graph kept its ring",
        ).toHaveBeenCalledTimes(1);
    });

    it("takes the ring off both graphs once a commit picked in the commit panel fills the details", async () => {
        const { commitGraph, sidebarGraph, commitPanel, settle } = wireTwoGraphs();

        commitPanel.commitSelected.fire("p1");
        await settle("p1");

        expect(
            commitGraph.deselectCommit,
            "the commit panel's commit fills the details, but the bottom graph kept its ring",
        ).toHaveBeenCalledTimes(1);
        expect(
            sidebarGraph.deselectCommit,
            "the commit panel's commit fills the details, but the sidebar graph kept its ring",
        ).toHaveBeenCalledTimes(1);
    });
});
