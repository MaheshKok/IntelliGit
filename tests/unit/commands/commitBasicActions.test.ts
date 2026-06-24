// Spec-derived tests for the commit graph context-menu actions in
// src/commands/commitBasicActions.ts. Each test drives a handler through one of
// its documented control-flow branches (confirm/cancel, validation pass/fail,
// merge vs non-merge, success vs Git error) and asserts the observable effect:
// which Git command ran, whether the user saw a success or error notification,
// and whether IntelliGit views were refreshed. The vscode UI, notification
// progress wrapper, and the Git-touching gitHelpers collaborators are mocked;
// the pure ref-name validators and getErrorMessage run for real.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: { t: (message: string) => message },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    env: { clipboard: { writeText: vi.fn() } },
    workspace: { fs: { writeFile: vi.fn() } },
    window: {
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInputBox: vi.fn(),
        showSaveDialog: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (_title: string, task: () => Promise<void>): Promise<void> => task(),
    ),
    showTimedInformationMessage: vi.fn((message: string) => {
        vscodeMock.window.showInformationMessage(message);
    }),
    showTimedWarningMessage: vi.fn((message: string) => {
        vscodeMock.window.showWarningMessage(message);
    }),
}));

vi.mock("../../../src/services/gitHelpers", async (importOriginal) => {
    // Keep the real pure validators (isValidBranchName / isValidTagName) and any
    // other real exports; only stub the collaborators that hit Git or vscode UI.
    const actual = await importOriginal<typeof import("../../../src/services/gitHelpers")>();
    return {
        ...actual,
        pickMainlineParent: vi.fn(),
        getCheckedOutBranchName: vi.fn(),
        resolveRemoteName: vi.fn(),
        resolveTrackedRemoteBranch: vi.fn(),
        isCommitUnpushed: vi.fn(),
    };
});

import * as vscode from "vscode";
import {
    checkoutRevision,
    cherryPick,
    copyRevision,
    createPatch,
    newBranch,
    newTag,
    pushAllUpToHere,
    resetCurrentToHere,
    revertCommit,
} from "../../../src/commands/commitBasicActions";
import {
    getCheckedOutBranchName,
    isCommitUnpushed,
    pickMainlineParent,
    resolveRemoteName,
    resolveTrackedRemoteBranch,
} from "../../../src/services/gitHelpers";
import type { CommitActionContext } from "../../../src/commands/commitActionContext";
import type { GitExecutor } from "../../../src/git/executor";
import type { GitOps } from "../../../src/git/operations";
import type { Branch } from "../../../src/types";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHORT = "a1b2c3d4";

/** Casts an over-typed vscode/gitHelpers mock to the simple vitest Mock surface. */
function asMock(fn: unknown): Mock {
    return fn as unknown as Mock;
}

const warn = asMock(vscode.window.showWarningMessage);
const info = asMock(vscode.window.showInformationMessage);
const errorMsg = asMock(vscode.window.showErrorMessage);
const inputBox = asMock(vscode.window.showInputBox);
const saveDialog = asMock(vscode.window.showSaveDialog);
const writeText = asMock(vscode.env.clipboard.writeText);
const writeFile = asMock(vscode.workspace.fs.writeFile);

const mockedUnpushed = asMock(isCommitUnpushed);
const mockedCheckedOut = asMock(getCheckedOutBranchName);
const mockedPickParent = asMock(pickMainlineParent);
const mockedResolveRemote = asMock(resolveRemoteName);
const mockedTrackedRemote = asMock(resolveTrackedRemoteBranch);

function makeBranch(overrides: Partial<Branch> = {}): Branch {
    return {
        name: "main",
        hash: "a1b2c3d",
        isRemote: false,
        isCurrent: true,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

function makeCtx(overrides: Partial<CommitActionContext> = {}): CommitActionContext {
    return {
        validatedHash: HASH,
        short: SHORT,
        executor: { run: vi.fn().mockResolvedValue("") } as unknown as GitExecutor,
        gitOps: { getBranches: vi.fn().mockResolvedValue([]) } as unknown as GitOps,
        repoRoot: "/repo",
        currentBranches: [],
        refreshAll: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function runOf(ctx: CommitActionContext): Mock {
    return asMock(ctx.executor.run);
}

function refreshOf(ctx: CommitActionContext): Mock {
    return asMock(ctx.refreshAll);
}

function getBranchesOf(ctx: CommitActionContext): Mock {
    return asMock(ctx.gitOps.getBranches);
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("copyRevision", () => {
    it("copies the validated hash and notifies without touching Git or refreshing", async () => {
        const ctx = makeCtx();
        await copyRevision(ctx);
        expect(writeText).toHaveBeenCalledWith(HASH);
        expect(info).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("propagates a clipboard failure instead of swallowing it or notifying success", async () => {
        // copyRevision has no try/catch, so a rejected write must surface to the
        // caller and the success notification must not fire.
        writeText.mockRejectedValue(new Error("clipboard unavailable"));
        const ctx = makeCtx();
        await expect(copyRevision(ctx)).rejects.toThrow("clipboard unavailable");
        expect(info).not.toHaveBeenCalled();
    });
});

describe("createPatch", () => {
    it("does nothing when the save dialog is cancelled", async () => {
        saveDialog.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await createPatch(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it("writes the format-patch output to the chosen file on success", async () => {
        saveDialog.mockResolvedValue({ fsPath: "/repo/out.patch" });
        const ctx = makeCtx();
        runOf(ctx).mockResolvedValue("PATCH-CONTENT");
        await createPatch(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["format-patch", "-1", "--stdout", HASH]);
        expect(writeFile).toHaveBeenCalledTimes(1);
        const [, buffer] = writeFile.mock.calls[0];
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect((buffer as Buffer).toString("utf8")).toBe("PATCH-CONTENT");
        expect(info).toHaveBeenCalledTimes(1);
        expect(errorMsg).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("shows an error and writes nothing when format-patch fails", async () => {
        saveDialog.mockResolvedValue({ fsPath: "/repo/out.patch" });
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("boom"));
        await createPatch(ctx);
        expect(writeFile).not.toHaveBeenCalled();
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(info).not.toHaveBeenCalled();
    });

    it("defaults the save target to <short>.patch under the repo root", async () => {
        saveDialog.mockResolvedValue(undefined);
        const ctx = makeCtx({ repoRoot: "/repo", short: SHORT });
        await createPatch(ctx);
        expect(saveDialog).toHaveBeenCalledTimes(1);
        const options = saveDialog.mock.calls[0][0] as { defaultUri?: { fsPath: string } };
        expect(options.defaultUri?.fsPath).toBe(`/repo/${SHORT}.patch`);
    });
});

describe("cherryPick", () => {
    it("does not run Git or refresh when the confirmation is dismissed", async () => {
        warn.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await cherryPick(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("aborts without running Git when mainline-parent selection is cancelled", async () => {
        warn.mockResolvedValue("Cherry-pick");
        mockedPickParent.mockResolvedValue({ kind: "cancelled" });
        const ctx = makeCtx();
        await cherryPick(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("cherry-picks a non-merge commit and refreshes", async () => {
        warn.mockResolvedValue("Cherry-pick");
        mockedPickParent.mockResolvedValue({ kind: "notMerge" });
        const ctx = makeCtx();
        await cherryPick(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["cherry-pick", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("passes -m with the selected parent number for a merge commit", async () => {
        warn.mockResolvedValue("Cherry-pick");
        mockedPickParent.mockResolvedValue({ kind: "selected", parentNumber: 2 });
        const ctx = makeCtx();
        await cherryPick(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["cherry-pick", "-m", "2", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("reports a Git failure but still refreshes", async () => {
        warn.mockResolvedValue("Cherry-pick");
        mockedPickParent.mockResolvedValue({ kind: "notMerge" });
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("conflict"));
        await cherryPick(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(info).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("checkoutRevision", () => {
    it("does nothing when the confirmation is dismissed", async () => {
        warn.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await checkoutRevision(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("checks out the revision in detached HEAD and refreshes on success", async () => {
        warn.mockResolvedValue("Checkout");
        const ctx = makeCtx();
        await checkoutRevision(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["checkout", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("reports a checkout failure and still refreshes", async () => {
        warn.mockResolvedValue("Checkout");
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("dirty tree"));
        await checkoutRevision(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("resetCurrentToHere", () => {
    it("does nothing when the destructive reset is not confirmed", async () => {
        warn.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await resetCurrentToHere(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("runs a hard reset to the hash and refreshes on confirmation", async () => {
        warn.mockResolvedValue("Reset");
        const ctx = makeCtx();
        await resetCurrentToHere(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["reset", "--hard", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("reports a reset failure and still refreshes", async () => {
        warn.mockResolvedValue("Reset");
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("locked"));
        await resetCurrentToHere(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("revertCommit", () => {
    it("does nothing when the confirmation is dismissed", async () => {
        warn.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await revertCommit(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("aborts when mainline-parent selection is cancelled", async () => {
        warn.mockResolvedValue("Revert");
        mockedPickParent.mockResolvedValue({ kind: "cancelled" });
        const ctx = makeCtx();
        await revertCommit(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("reverts a non-merge commit with --no-edit and refreshes", async () => {
        warn.mockResolvedValue("Revert");
        mockedPickParent.mockResolvedValue({ kind: "notMerge" });
        const ctx = makeCtx();
        await revertCommit(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["revert", "--no-edit", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("passes -m with the selected parent for a merge commit revert", async () => {
        warn.mockResolvedValue("Revert");
        mockedPickParent.mockResolvedValue({ kind: "selected", parentNumber: 1 });
        const ctx = makeCtx();
        await revertCommit(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["revert", "-m", "1", "--no-edit", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("newBranch", () => {
    it("does nothing when the input box is cancelled", async () => {
        inputBox.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await newBranch(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("does nothing when an empty branch name is submitted", async () => {
        inputBox.mockResolvedValue("");
        const ctx = makeCtx();
        await newBranch(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("rejects an invalid branch name without running Git or refreshing", async () => {
        inputBox.mockResolvedValue("-bad");
        const ctx = makeCtx();
        await newBranch(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("creates the branch ref at the hash for a valid name and refreshes", async () => {
        inputBox.mockResolvedValue("feature/x");
        const ctx = makeCtx();
        await newBranch(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["branch", "feature/x", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("reports a Git failure for a valid name and still refreshes", async () => {
        inputBox.mockResolvedValue("feature/x");
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("exists"));
        await newBranch(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("newTag", () => {
    it("does nothing when the input box is cancelled", async () => {
        inputBox.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await newTag(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("does nothing when an empty tag name is submitted", async () => {
        inputBox.mockResolvedValue("");
        const ctx = makeCtx();
        await newTag(ctx);
        expect(errorMsg).not.toHaveBeenCalled();
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("rejects an invalid tag name without running Git or refreshing", async () => {
        inputBox.mockResolvedValue("v1..0");
        const ctx = makeCtx();
        await newTag(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("creates the tag ref at the hash for a valid name and refreshes", async () => {
        inputBox.mockResolvedValue("v1.0.0");
        const ctx = makeCtx();
        await newTag(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["tag", "v1.0.0", HASH]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("reports a Git failure for a valid tag and still refreshes", async () => {
        inputBox.mockResolvedValue("v1.0.0");
        const ctx = makeCtx();
        runOf(ctx).mockRejectedValue(new Error("exists"));
        await newTag(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});

describe("pushAllUpToHere", () => {
    it("refuses when the commit is already pushed", async () => {
        mockedUnpushed.mockResolvedValue(false);
        const ctx = makeCtx();
        await pushAllUpToHere(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("refuses when no local branch is checked out", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue(undefined);
        const ctx = makeCtx();
        await pushAllUpToHere(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("refuses when the commit is not an ancestor of HEAD", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        runOf(ctx).mockRejectedValue(new Error("not ancestor"));
        await pushAllUpToHere(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith(["merge-base", "--is-ancestor", HASH, "HEAD"]);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        // The ancestry check precedes branch resolution: it must short-circuit
        // before any getBranches() lookup or push.
        expect(getBranchesOf(ctx)).not.toHaveBeenCalled();
        expect(runOf(ctx)).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("pushes to the tracked remote branch without -u when an upstream exists", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue({ remote: "origin", remoteBranch: "main" });
        warn.mockResolvedValue("Push");
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        await pushAllUpToHere(ctx);
        expect(getBranchesOf(ctx)).not.toHaveBeenCalled();
        expect(runOf(ctx)).toHaveBeenCalledWith(["push", "origin", `${HASH}:refs/heads/main`]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("refreshes stale branch metadata before resolving the upstream", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue({ remote: "origin", remoteBranch: "main" });
        warn.mockResolvedValue("Push");
        // Snapshot lacks the checked-out branch, forcing a getBranches() refresh.
        const ctx = makeCtx({ currentBranches: [] });
        getBranchesOf(ctx).mockResolvedValue([makeBranch()]);
        await pushAllUpToHere(ctx);
        expect(getBranchesOf(ctx)).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).toHaveBeenCalledWith(["push", "origin", `${HASH}:refs/heads/main`]);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("errors when branch metadata cannot be resolved even after a refresh", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        const ctx = makeCtx({ currentBranches: [] });
        getBranchesOf(ctx).mockResolvedValue([]);
        await pushAllUpToHere(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(runOf(ctx)).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("warns when no upstream exists and no remote is configured", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue(undefined);
        mockedResolveRemote.mockResolvedValue(undefined);
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        await pushAllUpToHere(ctx);
        expect(warn).toHaveBeenCalledWith("The repo has not been published yet.");
        expect(errorMsg).not.toHaveBeenCalled();
        expect(runOf(ctx)).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("aborts when the set-upstream prompt is dismissed", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue(undefined);
        mockedResolveRemote.mockResolvedValue("origin");
        // Dismiss only the first (set-upstream) prompt so the test pins that exit
        // point; a later push prompt would still resolve undefined by default.
        warn.mockResolvedValueOnce(undefined);
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        await pushAllUpToHere(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("sets upstream and pushes with -u when the user opts in", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("feature");
        mockedTrackedRemote.mockReturnValue(undefined);
        mockedResolveRemote.mockResolvedValue("origin");
        warn.mockResolvedValueOnce("Set Upstream and Push").mockResolvedValueOnce("Push");
        const ctx = makeCtx({ currentBranches: [makeBranch({ name: "feature" })] });
        await pushAllUpToHere(ctx);
        expect(runOf(ctx)).toHaveBeenCalledWith([
            "push",
            "-u",
            "origin",
            `${HASH}:refs/heads/feature`,
        ]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });

    it("aborts when the final push prompt is dismissed", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue({ remote: "origin", remoteBranch: "main" });
        warn.mockResolvedValue(undefined);
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        await pushAllUpToHere(ctx);
        expect(runOf(ctx)).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
        expect(refreshOf(ctx)).not.toHaveBeenCalled();
    });

    it("reports a push failure and still refreshes", async () => {
        mockedUnpushed.mockResolvedValue(true);
        mockedCheckedOut.mockResolvedValue("main");
        mockedTrackedRemote.mockReturnValue({ remote: "origin", remoteBranch: "main" });
        warn.mockResolvedValue("Push");
        const ctx = makeCtx({ currentBranches: [makeBranch()] });
        runOf(ctx).mockImplementation(async (args: string[]) => {
            if (args[0] === "push") throw new Error("rejected");
            return "";
        });
        await pushAllUpToHere(ctx);
        expect(errorMsg).toHaveBeenCalledTimes(1);
        expect(info).not.toHaveBeenCalled();
        expect(refreshOf(ctx)).toHaveBeenCalledTimes(1);
    });
});
