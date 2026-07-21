import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: { t: (message: string) => message },
    commands: {
        executeCommand: vi.fn(async () => undefined),
    },
    window: {
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (_title: string, task: () => Promise<void>): Promise<void> => task(),
    ),
    showTimedWarningMessage: vi.fn((message: string) => {
        vscodeMock.window.showWarningMessage(message);
    }),
    showTimedInformationMessage: vi.fn((message: string) => {
        vscodeMock.window.showInformationMessage(message);
    }),
}));

vi.mock("../../../src/services/gitHelpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/services/gitHelpers")>();
    return {
        ...actual,
        promptRebaseAfterPushRejection: vi.fn(),
    };
});

import {
    commitAndPushFromPanel,
    commitOnlyFromPanel,
    commitSelectedFromPanel,
    executeStashMutationRequest,
    runGitOperationFromPanel,
    stashMutationFromPanel,
} from "../../../src/views/commitPanelActions";
import type { CommitPanelGitOperation } from "../../../src/views/commitPanelActions";
import type { GitOps } from "../../../src/git/operations";

function makeGitOps(upstream?: string): GitOps {
    return {
        getBranches: vi.fn(async () => [
            {
                name: "main",
                hash: "abc1234",
                isCurrent: true,
                isRemote: false,
                upstream,
                ahead: 0,
                behind: 0,
            },
        ]),
        fetch: vi.fn(async () => ""),
        pullRebase: vi.fn(async () => ""),
        push: vi.fn(async () => ""),
        commit: vi.fn(async () => ""),
        commitAndPush: vi.fn(async () => ""),
        stageFiles: vi.fn(async () => ""),
        hasUncommittedChanges: vi.fn(async () => false),
        getStatus: vi.fn(async () => []),
        stashApply: vi.fn(async () => ""),
        stashPop: vi.fn(async () => ""),
        stashBranch: vi.fn(async () => ""),
        stashDelete: vi.fn(async () => ""),
        stashClear: vi.fn(async () => ""),
        getConflictFilesDetailed: vi.fn(async () => []),
    } as unknown as GitOps;
}

function makeDeps(gitOps: GitOps) {
    return {
        gitOps,
        refreshData: vi.fn(async () => undefined),
        refreshGraphData: vi.fn(async () => undefined),
        fireWorkingTreeChanged: vi.fn(),
        postCommitted: vi.fn(),
        maybeOfferPublishBranch: vi.fn(async () => undefined),
        publishBranch: vi.fn(async () => undefined),
    };
}

describe("runGitOperationFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("runs fetch when the current branch is unpublished", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await runGitOperationFromPanel(deps, "fetch");

        expect(gitOps.fetch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("runs fetch even when checking uncommitted changes would fail", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.hasUncommittedChanges).mockRejectedValueOnce(
            new Error("status should not run"),
        );

        await runGitOperationFromPanel(deps, "fetch");

        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(gitOps.fetch).toHaveBeenCalledTimes(1);
    });

    it.each<CommitPanelGitOperation>(["pull", "sync"])(
        "warns instead of running %s when the working tree is dirty",
        async (operation) => {
            const gitOps = makeGitOps("origin/main");
            const deps = makeDeps(gitOps);
            vi.mocked(gitOps.hasUncommittedChanges).mockResolvedValueOnce(true);

            await runGitOperationFromPanel(deps, operation);

            expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
                "There are uncommitted changes, please commit or stash them first.",
            );
            expect(gitOps.getBranches).not.toHaveBeenCalled();
            expect(gitOps.pullRebase).not.toHaveBeenCalled();
            expect(gitOps.push).not.toHaveBeenCalled();
            expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
            expect(deps.refreshData).not.toHaveBeenCalled();
            expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        },
    );

    it("publishes an unpublished branch even when the working tree is dirty", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.hasUncommittedChanges).mockRejectedValueOnce(
            new Error("status should not run"),
        );

        await runGitOperationFromPanel(deps, "push");

        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(deps.publishBranch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
            "There are uncommitted changes, please commit or stash them first.",
        );
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
    });

    it.each<CommitPanelGitOperation>(["pull", "sync"])(
        "warns instead of running %s when the current branch is unpublished",
        async (operation) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);

            await runGitOperationFromPanel(deps, operation);

            expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
                "The repo has not been published yet.",
            );
            expect(gitOps.pullRebase).not.toHaveBeenCalled();
            expect(gitOps.push).not.toHaveBeenCalled();
            expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
            expect(deps.refreshData).not.toHaveBeenCalled();
            expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        },
    );

    it("runs publish branch instead of raw push when the current branch is unpublished", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await runGitOperationFromPanel(deps, "push");

        expect(deps.publishBranch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
        expect(gitOps.push).not.toHaveBeenCalled();
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("falls back to the publish command when no scoped publish callback is supplied", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const { publishBranch: _publishBranch, ...depsWithoutPublish } = deps;

        await runGitOperationFromPanel(depsWithoutPublish, "push");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("intelligit.publishBranch");
        expect(gitOps.push).not.toHaveBeenCalled();
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("pushes a published branch even when the working tree is dirty", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.hasUncommittedChanges).mockRejectedValueOnce(
            new Error("status should not run"),
        );

        await runGitOperationFromPanel(deps, "push");

        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
            "There are uncommitted changes, please commit or stash them first.",
        );
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("does not offer publish branch automatically after a local-only commit", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await commitOnlyFromPanel(deps, "feat: local", false);

        expect(gitOps.commit).toHaveBeenCalledWith("feat: local", false);
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Committed successfully.",
        );
        expect(deps.postCommitted).toHaveBeenCalledTimes(1);
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
        expect(deps.maybeOfferPublishBranch).not.toHaveBeenCalled();
    });

    it("commits and routes push through publish branch when the current branch is unpublished", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await commitAndPushFromPanel(deps, "feat: publish", false);

        expect(gitOps.commit).toHaveBeenCalledWith("feat: publish", false);
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();
        expect(deps.publishBranch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
        expect(deps.postCommitted).toHaveBeenCalledTimes(1);
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("commits selected files and routes requested push through publish branch", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await commitSelectedFromPanel(deps, {
            message: "feat: publish selected",
            amend: false,
            push: true,
            paths: ["src/a.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: publish selected", false);
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();
        expect(deps.publishBranch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
        expect(deps.postCommitted).toHaveBeenCalledTimes(1);
    });

    it("pushes after a selected-file commit even when other files remain dirty", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.hasUncommittedChanges).mockRejectedValueOnce(
            new Error("status should not run"),
        );

        await commitSelectedFromPanel(deps, {
            message: "feat: partial commit",
            amend: false,
            push: true,
            paths: ["src/a.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: partial commit", false);
        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
            "There are uncommitted changes, please commit or stash them first.",
        );
    });
});

describe("stashMutationFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("applies with index reinstatement and refreshes working-tree state once", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await stashMutationFromPanel(deps, {
            action: "apply",
            index: 2,
            reinstateIndex: true,
        });

        expect(gitOps.stashApply).toHaveBeenCalledWith(2, true);
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });

    it("refreshes after a cancelled clear without reporting a working-tree change", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce(undefined);

        await stashMutationFromPanel(deps, { action: "clear" });

        expect(gitOps.stashClear).not.toHaveBeenCalled();
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
    });

    it("refreshes after a non-conflict failure without duplicate side effects", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.stashApply).mockRejectedValueOnce(new Error("apply failed"));

        await expect(
            stashMutationFromPanel(deps, {
                action: "apply",
                index: 0,
                reinstateIndex: false,
            }),
        ).rejects.toThrow("apply failed");

        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
    });
});

describe("executeStashMutationRequest", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("posts correlated completion after success", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();

        await executeStashMutationRequest(
            deps,
            { action: "apply", index: 0, reinstateIndex: false },
            "request-success",
            postCompleted,
        );

        expect(postCompleted).toHaveBeenCalledOnce();
        expect(postCompleted).toHaveBeenCalledWith("request-success");
    });

    it("posts correlated completion after cancellation", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce(undefined);

        await executeStashMutationRequest(
            deps,
            { action: "delete", index: 0 },
            "request-cancelled",
            postCompleted,
        );

        expect(gitOps.stashDelete).not.toHaveBeenCalled();
        expect(postCompleted).toHaveBeenCalledWith("request-cancelled");
    });

    it("posts correlated completion when mutation or refresh throws", async () => {
        const gitOps = makeGitOps();
        const mutationDeps = makeDeps(gitOps);
        const mutationCompleted = vi.fn();
        vi.mocked(gitOps.stashApply).mockRejectedValueOnce(new Error("mutation failed"));

        await expect(
            executeStashMutationRequest(
                mutationDeps,
                { action: "apply", index: 0, reinstateIndex: false },
                "request-mutation-failed",
                mutationCompleted,
            ),
        ).rejects.toThrow("mutation failed");
        expect(mutationCompleted).toHaveBeenCalledWith("request-mutation-failed");

        const refreshDeps = makeDeps(makeGitOps());
        const refreshCompleted = vi.fn();
        refreshDeps.refreshData.mockRejectedValueOnce(new Error("refresh failed"));

        await expect(
            executeStashMutationRequest(
                refreshDeps,
                { action: "apply", index: 0, reinstateIndex: false },
                "request-refresh-failed",
                refreshCompleted,
            ),
        ).rejects.toThrow("refresh failed");
        expect(refreshCompleted).toHaveBeenCalledWith("request-refresh-failed");
    });

    it("does not post completion when requestId is absent", async () => {
        const postCompleted = vi.fn();

        await executeStashMutationRequest(
            makeDeps(makeGitOps()),
            { action: "apply", index: 0, reinstateIndex: false },
            undefined,
            postCompleted,
        );

        expect(postCompleted).not.toHaveBeenCalled();
    });
});
