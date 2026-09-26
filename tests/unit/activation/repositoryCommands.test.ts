import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const branchHandlers = new Map<string, ReturnType<typeof vi.fn>>();
    class FakeUri {
        readonly scheme = "file";
        constructor(readonly fsPath: string) {}
        static file(fsPath: string): FakeUri {
            return new FakeUri(fsPath);
        }
        static parse(value: string): { parsed: string } {
            return { parsed: value };
        }
    }
    return {
        addFileToVcsFromContext: vi.fn(),
        branchHandlers,
        commands,
        FakeUri,
        annotateWithGitBlame: vi.fn(async () => undefined),
        commitFileFromContext: vi.fn(),
        commitSelectedFromPanel: vi.fn(async (_deps: unknown, _options: unknown) => undefined),
        compareFileWithBranchOrTag: vi.fn(async () => undefined),
        compareFileWithRevision: vi.fn(async () => undefined),
        fetchFile: vi.fn(async () => "/repo" as string | undefined),
        pullFileRepositoryFromContext: vi.fn(),
        pushFileRepositoryFromContext: vi.fn(),
        rollbackFile: vi.fn(async () => undefined),
        showCurrentRevision: vi.fn(async () => undefined),
        showFileDiff: vi.fn(async () => undefined),
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        executeCommand: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        openExternal: vi.fn(),
        l10nT: vi.fn(),
        runPublishBranchFlow: vi.fn(),
        createBranchCommands: vi.fn(() => []),
        discoverGitRepositories: vi.fn(async () => []),
        runGitOperationFromPanel: vi.fn(async () => undefined),
    };
});

vi.mock("vscode", () => ({
    commands: {
        registerCommand: mocks.registerCommand,
        executeCommand: mocks.executeCommand,
    },
    l10n: {
        t: (message: string) => mocks.l10nT(message),
    },
    window: {
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
        showQuickPick: mocks.showQuickPick,
        showWarningMessage: mocks.showWarningMessage,
        withProgress: vi.fn(async (_options, task) => task()),
    },
    env: {
        openExternal: mocks.openExternal,
    },
    Uri: mocks.FakeUri,
}));

vi.mock("../../../src/commands/fileContextCommands", () => ({
    addFileToVcsFromContext: mocks.addFileToVcsFromContext,
    annotateWithGitBlame: mocks.annotateWithGitBlame,
    commitFileFromContext: mocks.commitFileFromContext,
    compareFileWithBranchOrTag: mocks.compareFileWithBranchOrTag,
    compareFileWithRevision: mocks.compareFileWithRevision,
    fetchFile: mocks.fetchFile,
    pullFileRepositoryFromContext: mocks.pullFileRepositoryFromContext,
    pushFileRepositoryFromContext: mocks.pushFileRepositoryFromContext,
    rollbackFile: mocks.rollbackFile,
    showCurrentRevision: mocks.showCurrentRevision,
    showFileDiff: mocks.showFileDiff,
}));

vi.mock("../../../src/views/commitPanelActions", () => ({
    commitSelectedFromPanel: mocks.commitSelectedFromPanel,
    runGitOperationFromPanel: mocks.runGitOperationFromPanel,
}));

vi.mock("../../../src/commands/branchCommands", () => ({
    createBranchCommands: mocks.createBranchCommands,
}));

vi.mock("../../../src/services/publishService", () => ({
    runPublishBranchFlow: mocks.runPublishBranchFlow,
}));

vi.mock("../../../src/services/repositoryDiscovery", () => ({
    discoverGitRepositories: mocks.discoverGitRepositories,
}));

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(async (_title: string, task: () => Promise<void>) => task()),
    showTimedInformationMessage: vi.fn((message: string) => {
        mocks.showInformationMessage(message);
    }),
    showTimedWarningMessage: vi.fn((message: string) => {
        mocks.showWarningMessage(message);
    }),
}));

import { registerRepositoryCommands } from "../../../src/activation/repositoryCommands";
import { BRANCH_COMMAND_FENCE_DECISIONS } from "../../../src/commands/operationFence";
import type { GitOps } from "../../../src/git/operations";
import type { Branch } from "../../../src/types";

// Derived from the production decision map rather than restated: a branch command added later lands
// in whichever matrix its own declared decision puts it in, instead of quietly in neither. The
// partition itself is pinned against literals in the exhaustiveness test below, so a flipped
// decision still has to be declared.
const BRANCH_COMMAND_IDS = Object.keys(BRANCH_COMMAND_FENCE_DECISIONS);
const FENCED_BRANCH_COMMAND_IDS = BRANCH_COMMAND_IDS.filter(
    (id) => BRANCH_COMMAND_FENCE_DECISIONS[id],
);
const UNFENCED_BRANCH_COMMAND_IDS = BRANCH_COMMAND_IDS.filter(
    (id) => !BRANCH_COMMAND_FENCE_DECISIONS[id],
);

const makeGitOps = (): GitOps =>
    ({
        hasAnyCommits: vi.fn(async () => true),
        hasUncommittedChanges: vi.fn(async () => true),
        getStatus: vi.fn(async () => []),
        rollbackFiles: vi.fn(async () => undefined),
    }) as unknown as GitOps;

const makeDeps = (gitOps: GitOps) => {
    const currentBranch: Branch = {
        name: "feature/publish",
        hash: "abc1234",
        isCurrent: true,
        isRemote: false,
        upstream: undefined,
        ahead: 0,
        behind: 0,
    };

    return {
        context: { secrets: {}, subscriptions: [] },
        executor: {},
        gitOps,
        worktreeService: {},
        getRepoRoot: () => "/repo",
        setRepositories: vi.fn(),
        getCurrentBranches: () => [currentBranch],
        commitGraphFilterByBranch: vi.fn(),
        getCurrentBranchName: () => currentBranch.name,
        setActiveRepository: vi.fn(),
        clearSelection: vi.fn(),
        refreshActiveRepository: vi.fn(),
        refreshService: vi.fn(() => ({ refreshCommitPanels: vi.fn(async () => undefined) })),
        isKnownRepositoryRoot: (repositoryRoot: string) => repositoryRoot === "/repo",
        showUndockedGitLog: vi.fn(),
        pickUndockTargetAndOpen: vi.fn(),
        dockIntelliGit: vi.fn(),
        openMergeConflictForFile: vi.fn(),
        openConflictSession: vi.fn(),
        openVsCodeMergeEditorForFile: vi.fn(),
    } as Parameters<typeof registerRepositoryCommands>[0];
};

describe("registerRepositoryCommands", () => {
    beforeEach(() => {
        mocks.branchHandlers.clear();
        mocks.commands.clear();
        vi.clearAllMocks();
        mocks.l10nT.mockImplementation((message: string) => `xx:${message}`);
        mocks.commitFileFromContext.mockImplementation(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runCommit: (
                    gitOps: unknown,
                    root: string,
                    path: string,
                    message: string,
                ) => Promise<void>,
            ) => runCommit({ scope: "selected" }, "/repo", "selected.ts", "message"),
        );
        mocks.pullFileRepositoryFromContext.mockImplementation(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runPull: (gitOps: unknown, repoRoot: string) => Promise<void>,
            ) => runPull({ scope: "selected" }, "/repo"),
        );
        mocks.pushFileRepositoryFromContext.mockImplementation(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runPush: (gitOps: unknown, repoRoot: string) => Promise<void>,
            ) => runPush({ scope: "selected" }, "/repo"),
        );
        mocks.createBranchCommands.mockImplementation(() =>
            BRANCH_COMMAND_IDS.map((id) => {
                const handler = vi.fn();
                mocks.branchHandlers.set(id, handler);
                return { id, handler };
            }),
        );
    });

    it("registers Commit File with the selected-file action and an active-operation policy", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        registerRepositoryCommands(deps);
        const handler = mocks.commands.get("intelligit.fileCommit");
        expect(handler).toBeTypeOf("function");
        const ctx = { clicked: "file" };
        await handler?.(ctx);
        expect(mocks.commitFileFromContext).toHaveBeenCalledWith(ctx, gitOps, expect.any(Function));
        expect(mocks.commitSelectedFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: { scope: "selected" } }),
            {
                message: "message",
                paths: ["selected.ts"],
                amend: false,
                push: false,
                rejectActiveOperation: true,
            },
        );
        const action = mocks.commitSelectedFromPanel.mock.calls[0][0] as unknown as {
            postCommitted: () => unknown;
            refreshData: () => Promise<void>;
        };
        expect(action.postCommitted()).toBeUndefined();
        expect(deps.clearSelection).not.toHaveBeenCalled();
    });

    it.each(["/repo", "/other-repo"])(
        "refreshes Commit File panels and only its matching graph (%s)",
        async (selectedRoot) => {
            const deps = makeDeps(makeGitOps());
            const refreshCommitPanels = vi.fn(async () => undefined);
            vi.mocked(deps.refreshService).mockReturnValue({ refreshCommitPanels } as never);
            mocks.commitFileFromContext.mockImplementationOnce(async (_ctx, _gitOps, runCommit) =>
                runCommit({ scope: "selected" }, selectedRoot, "selected.ts", "message"),
            );
            registerRepositoryCommands(deps);
            expect(mocks.commands.get("intelligit.fileCommit")).toBeTypeOf("function");
            await mocks.commands.get("intelligit.fileCommit")?.({ clicked: "file" });
            const action = mocks.commitSelectedFromPanel.mock.calls[0][0] as unknown as {
                refreshData: () => Promise<void>;
            };
            await action.refreshData();
            expect(refreshCommitPanels).toHaveBeenCalledTimes(1);
            expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(
                selectedRoot === "/repo" ? 1 : 0,
            );
        },
    );

    it("reports post-commit refresh failure without rejecting the successful commit callback", async () => {
        const deps = makeDeps(makeGitOps());
        vi.mocked(deps.refreshActiveRepository).mockRejectedValueOnce(new Error("refresh refused"));
        registerRepositoryCommands(deps);
        expect(mocks.commands.get("intelligit.fileCommit")).toBeTypeOf("function");
        await mocks.commands.get("intelligit.fileCommit")?.({ clicked: "file" });
        const action = mocks.commitSelectedFromPanel.mock.calls[0][0] as unknown as {
            refreshData: () => Promise<void>;
        };
        await expect(action.refreshData()).resolves.toBeUndefined();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Commit succeeded, but refresh failed: {message}",
        );
    });

    it("makes branch fence decisions exhaustive for the registered command factory", async () => {
        const { createBranchCommands } = await vi.importActual<
            typeof import("../../../src/commands/branchCommands")
        >("../../../src/commands/branchCommands");
        const registeredIds = createBranchCommands({
            executor: {} as never,
            gitOps: {} as never,
            getCurrentBranchName: () => undefined,
            getCurrentBranches: () => [],
            createWorktree: async () => undefined,
            openConflictSession: async () => undefined,
            refreshConflictUi: async () => undefined,
        })
            .map((command) => command.id)
            .sort();

        expect(Object.keys(BRANCH_COMMAND_FENCE_DECISIONS).sort()).toEqual(registeredIds);

        // The key set alone would accept a command silently flipped to unfenced, and the matrices
        // below are derived from this map — so without this pin a wrong decision would simply move
        // the command into the other passing matrix.
        expect(FENCED_BRANCH_COMMAND_IDS).toEqual([
            "intelligit.checkout",
            "intelligit.checkoutAndRebase",
            "intelligit.rebaseCurrentOnto",
            "intelligit.mergeIntoCurrent",
            "intelligit.updateBranch",
            "intelligit.renameBranch",
            "intelligit.deleteBranch",
            "intelligit.deleteBranches",
        ]);
        expect(UNFENCED_BRANCH_COMMAND_IDS).toEqual([
            "intelligit.openWorktree",
            "intelligit.createWorktreeFromBranch",
            "intelligit.worktree.create",
            "intelligit.newBranchFrom",
            "intelligit.pushBranch",
        ]);
    });

    it.each(FENCED_BRANCH_COMMAND_IDS)("refuses %s while a rebase is active", async (commandId) => {
        const gitOps = makeGitOps();
        gitOps.getActiveOperation = vi.fn(async () => "rebase");
        registerRepositoryCommands(makeDeps(gitOps));

        await mocks.commands.get(commandId)?.({ branch: { name: "feature/fenced" } });

        expect(mocks.branchHandlers.get(commandId)).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
        // Naming the blocking operation is the user-visible contract, not merely refusing.
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:A rebase is in progress — continue or abort it first.",
        );
    });

    it.each(UNFENCED_BRANCH_COMMAND_IDS)(
        "keeps %s available while a rebase is active",
        async (commandId) => {
            const gitOps = makeGitOps();
            gitOps.getActiveOperation = vi.fn(async () => "rebase");
            registerRepositoryCommands(makeDeps(gitOps));

            const item = { branch: { name: "feature/available" } };
            await mocks.commands.get(commandId)?.(item);

            expect(mocks.branchHandlers.get(commandId)).toHaveBeenCalledWith(item);
            expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        },
    );

    it.each(BRANCH_COMMAND_IDS)("runs %s when no operation is active", async (commandId) => {
        const gitOps = makeGitOps();
        gitOps.getActiveOperation = vi.fn(async () => "none");
        registerRepositoryCommands(makeDeps(gitOps));

        const item = { branch: { name: "feature/clear" } };
        await mocks.commands.get(commandId)?.(item);

        expect(mocks.branchHandlers.get(commandId)).toHaveBeenCalledWith(item);
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("fails closed for an unclassified branch command", async () => {
        const commandId = "intelligit.futureBranchMutation";
        const handler = vi.fn();
        const gitOps = makeGitOps();
        gitOps.getActiveOperation = vi.fn(async () => "rebase");
        mocks.createBranchCommands.mockReturnValueOnce([{ id: commandId, handler }]);
        registerRepositoryCommands(makeDeps(gitOps));

        await mocks.commands.get(commandId)?.({ branch: { name: "feature/future" } });

        expect(handler).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("preserves the validated item payload for a fenced dispatch when nothing blocks", async () => {
        const gitOps = makeGitOps();
        gitOps.getActiveOperation = vi.fn(async () => "none");
        registerRepositoryCommands(makeDeps(gitOps));

        const item = { branch: { name: "feature/payload" } };
        await mocks.commands.get("intelligit.checkout")?.(item);

        expect(mocks.branchHandlers.get("intelligit.checkout")).toHaveBeenCalledWith(item);
    });

    it("publishes the current branch even when the working tree is dirty", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.publishBranch")?.();

        expect(gitOps.hasAnyCommits).toHaveBeenCalledTimes(1);
        expect(gitOps.hasUncommittedChanges).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(mocks.runPublishBranchFlow).toHaveBeenCalledWith(
            gitOps,
            "feature/publish",
            "/repo",
            deps.context.secrets,
        );
    });

    it("routes conflict open commands to IntelliGit and VS Code merge editors", async () => {
        const deps = makeDeps(makeGitOps());
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.openMergeConflict")?.({
            filePath: "src/conflicted.ts",
        });
        await mocks.commands.get("intelligit.openMergeConflictInVsCode")?.({
            filePath: "src/conflicted.ts",
        });

        expect(deps.openMergeConflictForFile).toHaveBeenCalledWith("src/conflicted.ts");
        expect(deps.openVsCodeMergeEditorForFile).toHaveBeenCalledWith("src/conflicted.ts");
    });

    it("registers Compare with Revision through the file-context wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.compareWithRevision")?.(context);

        expect(mocks.compareFileWithRevision).toHaveBeenCalledWith(context, gitOps);
    });

    it("registers Compare with Branch or Tag through the selected-file repository wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.compareWithBranch")?.(context);

        expect(mocks.compareFileWithBranchOrTag).toHaveBeenCalledWith(context, gitOps);
    });

    it("registers Show Diff through the file-context wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.showFileDiff")?.(context);

        expect(mocks.showFileDiff).toHaveBeenCalledWith(context, gitOps);
    });

    it("registers Show Current Revision through the file-context wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.showCurrentRevision")?.(context);

        expect(mocks.showCurrentRevision).toHaveBeenCalledWith(context, gitOps);
    });

    it("registers Annotate with Git Blame through the file-context wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.annotateWithGitBlame")?.(context);

        expect(mocks.annotateWithGitBlame).toHaveBeenCalledWith(context, gitOps);
    });

    it("refreshes active-repository data after fetching the active file repository", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const context = { clicked: "file" };
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.fileFetch")?.(context);

        expect(mocks.fetchFile).toHaveBeenCalledWith(context, gitOps);
        expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(1);
    });

    it("refreshes when Windows drive case and separators spell the same repository root", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.getRepoRoot = () => "c:\\work\\repo";
        mocks.fetchFile.mockResolvedValueOnce("C:/Work/Repo/");
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.fileFetch")?.({ clicked: "file" });

        expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(1);
    });

    it("does not collapse POSIX repository roots that differ only by case", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.getRepoRoot = () => "/repo";
        mocks.fetchFile.mockResolvedValueOnce("/Repo");
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.fileFetch")?.({ clicked: "file" });

        expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
    });

    it("does not refresh active or commit-panel data after fetching a non-active repository", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const refreshCommitPanels = vi.fn(async () => undefined);
        deps.refreshService = vi.fn(
            () => ({ refreshCommitPanels }) as ReturnType<typeof deps.refreshService>,
        );
        mocks.fetchFile.mockResolvedValueOnce("/repo-b");
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.fileFetch")?.({ clicked: "file" });

        expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
        expect(refreshCommitPanels).not.toHaveBeenCalled();
    });

    it("runs file Pull through the shared pull flow with the selected repository GitOps", async () => {
        const gitOps = makeGitOps();
        const scopedGitOps = { scope: "selected" };
        const context = { clicked: "file" };
        mocks.pullFileRepositoryFromContext.mockImplementationOnce(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runPull: (selectedGitOps: unknown, repoRoot: string) => Promise<void>,
            ) => runPull(scopedGitOps, "/repo-b"),
        );
        registerRepositoryCommands(makeDeps(gitOps));

        await mocks.commands.get("intelligit.filePull")?.(context);

        expect(mocks.pullFileRepositoryFromContext).toHaveBeenCalledWith(
            context,
            gitOps,
            expect.any(Function),
        );
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: scopedGitOps }),
            "pull",
        );
    });

    it.each([
        { selectedRoot: "/repo", activeRoot: "/repo", shouldRefresh: true },
        { selectedRoot: "C:/Work/Repo/", activeRoot: "c:\\work\\repo", shouldRefresh: true },
        { selectedRoot: "/Repo", activeRoot: "/repo", shouldRefresh: false },
    ])(
        "refreshes only the matching active root after file Pull: $selectedRoot",
        async ({ selectedRoot, activeRoot, shouldRefresh }) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            deps.getRepoRoot = () => activeRoot;
            mocks.pullFileRepositoryFromContext.mockImplementationOnce(
                async (
                    _ctx: unknown,
                    _gitOps: unknown,
                    runPull: (selectedGitOps: unknown, repoRoot: string) => Promise<void>,
                ) => runPull({ scope: "selected" }, selectedRoot),
            );
            mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
                await (actionDeps as { refreshData: () => Promise<void> }).refreshData();
            });
            registerRepositoryCommands(deps);

            await mocks.commands.get("intelligit.filePull")?.({ clicked: "file" });

            expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
        },
    );

    it("contains active-graph refresh rejection after Pull succeeds", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const refreshError = new Error("graph unavailable");
        deps.refreshActiveRepository = vi.fn(async () => {
            throw refreshError;
        });
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            await (actionDeps as { refreshData: () => Promise<void> }).refreshData();
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        registerRepositoryCommands(deps);

        try {
            await expect(
                mocks.commands.get("intelligit.filePull")?.({ clicked: "file" }),
            ).resolves.toBeUndefined();
            expect(consoleError).toHaveBeenCalledWith(
                "Failed to refresh after file Pull:",
                refreshError,
            );
        } finally {
            consoleError.mockRestore();
        }

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Pull succeeded, but refresh failed: {message}",
        );
    });

    it("runs file Push through the shared default non-force flow with selected repository GitOps", async () => {
        const gitOps = makeGitOps();
        const scopedGitOps = { scope: "selected" };
        const context = { clicked: "file" };
        mocks.pushFileRepositoryFromContext.mockImplementationOnce(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runPush: (selectedGitOps: unknown, repoRoot: string) => Promise<void>,
            ) => runPush(scopedGitOps, "/repo-b"),
        );
        registerRepositoryCommands(makeDeps(gitOps));

        await mocks.commands.get("intelligit.filePush")?.(context);

        expect(mocks.pushFileRepositoryFromContext).toHaveBeenCalledWith(
            context,
            gitOps,
            expect.any(Function),
        );
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: scopedGitOps }),
            "push",
        );
    });

    it.each([
        { selectedRoot: "/repo", activeRoot: "/repo", shouldRefresh: true },
        { selectedRoot: "C:/Work/Repo/", activeRoot: "c:\\work\\repo", shouldRefresh: true },
        { selectedRoot: "/Repo", activeRoot: "/repo", shouldRefresh: false },
    ])(
        "refreshes only the matching active root after file Push: $selectedRoot",
        async ({ selectedRoot, activeRoot, shouldRefresh }) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            deps.getRepoRoot = () => activeRoot;
            mocks.pushFileRepositoryFromContext.mockImplementationOnce(
                async (
                    _ctx: unknown,
                    _gitOps: unknown,
                    runPush: (selectedGitOps: unknown, repoRoot: string) => Promise<void>,
                ) => runPush({ scope: "selected" }, selectedRoot),
            );
            mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
                await (actionDeps as { refreshData: () => Promise<void> }).refreshData();
            });
            registerRepositoryCommands(deps);

            await mocks.commands.get("intelligit.filePush")?.({ clicked: "file" });

            expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
        },
    );

    it("contains active-graph refresh rejection after file Push without claiming success", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const refreshError = new Error("graph unavailable");
        deps.refreshActiveRepository = vi.fn(async () => {
            throw refreshError;
        });
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            await (actionDeps as { refreshData: () => Promise<void> }).refreshData();
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        registerRepositoryCommands(deps);

        try {
            await expect(
                mocks.commands.get("intelligit.filePush")?.({ clicked: "file" }),
            ).resolves.toBeUndefined();
            expect(consoleError).toHaveBeenCalledWith(
                "Failed to refresh after file Push:",
                refreshError,
            );
        } finally {
            consoleError.mockRestore();
        }

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Could not refresh after Push: {message}",
        );
    });

    it("publishes an unpublished selected repository through its scoped branch, root, and secrets", async () => {
        const gitOps = makeGitOps();
        const selectedBranch: Branch = {
            name: "selected/topic",
            hash: "selected123",
            isCurrent: true,
            isRemote: false,
            upstream: undefined,
            ahead: 0,
            behind: 0,
        };
        const scopedGitOps = {
            scope: "selected",
            hasAnyCommits: vi.fn(async () => true),
            getBranches: vi.fn(async () => [selectedBranch]),
        };
        mocks.pushFileRepositoryFromContext.mockImplementationOnce(
            async (
                _ctx: unknown,
                _gitOps: unknown,
                runPush: (selectedGitOps: unknown, repoRoot: string) => Promise<void>,
            ) => runPush(scopedGitOps, "/repo-b"),
        );
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            await (actionDeps as { publishBranch: () => Promise<void> }).publishBranch();
        });
        const deps = makeDeps(gitOps);
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.filePush")?.({ clicked: "file" });

        expect(scopedGitOps.hasAnyCommits).toHaveBeenCalledTimes(1);
        expect(scopedGitOps.getBranches).toHaveBeenCalledTimes(1);
        expect(mocks.runPublishBranchFlow).toHaveBeenCalledWith(
            scopedGitOps,
            "selected/topic",
            "/repo-b",
            deps.context.secrets,
        );
        expect(mocks.executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
    });

    it("keeps refresh wording neutral when scoped publish returns without a success signal", async () => {
        const scopedGitOps = {
            hasAnyCommits: vi.fn(async () => true),
            getBranches: vi.fn(async () => [
                {
                    name: "selected/topic",
                    isCurrent: true,
                },
            ]),
        };
        mocks.pushFileRepositoryFromContext.mockImplementationOnce(async (_ctx, _gitOps, runPush) =>
            runPush(scopedGitOps, "/repo"),
        );
        mocks.runPublishBranchFlow.mockResolvedValueOnce(undefined);
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            const actions = actionDeps as {
                publishBranch: () => Promise<void>;
                refreshData: () => Promise<void>;
            };
            await actions.publishBranch();
            await actions.refreshData();
        });
        const deps = makeDeps(makeGitOps());
        deps.refreshActiveRepository = vi.fn(async () => {
            throw new Error("graph unavailable");
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        registerRepositoryCommands(deps);

        try {
            await expect(
                mocks.commands.get("intelligit.filePush")?.({ clicked: "file" }),
            ).resolves.toBeUndefined();
        } finally {
            consoleError.mockRestore();
        }

        expect(mocks.runPublishBranchFlow).toHaveBeenCalledTimes(1);
        expect(deps.refreshActiveRepository).toHaveBeenCalledTimes(1);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Could not refresh after Push: {message}",
        );
        expect(mocks.showErrorMessage).not.toHaveBeenCalledWith(
            expect.stringContaining("succeeded"),
        );
    });

    it("keeps the existing no-commit warning for selected-repository publish", async () => {
        const scopedGitOps = {
            hasAnyCommits: vi.fn(async () => false),
            getBranches: vi.fn(async () => []),
        };
        mocks.pushFileRepositoryFromContext.mockImplementationOnce(async (_ctx, _gitOps, runPush) =>
            runPush(scopedGitOps, "/repo-b"),
        );
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            await (actionDeps as { publishBranch: () => Promise<void> }).publishBranch();
        });
        registerRepositoryCommands(makeDeps(makeGitOps()));

        await mocks.commands.get("intelligit.filePush")?.({ clicked: "file" });

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "xx:Create a commit before publishing this branch.",
        );
        expect(scopedGitOps.getBranches).not.toHaveBeenCalled();
        expect(mocks.runPublishBranchFlow).not.toHaveBeenCalled();
    });

    it("keeps the existing no-current-branch error for selected-repository publish", async () => {
        const scopedGitOps = {
            hasAnyCommits: vi.fn(async () => true),
            getBranches: vi.fn(async () => []),
        };
        mocks.pushFileRepositoryFromContext.mockImplementationOnce(async (_ctx, _gitOps, runPush) =>
            runPush(scopedGitOps, "/repo-b"),
        );
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: unknown) => {
            await (actionDeps as { publishBranch: () => Promise<void> }).publishBranch();
        });
        registerRepositoryCommands(makeDeps(makeGitOps()));

        await mocks.commands.get("intelligit.filePush")?.({ clicked: "file" });

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("xx:No current branch found.");
        expect(mocks.runPublishBranchFlow).not.toHaveBeenCalled();
    });

    it("routes native file rollback contexts through the selected-file wrapper", async () => {
        const gitOps = makeGitOps();
        registerRepositoryCommands(makeDeps(gitOps));
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.fileRollback")?.(context);

        expect(mocks.rollbackFile).toHaveBeenCalledWith(context, gitOps);
        expect(gitOps.rollbackFiles).not.toHaveBeenCalled();
    });

    it("keeps legacy filePath rollback contexts on the commit-panel handler", async () => {
        const gitOps = makeGitOps();
        mocks.showWarningMessage.mockResolvedValueOnce("xx:Rollback");
        registerRepositoryCommands(makeDeps(gitOps));

        await mocks.commands.get("intelligit.fileRollback")?.({ filePath: "src/a.ts" });

        expect(mocks.rollbackFile).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "xx:Rollback {path}?",
            { modal: true },
            "xx:Rollback",
        );
        expect(gitOps.rollbackFiles).toHaveBeenCalledWith(["src/a.ts"]);
    });

    describe("intelligit.fileAddToVcs", () => {
        const command = (): ((context: unknown) => Promise<void>) => {
            const handler = mocks.commands.get("intelligit.fileAddToVcs");
            expect(handler).toBeTypeOf("function");
            return handler as (context: unknown) => Promise<void>;
        };

        it("tracks current unversioned files with GitOps derived for the exact known non-active root", async () => {
            const activeGitOps = makeGitOps();
            const selectedGitOps = makeGitOps();
            selectedGitOps.getStatus = vi.fn(async () => [
                { path: "first.ts", status: "?" },
                { path: "second.ts", status: "?" },
            ]);
            selectedGitOps.intentToAddFiles = vi.fn(async () => undefined);
            activeGitOps.deriveFor = vi.fn(() => selectedGitOps);
            const refreshCommitPanels = vi.fn(async () => undefined);
            const deps = makeDeps(activeGitOps);
            deps.refreshService = vi.fn(
                () => ({ refreshCommitPanels }) as ReturnType<typeof deps.refreshService>,
            );
            (
                deps as typeof deps & { isKnownRepositoryRoot: (repositoryRoot: string) => boolean }
            ).isKnownRepositoryRoot = (repositoryRoot) => repositoryRoot === "/repo/selected";
            registerRepositoryCommands(deps);

            await command()({
                repositoryRoot: "/repo/selected",
                filePaths: ["first.ts", "second.ts"],
            });

            expect(activeGitOps.deriveFor).toHaveBeenCalledWith("/repo/selected");
            expect(activeGitOps.getStatus).not.toHaveBeenCalled();
            expect(selectedGitOps.getStatus).toHaveBeenCalledTimes(1);
            expect(selectedGitOps.intentToAddFiles).toHaveBeenCalledWith(["first.ts", "second.ts"]);
            expect(refreshCommitPanels).toHaveBeenCalledTimes(1);
        });

        it("routes a native URI through the file wrapper and reports refresh failure after Git succeeds", async () => {
            const gitOps = makeGitOps();
            const selectedGitOps = makeGitOps();
            selectedGitOps.getStatus = vi.fn(async () => [{ path: "selected.ts", status: "?" }]);
            selectedGitOps.intentToAddFiles = vi.fn(async () => undefined);
            const refreshCommitPanels = vi.fn(async () => {
                throw new Error("refresh unavailable");
            });
            const deps = makeDeps(gitOps);
            deps.refreshService = vi.fn(
                () => ({ refreshCommitPanels }) as ReturnType<typeof deps.refreshService>,
            );
            mocks.addFileToVcsFromContext.mockImplementationOnce(async (_ctx, _gitOps, runAdd) =>
                runAdd(selectedGitOps, "/repo/not-known", "selected.ts"),
            );
            registerRepositoryCommands(deps);
            const context = new mocks.FakeUri("/repo/not-known/selected.ts");

            await command()(context);

            expect(mocks.addFileToVcsFromContext).toHaveBeenCalledWith(
                context,
                gitOps,
                expect.any(Function),
            );
            expect(selectedGitOps.intentToAddFiles).toHaveBeenCalledWith(["selected.ts"]);
            expect(refreshCommitPanels).toHaveBeenCalledOnce();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "xx:Added to VCS, but refresh failed: {message}",
            );
        });

        it.each([
            { repositoryRoot: "/repo/unknown", filePaths: ["new.ts"] },
            { repositoryRoot: "/repo/selected", filePaths: ["../escape.ts"] },
            { repositoryRoot: "/repo/selected", filePaths: "new.ts" },
        ])("fails closed without Git or refresh side effects for %o", async (context) => {
            const gitOps = makeGitOps();
            gitOps.deriveFor = vi.fn();
            const refreshCommitPanels = vi.fn(async () => undefined);
            const deps = makeDeps(gitOps);
            deps.refreshService = vi.fn(
                () => ({ refreshCommitPanels }) as ReturnType<typeof deps.refreshService>,
            );
            (
                deps as typeof deps & { isKnownRepositoryRoot: (repositoryRoot: string) => boolean }
            ).isKnownRepositoryRoot = (repositoryRoot) => repositoryRoot === "/repo/selected";
            registerRepositoryCommands(deps);

            await command()(context);

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(gitOps.getStatus).not.toHaveBeenCalled();
            expect(refreshCommitPanels).not.toHaveBeenCalled();
        });
    });

    describe("intelligit.openRepository", () => {
        /**
         * `gitOps` answers for the active repository and `deriveFor(root)` answers for any
         * other one. The two return distinct remotes so an assertion on the opened URL alone
         * names which repository was actually read — asserting that `deriveFor` was called
         * would pass even if the handler then read the active ops anyway.
         */
        const makeMultiRepoGitOps = (): GitOps => {
            const scoped = {
                getRemotes: vi.fn(async () => ["origin"]),
                getRemoteUrl: vi.fn(async () => "git@github.com:acme/selected.git"),
            };
            return {
                getRemotes: vi.fn(async () => ["origin"]),
                getRemoteUrl: vi.fn(async () => "git@github.com:acme/active.git"),
                deriveFor: vi.fn(() => scoped),
            } as unknown as GitOps;
        };

        it.each(["intelligit.openRepository", "intelligit.openRepository.color"])(
            "%s opens the remote of the repository root the panel passed, not the active one",
            async (commandId) => {
                const gitOps = makeMultiRepoGitOps();
                registerRepositoryCommands(makeDeps(gitOps));

                await mocks.commands.get(commandId)?.("/repo/selected");

                expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo/selected");
                expect(mocks.openExternal).toHaveBeenCalledWith({
                    parsed: "https://github.com/acme/selected",
                });
                expect(gitOps.getRemoteUrl).not.toHaveBeenCalled();
            },
        );

        it("falls back to the active repository when no root travels with the command", async () => {
            const gitOps = makeMultiRepoGitOps();
            registerRepositoryCommands(makeDeps(gitOps));

            await mocks.commands.get("intelligit.openRepository")?.();

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.openExternal).toHaveBeenCalledWith({
                parsed: "https://github.com/acme/active",
            });
        });

        // A `view/title` button invokes the same id with the view's context object. Handing
        // that object to `deriveFor` would run Git against a root spelled "[object Object]".
        it("ignores a non-string argument from the view/title menu", async () => {
            const gitOps = makeMultiRepoGitOps();
            registerRepositoryCommands(makeDeps(gitOps));

            await mocks.commands.get("intelligit.openRepository")?.({ groupId: "navigation@5" });

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.openExternal).toHaveBeenCalledWith({
                parsed: "https://github.com/acme/active",
            });
        });
    });
});
