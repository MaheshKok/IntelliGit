import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
    COMMIT_ACTION_VALUES,
    type CommitAction,
} from "../../../src/webviews/protocol/commitGraphTypes";
import { COMMIT_ACTION_FENCE_DECISIONS } from "../../../src/commands/operationFence";

const mocks = vi.hoisted(() => ({
    getActiveOperation: vi.fn(),
    l10nT: vi.fn(),
    showErrorMessage: vi.fn(),
    handlers: {
        checkoutRevision: vi.fn(),
        cherryPick: vi.fn(),
        copyRevision: vi.fn(),
        createPatch: vi.fn(),
        dropCommit: vi.fn(),
        editCommitMessage: vi.fn(),
        interactiveRebaseFromHere: vi.fn(),
        newBranch: vi.fn(),
        newTag: vi.fn(),
        pushAllUpToHere: vi.fn(),
        resetCurrentToHere: vi.fn(),
        revertCommit: vi.fn(),
        squashCommits: vi.fn(),
        undoCommit: vi.fn(),
    },
}));

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => mocks.l10nT(message) },
    window: { showErrorMessage: mocks.showErrorMessage },
}));
vi.mock("../../../src/services/gitHelpers", () => ({ isValidGitHash: vi.fn(() => true) }));
vi.mock("../../../src/commands/commitBasicActions", () => ({
    checkoutRevision: mocks.handlers.checkoutRevision,
    cherryPick: mocks.handlers.cherryPick,
    copyRevision: mocks.handlers.copyRevision,
    createPatch: mocks.handlers.createPatch,
    newBranch: mocks.handlers.newBranch,
    newTag: mocks.handlers.newTag,
    pushAllUpToHere: mocks.handlers.pushAllUpToHere,
    resetCurrentToHere: mocks.handlers.resetCurrentToHere,
    revertCommit: mocks.handlers.revertCommit,
}));
vi.mock("../../../src/commands/commitHistoryActions", () => ({
    dropCommit: mocks.handlers.dropCommit,
    editCommitMessage: mocks.handlers.editCommitMessage,
    interactiveRebaseFromHere: mocks.handlers.interactiveRebaseFromHere,
    squashCommits: mocks.handlers.squashCommits,
    undoCommit: mocks.handlers.undoCommit,
}));

import { handleCommitContextAction } from "../../../src/commands/commitCommands";

const HASH = "a".repeat(40);
// Derived from the production decision map rather than restated: a new protocol action lands in
// whichever matrix its own declared decision puts it in, instead of quietly in neither.
const fencedActions = COMMIT_ACTION_VALUES.filter((action) => COMMIT_ACTION_FENCE_DECISIONS[action]);
const unfencedActions = COMMIT_ACTION_VALUES.filter(
    (action) => !COMMIT_ACTION_FENCE_DECISIONS[action],
);

function handlerFor(action: CommitAction): Mock {
    return mocks.handlers[action] as Mock;
}

function paramsFor(action: CommitAction) {
    return {
        action,
        hash: HASH,
        executor: {},
        gitOps: { getActiveOperation: mocks.getActiveOperation },
        repoRoot: "/repo",
        currentBranches: [],
        refreshAll: vi.fn(),
        originProvider: {},
        postRebaseDialog: vi.fn(),
        pendingRebaseDialogRequests: {},
    } as Parameters<typeof handleCommitContextAction>[0];
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.l10nT.mockImplementation((message: string) => `xx:${message}`);
    mocks.getActiveOperation.mockResolvedValue("none");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("handleCommitContextAction operation fence", () => {
    it.each(fencedActions)("refuses %s during a rebase before its handler runs", async (action) => {
        mocks.getActiveOperation.mockResolvedValueOnce("rebase");

        await handleCommitContextAction(paramsFor(action));

        expect(handlerFor(action)).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it.each(unfencedActions)("dispatches unfenced %s during a rebase", async (action) => {
        mocks.getActiveOperation.mockResolvedValueOnce("rebase");

        await handleCommitContextAction(paramsFor(action));

        expect(handlerFor(action)).toHaveBeenCalledTimes(1);
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it.each(COMMIT_ACTION_VALUES)("dispatches %s when no operation is active", async (action) => {
        await handleCommitContextAction(paramsFor(action));

        expect(handlerFor(action)).toHaveBeenCalledTimes(1);
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("fails closed when the operation probe rejects before dispatching", async () => {
        mocks.getActiveOperation.mockRejectedValueOnce(new Error("EACCES"));

        await handleCommitContextAction(paramsFor("dropCommit"));

        expect(handlerFor("dropCommit")).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "xx:Unable to check whether a Git operation is in progress. Try again before changing history.",
        );
    });
});
