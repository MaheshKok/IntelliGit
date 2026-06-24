import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: { t: (message: string) => message },
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

import { runGitOperationFromPanel } from "../../../src/views/commitPanelActions";
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
    } as unknown as GitOps;
}

function makeDeps(gitOps: GitOps) {
    return {
        gitOps,
        refreshData: vi.fn(async () => undefined),
        refreshGraphData: vi.fn(async () => undefined),
        fireWorkingTreeChanged: vi.fn(),
    };
}

describe("runGitOperationFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each<CommitPanelGitOperation>(["pull", "push", "sync"])(
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
            expect(deps.refreshData).not.toHaveBeenCalled();
            expect(deps.fireWorkingTreeChanged).not.toHaveBeenCalled();
        },
    );

    it("allows fetch when the current branch is unpublished", async () => {
        const gitOps = makeGitOps();
        const deps = makeDeps(gitOps);

        await runGitOperationFromPanel(deps, "fetch");

        expect(gitOps.fetch).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Fetched successfully.",
        );
        expect(deps.refreshData).toHaveBeenCalledTimes(1);
        expect(deps.fireWorkingTreeChanged).toHaveBeenCalledTimes(1);
    });
});
