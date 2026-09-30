import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            args
                ? message.replace(/\{(\w+)\}/g, (_match, key: string) => String(args[key] ?? ""))
                : message,
    },
    commands: {
        executeCommand: vi.fn(async () => undefined),
    },
    window: {
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (
            _title: string,
            task: (progress: { report: ReturnType<typeof vi.fn> }) => Promise<unknown>,
        ): Promise<unknown> => task({ report: vi.fn() }),
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
import type {
    PullUpdateContext,
    PullUpdatePreparation,
    PullUpdateResult,
} from "../../../src/git/updateWithLocalChanges";

const pullContext: PullUpdateContext = {
    repositoryRoot: "/repo",
    branch: "main",
    upstream: "refs/remotes/origin/main",
    head: "a".repeat(40),
    dirty: false,
};

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
        preparePullRebaseWithLocalChanges: vi.fn(async (): Promise<PullUpdatePreparation> =>
            upstream
                ? { kind: "ready", context: pullContext }
                : { kind: "refused", reason: "no-upstream" },
        ),
        pullRebasePreservingLocalChanges: vi.fn(async (): Promise<PullUpdateResult> => ({
            kind: "complete",
        })),
        push: vi.fn(async () => ""),
        commit: vi.fn(async () => ""),
        commitAndPush: vi.fn(async () => ""),
        stageFiles: vi.fn(async () => ""),
        hasUncommittedChanges: vi.fn(async () => false),
        getStatus: vi.fn(async () => []),
        stashApply: vi.fn(async () => ""),
        applyStashFile: vi.fn(async () => undefined),
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

    it.each<CommitPanelGitOperation>(["sync"])(
        "warns instead of running %s when the working tree is dirty",
        async (operation) => {
            const gitOps = makeGitOps("origin/main");
            const deps = makeDeps(gitOps);
            vi.mocked(gitOps.hasUncommittedChanges).mockResolvedValueOnce(true);

            await runGitOperationFromPanel(deps, operation);

            expect(gitOps.push, "dirty Sync must never push local work").not.toHaveBeenCalled();
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
                operation === "pull"
                    ? "The current branch has no upstream. Publish it or configure tracking before pulling."
                    : "The repo has not been published yet.",
            );
            expect(gitOps.pullRebase).not.toHaveBeenCalled();
            expect(gitOps.push).not.toHaveBeenCalled();
            expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
            expect(deps.refreshData).not.toHaveBeenCalled();
            expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        },
    );

    it("dirty Pull asks explicit consent and reports expected retained-backup success", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        const context = { ...pullContext, dirty: true };
        vi.mocked(gitOps.preparePullRebaseWithLocalChanges).mockResolvedValueOnce({
            kind: "ready",
            context,
        });
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "complete",
            backup: { oid: "b".repeat(40), message: "IntelliGit update: main backup" },
        });
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Save Changes and Pull");
        await runGitOperationFromPanel(deps, "pull");
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Pull with local changes?",
            expect.objectContaining({ modal: true, detail: expect.stringContaining("/repo") }),
            "Save Changes and Pull",
        );
        expect(gitOps.pullRebasePreservingLocalChanges).toHaveBeenCalledWith(
            expect.objectContaining({ expected: context, saveLocalChanges: true }),
        );
        expect(gitOps.pullRebase).not.toHaveBeenCalled();
        expect(gitOps.push).not.toHaveBeenCalled();
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("local changes were restored"),
        );
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("bbbbbbbb"),
        );
        expect(deps.refreshData).toHaveBeenCalledOnce();
    });

    it.each([undefined, "Cancel"])(
        "dirty Pull cancellation %s never starts the transaction",
        async (answer) => {
            const gitOps = makeGitOps("origin/main");
            vi.mocked(gitOps.preparePullRebaseWithLocalChanges).mockResolvedValueOnce({
                kind: "ready",
                context: { ...pullContext, dirty: true },
            });
            vscodeMock.window.showWarningMessage.mockResolvedValueOnce(answer);
            await runGitOperationFromPanel(makeDeps(gitOps), "pull");
            expect(gitOps.pullRebasePreservingLocalChanges).not.toHaveBeenCalled();
            expect(gitOps.pullRebase).not.toHaveBeenCalled();
        },
    );

    it("clean Pull requests consent after gated revalidation discovers new dirt", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges)
            .mockResolvedValueOnce({
                kind: "confirmation-required",
                context: { ...pullContext, dirty: true },
            })
            .mockResolvedValueOnce({ kind: "complete" });
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Save Changes and Pull");
        await runGitOperationFromPanel(makeDeps(gitOps), "pull");
        expect(gitOps.pullRebasePreservingLocalChanges).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ saveLocalChanges: false }),
        );
        expect(gitOps.pullRebasePreservingLocalChanges).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ saveLocalChanges: true }),
        );
    });

    it("failed pull and failed restoration reports both diagnostics without pull-complete wording", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "restore-failed",
            integration: "failed",
            integrationError: new Error("network offline"),
            error: new Error("index restoration blocked"),
            backup: { oid: "b".repeat(40), message: "owned backup" },
            hasUnmergedPaths: false,
        });
        await runGitOperationFromPanel(makeDeps(gitOps), "pull");
        const message = vscodeMock.window.showErrorMessage.mock.calls.at(-1)?.[0];
        expect(message).toContain("The pull failed, and local changes could not be fully restored");
        expect(message).toContain("network offline");
        expect(message).toContain("index restoration blocked");
        expect(message).toContain("b".repeat(40));
        expect(message).not.toContain("pull completed");
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("restoration conflicts open only the captured repository's conflict session", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "restore-failed",
            integration: "succeeded",
            error: new Error("conflicts"),
            backup: { oid: "b".repeat(40), message: "owned backup" },
            hasUnmergedPaths: true,
        });
        const openConflictSession = vi.fn(async () => undefined);
        await runGitOperationFromPanel({ ...makeDeps(gitOps), openConflictSession }, "pull");
        expect(openConflictSession).toHaveBeenCalledWith(pullContext);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("refresh failure after completed Pull is separate and never repeats Git", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        deps.refreshData.mockRejectedValueOnce(new Error("view unavailable"));
        await expect(runGitOperationFromPanel(deps, "pull")).resolves.toBeUndefined();
        expect(gitOps.pullRebasePreservingLocalChanges).toHaveBeenCalledOnce();
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Pulled successfully.",
        );
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("view could not refresh"),
        );
        expect(vscodeMock.window.showErrorMessage.mock.calls.at(-1)?.[0]).not.toContain(
            "Pull failed",
        );
    });

    it("the approved GitOps and original context survive a repository switch during consent", async () => {
        const gitOps = makeGitOps("origin/main");
        const other = makeGitOps("origin/other");
        const deps = makeDeps(gitOps);
        const context = { ...pullContext, dirty: true };
        vi.mocked(gitOps.preparePullRebaseWithLocalChanges).mockResolvedValueOnce({
            kind: "ready",
            context,
        });
        vscodeMock.window.showWarningMessage.mockImplementationOnce(async () => {
            deps.gitOps = other;
            return "Save Changes and Pull";
        });
        await runGitOperationFromPanel(deps, "pull");
        expect(
            gitOps.pullRebasePreservingLocalChanges,
            "the originally approved repository must own the mutation",
        ).toHaveBeenCalledWith(expect.objectContaining({ expected: context }));
        expect(other.pullRebasePreservingLocalChanges).not.toHaveBeenCalled();
    });

    it("changed context after confirmation is refused without complete-success messaging", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "refused",
            reason: "context-changed",
        });
        const deps = makeDeps(gitOps);
        await runGitOperationFromPanel(deps, "pull");
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("HEAD changed"),
        );
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(deps.refreshData).not.toHaveBeenCalled();
    });

    it("integration conflict keeps the backup and explains deliberate recovery after Continue or Abort", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "integration-conflict",
            error: new Error("rebase conflict"),
            backup: { oid: "b".repeat(40), message: "retained backup" },
            hasUnmergedPaths: true,
        });
        await runGitOperationFromPanel(makeDeps(gitOps), "pull");
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("After Continue or Abort and a clean worktree"),
        );
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("retained backup (bbbbbbbb)"),
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "intelligit.openConflictSession",
            { repositoryRoot: "/repo" },
        );
    });

    it("failed save with unverified object identity still exposes the searchable backup name", async () => {
        const gitOps = makeGitOps("origin/main");
        vi.mocked(gitOps.pullRebasePreservingLocalChanges).mockResolvedValueOnce({
            kind: "failed",
            phase: "save",
            error: new Error("reflog unavailable"),
            localChanges: "uncertain",
            backupName: "IntelliGit update: unique name",
        });
        await runGitOperationFromPanel(makeDeps(gitOps), "pull");
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("IntelliGit update: unique name"),
        );
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("object ID could not be verified"),
        );
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    });

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

    it("force pushes only after the rewrite is confirmed", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Force Push");

        await runGitOperationFromPanel(deps, "push", true);

        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Force push rewrites the remote branch history. Continue?",
            { modal: true },
            "Force Push",
        );
        expect(gitOps.push).toHaveBeenCalledWith(true);
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
    });

    it("leaves the remote untouched when the force-push confirmation is declined", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce(undefined);

        await runGitOperationFromPanel(deps, "push", true);

        expect(gitOps.push).not.toHaveBeenCalled();
        expect(deps.refreshData).not.toHaveBeenCalled();
        expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
    });

    it("pushes without force when force is not requested", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);

        await runGitOperationFromPanel(deps, "push");

        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
            "Force push rewrites the remote branch history. Continue?",
            { modal: true },
            "Force Push",
        );
        expect(gitOps.push).toHaveBeenCalledWith(false);
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

    it("signals commit completion once when push rejects after a local commit", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.push).mockRejectedValueOnce(new Error("push failed"));

        await expect(commitAndPushFromPanel(deps, "feat: push rejection", false)).rejects.toThrow(
            "push failed",
        );

        expect(gitOps.commit).toHaveBeenCalledWith("feat: push rejection", false);
        expect(deps.postCommitted).toHaveBeenCalledTimes(1);
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

        expect(gitOps.getStatus).toHaveBeenCalledWith({ withStats: false });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: publish selected", false, ["src/a.ts"]);
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

        expect(gitOps.getStatus).toHaveBeenCalledWith({ withStats: false });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: partial commit", false, ["src/a.ts"]);
        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(gitOps.push).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
            "There are uncommitted changes, please commit or stash them first.",
        );
    });

    it("signals commit completion once when push rejects after a selected-file commit", async () => {
        const gitOps = makeGitOps("origin/main");
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.push).mockRejectedValueOnce(new Error("push failed"));

        await expect(
            commitSelectedFromPanel(deps, {
                message: "feat: push rejection",
                amend: false,
                push: true,
                paths: ["src/a.ts"],
            }),
        ).rejects.toThrow("push failed");

        expect(gitOps.commit).toHaveBeenCalledWith("feat: push rejection", false, ["src/a.ts"]);
        expect(deps.postCommitted).toHaveBeenCalledTimes(1);
    });

    it("stages and commits both sides of a checked rename", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        vi.mocked(gitOps.getStatus).mockResolvedValueOnce([
            {
                path: "src/renamed.ts",
                sourcePath: "src/original.ts",
                status: "R",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ]);

        await commitSelectedFromPanel(deps, {
            message: "feat: rename",
            amend: false,
            push: false,
            paths: ["src/renamed.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/renamed.ts", "src/original.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: rename", false, [
            "src/renamed.ts",
            "src/original.ts",
        ]);
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

    it("confirms, applies, stages, refreshes, notifies, and completes one stash file", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce("Apply Change");

        await executeStashMutationRequest(
            deps,
            {
                action: "cherryPickFile",
                index: 2,
                stashHash: "a".repeat(40),
                path: "src/a.ts",
            },
            "request-file-success",
            postCompleted,
        );

        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Apply the change from Stash {2} for src/a.ts to your working tree and stage it?",
            { modal: true },
            "Apply Change",
        );
        expect(gitOps.applyStashFile).toHaveBeenCalledWith(2, "a".repeat(40), "src/a.ts");
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Applied selected change from Stash {2} for src/a.ts.",
        );
        expect(deps.refreshData).toHaveBeenCalledOnce();
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledOnce();
        expect(postCompleted).toHaveBeenCalledWith("request-file-success");
    });

    it("completes a cancelled stash-file request without mutating the repository", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce(undefined);

        await executeStashMutationRequest(
            deps,
            {
                action: "cherryPickFile",
                index: 2,
                stashHash: "b".repeat(40),
                path: "src/a.ts",
            },
            "request-file-cancel",
            postCompleted,
        );

        expect(gitOps.applyStashFile).not.toHaveBeenCalled();
        expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        expect(postCompleted).toHaveBeenCalledWith("request-file-cancel");
    });

    it("completes stash-file failures without false success or mutation signals", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce("Apply Change");
        vi.mocked(gitOps.applyStashFile).mockRejectedValueOnce(new Error("patch failed"));

        await expect(
            executeStashMutationRequest(
                deps,
                {
                    action: "cherryPickFile",
                    index: 2,
                    stashHash: "c".repeat(40),
                    path: "src/a.ts",
                },
                "request-file-error",
                postCompleted,
            ),
        ).rejects.toThrow("patch failed");

        expect(deps.refreshData).toHaveBeenCalledOnce();
        expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(postCompleted).toHaveBeenCalledWith("request-file-error");
    });

    it("opens the conflict session and signals state after a stash-file apply conflict", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const postCompleted = vi.fn();
        vi.mocked(vscodeMock.window.showWarningMessage).mockResolvedValueOnce("Apply Change");
        vi.mocked(gitOps.applyStashFile).mockRejectedValueOnce(new Error("patch conflicted"));
        vi.mocked(gitOps.getConflictFilesDetailed).mockResolvedValueOnce([
            { path: "src/a.ts", code: "UU", ours: "Modified", theirs: "Modified" },
        ]);

        await executeStashMutationRequest(
            deps,
            {
                action: "cherryPickFile",
                index: 2,
                stashHash: "d".repeat(40),
                path: "src/a.ts",
            },
            "request-file-conflict",
            postCompleted,
        );

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "intelligit.openConflictSession",
        );
        expect(deps.refreshData).toHaveBeenCalledOnce();
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledOnce();
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(postCompleted).toHaveBeenCalledWith("request-file-conflict");
    });
});
