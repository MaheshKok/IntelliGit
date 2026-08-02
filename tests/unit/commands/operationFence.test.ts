import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    COMMIT_ACTION_VALUES,
    type CommitAction,
} from "../../../src/webviews/protocol/commitGraphTypes";

const mocks = vi.hoisted(() => ({
    getActiveOperation: vi.fn(),
    l10nT: vi.fn(),
    showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => mocks.l10nT(message) },
    window: { showErrorMessage: mocks.showErrorMessage },
}));

import {
    COMMIT_ACTION_FENCE_DECISIONS,
    rejectCommitActionWhenOperationInProgress,
    rejectWhenOperationInProgress,
} from "../../../src/commands/operationFence";

function gitOps() {
    return { getActiveOperation: mocks.getActiveOperation };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.l10nT.mockImplementation((message: string) => `xx:${message}`);
    mocks.getActiveOperation.mockResolvedValue("none");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("operation fence", () => {
    it("makes the protocol action partition explicit and exhaustive", () => {
        const fenced = COMMIT_ACTION_VALUES.filter(
            (action) => COMMIT_ACTION_FENCE_DECISIONS[action],
        );
        const unfenced = COMMIT_ACTION_VALUES.filter(
            (action) => !COMMIT_ACTION_FENCE_DECISIONS[action],
        );

        expect(fenced).toEqual([
            "cherryPick",
            "checkoutRevision",
            "resetCurrentToHere",
            "revertCommit",
            "undoCommit",
            "editCommitMessage",
            "squashCommits",
            "dropCommit",
            "interactiveRebaseFromHere",
        ] satisfies CommitAction[]);
        expect(unfenced).toEqual([
            "copyRevision",
            "createPatch",
            "pushAllUpToHere",
            "newBranch",
            "newTag",
        ] satisfies CommitAction[]);
    });

    it.each([
        ["rebase", "A rebase is in progress — continue or abort it first."],
        ["merge", "A merge is in progress — resolve or abort it first."],
        ["cherry-pick", "A cherry-pick is in progress — continue or abort it first."],
        ["revert", "A revert is in progress — continue or abort it first."],
    ] as const)("shows the translated %s rejection", async (operation, message) => {
        mocks.getActiveOperation.mockResolvedValueOnce(operation);

        await expect(rejectCommitActionWhenOperationInProgress("dropCommit", gitOps())).resolves.toBe(
            true,
        );

        expect(mocks.l10nT).toHaveBeenCalledWith(message);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(`xx:${message}`);
    });

    it("allows a fenced action when no whole-index operation is active", async () => {
        await expect(rejectCommitActionWhenOperationInProgress("dropCommit", gitOps())).resolves.toBe(
            false,
        );

        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("uses the extracted operation rejection for commit and branch entry points", async () => {
        mocks.getActiveOperation.mockResolvedValueOnce("rebase");
        await rejectCommitActionWhenOperationInProgress("dropCommit", gitOps());
        const commitMessage = mocks.showErrorMessage.mock.calls[0]?.[0];

        mocks.showErrorMessage.mockClear();
        mocks.l10nT.mockClear();
        mocks.getActiveOperation.mockResolvedValueOnce("rebase");
        await rejectWhenOperationInProgress(gitOps());

        expect(mocks.l10nT).toHaveBeenCalledTimes(1);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(commitMessage);
    });

    it("fails closed on an operation kind it does not recognize", async () => {
        // The probe is duck-typed on the parameter, so an adapter or test double reaching this
        // function is not constrained by `GitOps`'s return type. Falling out of the switch would
        // resolve `undefined`, which the dispatcher reads as "not refused" — the one exit from
        // this function that lets a history rewrite land on top of an active operation.
        mocks.getActiveOperation.mockResolvedValueOnce("bisect");

        await expect(
            rejectCommitActionWhenOperationInProgress("dropCommit", gitOps()),
        ).resolves.toBe(true);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Unable to check whether a Git operation is in progress. Try again before changing history.",
        );
    });

    it("fails closed when the operation probe cannot be completed", async () => {
        mocks.getActiveOperation.mockRejectedValueOnce(new Error("EACCES"));

        await expect(rejectCommitActionWhenOperationInProgress("dropCommit", gitOps())).resolves.toBe(
            true,
        );

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Unable to check whether a Git operation is in progress. Try again before changing history.",
        );
    });
});
