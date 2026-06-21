import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitExecutor } from "../../../src/git/executor";
import {
    addWorktree,
    assertWorktreePathSafe,
    listWorktrees,
    parseWorktreeList,
    removeWorktree,
} from "../../../src/git/worktrees";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

function porcelainRecord(tokens: string[]): string {
    return `${tokens.join("\0")}\0`;
}

function porcelain(records: string[][]): string {
    return records.map(porcelainRecord).join("\0");
}

function createMockExecutor(stdout: string): GitExecutor {
    const run = vi.fn(async () => stdout);
    return { run } as unknown as GitExecutor;
}

class RealGitExecutor {
    constructor(private readonly cwd: string) {}

    async run(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
        return stdout;
    }
}

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}

async function createTempGitRepo(): Promise<{ root: string; repo: string }> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-worktrees-")));
    tempRoots.push(root);
    const repo = path.join(root, "repo");
    await mkdir(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    return { root, repo };
}

afterEach(async () => {
    await Promise.all(
        tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

describe("parseWorktreeList", () => {
    it("parses a single current main worktree", () => {
        const repo = "/tmp/project";
        const parsed = parseWorktreeList(
            porcelain([["worktree /tmp/project", "HEAD abc123", "branch refs/heads/main"]]),
            `${repo}/`,
        );

        expect(parsed).toEqual([
            {
                path: repo,
                head: "abc123",
                branch: "main",
                state: "main",
                isMain: true,
                isCurrent: true,
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });

    it("parses main plus linked worktrees with short branch names", () => {
        const parsed = parseWorktreeList(
            porcelain([
                ["worktree /tmp/repo", "HEAD aaaaaaa", "branch refs/heads/main"],
                ["worktree /tmp/repo feature", "HEAD bbbbbbb", "branch refs/heads/feature/x"],
                ["worktree /tmp/repo-review", "HEAD ccccccc", "branch refs/heads/review"],
            ]),
            "/tmp/repo",
        );

        expect(parsed).toHaveLength(3);
        expect(parsed[1]).toMatchObject({
            path: "/tmp/repo feature",
            head: "bbbbbbb",
            branch: "feature/x",
            state: "linked",
            isMain: false,
            isCurrent: false,
        });
        expect(parsed[2]).toMatchObject({
            branch: "review",
            state: "linked",
            isMain: false,
        });
    });

    it("keeps detached main identity separate from detached state", () => {
        const parsed = parseWorktreeList(
            porcelain([["worktree /tmp/repo", "HEAD abc123", "detached"]]),
            "/tmp/repo",
        );

        expect(parsed[0]).toMatchObject({
            branch: null,
            state: "detached",
            isMain: true,
        });
    });

    it("parses detached and bare worktrees without branches", () => {
        const parsed = parseWorktreeList(
            porcelain([
                ["worktree /tmp/repo", "HEAD aaaaaaa", "branch refs/heads/main"],
                ["worktree /tmp/detached", "HEAD bbbbbbb", "detached"],
                ["worktree /tmp/bare", "bare"],
            ]),
            "/tmp/repo",
        );

        expect(parsed[1]).toMatchObject({
            branch: null,
            head: "bbbbbbb",
            state: "detached",
        });
        expect(parsed[2]).toMatchObject({
            branch: null,
            head: null,
            state: "bare",
        });
    });

    it("parses locked and prunable reasons without dropping spaces", () => {
        const parsed = parseWorktreeList(
            porcelain([
                ["worktree /tmp/repo", "HEAD aaaaaaa", "branch refs/heads/main"],
                ["worktree /tmp/locked", "HEAD bbbbbbb", "branch refs/heads/locked", "locked"],
                [
                    "worktree /tmp/locked-reason",
                    "HEAD ccccccc",
                    "branch refs/heads/locked-reason",
                    "locked mounted on external drive",
                ],
                [
                    "worktree /tmp/prunable",
                    "HEAD ddddddd",
                    "branch refs/heads/prunable",
                    "prunable gitdir file points to missing location",
                ],
            ]),
            "/tmp/repo",
        );

        expect(parsed[1]?.isLocked).toBe(true);
        expect(parsed[1]?.lockedReason).toBeUndefined();
        expect(parsed[2]).toMatchObject({
            isLocked: true,
            lockedReason: "mounted on external drive",
        });
        expect(parsed[3]).toMatchObject({
            isPrunable: true,
            prunableReason: "gitdir file points to missing location",
        });
    });

    it("ignores trailing empty records and tolerates missing HEAD", () => {
        const parsed = parseWorktreeList(
            `${porcelain([["worktree /tmp/repo", "branch refs/heads/main"]])}\0\0`,
            "/tmp/repo",
        );

        expect(parsed).toHaveLength(1);
        expect(parsed[0]).toMatchObject({
            head: null,
            branch: "main",
            isMain: true,
        });
    });
});

describe("listWorktrees", () => {
    it("runs porcelain worktree listing through the executor", async () => {
        const executor = createMockExecutor(
            porcelain([["worktree /tmp/repo", "HEAD abc123", "branch refs/heads/main"]]),
        );

        const worktrees = await listWorktrees(executor, "/tmp/repo");

        expect(executor.run).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
        expect(worktrees[0]?.branch).toBe("main");
    });

    it("lists worktrees from a real repository with two linked worktrees", async () => {
        const { root, repo } = await createTempGitRepo();
        const linkedOne = path.join(root, "feature-x");
        const linkedTwo = path.join(root, "feature-y");
        await git(repo, ["branch", "feature/x"]);
        await git(repo, ["worktree", "add", linkedOne, "feature/x"]);
        await git(repo, ["worktree", "add", "-b", "feature/y", linkedTwo, "HEAD"]);
        const defaultBranch = (await git(repo, ["branch", "--show-current"])).trim();

        const worktrees = await listWorktrees(new RealGitExecutor(repo) as GitExecutor, repo);

        expect(worktrees).toHaveLength(3);
        expect(worktrees.map((worktree) => worktree.branch).sort()).toEqual([
            defaultBranch,
            "feature/x",
            "feature/y",
        ].sort());
        expect(worktrees.find((worktree) => worktree.path === repo)).toMatchObject({
            isMain: true,
            isCurrent: true,
        });
        expect(worktrees.find((worktree) => worktree.path === linkedOne)).toMatchObject({
            branch: "feature/x",
            state: "linked",
            isMain: false,
        });
    });
});

describe("assertWorktreePathSafe", () => {
    it("rejects paths inside the repository or an existing worktree", async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-safe-")));
        tempRoots.push(root);
        const repo = path.join(root, "repo");
        const linked = path.join(root, "linked");
        await mkdir(path.join(repo, "src"), { recursive: true });
        await mkdir(linked);

        expect(() =>
            assertWorktreePathSafe(path.join(repo, "src", "nested"), repo, []),
        ).toThrow("inside the current repository");
        expect(() =>
            assertWorktreePathSafe(path.join(linked, "child"), repo, [
                {
                    path: linked,
                    head: null,
                    branch: "feature/x",
                    state: "linked",
                    isMain: false,
                    isCurrent: false,
                    isLocked: false,
                    isPrunable: false,
                },
            ]),
        ).toThrow("inside an existing worktree");
    });

    it("rejects non-empty directories and symlinks resolving inside the repository", async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-safe-")));
        tempRoots.push(root);
        const repo = path.join(root, "repo");
        const occupied = path.join(root, "occupied");
        const link = path.join(root, "repo-link");
        await mkdir(repo);
        await mkdir(occupied);
        await writeFile(path.join(occupied, "file.txt"), "x", "utf8");
        await symlink(repo, link);

        expect(() => assertWorktreePathSafe(occupied, repo, [])).toThrow("not empty");
        expect(() => assertWorktreePathSafe(link, repo, [])).toThrow(
            "inside the current repository",
        );
    });
});

describe("addWorktree", () => {
    it("runs the correct argv for existing, new, and detached worktrees", async () => {
        const executor = createMockExecutor("");

        await addWorktree(executor, { path: "/wt/existing", branch: "feature/x" });
        await addWorktree(executor, {
            path: "/wt/new",
            newBranch: "feature/new",
            base: "origin/feature/new",
        });
        await addWorktree(executor, {
            path: "/wt/detached",
            base: "abc1234",
            detach: true,
        });

        expect(executor.run).toHaveBeenNthCalledWith(1, [
            "worktree",
            "add",
            "/wt/existing",
            "feature/x",
        ]);
        expect(executor.run).toHaveBeenNthCalledWith(2, [
            "worktree",
            "add",
            "-b",
            "feature/new",
            "/wt/new",
            "origin/feature/new",
        ]);
        expect(executor.run).toHaveBeenNthCalledWith(3, [
            "worktree",
            "add",
            "--detach",
            "/wt/detached",
            "abc1234",
        ]);
    });
});

describe("removeWorktree", () => {
    it("runs the correct argv for clean and forced removals", async () => {
        const executor = createMockExecutor("");

        await removeWorktree(executor, "/wt/clean", false);
        await removeWorktree(executor, "/wt/dirty", true);

        expect(executor.run).toHaveBeenNthCalledWith(1, ["worktree", "remove", "/wt/clean"]);
        expect(executor.run).toHaveBeenNthCalledWith(2, [
            "worktree",
            "remove",
            "--force",
            "/wt/dirty",
        ]);
    });
});
