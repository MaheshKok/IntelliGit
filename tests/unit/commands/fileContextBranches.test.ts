import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { GitExecutor } from "../../../src/git/executor";

const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
        static file(filePath: string): Uri {
            return new Uri(filePath);
        }
    }
    const executor = { run: vi.fn(async () => undefined) };
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        executor,
        deriveExecutor: vi.fn(() => executor),
        branches: vi.fn(async () => [
            { name: "main", isCurrent: true, isRemote: false },
            { name: "feature", isCurrent: false, isRemote: false },
            { name: "origin/remote", isCurrent: false, isRemote: true },
        ]),
        operation: vi.fn(async () => "none"),
        picker: vi.fn(async (items: Array<{ label: string }>) => items[1]),
        checkout: vi.fn(async () => ({ kind: "checkedOut", branch: "feature" })),
        worktreesRefresh: vi.fn(async () => []),
        worktreeConstructor: vi.fn(),
        decorate: vi.fn((branches: unknown[]) => branches),
        dispose: vi.fn(),
        executeCommand: vi.fn(async () => undefined),
        error: vi.fn(),
        info: vi.fn(),
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
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    commands: { executeCommand: mocks.executeCommand },
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
        deriveFor = mocks.deriveExecutor;
    },
}));
vi.mock("../../../src/services/worktreeService", () => ({
    WorktreeService: class {
        constructor(executor: unknown, getRoot: () => string) {
            mocks.worktreeConstructor(executor, getRoot);
        }
        refresh = mocks.worktreesRefresh;
        decorateBranches = mocks.decorate;
        dispose = mocks.dispose;
    },
}));
vi.mock("../../../src/services/gitHelpers", () => ({ checkoutBranch: mocks.checkout }));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: mocks.info }));

import { branchesFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getBranches: mocks.branches,
    getActiveOperation: mocks.operation,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const executor = new GitExecutor("/repo-a");
const refresh = vi.fn(async (_repoRoot: string) => undefined);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.discover.mockReset();
    mocks.branches.mockReset();
    mocks.operation.mockReset();
    mocks.picker.mockReset();
    mocks.checkout.mockReset();
    mocks.worktreesRefresh.mockReset();
    mocks.decorate.mockReset();
    refresh.mockReset();
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.branches.mockResolvedValue([
        { name: "main", isCurrent: true, isRemote: false },
        { name: "feature", isCurrent: false, isRemote: false },
        { name: "origin/remote", isCurrent: false, isRemote: true },
    ]);
    mocks.operation.mockResolvedValue("none");
    mocks.picker.mockImplementation(async (items) => items[1]);
    mocks.checkout.mockResolvedValue({ kind: "checkedOut", branch: "feature" });
    mocks.worktreesRefresh.mockResolvedValue([]);
    mocks.decorate.mockImplementation((branches) =>
        branches.map((branch) => ({ ...branch, worktreePath: "/repo-b-linked" })),
    );
    refresh.mockResolvedValue(undefined);
});

describe("native Branches repository contract", () => {
    it("keeps branch checkout available when only worktree discovery fails", async () => {
        mocks.worktreesRefresh.mockRejectedValueOnce(new Error("worktree list unavailable"));
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(
            mocks.picker,
            "branch chooser survives worktree discovery failure",
        ).toHaveBeenCalledOnce();
        expect(mocks.decorate).not.toHaveBeenCalled();
        expect(
            mocks.picker.mock.calls[0][0].map((item) => item.branch),
            "fallback preserves every raw branch",
        ).toEqual([
            { name: "main", isCurrent: true, isRemote: false },
            { name: "feature", isCurrent: false, isRemote: false },
            { name: "origin/remote", isCurrent: false, isRemote: true },
        ]);
        expect(mocks.checkout).toHaveBeenCalledWith(
            expect.objectContaining({ name: "feature" }),
            expect.arrayContaining([expect.objectContaining({ name: "feature" })]),
            mocks.executor,
        );
        expect(refresh).toHaveBeenCalledWith("/repo-b");
        expect(mocks.error).not.toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it("still reports branch inventory failures after worktree discovery fails", async () => {
        mocks.worktreesRefresh.mockRejectedValueOnce(new Error("worktree list unavailable"));
        mocks.branches.mockRejectedValueOnce(new Error("branch inventory unavailable"));
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error).toHaveBeenCalledWith("Checkout failed: branch inventory unavailable");
        expect(mocks.picker).not.toHaveBeenCalled();
        expect(mocks.checkout).not.toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it("still reports checkout refusal after worktree discovery fails", async () => {
        mocks.worktreesRefresh.mockRejectedValueOnce(new Error("worktree list unavailable"));
        mocks.checkout.mockRejectedValueOnce(new Error("local changes would be overwritten"));
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error, "Git checkout refusal must stay visible").toHaveBeenCalledWith(
            "Checkout failed: local changes would be overwritten",
        );
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it("keeps clicked B's branch identity and executor after active A changes", async () => {
        let release!: (value: { label: string; branch: unknown }) => void;
        mocks.picker.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.picker).toHaveBeenCalledOnce());
        mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
        release(mocks.picker.mock.calls[0]![0][2] as { label: string; branch: unknown });
        await pending;
        expect(deriveFor, "clicked B owns branch inventory").toHaveBeenCalledWith("/repo-b");
        expect(mocks.deriveExecutor, "clicked B owns checkout").toHaveBeenCalledWith("/repo-b");
        expect(mocks.worktreeConstructor, "B owns worktree inventory").toHaveBeenCalledWith(
            mocks.executor,
            expect.any(Function),
        );
        expect(mocks.worktreeConstructor.mock.calls[0]![1]()).toBe("/repo-b");
        expect(mocks.checkout, "remote identity survives picker presentation").toHaveBeenCalledWith(
            expect.objectContaining({
                name: "origin/remote",
                isRemote: true,
                worktreePath: "/repo-b-linked",
            }),
            expect.any(Array),
            mocks.executor,
        );
        expect(refresh).toHaveBeenCalledWith("/repo-b");
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it("cancels without checkout or success refresh", async () => {
        mocks.picker.mockResolvedValueOnce(undefined!);
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.checkout).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it.each([new mocks.Uri("/repo-b/selected.txt", "git"), { fsPath: "/repo-b/selected.txt" }])(
        "rejects malformed explicit context without falling back to active A: %j",
        async (ctx) => {
            await branchesFileFromContext(ctx, gitOps, executor, refresh);
            expect(mocks.error).toHaveBeenCalledWith("Branches is only available for local files.");
            expect(deriveFor).not.toHaveBeenCalled();
            expect(mocks.picker).not.toHaveBeenCalled();
        },
    );

    it("blocks a Git operation that starts while the picker is pending", async () => {
        let release!: (value: { label: string; branch: unknown }) => void;
        mocks.picker.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.picker).toHaveBeenCalledOnce());
        mocks.operation.mockResolvedValue("merge");
        release(mocks.picker.mock.calls[0]![0][1] as { label: string; branch: unknown });
        await pending;
        expect(mocks.checkout, "operation after picker must block mutation").not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("A merge is in progress"));
    });

    it("offers an open worktree continuation without reporting an in-place checkout", async () => {
        mocks.checkout.mockResolvedValueOnce({
            kind: "openWorktree",
            branch: "feature",
            path: "/b-worktree",
        });
        let release!: (value: { label: string; forceNewWindow: boolean }) => void;
        mocks.picker.mockImplementationOnce(async (items) => items[1]);
        mocks.picker.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.picker).toHaveBeenCalledTimes(2));
        mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
        release({ label: "Open in New Window", forceNewWindow: true });
        await pending;
        expect(mocks.picker).toHaveBeenCalledTimes(2);
        expect(mocks.executeCommand, "worktree continuation stays with B").toHaveBeenCalledWith(
            "vscode.openFolder",
            expect.objectContaining({ fsPath: "/b-worktree" }),
            { forceNewWindow: true, forceReuseWindow: false },
        );
        expect(mocks.info).not.toHaveBeenCalledWith("Checked out feature");
        expect(refresh).not.toHaveBeenCalled();
    });

    it("allows the existing helper to handle a selected current branch", async () => {
        mocks.picker.mockImplementationOnce(async (items) => items[0]);
        mocks.checkout.mockResolvedValueOnce({ kind: "checkedOut", branch: "main" });
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.picker.mock.calls[0]![0][0]).toMatchObject({
            label: "main",
            description: "main is already the current branch.",
        });
        expect(mocks.checkout).toHaveBeenCalledWith(
            expect.objectContaining({ name: "main", isCurrent: true }),
            expect.any(Array),
            mocks.executor,
        );
    });

    it("passes decorated local worktree metadata with a selected remote branch", async () => {
        mocks.branches.mockResolvedValueOnce([
            { name: "main", isCurrent: true, isRemote: false },
            { name: "linked", isCurrent: false, isRemote: false },
            { name: "origin/linked", isCurrent: false, isRemote: true },
        ]);
        mocks.decorate.mockImplementationOnce((branches) =>
            branches.map((branch) =>
                branch.name === "linked"
                    ? { ...branch, isCheckedOutInWorktree: true, worktreePath: "/repo-b-linked" }
                    : branch,
            ),
        );
        mocks.picker.mockImplementationOnce(async (items) => items[2]);
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.checkout.mock.calls[0]![0]).toMatchObject({
            name: "origin/linked",
            isRemote: true,
        });
        expect(mocks.checkout.mock.calls[0]![1]).toContainEqual(
            expect.objectContaining({
                name: "linked",
                isCheckedOutInWorktree: true,
                worktreePath: "/repo-b-linked",
            }),
        );
    });

    it("reports refresh failure after Git checkout has succeeded", async () => {
        refresh.mockRejectedValueOnce(new Error("refresh unavailable"));
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error).toHaveBeenCalledWith(
            "Checkout succeeded, but refresh failed: refresh unavailable",
        );
        expect(mocks.checkout).toHaveBeenCalledOnce();
    });

    it("reports Git checkout refusal without discarding dirty work", async () => {
        mocks.checkout.mockRejectedValueOnce(new Error("local changes would be overwritten"));
        await branchesFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error).toHaveBeenCalledWith(
            "Checkout failed: local changes would be overwritten",
        );
        expect(refresh).not.toHaveBeenCalled();
    });
});
