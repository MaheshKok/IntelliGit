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
