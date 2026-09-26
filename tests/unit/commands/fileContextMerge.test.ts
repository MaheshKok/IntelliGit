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
        activeUri: new Uri("/repo-a/active.txt") as Uri | undefined,
        root: "/repo-a",
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        branches: vi.fn(async () => [
            { name: "main", isCurrent: true, isRemote: false },
            { name: "feature", isCurrent: false, isRemote: false },
            { name: "origin/feature", isCurrent: false, isRemote: true },
        ]),
        target: vi.fn(async () => ({ head: "main", oid: "a".repeat(40) })),
        operation: vi.fn(async () => "none"),
        merge: vi.fn(async (_branch: string) => undefined),
        conflicts: vi.fn(async (): Promise<Array<{ path: string }>> => []),
        picker: vi.fn(async (items: Array<{ label: string }>, _options?: unknown) => items[0]),
        confirm: vi.fn(
            async (_message: string, _options: unknown, action: string) =>
                action as string | undefined,
        ),
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
            return mocks.activeUri ? { document: { uri: mocks.activeUri } } : undefined;
        },
        showQuickPick: mocks.picker,
        showWarningMessage: mocks.confirm,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (s, [k, v]) => s.replace(`{${k}}`, String(v)),
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

import { mergeFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getBranches: mocks.branches,
    getMergeTarget: mocks.target,
    getActiveOperation: mocks.operation,
    merge: mocks.merge,
    getConflictFilesDetailed: mocks.conflicts,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const callbacks = {
    refresh: vi.fn(async (_root: string) => undefined),
    refreshConflicts: vi.fn(async (_root: string) => undefined),
    openConflictSession: vi.fn(
        async (_gitOps: GitOps, _root: string, _labels: unknown) => undefined,
    ),
};
const clicked = new mocks.Uri("/repo-b/selected.txt");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.root = "/repo-a";
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.branches.mockResolvedValue([
        { name: "main", isCurrent: true, isRemote: false },
        { name: "feature", isCurrent: false, isRemote: false },
        { name: "origin/feature", isCurrent: false, isRemote: true },
    ]);
    mocks.target.mockReset().mockResolvedValue({ head: "main", oid: "a".repeat(40) });
    mocks.operation.mockReset().mockResolvedValue("none");
    mocks.merge.mockReset().mockResolvedValue(undefined);
    mocks.conflicts.mockReset().mockResolvedValue([]);
    mocks.picker.mockReset().mockImplementation(async (items) => items[0]);
    mocks.confirm.mockReset().mockImplementation(async (_m, _o, action) => action);
    callbacks.refresh.mockReset().mockResolvedValue(undefined);
    callbacks.refreshConflicts.mockReset().mockResolvedValue(undefined);
    callbacks.openConflictSession.mockReset().mockResolvedValue(undefined);
});

describe("native Merge repository contract", () => {
    it("keeps clicked B while active A switches to C during prompts; excludes current and includes remote", async () => {
        mocks.picker.mockImplementationOnce(async (items) => {
            mocks.root = "/repo-c";
            mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
            return items[1];
        });
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.picker.mock.calls[0]?.[0].map((item) => item.label)).toEqual([
            "feature",
            "origin/feature",
        ]);
        expect(mocks.picker).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({ title: "/repo-b" }),
        );
        expect(mocks.confirm).toHaveBeenCalledWith(
            "Merge origin/feature into current branch?",
            { modal: true },
            "Merge",
        );
        expect(mocks.merge).toHaveBeenCalledWith("origin/feature");
        expect(callbacks.refresh).toHaveBeenCalledWith("/repo-b");
        expect(mocks.operation).toHaveBeenCalledTimes(2);
    });
    it.each([null, {}, new mocks.Uri("/remote/file", "vscode-remote")])(
        "refuses explicit invalid input %s without editor fallback",
        async (input) => {
            await mergeFileFromContext(input, gitOps, callbacks);
            expect(mocks.error).toHaveBeenCalledWith("Merge is only available for local files.");
            expect(mocks.discover).not.toHaveBeenCalled();
            expect(mocks.merge).not.toHaveBeenCalled();
        },
    );
    it("uses the editor only for undefined context", async () => {
        mocks.discover.mockResolvedValueOnce("/repo-a\n");
        await mergeFileFromContext(undefined, gitOps, callbacks);
        expect(mocks.realpath).toHaveBeenCalledWith("/repo-a");
        expect(mocks.merge).toHaveBeenCalledWith("feature");
    });
    it.each(["picker", "confirmation"])("cancelling %s leaves Git untouched", async (stage) => {
        if (stage === "picker") mocks.picker.mockResolvedValueOnce(undefined!);
        else mocks.confirm.mockResolvedValueOnce(undefined);
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.picker).toHaveBeenCalledOnce();
        expect(mocks.merge).not.toHaveBeenCalled();
        expect(callbacks.refresh).not.toHaveBeenCalled();
    });
    it("reports an empty branch inventory", async () => {
        mocks.branches.mockResolvedValueOnce([{ name: "main", isCurrent: true, isRemote: false }]);
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.info).toHaveBeenCalledWith("No other branches are available to merge.");
        expect(mocks.picker).not.toHaveBeenCalled();
    });
    it.each(["before", "after"])("fences the selected repository %s the dialogs", async (when) => {
        if (when === "before") mocks.operation.mockResolvedValueOnce("merge");
        else mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce("rebase");
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining(
                when === "before" ? "A merge is in progress" : "A rebase is in progress",
            ),
        );
        expect(mocks.picker).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
        expect(mocks.merge).not.toHaveBeenCalled();
    });
    it.each([
        { head: "main", oid: "b".repeat(40) },
        { head: "other", oid: "a".repeat(40) },
    ])("refuses changed target %j after confirmation", async (changed) => {
        mocks.target
            .mockResolvedValueOnce({ head: "main", oid: "a".repeat(40) })
            .mockResolvedValueOnce(changed);
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith(
            "The current branch or HEAD changed. Start Merge again.",
        );
        expect(mocks.merge).not.toHaveBeenCalled();
    });
    it.each([
        { head: "(detached)", oid: "a".repeat(40) },
        { head: "main", oid: "(initial)" },
    ])("permits unchanged detached/unborn identity %j", async (target) => {
        mocks.target.mockResolvedValue(target);
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.merge).toHaveBeenCalledWith("feature");
    });
    it("reports discovery failure without mutation", async () => {
        mocks.branches.mockRejectedValueOnce(new Error("cannot read refs"));
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith("Merge failed: cannot read refs");
        expect(mocks.merge).not.toHaveBeenCalled();
    });
    it("opens conflicts with B and captured labels after the active root changes", async () => {
        mocks.merge.mockRejectedValueOnce(new Error("merge conflict"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        mocks.confirm.mockImplementationOnce(async (_m, _o, action) => {
            mocks.root = "/repo-c";
            return action;
        });
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(callbacks.openConflictSession).toHaveBeenCalledWith(scoped, "/repo-b", {
            sourceBranch: "feature",
            targetBranch: "main",
        });
        expect(callbacks.refreshConflicts).toHaveBeenCalledWith("/repo-b");
        expect(mocks.error).not.toHaveBeenCalled();
    });
    it("preserves the Git error if conflict inspection or opening fails", async () => {
        mocks.merge.mockRejectedValueOnce(new Error("original Git failure"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        callbacks.openConflictSession.mockRejectedValueOnce(new Error("panel failed"));
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.error).toHaveBeenCalledWith("Merge failed: original Git failure");
    });
    it("distinguishes refresh failure after success from Git failure", async () => {
        callbacks.refresh.mockRejectedValueOnce(new Error("refresh unavailable"));
        await mergeFileFromContext(clicked, gitOps, callbacks);
        expect(mocks.info).toHaveBeenCalledWith("Merged feature");
        expect(mocks.error).toHaveBeenCalledWith(
            "Merge succeeded, but refresh failed: refresh unavailable",
        );
        expect(mocks.conflicts).not.toHaveBeenCalled();
    });
});
