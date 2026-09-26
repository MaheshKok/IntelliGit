import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        branches: vi.fn(async () => [
            { name: "main", isCurrent: true, isRemote: false },
            { name: "feature", isCurrent: false, isRemote: false },
            { name: "origin/feature", isCurrent: false, isRemote: true },
        ]),
        target: vi.fn(async () => ({ head: "main", oid: "a".repeat(40) })),
        operation: vi.fn(async () => "none"),
        rebase: vi.fn(async (_branch: string) => undefined),
        conflicts: vi.fn(async () => []),
        picker: vi.fn(async (items: Array<{ label: string }>) => items[1]),
        confirm: vi.fn(async (_message: string, _options: unknown, action: string) => action),
        error: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.activeUri } };
        },
        showQuickPick: mocks.picker,
        showWarningMessage: mocks.confirm,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: mocks.info,
    showTimedWarningMessage: mocks.warning,
}));

import { rebaseFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getBranches: mocks.branches,
    getMergeTarget: mocks.target,
    getActiveOperation: mocks.operation,
    rebase: mocks.rebase,
    getConflictFilesDetailed: mocks.conflicts,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const callbacks = {
    refresh: vi.fn(async (_root: string) => undefined),
    refreshConflicts: vi.fn(async (_root: string) => undefined),
    openConflictSession: vi.fn(async (_ops: GitOps, _root: string, _labels: unknown) => undefined),
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.branches.mockResolvedValue([
        { name: "main", isCurrent: true, isRemote: false },
        { name: "feature", isCurrent: false, isRemote: false },
        { name: "origin/feature", isCurrent: false, isRemote: true },
    ]);
    mocks.target.mockReset().mockResolvedValue({ head: "main", oid: "a".repeat(40) });
    mocks.operation.mockReset().mockResolvedValue("none");
    mocks.rebase.mockReset().mockResolvedValue(undefined);
    mocks.conflicts.mockReset().mockResolvedValue([]);
    mocks.picker.mockReset().mockImplementation(async (items) => items[1]);
    mocks.confirm.mockReset().mockImplementation(async (_m, _o, action) => action);
    callbacks.refresh.mockReset().mockResolvedValue(undefined);
    callbacks.refreshConflicts.mockReset().mockResolvedValue(undefined);
    callbacks.openConflictSession.mockReset().mockResolvedValue(undefined);
});

describe("native Rebase repository contract", () => {
    it.each([new mocks.Uri("/repo-b/selected.txt", "git"), { fsPath: "/repo-b/selected.txt" }])(
        "rejects an explicit non-file or invalid context without using the active repository: %j",
        async (context) => {
            await rebaseFileFromContext(context, gitOps, callbacks);
            expect(mocks.error).toHaveBeenCalledWith("Rebase is only available for local files.");
            expect(deriveFor).not.toHaveBeenCalled();
            expect(mocks.picker).not.toHaveBeenCalled();
            expect(mocks.rebase).not.toHaveBeenCalled();
        },
    );
    it("reports when B has no eligible target branch", async () => {
        mocks.branches.mockResolvedValueOnce([{ name: "main", isCurrent: true, isRemote: false }]);
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.info).toHaveBeenCalledWith("No other branches are available to rebase onto.");
        expect(mocks.picker).not.toHaveBeenCalled();
        expect(mocks.rebase).not.toHaveBeenCalled();
    });
    it("rebases the clicked B onto its selected remote branch after active A changes", async () => {
        mocks.picker.mockImplementationOnce(async (items) => {
            mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
            return items[1];
        });
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(deriveFor, "clicked B owns the operation").toHaveBeenCalledWith("/repo-b");
        expect(mocks.picker.mock.calls[0]?.[0].map((item) => item.label)).toEqual([
            "feature",
            "origin/feature",
        ]);
        expect(mocks.rebase, "clicked B receives the selected target").toHaveBeenCalledWith(
            "origin/feature",
        );
        expect(callbacks.refresh).toHaveBeenCalledWith("/repo-b");
    });
    it.each(["picker", "confirmation"])("cancelling %s never rebases", async (stage) => {
        if (stage === "picker") mocks.picker.mockResolvedValueOnce(undefined!);
        else mocks.confirm.mockResolvedValueOnce(undefined);
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.rebase).not.toHaveBeenCalled();
        expect(callbacks.refresh).not.toHaveBeenCalled();
    });
    it.each(["before", "after"])("fences B %s the dialogs", async (when) => {
        if (when === "before") mocks.operation.mockResolvedValueOnce("merge");
        else mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce("rebase");
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining(
                when === "before" ? "A merge is in progress" : "A rebase is in progress",
            ),
        );
        expect(mocks.rebase).not.toHaveBeenCalled();
    });
    it.each([
        { head: "other", oid: "a".repeat(40) },
        { head: "main", oid: "b".repeat(40) },
    ])("rejects a changed B branch or HEAD after confirmation: %j", async (changed) => {
        mocks.target.mockResolvedValueOnce({ head: "main", oid: "a".repeat(40) });
        mocks.target.mockResolvedValueOnce(changed);
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith(
            "The current branch or HEAD changed. Start Rebase again.",
        );
        expect(mocks.rebase).not.toHaveBeenCalled();
    });
    it("keeps B and correct rebase sides when its Git operation conflicts", async () => {
        mocks.rebase.mockRejectedValueOnce(new Error("rebase conflict"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        mocks.confirm.mockImplementationOnce(async (_m, _o, action) => {
            mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
            return action;
        });
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(callbacks.openConflictSession).toHaveBeenCalledWith(scoped, "/repo-b", {
            sourceBranch: "main",
            targetBranch: "origin/feature",
        });
        expect(callbacks.refreshConflicts).toHaveBeenCalledWith("/repo-b");
        expect(mocks.error).not.toHaveBeenCalled();
    });
    it("reports the original Git error if opening conflict recovery fails", async () => {
        mocks.rebase.mockRejectedValueOnce(new Error("original Git failure"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        callbacks.openConflictSession.mockRejectedValueOnce(new Error("panel failed"));
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith("Rebase failed: original Git failure");
    });
    it("does not call a completed rebase a failure when refresh fails", async () => {
        callbacks.refresh.mockRejectedValueOnce(new Error("refresh unavailable"));
        await rebaseFileFromContext(new mocks.Uri("/repo-b/selected.txt"), gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith(
            "Rebase succeeded, but refresh failed: refresh unavailable",
        );
        expect(mocks.rebase).toHaveBeenCalledOnce();
    });
});
