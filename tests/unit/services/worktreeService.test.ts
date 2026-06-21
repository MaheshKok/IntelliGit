import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitExecutor } from "../../../src/git/executor";
import { WorktreeService } from "../../../src/services/worktreeService";

const showWarningMessage = vi.hoisted(() => vi.fn());
const includeFiles = vi.hoisted(() => ({ value: [] as string[] }));
const tempRoots: string[] = [];

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
    return {
        EventEmitter,
        window: {
            showWarningMessage,
        },
        l10n: { t: (message: string) => message },
        workspace: {
            getConfiguration: () => ({
                get: <T>(_key: string, defaultValue: T) =>
                    (includeFiles.value.length > 0 ? includeFiles.value : defaultValue) as T,
            }),
        },
    };
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

function createScopedExecutor(statusOutput: string): {
    factory: (repoRoot: string) => GitExecutor;
    runs: Array<{ repoRoot: string; run: ReturnType<typeof vi.fn> }>;
} {
    const runs: Array<{ repoRoot: string; run: ReturnType<typeof vi.fn> }> = [];
    return {
        runs,
        factory: (repoRoot: string) => {
            const run = vi.fn(async () => statusOutput);
            runs.push({ repoRoot, run });
            return { run } as unknown as GitExecutor;
        },
    };
}

describe("WorktreeService", () => {
    afterEach(async () => {
        includeFiles.value = [];
        await Promise.all(
            tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
        );
    });

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

    it("copies configured include files into a new worktree and skips missing entries", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-include-"));
        tempRoots.push(root);
        const sourceRoot = path.join(root, "source");
        const worktreeRoot = path.join(root, "feature");
        await mkdir(path.join(sourceRoot, ".vscode"), { recursive: true });
        await writeFile(path.join(sourceRoot, ".env"), "TOKEN=1\n", "utf8");
        await writeFile(path.join(sourceRoot, ".vscode", "settings.json"), "{\"x\":true}\n", "utf8");
        includeFiles.value = [".env", ".vscode/settings.json", "missing.local"];
        const executor = createExecutor([porcelain("main"), porcelain("feature/x")]);
        const service = new WorktreeService(executor, () => sourceRoot);

        await service.createWorktree({
            path: worktreeRoot,
            branch: { name: "feature/x", hash: "b2", isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
        });

        await expect(readFile(path.join(worktreeRoot, ".env"), "utf8")).resolves.toBe("TOKEN=1\n");
        await expect(
            readFile(path.join(worktreeRoot, ".vscode", "settings.json"), "utf8"),
        ).resolves.toBe("{\"x\":true}\n");
    });

    it("rejects unsafe include-file paths before adding a worktree", async () => {
        const executor = createExecutor([porcelain("main")]);
        includeFiles.value = ["../secret.env"];
        const service = new WorktreeService(executor, () => "/repo");

        await expect(
            service.createWorktree({
                path: "/worktrees/feature",
                branch: {
                    name: "feature/x",
                    hash: "b2",
                    isRemote: false,
                    isCurrent: false,
                    ahead: 0,
                    behind: 0,
                },
            }),
        ).rejects.toThrow("include file path");
        expect(executor.run).not.toHaveBeenCalledWith([
            "worktree",
            "add",
            "/worktrees/feature",
            "feature/x",
        ]);
    });

    it("rejects removing main, detached main, or current worktrees", async () => {
        const executor = createExecutor([
            porcelainRecords([
                { path: "/repo", branch: "main" },
                { path: "/worktrees/feature", branch: "feature/x" },
            ]),
            ["worktree /repo", "HEAD 1111111111111111111111111111111111111111", "detached", ""].join(
                "\0",
            ),
            porcelainRecords([
                { path: "/repo", branch: "main" },
                { path: "/worktrees/current", branch: "feature/current" },
            ]),
        ]);
        const service = new WorktreeService(executor, () => "/repo");

        await expect(service.removeWorktree("/repo")).rejects.toThrow("main worktree");
        await service.refresh();
        await expect(service.removeWorktree("/repo")).rejects.toThrow("main worktree");
        const currentLinked = new WorktreeService(executor, () => "/worktrees/current");
        await expect(currentLinked.removeWorktree("/worktrees/current")).rejects.toThrow(
            "current worktree",
        );
        await expect(service.removeWorktree("/missing")).rejects.toThrow("Worktree not found");
    });

    it("removes a clean worktree without force and leaves branches untouched", async () => {
        const executor = createExecutor([
            porcelainRecords([
                { path: "/repo", branch: "main" },
                { path: "/worktrees/feature", branch: "feature/x" },
            ]),
            "",
            porcelain("main"),
        ]);
        const scoped = createScopedExecutor("");
        const service = new WorktreeService(executor, () => "/repo", scoped.factory);

        await service.removeWorktree("/worktrees/feature");

        expect(scoped.runs).toHaveLength(1);
        expect(scoped.runs[0]).toMatchObject({ repoRoot: "/worktrees/feature" });
        expect(scoped.runs[0]?.run).toHaveBeenCalledWith(["status", "--porcelain"]);
        expect(executor.run).toHaveBeenCalledWith([
            "worktree",
            "remove",
            "/worktrees/feature",
        ]);
        expect(executor.run).not.toHaveBeenCalledWith(expect.arrayContaining(["branch"]));
    });

    it("requires explicit confirmation before force-removing a dirty worktree", async () => {
        const executor = createExecutor([
            porcelainRecords([
                { path: "/repo", branch: "main" },
                { path: "/worktrees/dirty", branch: "dirty" },
            ]),
            "",
            porcelain("main"),
        ]);
        const scoped = createScopedExecutor(" M file.txt\n");
        const service = new WorktreeService(executor, () => "/repo", scoped.factory);

        showWarningMessage.mockResolvedValueOnce(undefined);
        await expect(service.removeWorktree("/worktrees/dirty")).resolves.toBeUndefined();
        expect(executor.run).not.toHaveBeenCalledWith([
            "worktree",
            "remove",
            "--force",
            "/worktrees/dirty",
        ]);

        showWarningMessage.mockResolvedValueOnce("Delete Worktree");
        await service.removeWorktree("/worktrees/dirty");
        expect(executor.run).toHaveBeenCalledWith([
            "worktree",
            "remove",
            "--force",
            "/worktrees/dirty",
        ]);
    });

    it("runs advanced worktree operations and refreshes after each one", async () => {
        const executor = createExecutor([
            porcelain("main"),
            porcelain("main"),
            porcelain("main"),
            porcelain("main"),
            porcelain("main"),
        ]);
        const service = new WorktreeService(executor, () => "/repo");

        await service.lockWorktree("/worktrees/feature", "hold");
        await service.unlockWorktree("/worktrees/feature");
        await service.pruneWorktrees();
        await service.repairWorktrees();

        expect(executor.run).toHaveBeenCalledWith([
            "worktree",
            "lock",
            "--reason",
            "hold",
            "/worktrees/feature",
        ]);
        expect(executor.run).toHaveBeenCalledWith(["worktree", "unlock", "/worktrees/feature"]);
        expect(executor.run).toHaveBeenCalledWith(["worktree", "prune"]);
        expect(executor.run).toHaveBeenCalledWith(["worktree", "repair"]);
    });

    it("validates move destinations before running git worktree move", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-move-"));
        tempRoots.push(root);
        const repo = path.join(root, "repo");
        await mkdir(repo);
        const executor = createExecutor([
            porcelainRecords([
                { path: repo, branch: "main" },
                { path: path.join(root, "feature"), branch: "feature/x" },
            ]),
        ]);
        const service = new WorktreeService(executor, () => repo);

        await expect(
            service.moveWorktree(path.join(root, "feature"), path.join(repo, "nested")),
        ).rejects.toThrow("inside the current repository");
        expect(executor.run).not.toHaveBeenCalledWith([
            "worktree",
            "move",
            path.join(root, "feature"),
            path.join(repo, "nested"),
        ]);
    });
});
