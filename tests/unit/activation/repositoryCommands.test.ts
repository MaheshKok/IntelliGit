import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/updateStrategy", () => ({
    readPullUpdateStrategy: vi.fn(async () => "rebase"),
}));

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
        branchesFileFromContext: vi.fn(),
        newBranchFileFromContext: vi.fn(),
        newTagFileFromContext: vi.fn(),
        resetHeadFileFromContext: vi.fn(),
        stashChangesFromContext: vi.fn(),
        unstashChangesFromContext: vi.fn(),
        commitFileFromContext: vi.fn(),
        resolveFileCommandContext: vi.fn(),
        commitSelectedFromPanel: vi.fn(async (_deps: unknown, _options: unknown) => undefined),
        compareFileWithBranchOrTag: vi.fn(async () => undefined),
        compareFileWithRevision: vi.fn(async () => undefined),
        compareCommitInfoFileWithLocal: vi.fn(async () => undefined),
        applySelectedCommitFileChange: vi.fn(async () => undefined),
        fetchFile: vi.fn(async () => "/repo" as string | undefined),
        mergeFileFromContext: vi.fn(),
        rebaseFileFromContext: vi.fn(),
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
        showInputBox: vi.fn(),
        showOpenDialog: vi.fn(),
        showWarningMessage: vi.fn(),
        openExternal: vi.fn(),
        l10nT: vi.fn(),
        runPublishBranchFlow: vi.fn(),
        runCloneFlow: vi.fn(),
        runGitHubCloneFlow: vi.fn(),
        createBranchCommands: vi.fn((_deps: unknown) => []),
        listWorktrees: vi.fn(async () => []),
        worktreeInstances: [] as Array<{
            root: () => string;
            lockWorktree: ReturnType<typeof vi.fn>;
            unlockWorktree: ReturnType<typeof vi.fn>;
            removeWorktree: ReturnType<typeof vi.fn>;
            moveWorktree: ReturnType<typeof vi.fn>;
            pruneWorktrees: ReturnType<typeof vi.fn>;
            repairWorktrees: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }>,
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
        t: (message: string, values?: Record<string, string>) =>
            values ? mocks.l10nT(message, values) : mocks.l10nT(message),
    },
    window: {
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
        showOpenDialog: mocks.showOpenDialog,
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
    branchesFileFromContext: mocks.branchesFileFromContext,
    newBranchFileFromContext: mocks.newBranchFileFromContext,
    newTagFileFromContext: mocks.newTagFileFromContext,
    resetHeadFileFromContext: mocks.resetHeadFileFromContext,
    stashChangesFromContext: mocks.stashChangesFromContext,
    unstashChangesFromContext: mocks.unstashChangesFromContext,
    commitFileFromContext: mocks.commitFileFromContext,
    resolveFileCommandContext: mocks.resolveFileCommandContext,
    compareFileWithBranchOrTag: mocks.compareFileWithBranchOrTag,
    compareFileWithRevision: mocks.compareFileWithRevision,
    fetchFile: mocks.fetchFile,
    mergeFileFromContext: mocks.mergeFileFromContext,
    rebaseFileFromContext: mocks.rebaseFileFromContext,
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

vi.mock("../../../src/services/diffService", () => ({
    compareCommitInfoFileWithLocal: mocks.compareCommitInfoFileWithLocal,
    applySelectedCommitFileChange: mocks.applySelectedCommitFileChange,
    beginEditableDiffSession: vi.fn(),
    createReadonlyDiffUri: vi.fn(),
}));

vi.mock("../../../src/commands/branchCommands", () => ({
    createBranchCommands: mocks.createBranchCommands,
}));

vi.mock("../../../src/services/worktreeService", () => ({
    WorktreeService: class {
        constructor(
            _executor: unknown,
            readonly root: () => string,
        ) {
            mocks.worktreeInstances.push(this);
        }
        listWorktrees = mocks.listWorktrees;
        decorateBranches = (branches: Branch[]) => branches;
        createWorktree = vi.fn(async () => []);
        lockWorktree = vi.fn(async () => []);
        unlockWorktree = vi.fn(async () => []);
        removeWorktree = vi.fn(async () => []);
        moveWorktree = vi.fn(async () => []);
        pruneWorktrees = vi.fn(async () => []);
        repairWorktrees = vi.fn(async () => []);
        dispose = vi.fn();
    },
}));

vi.mock("../../../src/services/publishService", () => ({
    runPublishBranchFlow: mocks.runPublishBranchFlow,
}));

vi.mock("../../../src/services/cloneService", () => ({
    runCloneFlow: mocks.runCloneFlow,
    runGitHubCloneFlow: mocks.runGitHubCloneFlow,
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

const makeGitOps = (): GitOps => {
    const gitOps = {
        hasAnyCommits: vi.fn(async () => true),
        hasUncommittedChanges: vi.fn(async () => true),
        getStatus: vi.fn(async () => []),
        getBranches: vi.fn(async () => [
            { name: "feature/publish", isCurrent: true, isRemote: false },
        ]),
        rollbackFiles: vi.fn(async () => undefined),
        deriveFor: vi.fn((_root: string) => gitOps),
    } as unknown as GitOps;
    return gitOps;
};

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
        executor: { deriveFor: vi.fn(() => ({})) },
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
        openConflictSessionForRepository: vi.fn(),
        openVsCodeMergeEditorForFile: vi.fn(),
        openPartialChanges: vi.fn().mockResolvedValue(undefined),
    } as Parameters<typeof registerRepositoryCommands>[0];
};

describe("registerRepositoryCommands", () => {
    // The resolver keeps its real contract: only a Uri (or no context) resolves; a row payload does not.
    const resolveUriOnly = (resolved: { repoRoot: string; repoRelativePath: string }) =>
        mocks.resolveFileCommandContext.mockImplementation(async (ctx: unknown) =>
            ctx instanceof mocks.FakeUri ? resolved : undefined,
        );

    it("native whole-file Save from a Changes row saves for the row's repository and path", async () => {
        const deps = makeDeps(makeGitOps());
        deps.isKnownRepositoryRoot = (root: string) => root === "/repo" || root === "/repo-b";
        const saveWholeFileToShelf = vi.fn().mockResolvedValue(undefined);
        Object.assign(deps, { saveWholeFileToShelf });
        resolveUriOnly({ repoRoot: "/repo", repoRelativePath: "active.ts" });
        registerRepositoryCommands(deps);
        const command = mocks.commands.get("intelligit.fileSaveToShelf");
        expect(command, "native whole-file Save must be registered").toBeTypeOf("function");
        await command?.({ filePath: "src/selected.ts", repositoryRoot: "/repo-b" });
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(saveWholeFileToShelf).toHaveBeenCalledExactlyOnceWith("/repo-b", "src/selected.ts");
        expect(deps.setActiveRepository).not.toHaveBeenCalled();
        expect(mocks.commands.has("intelligit.fileShelve")).toBe(true);
    });

    it("native whole-file Save from an Explorer Uri saves for the resolved repository", async () => {
        const deps = makeDeps(makeGitOps());
        const saveWholeFileToShelf = vi.fn().mockResolvedValue(undefined);
        Object.assign(deps, { saveWholeFileToShelf });
        resolveUriOnly({ repoRoot: "/repo-b", repoRelativePath: "selected.ts" });
        registerRepositoryCommands(deps);
        await mocks.commands.get("intelligit.fileSaveToShelf")?.(
            mocks.FakeUri.file("/repo-b/selected.ts"),
        );
        expect(saveWholeFileToShelf).toHaveBeenCalledExactlyOnceWith("/repo-b", "selected.ts");
    });
    describe("native partial command", () => {
        beforeEach(() => {
            mocks.l10nT.mockImplementation((message: string, values: Record<string, string> = {}) =>
                message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
            );
        });
        it("opens partial changes for the explicit file repository instead of the selected repository", async () => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            deps.getRepoRoot = () => "/repo-a";
            const uri = mocks.FakeUri.file("/repo-b/selected.ts");
            mocks.resolveFileCommandContext.mockResolvedValue({
                repoRoot: "/repo-b",
                repoRelativePath: "selected.ts",
            });
            registerRepositoryCommands(deps);
            const handler = mocks.commands.get("intelligit.openPartialChanges");
            expect(handler, "native partial command must be registered").toBeTypeOf("function");
            await handler?.(uri);
            expect(
                mocks.resolveFileCommandContext,
                "explicit file context must reach the resolver",
            ).toHaveBeenCalledWith(uri, gitOps);
            expect(deps.openPartialChanges).toHaveBeenCalledExactlyOnceWith(
                "/repo-b",
                "selected.ts",
            );
            expect(deps.setActiveRepository).not.toHaveBeenCalled();
            expect(deps.clearSelection).not.toHaveBeenCalled();
        });

        it("passes absent context unchanged for active-file resolution", async () => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            mocks.resolveFileCommandContext.mockResolvedValue({
                repoRoot: "/repo-b",
                repoRelativePath: "active.ts",
            });
            registerRepositoryCommands(deps);
            await mocks.commands.get("intelligit.openPartialChanges")?.();
            expect(mocks.resolveFileCommandContext).toHaveBeenCalledWith(undefined, gitOps);
            expect(deps.openPartialChanges).toHaveBeenCalledExactlyOnceWith("/repo-b", "active.ts");
        });

        it.each([{ scheme: "git", fsPath: "/repo-b/file.ts" }, null, { invalid: true }])(
            "does not substitute an active file for rejected explicit context %j",
            async (context) => {
                const gitOps = makeGitOps();
                const deps = makeDeps(gitOps);
                mocks.resolveFileCommandContext.mockImplementation(async (input) =>
                    input === undefined
                        ? { repoRoot: "/repo-a", repoRelativePath: "active.ts" }
                        : undefined,
                );
                registerRepositoryCommands(deps);
                await mocks.commands.get("intelligit.openPartialChanges")?.(context);
                expect(
                    mocks.resolveFileCommandContext,
                    "rejected explicit context must not become active-file fallback",
                ).toHaveBeenCalledWith(context, gitOps);
                expect(deps.openPartialChanges).not.toHaveBeenCalled();
                expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                    expect.stringContaining("only available for local files"),
                );
            },
        );

        it("reports resolution failure without opening another file", async () => {
            const deps = makeDeps(makeGitOps());
            mocks.resolveFileCommandContext.mockRejectedValue(new Error("resolution refused"));
            registerRepositoryCommands(deps);
            await mocks.commands.get("intelligit.openPartialChanges")?.();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("resolution refused"),
            );
            expect(deps.openPartialChanges).not.toHaveBeenCalled();
            expect(deps.setActiveRepository).not.toHaveBeenCalled();
        });

        it("awaits and reports provider failure", async () => {
            const deps = makeDeps(makeGitOps());
            mocks.resolveFileCommandContext.mockResolvedValue({
                repoRoot: "/repo-b",
                repoRelativePath: "file.ts",
            });
            let fail!: (error: Error) => void;
            vi.mocked(deps.openPartialChanges).mockImplementation(
                () =>
                    new Promise((_resolve, reject) => {
                        fail = reject;
                    }),
            );
            registerRepositoryCommands(deps);
            let settled = false;
            const command = Promise.resolve(
                mocks.commands.get("intelligit.openPartialChanges")?.(),
            ).then(() => {
                settled = true;
            });
            await vi.waitFor(() => expect(deps.openPartialChanges).toHaveBeenCalled());
            expect(settled, "native command must await the provider").toBe(false);
            fail(new Error("connection refused"));
            await command;
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("connection refused"),
            );
        });
    });

    it.each([
        ["conflictAcceptYours", "ours"],
        ["conflictAcceptTheirs", "theirs"],
    ] as const)("binds %s to its addressed repository", async (command, side) => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
        scoped.acceptConflictSide = vi.fn(async () => undefined);
        vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
        registerRepositoryCommands(deps);
        await mocks.commands.get(`intelligit.${command}`)?.({
            repositoryRoot: "/repo-b",
            filePath: "same.txt",
        });
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(scoped.acceptConflictSide).toHaveBeenCalledWith("same.txt", side);
    });

    it.each([
        ["commitFileCherryPickChange", "cherry-pick"],
        ["commitFileRevertChange", "revert"],
    ])("binds commit-info %s to the rendered B repository", async (command, mode) => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        const scopedExecutor = {};
        deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
        vi.mocked(deps.executor.deriveFor).mockReturnValue(scopedExecutor as never);
        registerRepositoryCommands(deps);
        const context = {
            repositoryRoot: "/repo-b",
            filePath: "same.txt",
            commitHash: "a".repeat(40),
        };
        await mocks.commands.get(`intelligit.${command}`)?.(context);
        expect(deps.executor.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.applySelectedCommitFileChange).toHaveBeenCalledWith(
            context,
            mode,
            scopedExecutor,
            expect.any(Function),
        );
    });

    it("binds commit-info comparison to B rather than the active graph", async () => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
        vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
        registerRepositoryCommands(deps);
        const context = {
            repositoryRoot: "/repo-b",
            filePath: "same.txt",
            commitHash: "a".repeat(40),
        };
        await mocks.commands.get("intelligit.commitFileCompareWithLocal")?.(context);
        expect(mocks.compareCommitInfoFileWithLocal).toHaveBeenCalledWith(
            context,
            "/repo-b",
            scoped,
        );
    });

    it.each(["checkout", "pushBranch", "renameBranch", "deleteBranch", "worktree.create"])(
        "captures legacy native %s services before the operation fence",
        async (action) => {
            const gitOps = makeGitOps();
            const scoped = makeGitOps();
            const deps = makeDeps(gitOps);
            let active = "/repo";
            deps.getRepoRoot = () => active;
            vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
            scoped.getActiveOperation = vi.fn(async () => {
                active = "/repo-b";
                return "none";
            });
            gitOps.getActiveOperation = vi.fn(async () => "none");
            registerRepositoryCommands(deps);
            await mocks.commands.get(`intelligit.${action}`)?.({
                branch: { name: "feature/publish", isCurrent: true, isRemote: false },
            });
            const captured = mocks.createBranchCommands.mock.calls.at(-1)?.[0] as {
                gitOps: GitOps;
                getCurrentBranchName: () => string;
            };
            expect(captured.gitOps).toBe(scoped);
            expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo");
            expect(captured.getCurrentBranchName()).toBe("feature/publish");
        },
    );

    it.each([
        ["fileRollback", "rollbackFiles"],
        ["fileDelete", "deleteFile"],
        ["fileShelve", "stashSave"],
    ] as const)(
        "keeps row command %s on B through a confirmation-time switch",
        async (command, method) => {
            const gitOps = makeGitOps();
            const scoped = makeGitOps();
            const deps = makeDeps(gitOps);
            let active = "/repo";
            deps.getRepoRoot = () => active;
            deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
            const mutation = vi.fn(async () => undefined);
            Object.assign(scoped, { [method]: mutation });
            vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
            mocks.showWarningMessage.mockImplementationOnce(async (...args: unknown[]) => {
                active = "/repo-c";
                return args[2];
            });
            registerRepositoryCommands(deps);

            await mocks.commands.get(`intelligit.${command}`)?.({
                repositoryRoot: "/repo-b",
                filePath: "same.txt",
            });

            expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
            expect(mutation).toHaveBeenCalledOnce();
            expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        },
    );

    it.each(["fileRollback", "fileDelete", "fileShelve"])(
        "refuses an unknown row repository for %s before confirmation",
        async (command) => {
            const gitOps = makeGitOps();
            registerRepositoryCommands(makeDeps(gitOps));
            await mocks.commands.get(`intelligit.${command}`)?.({
                repositoryRoot: "/unknown",
                filePath: "same.txt",
            });
            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.showWarningMessage).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalled();
        },
    );

    it.each(["fetch", "push", "sync"] as const)(
        "captures graph %s before the active repository changes",
        async (operation) => {
            const gitOps = makeGitOps();
            const scoped = makeGitOps();
            const deps = makeDeps(gitOps);
            let active = "/repo";
            deps.getRepoRoot = () => active;
            vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
            mocks.runGitOperationFromPanel.mockImplementationOnce(async (value) => {
                const actions = value as {
                    gitOps: GitOps;
                    refreshData: () => Promise<void>;
                };
                expect(actions.gitOps).toBe(scoped);
                active = "/repo-b";
                await actions.refreshData();
            });
            registerRepositoryCommands(deps);

            await mocks.commands.get(`intelligit.graph.${operation}`)?.();

            expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo");
            expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
        },
    );

    it("publishes captured B after the active repository changes during preflight", async () => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        let active = "/repo";
        deps.getRepoRoot = () => active;
        deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
        vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
        scoped.hasAnyCommits = vi.fn(async () => {
            active = "/repo-c";
            return true;
        });
        scoped.getBranches = vi.fn(async () => [
            { name: "unpublished-b", isCurrent: true, isRemote: false },
        ]) as never;
        registerRepositoryCommands(deps);

        await mocks.commands.get("intelligit.publishBranch")?.("/repo-b");

        expect(mocks.runPublishBranchFlow).toHaveBeenCalledWith(
            scoped,
            "unpublished-b",
            "/repo-b",
            deps.context.secrets,
        );
    });

    it.each(["/unknown", "", 3, null])(
        "refuses invalid publish repository %j without Git or prompts",
        async (root) => {
            const gitOps = makeGitOps();
            registerRepositoryCommands(makeDeps(gitOps));
            await expect(mocks.commands.get("intelligit.publishBranch")?.(root)).rejects.toThrow(
                "repository",
            );
            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.runPublishBranchFlow).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["delete", "removeWorktree"],
        ["lock", "lockWorktree"],
        ["unlock", "unlockWorktree"],
        ["move", "moveWorktree"],
        ["prune", "pruneWorktrees"],
        ["repair", "repairWorktrees"],
    ] as const)("binds worktree %s to the originating repository", async (action, method) => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let active = "/repo";
        deps.getRepoRoot = () => active;
        deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
        deps.worktreeService = { [method]: vi.fn(async () => []) } as never;
        mocks.showInputBox.mockImplementationOnce(async () => {
            active = "/repo-c";
            return "test lock";
        });
        mocks.showOpenDialog.mockImplementationOnce(async () => {
            active = "/repo-c";
            return [mocks.FakeUri.file("/repo-b-new")];
        });
        registerRepositoryCommands(deps);

        await mocks.commands.get(`intelligit.worktree.${action}`)?.({
            repositoryRoot: "/repo-b",
            path: "/repo-b-linked",
        });

        const scoped = mocks.worktreeInstances.at(-1);
        expect(scoped).toBeDefined();
        expect(scoped?.root()).toBe("/repo-b");
        expect(scoped?.[method]).toHaveBeenCalledOnce();
        expect(scoped?.dispose).toHaveBeenCalledOnce();
        expect(deps.worktreeService[method]).not.toHaveBeenCalled();
    });

    it.each(["mergeIntoCurrent", "updateBranch", "checkout", "deleteBranch", "deleteBranches"])(
        "keeps worktree safety when listing fails for %s",
        async (action) => {
            const gitOps = makeGitOps();
            const scoped = makeGitOps();
            const deps = makeDeps(gitOps);
            deps.isKnownRepositoryRoot = () => true;
            vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
            scoped.getBranches = vi.fn(async () => [
                { name: "main", isCurrent: true, isRemote: false },
                { name: "topic", isCurrent: false, isRemote: false },
            ]) as never;
            scoped.getActiveOperation = vi.fn(async () => "none");
            mocks.listWorktrees.mockRejectedValue(new Error("worktree metadata unavailable"));
            registerRepositoryCommands(deps);
            const invocation = mocks.commands.get(`intelligit.${action}`)?.({
                repositoryRoot: "/repo-b",
                branch: { name: "topic" },
            });
            if (action === "mergeIntoCurrent" || action === "updateBranch") {
                await invocation;
                expect(mocks.branchHandlers.get(`intelligit.${action}`)).toHaveBeenCalledWith({
                    branch: expect.objectContaining({ name: "topic", isCurrent: false }),
                });
            } else {
                await expect(invocation).rejects.toThrow("worktree metadata unavailable");
                expect(mocks.branchHandlers.get(`intelligit.${action}`)).not.toHaveBeenCalled();
            }
        },
    );
    it.each(["mergeIntoCurrent", "updateBranch", "checkout", "renameBranch", "deleteBranch"])(
        "keeps explicit repository B for %s when active A switches during the fence",
        async (action) => {
            const gitOps = makeGitOps();
            const scoped = makeGitOps();
            const deps = makeDeps(gitOps);
            let active = "/repo";
            deps.getRepoRoot = () => active;
            deps.isKnownRepositoryRoot = (root) => ["/repo", "/repo-b"].includes(root);
            vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
            scoped.getBranches = vi.fn(async () => [
                { name: "main-b", isCurrent: true, isRemote: false },
                { name: "topic", isCurrent: false, isRemote: false },
            ]) as never;
            scoped.getActiveOperation = vi.fn(async () => {
                active = "/repo-c";
                return "none";
            });
            registerRepositoryCommands(deps);
            await mocks.commands.get(`intelligit.${action}`)?.({
                repositoryRoot: "/repo-b",
                branch: { name: "topic", isCurrent: true },
            });
            expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
            const captured = mocks.createBranchCommands.mock.calls.at(-1)?.[0] as unknown as {
                gitOps: GitOps;
                getCurrentBranchName: () => string;
                getCurrentBranches: () => Branch[];
            };
            expect(captured.gitOps).toBe(scoped);
            expect(captured.getCurrentBranchName()).toBe("main-b");
            expect(
                captured.getCurrentBranches().find((branch) => branch.name === "topic"),
            ).toMatchObject({ isCurrent: false });
        },
    );

    it.each(["/unknown", "", 3, null])(
        "rejects explicit invalid branch repository %j before Git",
        async (repositoryRoot) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            registerRepositoryCommands(deps);
            await expect(
                mocks.commands.get("intelligit.mergeIntoCurrent")?.({
                    repositoryRoot,
                    branch: { name: "topic" },
                }),
            ).rejects.toThrow("repository");
            expect(gitOps.deriveFor).not.toHaveBeenCalled();
        },
    );

    it("opens explicit known-root conflicts after the active repository changes", async () => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        let active = "/repo";
        deps.getRepoRoot = () => active;
        vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
        scoped.getConflictFilesDetailed = vi.fn(async () => {
            active = "/other";
            return [{ path: "conflict.txt" }] as never;
        });
        registerRepositoryCommands(deps);
        await mocks.commands.get("intelligit.openConflictSession")?.({ repositoryRoot: "/repo" });
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledWith(scoped, "/repo", {});
        expect(deps.openConflictSession).not.toHaveBeenCalled();
    });

    it.each([{}, { repositoryRoot: "/unknown" }, { repositoryRoot: 3 }, "malformed"])(
        "rejects invalid explicit conflict context %j without falling back to the active repository",
        async (context) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            registerRepositoryCommands(deps);
            await expect(
                mocks.commands.get("intelligit.openConflictSession")?.(context),
            ).rejects.toThrow("The requested repository is no longer available");
            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(deps.openConflictSession).not.toHaveBeenCalled();
            expect(deps.openConflictSessionForRepository).not.toHaveBeenCalled();
        },
    );

    it("current Update captures its repository before awaiting the operation fence", async () => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        let active = "/repo";
        deps.getRepoRoot = () => active;
        vi.mocked(gitOps.deriveFor).mockReturnValue(scoped);
        scoped.getActiveOperation = vi.fn(async () => {
            active = "/other";
            return "none";
        });
        gitOps.getActiveOperation = vi.fn(async () => {
            active = "/other";
            return "none";
        });
        registerRepositoryCommands(deps);
        await mocks.commands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isCurrent: true },
        });
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo");
        expect(scoped.getActiveOperation).toHaveBeenCalled();
        const captured = mocks.createBranchCommands.mock.calls.at(-1)?.[0] as unknown as {
            gitOps: GitOps;
            refreshRepository: () => Promise<void>;
            openConflictSession: (labels: {}) => Promise<void>;
        };
        expect(captured.gitOps).toBe(scoped);
        await captured.refreshRepository();
        expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
        await captured.openConflictSession({});
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledWith(scoped, "/repo", {});
    });

    it("file Pull retains its clicked conflict and refresh scope across a consent-time switch", async () => {
        const gitOps = makeGitOps();
        const scoped = makeGitOps();
        const deps = makeDeps(gitOps);
        let active = "/repo-b";
        deps.getRepoRoot = () => active;
        mocks.pullFileRepositoryFromContext.mockImplementationOnce(async (_ctx, _ops, runPull) =>
            runPull(scoped, "/repo-b"),
        );
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (actionDeps: any) => {
            active = "/repo";
            await actionDeps.refreshData();
            await actionDeps.openConflictSession({ repositoryRoot: "/repo-b" });
        });
        registerRepositoryCommands(deps);
        await mocks.commands.get("intelligit.filePull")?.({ clicked: "file" });
        expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledWith(scoped, "/repo-b", {});
    });
    it("registers generic Clone with secrets and preserves GitHub Clone", async () => {
        const deps = makeDeps(makeGitOps());
        registerRepositoryCommands(deps);

        const clone = mocks.commands.get("intelligit.cloneRepository");
        expect(clone, "repository-mode generic Clone handler").toBeTypeOf("function");
        await clone!();
        expect(mocks.runCloneFlow).toHaveBeenCalledExactlyOnceWith(deps.context.secrets);

        await mocks.commands.get("intelligit.github.cloneRepository")?.();
        expect(mocks.runGitHubCloneFlow).toHaveBeenCalledOnce();
    });
    it("routes Unstash refresh and conflicts to captured B across active-root changes", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        const scopedB = {} as GitOps;
        mocks.unstashChangesFromContext.mockImplementationOnce(async (_ctx, _ops, callbacks) => {
            await callbacks.openConflictSession(scopedB, "/repo-b");
            await callbacks.refresh("/repo-b");
            activeRoot = "/repo-b/";
            await callbacks.refresh("/repo-b");
        });
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        await mocks.commands.get("intelligit.fileContextUnstashChanges")!(uri);
        expect(mocks.unstashChangesFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            expect.objectContaining({
                refresh: expect.any(Function),
                openConflictSession: expect.any(Function),
            }),
        );
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledExactlyOnceWith(
            scopedB,
            "/repo-b",
            {},
        );
        expect(commitRefresh).toHaveBeenCalledTimes(2);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it("routes Stash Changes refresh to clicked B and checks the current active root", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.stashChangesFromContext.mockImplementationOnce(async (_ctx, _ops, refresh) => {
            await refresh("/repo-b");
            expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
            activeRoot = "/repo-b/";
            await refresh("/repo-b");
        });
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileStashChanges");
        expect(handler, "native Stash Changes has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.stashChangesFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            expect.any(Function),
        );
        expect(commitRefresh).toHaveBeenCalledTimes(2);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it.each([
        ["/repo-b/", "/repo-a", false],
        ["/repo-a", "/repo-b/", true],
    ] as const)(
        "checks active root after pending Stash Changes panel refresh changes %s to %s",
        async (initialRoot, nextRoot, shouldRefreshActive) => {
            const gitOps = makeGitOps();
            const deps = makeDeps(gitOps);
            let activeRoot: string = initialRoot;
            deps.getRepoRoot = () => activeRoot;
            let markStarted = () => undefined;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let finishRefresh = () => undefined;
            const pendingRefresh = new Promise<void>((resolve) => {
                finishRefresh = resolve;
            });
            const commitRefresh = vi.fn(async () => {
                markStarted();
                await pendingRefresh;
            });
            deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
            mocks.stashChangesFromContext.mockImplementationOnce(async (_ctx, _ops, refresh) =>
                refresh("/repo-b"),
            );
            registerRepositoryCommands(deps);
            const pendingCommand = mocks.commands.get("intelligit.fileStashChanges")!(
                mocks.FakeUri.file("/repo-b/file.txt"),
            );
            await started;
            activeRoot = nextRoot;
            finishRefresh();
            await pendingCommand;
            expect(commitRefresh).toHaveBeenCalledOnce();
            if (shouldRefreshActive) {
                expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
            } else {
                expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
            }
        },
    );
    it("routes Reset HEAD refresh to clicked B while A is active", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.getRepoRoot = () => "/repo-a";
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.resetHeadFileFromContext.mockImplementationOnce(
            async (_ctx, _ops, _executor, refresh) => refresh("/repo-b"),
        );
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileResetHead");
        expect(handler, "native Reset HEAD has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.resetHeadFileFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            deps.executor,
            expect.any(Function),
        );
        expect(commitRefresh).toHaveBeenCalledOnce();
        expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
    });
    it("refreshes active repository data when clicked B is still active", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        deps.getRepoRoot = () => "/repo-b/";
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.resetHeadFileFromContext.mockImplementationOnce(
            async (_ctx, _ops, _executor, refresh) => refresh("/repo-b"),
        );
        registerRepositoryCommands(deps);
        await mocks.commands.get("intelligit.fileResetHead")!(
            mocks.FakeUri.file("/repo-b/file.txt"),
        );
        expect(commitRefresh).toHaveBeenCalledOnce();
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it("routes New Tag refresh to clicked B and refreshes active data only when B is active", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.newTagFileFromContext.mockImplementationOnce(
            async (_ctx, _ops, _executor, refresh) => {
                await refresh("/repo-b");
                expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
                activeRoot = "/repo-b/";
                await refresh("/repo-b");
            },
        );
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileNewTag");
        expect(handler, "native New Tag has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.newTagFileFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            deps.executor,
            expect.any(Function),
        );
        expect(commitRefresh).toHaveBeenCalledTimes(2);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it("routes New Branch refresh to clicked B and refreshes the active graph only when B is active", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.newBranchFileFromContext.mockImplementationOnce(
            async (_ctx, _ops, _executor, refresh) => {
                await refresh("/repo-b");
                expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
                activeRoot = "/repo-b/";
                await refresh("/repo-b");
            },
        );
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileNewBranch");
        expect(handler, "native New Branch has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.newBranchFileFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            deps.executor,
            expect.any(Function),
        );
        expect(commitRefresh).toHaveBeenCalledTimes(2);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it("passes the clicked file, Git facade, and shared executor to Branches", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () => ({ refreshCommitPanels: commitRefresh }) as never;
        mocks.branchesFileFromContext.mockImplementationOnce(
            async (_ctx, _ops, _executor, refresh) => {
                await refresh("/repo-b");
                expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
                activeRoot = "/repo-b/";
                await refresh("/repo-b");
            },
        );
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileBranches");
        expect(handler, "native Branches has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.branchesFileFromContext).toHaveBeenCalledWith(
            uri,
            gitOps,
            deps.executor,
            expect.any(Function),
        );
        expect(commitRefresh).toHaveBeenCalledTimes(2);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
    });
    it("routes native Rebase callbacks to B and treats equivalent active roots as B", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const conflictRefresh = vi.fn(async () => undefined);
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () =>
            ({ refreshConflictUi: conflictRefresh, refreshCommitPanels: commitRefresh }) as never;
        const selected = { scope: "B" } as unknown as GitOps;
        mocks.rebaseFileFromContext.mockImplementationOnce(async (_ctx, _ops, callbacks) => {
            await callbacks.refresh("/repo-b");
            await callbacks.refreshConflicts("/repo-b");
            expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
            expect(conflictRefresh).not.toHaveBeenCalled();
            activeRoot = "/repo-b/";
            await callbacks.refresh("/repo-b");
            await callbacks.refreshConflicts("/repo-b");
            activeRoot = "/repo-c";
            await callbacks.openConflictSession(selected, "/repo-b", {
                sourceBranch: "main",
                targetBranch: "feature",
            });
        });
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileRebase");
        expect(handler, "native Rebase has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.rebaseFileFromContext).toHaveBeenCalledWith(uri, gitOps, expect.any(Object));
        expect(commitRefresh).toHaveBeenCalledTimes(4);
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
        expect(conflictRefresh).toHaveBeenCalledOnce();
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledWith(selected, "/repo-b", {
            sourceBranch: "main",
            targetBranch: "feature",
        });
    });
    it("wires native Merge callbacks to B and refreshes active views only while B remains active", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);
        let activeRoot = "/repo-a";
        deps.getRepoRoot = () => activeRoot;
        const conflictRefresh = vi.fn(async () => undefined);
        const commitRefresh = vi.fn(async () => undefined);
        deps.refreshService = () =>
            ({ refreshConflictUi: conflictRefresh, refreshCommitPanels: commitRefresh }) as never;
        const selected = { scope: "B" } as unknown as GitOps;
        mocks.mergeFileFromContext.mockImplementationOnce(async (_ctx, _ops, callbacks) => {
            await callbacks.refresh("/repo-b");
            await callbacks.refreshConflicts("/repo-b");
            expect(deps.refreshActiveRepository).not.toHaveBeenCalled();
            expect(conflictRefresh).not.toHaveBeenCalled();
            expect(
                commitRefresh,
                "non-active B panels still receive refreshed repository data",
            ).toHaveBeenCalledTimes(2);
            activeRoot = "/repo-b";
            await callbacks.refresh("/repo-b");
            await callbacks.refreshConflicts("/repo-b");
            activeRoot = "/repo-c";
            await callbacks.openConflictSession(selected, "/repo-b", {
                sourceBranch: "incoming",
                targetBranch: "main",
            });
        });
        registerRepositoryCommands(deps);
        const uri = mocks.FakeUri.file("/repo-b/file.txt");
        const handler = mocks.commands.get("intelligit.fileMerge");
        expect(handler, "native Merge has a registered handler").toBeTypeOf("function");
        await handler!(uri);
        expect(mocks.mergeFileFromContext).toHaveBeenCalledWith(uri, gitOps, expect.any(Object));
        expect(deps.refreshActiveRepository).toHaveBeenCalledOnce();
        expect(conflictRefresh).toHaveBeenCalledOnce();
        expect(deps.openConflictSessionForRepository).toHaveBeenCalledWith(selected, "/repo-b", {
            sourceBranch: "incoming",
            targetBranch: "main",
        });
    });

    beforeEach(() => {
        mocks.worktreeInstances.length = 0;
        mocks.showInputBox.mockReset();
        mocks.showOpenDialog.mockReset();
        mocks.showWarningMessage.mockReset();
        mocks.branchHandlers.clear();
        mocks.commands.clear();
        mocks.resolveFileCommandContext.mockReset();
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
        mocks.listWorktrees.mockReset().mockResolvedValue([]);
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
        const deps = makeDeps(gitOps);
        registerRepositoryCommands(deps);
        const context = { clicked: "file" };

        await mocks.commands.get("intelligit.annotateWithGitBlame")?.(context);

        expect(mocks.annotateWithGitBlame).toHaveBeenCalledWith(context, gitOps, deps.context);
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
        gitOps.preparePullWithLocalChanges = vi.fn(async () => ({
            kind: "ready",
            context: {
                repositoryRoot: "/repo",
                branch: "main",
                head: "a".repeat(40),
                upstream: "origin/main",
                dirty: false,
            },
        }));
        gitOps.pullPreservingLocalChanges = vi.fn(async () => ({ kind: "complete" }));
        const deps = makeDeps(gitOps);
        const refreshError = new Error("graph unavailable");
        deps.refreshActiveRepository = vi.fn(async () => {
            throw refreshError;
        });
        const actual = await vi.importActual<
            typeof import("../../../src/views/commitPanelActions")
        >("../../../src/views/commitPanelActions");
        mocks.runGitOperationFromPanel.mockImplementationOnce(
            actual.runGitOperationFromPanel as never,
        );
        mocks.pullFileRepositoryFromContext.mockImplementationOnce(async (_ctx, _ops, runPull) =>
            runPull(gitOps, "/repo"),
        );
        registerRepositoryCommands(deps);
        await expect(
            mocks.commands.get("intelligit.filePull")?.({ clicked: "file" }),
        ).resolves.toBeUndefined();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Pull finished, but the view could not refresh: {message}",
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
