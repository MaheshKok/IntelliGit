import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const branchHandlers = new Map<string, ReturnType<typeof vi.fn>>();
    return {
        branchHandlers,
        commands,
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        l10nT: vi.fn(),
        runPublishBranchFlow: vi.fn(),
        createBranchCommands: vi.fn(() => []),
        discoverGitRepositories: vi.fn(async () => []),
    };
});

vi.mock("vscode", () => ({
    commands: {
        registerCommand: mocks.registerCommand,
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
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
    },
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
        sidebarGraphFilterByBranch: vi.fn(),
        getCurrentBranchName: () => currentBranch.name,
        setActiveRepository: vi.fn(),
        clearSelection: vi.fn(),
        refreshActiveRepository: vi.fn(),
        refreshService: vi.fn(() => ({})),
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
        mocks.createBranchCommands.mockImplementation(() =>
            BRANCH_COMMAND_IDS.map((id) => {
                const handler = vi.fn();
                mocks.branchHandlers.set(id, handler);
                return { id, handler };
            }),
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
});
