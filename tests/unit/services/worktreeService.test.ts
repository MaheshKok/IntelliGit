import { describe, expect, it, vi } from "vitest";
import type { GitExecutor } from "../../../src/git/executor";
import { WorktreeService } from "../../../src/services/worktreeService";

vi.mock("vscode", () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];
        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return { dispose: vi.fn() };
        };
        fire(event: T): void {
            for (const listener of this.listeners) listener(event);
        }
        dispose(): void {
            this.listeners = [];
        }
    }
    return { EventEmitter };
});

function porcelain(branch: string): string {
    return [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        `branch refs/heads/${branch}`,
        "",
    ].join("\0");
}

function porcelainRecords(records: Array<{ path: string; branch: string }>): string {
    return records
        .flatMap((record, index) => [
            `worktree ${record.path}`,
            `HEAD ${String(index + 1).repeat(40).slice(0, 40)}`,
            `branch refs/heads/${record.branch}`,
            "",
        ])
        .join("\0");
}

function createExecutor(outputs: string[]): GitExecutor {
    return {
        run: vi.fn(async () => outputs.shift() ?? porcelain("fallback")),
    } as unknown as GitExecutor;
}

describe("WorktreeService", () => {
    it("caches worktree lists until refresh repulls and emits", async () => {
        const executor = createExecutor([porcelain("main"), porcelain("feature/x")]);
        const service = new WorktreeService(executor, () => "/repo");
        const listener = vi.fn();
        service.onDidChangeWorktrees(listener);

        await expect(service.listWorktrees()).resolves.toMatchObject([{ branch: "main" }]);
        await expect(service.listWorktrees()).resolves.toMatchObject([{ branch: "main" }]);
        expect(executor.run).toHaveBeenCalledTimes(1);

        await expect(service.refresh()).resolves.toMatchObject([{ branch: "feature/x" }]);
        expect(executor.run).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenCalledWith([expect.objectContaining({ branch: "feature/x" })]);
    });

    it("decorates matching local branches without mutating the source list", async () => {
        const executor = createExecutor([
            porcelainRecords([
                { path: "/repo", branch: "main" },
                { path: "/repo-feature", branch: "feature/x" },
            ]),
        ]);
        const service = new WorktreeService(executor, () => "/repo");
        const branches = [
            {
                name: "main",
                hash: "a1",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature/x",
                hash: "b2",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature/x",
                hash: "b2",
                isRemote: true,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "unused",
                hash: "c3",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ];

        await service.refresh();
        const decorated = service.decorateBranches(branches);

        expect(decorated).not.toBe(branches);
        expect(decorated[0]).toMatchObject({
            isCheckedOutInWorktree: true,
            isCurrentWorktree: true,
            worktreePath: "/repo",
        });
        expect(decorated[1]).toMatchObject({
            isCheckedOutInWorktree: true,
            isCurrentWorktree: false,
            worktreePath: "/repo-feature",
        });
        expect(decorated[2]).toMatchObject({
            isCheckedOutInWorktree: false,
            isCurrentWorktree: false,
        });
        expect(decorated[3]).toMatchObject({
            isCheckedOutInWorktree: false,
            isCurrentWorktree: false,
        });
        expect(branches[0]).not.toHaveProperty("isCheckedOutInWorktree");
        expect(branches[1]).not.toHaveProperty("worktreePath");
    });

    it("creates a remote-branch worktree and sets upstream explicitly", async () => {
        const executor = createExecutor([porcelain("main"), porcelain("feature/x")]);
        const service = new WorktreeService(executor, () => "/repo");

        await service.createWorktree({
            path: "/worktrees/feature-x",
            branch: {
                name: "origin/feature/x",
                hash: "b2",
                isRemote: true,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        });

        expect(executor.run).toHaveBeenNthCalledWith(1, [
            "worktree",
            "list",
            "--porcelain",
            "-z",
        ]);
        expect(executor.run).toHaveBeenNthCalledWith(2, [
            "worktree",
            "add",
            "-b",
            "feature/x",
            "/worktrees/feature-x",
            "origin/feature/x",
        ]);
        expect(executor.run).toHaveBeenNthCalledWith(3, [
            "branch",
            "--set-upstream-to=origin/feature/x",
            "feature/x",
        ]);
        expect(executor.run).toHaveBeenNthCalledWith(4, [
            "worktree",
            "list",
            "--porcelain",
            "-z",
        ]);
    });
});
