import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    return {
        commands,
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
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
        t: (message: string) => message,
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
    runWithNotificationProgress: vi.fn(async (_title: string, task: () => Promise<void>) =>
        task(),
    ),
    showTimedInformationMessage: vi.fn((message: string) => {
        mocks.showInformationMessage(message);
    }),
    showTimedWarningMessage: vi.fn((message: string) => {
        mocks.showWarningMessage(message);
    }),
}));

import { registerRepositoryCommands } from "../../../src/activation/repositoryCommands";
import type { GitOps } from "../../../src/git/operations";
import type { Branch } from "../../../src/types";

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
        openBuiltInMergeEditorForFile: vi.fn(),
    } as Parameters<typeof registerRepositoryCommands>[0];
};

describe("registerRepositoryCommands", () => {
    beforeEach(() => {
        mocks.commands.clear();
        vi.clearAllMocks();
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
});
