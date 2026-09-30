import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "../../../src/types";

const mocks = vi.hoisted(() => ({
    showErrorMessage: vi.fn(),
    showTimedInformationMessage: vi.fn(),
    showTimedWarningMessage: vi.fn(),
    executeCommand: vi.fn(),
    showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            args
                ? message.replace(/\{(\w+)\}/g, (_match, key: string) => String(args[key] ?? ""))
                : message,
    },
    window: {
        showErrorMessage: mocks.showErrorMessage,
        showWarningMessage: mocks.showWarningMessage,
    },
    commands: { executeCommand: mocks.executeCommand },
    ProgressLocation: { Notification: 15 },
}));

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: async (_label: string, task: () => Promise<void>) => {
        return task();
    },
    showTimedInformationMessage: mocks.showTimedInformationMessage,
    showTimedWarningMessage: mocks.showTimedWarningMessage,
}));

import { createBranchCommands } from "../../../src/commands/branchCommands";

const CURRENT: Branch = {
    name: "feature",
    hash: "a".repeat(40),
    isRemote: false,
    isCurrent: true,
    upstream: "origin/feature",
    ahead: 0,
    behind: 2,
};

const OTHER: Branch = {
    name: "release",
    hash: "b".repeat(40),
    isRemote: false,
    isCurrent: false,
    upstream: "origin/release",
    ahead: 0,
    behind: 1,
};

function makeDeps(overrides: { hasUncommittedChanges?: boolean } = {}) {
    const executor = { run: vi.fn(async () => "") };
    const gitOps = {
        pullRebase: vi.fn(async () => undefined),
        hasUncommittedChanges: vi.fn(async () => overrides.hasUncommittedChanges ?? false),
        getBranches: vi.fn(async () => [CURRENT, OTHER]),
        getConflictFilesDetailed: vi.fn(async () => []),
        preparePullRebaseWithLocalChanges: vi.fn(async () => ({
            kind: "ready",
            context: {
                repositoryRoot: "/captured",
                branch: "feature",
                head: "a".repeat(40),
                upstream: "refs/remotes/origin/feature",
                dirty: overrides.hasUncommittedChanges ?? false,
            },
        })),
        pullRebasePreservingLocalChanges: vi.fn(async () => ({ kind: "complete" })),
    };
    return {
        executor,
        gitOps,
        deps: {
            executor,
            gitOps,
            getCurrentBranchName: () => "feature",
            getCurrentBranches: () => [CURRENT, OTHER],
            createWorktree: vi.fn(async () => undefined),
            openConflictSession: vi.fn(async () => undefined),
            refreshConflictUi: vi.fn(async () => undefined),
            refreshRepository: vi.fn(async () => undefined),
        },
    };
}

function updateHandler(deps: ReturnType<typeof makeDeps>["deps"]) {
    const entries = createBranchCommands(deps as any);
    const entry = entries.find((candidate) => candidate.id === "intelligit.updateBranch");
    if (!entry) throw new Error("intelligit.updateBranch is no longer registered");
    return entry.handler;
}

describe("intelligit.updateBranch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // The Changes toolbar's down-arrow and the graph toolbar's down-arrow both reach
    // `runGitOperationFromPanel(..., "pull")`, which runs `pull --rebase`. The branch menu's
    // "Update" ran `fetch` plus a merge instead, so the same intent produced two different
    // histories depending on which control the user clicked (#218). All three run one operation
    // now, so no `merge` may reach the executor for the checked-out branch.
    it("routes Update on the current branch through the shared pull --rebase action", async () => {
        const { executor, gitOps, deps } = makeDeps();

        await updateHandler(deps)({ branch: CURRENT });

        expect(
            gitOps.pullRebasePreservingLocalChanges,
            "Update on the checked-out branch did not run the shared pull --rebase operation",
        ).toHaveBeenCalledTimes(1);
        const mergeCalls = executor.run.mock.calls.filter((call) =>
            (call[0] as string[] | undefined)?.includes("merge"),
        );
        expect(
            mergeCalls,
            "Update on the checked-out branch still merged the tracked remote instead of rebasing",
        ).toEqual([]);
    });

    it("current Update saves local changes only after explicit consent", async () => {
        const { executor, gitOps, deps } = makeDeps({ hasUncommittedChanges: true });
        mocks.showWarningMessage.mockResolvedValueOnce("Save Changes and Pull");
        await updateHandler(deps)({ branch: CURRENT });
        expect(gitOps.pullRebasePreservingLocalChanges).toHaveBeenCalledWith(
            expect.objectContaining({ saveLocalChanges: true }),
        );
        expect(executor.run).not.toHaveBeenCalled();
        expect(gitOps.pullRebase).not.toHaveBeenCalled();
        expect(deps.refreshRepository).toHaveBeenCalledOnce();
        expect(mocks.executeCommand).not.toHaveBeenCalled();
    });

    // A branch that is not checked out cannot be pulled into: Git needs the fetch refspec form.
    // This is the path the fix must leave alone, and the mutation that reroutes the current branch
    // cannot touch it.
    it("still updates a branch that is not checked out with a fetch refspec", async () => {
        const { executor, gitOps, deps } = makeDeps();

        await updateHandler(deps)({ branch: OTHER });

        expect(
            executor.run,
            "updating a branch that is not checked out stopped using the fetch refspec",
        ).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "release:release",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(
            gitOps.pullRebase,
            "updating a branch that is not checked out pulled into the checked-out branch instead",
        ).not.toHaveBeenCalled();
    });
});
