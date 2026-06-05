import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitOps, UpstreamPushDeclinedError } from "../../src/git/operations";
import type { GitExecutor } from "../../src/git/executor";

const execFileAsync = promisify(execFile);

function createMockExecutor(responses: Record<string, string> = {}): GitExecutor {
    const run = vi.fn(async (args: string[]) => {
        const key = args.join(" ");
        for (const [pattern, response] of Object.entries(responses)) {
            if (key.includes(pattern)) return response;
        }
        return "";
    });
    return { run } as unknown as GitExecutor;
}

class RealGitExecutor {
    constructor(private readonly cwd: string) {}

    async run(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
        return stdout;
    }
}

async function createTempGitRepo(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-gitops-"));
    await execFileAsync("git", ["init"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repo });
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await mkdir(path.join(repo, "nested"));
    await writeFile(path.join(repo, "nested", "tracked.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
    return repo;
}

async function git(repo: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: repo });
    return stdout;
}

async function status(repo: string): Promise<string> {
    return git(repo, ["status", "--porcelain=v1"]);
}

describe("GitOps", () => {
    describe("isRepository", () => {
        it("returns true when rev-parse succeeds", async () => {
            const executor = createMockExecutor({ "rev-parse": "true" });
            const ops = new GitOps(executor);
            expect(await ops.isRepository()).toBe(true);
        });

        it("returns false when rev-parse throws", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("not a repo");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            expect(await ops.isRepository()).toBe(false);
        });
    });

    describe("publish and onboarding git commands", () => {
        it("initializes a Git repository at the requested path", async () => {
            const repo = await mkdtemp(path.join(tmpdir(), "intelligit-init-"));
            const ops = new GitOps(createMockExecutor({}));
            try {
                await ops.init(repo);

                const gitDir = (await git(repo, ["rev-parse", "--git-dir"])).trim();
                expect(gitDir).toBe(".git");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("constructs remote add and remove commands", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.addRemote("origin", "https://github.com/user/repo.git");
            await ops.removeRemote("origin");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toEqual([
                ["remote", "add", "origin", "https://github.com/user/repo.git"],
                ["remote", "remove", "origin"],
            ]);
        });

        it("constructs publish push with upstream command", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.pushWithUpstream("upstream", "feature/test");

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
                "push",
                "-u",
                "upstream",
                "feature/test",
            ]);
        });
    });

    describe("getBranches", () => {
        it("parses local and remote branches", async () => {
            const output = [
                "refs/heads/main\tmain\tabc1234\torigin/main\tahead 2\t*",
                "refs/heads/feature\tfeature\tdef5678\torigin/feature\t\t ",
                "refs/remotes/origin/main\torigin/main\tabc1234\t\t\t ",
            ].join("\n");

            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();

            expect(branches).toHaveLength(3);

            expect(branches[0].name).toBe("main");
            expect(branches[0].isCurrent).toBe(true);
            expect(branches[0].ahead).toBe(2);
            expect(branches[0].isRemote).toBe(false);
            expect(branches[0].remote).toBe("origin");
            expect(branches[0].upstream).toBe("origin/main");

            expect(branches[1].name).toBe("feature");
            expect(branches[1].isCurrent).toBe(false);

            expect(branches[2].name).toBe("origin/main");
            expect(branches[2].isRemote).toBe(true);
            expect(branches[2].remote).toBe("origin");
        });

        it("skips symbolic HEAD refs", async () => {
            const output = "refs/remotes/origin/HEAD\torigin\tabc1234\t\t\t \n";
            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();
            expect(branches).toHaveLength(0);
        });

        it("parses behind count", async () => {
            const output = "refs/heads/main\tmain\tabc1234\torigin/main\tbehind 3\t*\n";
            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();
            expect(branches[0].behind).toBe(3);
            expect(branches[0].ahead).toBe(0);
        });
    });

    describe("getLog", () => {
        const FIELD_SEP = "\x1f";
        const RECORD_SEP = "\x1e";

        function makeCommitRecord(
            hash: string,
            shortHash: string,
            message: string,
            author: string,
            email: string,
            date: string,
            parents: string,
            refs: string,
        ): string {
            return (
                [hash, shortHash, message, author, email, date, parents, refs].join(FIELD_SEP) +
                RECORD_SEP
            );
        }

        it("parses commit records", async () => {
            const output = makeCommitRecord(
                "abc123full",
                "abc123",
                "Initial commit",
                "John",
                "john@test.com",
                "2024-01-01T00:00:00Z",
                "",
                "HEAD -> main",
            );
            const executor = createMockExecutor({ log: output });
            const ops = new GitOps(executor);
            const commits = await ops.getLog();

            expect(commits).toHaveLength(1);
            expect(commits[0].hash).toBe("abc123full");
            expect(commits[0].shortHash).toBe("abc123");
            expect(commits[0].message).toBe("Initial commit");
            expect(commits[0].author).toBe("John");
            expect(commits[0].parentHashes).toEqual([]);
            expect(commits[0].refs).toContain("HEAD -> main");
        });

        it("preserves literal separator text in commit subjects", async () => {
            const output = makeCommitRecord(
                "abc123full",
                "abc123",
                "Handle <<|>> and <<||>> in subject",
                "John",
                "john@test.com",
                "2024-01-01T00:00:00Z",
                "",
                "",
            );
            const executor = createMockExecutor({ log: output });
            const ops = new GitOps(executor);
            const commits = await ops.getLog();

            expect(commits[0].message).toBe("Handle <<|>> and <<||>> in subject");
        });

        it("parses parent hashes", async () => {
            const output = makeCommitRecord(
                "abc123",
                "abc",
                "Merge",
                "A",
                "a@b.com",
                "2024-01-01T00:00:00Z",
                "parent1 parent2",
                "",
            );
            const executor = createMockExecutor({ log: output });
            const ops = new GitOps(executor);
            const commits = await ops.getLog();
            expect(commits[0].parentHashes).toEqual(["parent1", "parent2"]);
        });

        it("passes validated branch filter after an end-of-options guard", async () => {
            const executor = createMockExecutor({ log: "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, "feature/test", "fix bug");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("feature/test");
            expect(call).toContain("--end-of-options");
            expect(call).not.toContain("--all");
            expect(call.indexOf("--grep=fix bug")).toBeLessThan(call.indexOf("--end-of-options"));
            expect(call.indexOf("--end-of-options")).toBeLessThan(call.indexOf("feature/test"));
        });

        it("rejects unsafe branch filter arguments before invoking git", async () => {
            const executor = createMockExecutor({ log: "" });
            const ops = new GitOps(executor);

            await expect(ops.getLog(100, "--output=/tmp/intelligit-log")).rejects.toThrow(
                "Invalid branch filter",
            );
            expect(executor.run).not.toHaveBeenCalled();
        });

        it("passes filter text argument", async () => {
            const executor = createMockExecutor({ log: "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, undefined, "fix bug");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("--grep=fix bug");
            expect(call).toContain("-i");
        });

        it("passes skip argument for pagination", async () => {
            const executor = createMockExecutor({ log: "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, undefined, undefined, 200);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("--skip=200");
        });
    });

    describe("getCommitDetail", () => {
        const FIELD_SEP = "\x1f";

        it("parses commit detail with files", async () => {
            const showOutput = [
                "abc123full",
                "abc123",
                "Fix bug",
                "Body text",
                "John",
                "john@test.com",
                "2024-01-01T00:00:00Z",
                "parent1",
                "HEAD -> main",
            ].join(FIELD_SEP);

            const nameStatusOutput = "M\tsrc/foo.ts\nA\tsrc/bar.ts\n";
            const numstatOutput = "10\t2\tsrc/foo.ts\n5\t0\tsrc/bar.ts\n";

            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args[0] === "show") return showOutput;
                    if (args.includes("--name-status")) return nameStatusOutput;
                    if (args.includes("--numstat")) return numstatOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const detail = await ops.getCommitDetail("abc123full");

            expect(detail.hash).toBe("abc123full");
            expect(detail.message).toBe("Fix bug");
            expect(detail.body).toBe("Body text");
            expect(detail.files).toHaveLength(2);
            expect(detail.files[0].path).toBe("src/foo.ts");
            expect(detail.files[0].status).toBe("M");
            expect(detail.files[0].additions).toBe(10);
            expect(detail.files[0].deletions).toBe(2);
            expect(detail.files[1].path).toBe("src/bar.ts");
            expect(detail.files[1].status).toBe("A");
            expect(detail.files[1].additions).toBe(5);
        });

        it("applies numstat for renamed commit files to the destination path", async () => {
            const showOutput = [
                "abc123full",
                "abc123",
                "Rename file",
                "",
                "John",
                "john@test.com",
                "2024-01-01T00:00:00Z",
                "parent1",
                "",
            ].join(FIELD_SEP);
            const nameStatusOutput = "R100\tsrc/old-name.ts\tsrc/new-name.ts\n";
            const numstatOutput = "1\t0\tsrc/{old-name.ts => new-name.ts}\n";

            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args[0] === "show") return showOutput;
                    if (args.includes("--name-status")) return nameStatusOutput;
                    if (args.includes("--numstat")) return numstatOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const detail = await ops.getCommitDetail("abc123full");

            expect(detail.files).toEqual([
                {
                    path: "src/new-name.ts",
                    status: "R",
                    additions: 1,
                    deletions: 0,
                },
            ]);
        });
    });

    describe("getStatus", () => {
        it("parses porcelain status output", async () => {
            const statusOutput = " M src/foo.ts\0?? src/new.ts\0A  src/added.ts\0";
            const diffStatOutput = "3\t1\tsrc/foo.ts\n";
            const stagedStatOutput = "5\t0\tsrc/added.ts\n";

            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--porcelain=v1")) return statusOutput;
                    if (args.includes("--cached")) return stagedStatOutput;
                    if (args[0] === "diff" && args.includes("--numstat")) return diffStatOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const files = await ops.getStatus();

            const unstaged = files.filter((f) => !f.staged);
            const staged = files.filter((f) => f.staged);

            expect(unstaged.some((f) => f.path === "src/foo.ts" && f.status === "M")).toBe(true);
            expect(unstaged.some((f) => f.path === "src/new.ts" && f.status === "?")).toBe(true);
            expect(staged.some((f) => f.path === "src/added.ts" && f.status === "A")).toBe(true);
        });

        it("emits two entries for files with both staged and unstaged changes", async () => {
            const statusOutput = "MM src/both.ts\0";

            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--porcelain=v1")) return statusOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const files = await ops.getStatus();

            const bothEntries = files.filter((f) => f.path === "src/both.ts");
            expect(bothEntries).toHaveLength(2);
            expect(bothEntries.some((f) => f.staged)).toBe(true);
            expect(bothEntries.some((f) => !f.staged)).toBe(true);
        });

        it("parses rename entries from porcelain -z output", async () => {
            const statusOutput = "R  src/new-name.ts\0src/old-name.ts\0";
            const stagedStatOutput = "1\t0\tsrc/{old-name.ts => new-name.ts}\n";

            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--porcelain=v1")) return statusOutput;
                    if (args.includes("--cached")) return stagedStatOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const files = await ops.getStatus();

            expect(files).toHaveLength(1);
            expect(files[0].path).toBe("src/new-name.ts");
            expect(files[0].status).toBe("R");
            expect(files[0].staged).toBe(true);
        });
    });

    describe("stageFiles", () => {
        it("calls git add with paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stageFiles(["src/a.ts", "src/b.ts"]);

            expect(executor.run).toHaveBeenCalledWith([
                "status",
                "--porcelain=v1",
                "-z",
                "--",
                "src/a.ts",
                "src/b.ts",
            ]);
            expect(executor.run).toHaveBeenCalledWith(["add", "--", "src/a.ts", "src/b.ts"]);
        });

        it("does not rerun git add for an already staged deleted file", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -- ads.py": "D  ads.py\0",
            });
            const ops = new GitOps(executor);

            await ops.stageFiles(["ads.py"]);

            expect(executor.run).toHaveBeenCalledTimes(1);
            expect(executor.run).toHaveBeenCalledWith([
                "status",
                "--porcelain=v1",
                "-z",
                "--",
                "ads.py",
            ]);
        });

        it("still stages an unstaged deleted file", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -- ads.py": " D ads.py\0",
            });
            const ops = new GitOps(executor);

            await ops.stageFiles(["ads.py"]);

            expect(executor.run).toHaveBeenCalledWith(["add", "--", "ads.py"]);
        });

        it("stages other selected paths when one selected path is already a staged deletion", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -- ads.py src/a.ts": "D  ads.py\0 M src/a.ts\0",
            });
            const ops = new GitOps(executor);

            await ops.stageFiles(["ads.py", "src/a.ts"]);

            expect(executor.run).toHaveBeenCalledWith(["add", "--", "src/a.ts"]);
        });

        it("skips empty paths array", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stageFiles([]);
            expect(executor.run).not.toHaveBeenCalled();
        });
    });

    describe("real git file-operation matrix", () => {
        it("stages modified, unstaged deleted, and already staged deleted files without pathspec errors", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");
                await ops.stageFiles(["tracked.txt"]);
                expect(await status(repo)).toBe("M  tracked.txt\n");

                await git(repo, ["reset", "--hard", "HEAD"]);
                await rm(path.join(repo, "tracked.txt"));
                await ops.stageFiles(["tracked.txt"]);
                expect(await status(repo)).toBe("D  tracked.txt\n");

                await ops.stageFiles(["tracked.txt"]);
                expect(await status(repo)).toBe("D  tracked.txt\n");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("handles spaces, nested paths, and option-like filenames through stage and unstage", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);
                await writeFile(path.join(repo, "space name.txt"), "space\n", "utf8");
                await writeFile(path.join(repo, "--weird.txt"), "dash\n", "utf8");
                await writeFile(
                    path.join(repo, "nested", "tracked.txt"),
                    "nested changed\n",
                    "utf8",
                );

                await ops.stageFiles(["space name.txt", "--weird.txt", "nested/tracked.txt"]);
                expect(await status(repo)).toBe(
                    'A  --weird.txt\nM  nested/tracked.txt\nA  "space name.txt"\n',
                );

                await ops.unstageFiles(["--weird.txt", "space name.txt", "nested/tracked.txt"]);
                expect(await status(repo)).toBe(
                    ' M nested/tracked.txt\n?? --weird.txt\n?? "space name.txt"\n',
                );
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("rolls back staged, unstaged, and untracked selected files", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "tracked.txt"), "staged\n", "utf8");
                await git(repo, ["add", "tracked.txt"]);
                await writeFile(path.join(repo, "nested", "tracked.txt"), "unstaged\n", "utf8");
                await writeFile(path.join(repo, "new.txt"), "new\n", "utf8");
                await writeFile(path.join(repo, "added.txt"), "added\n", "utf8");
                await git(repo, ["add", "added.txt"]);

                expect(await status(repo)).toBe(
                    "A  added.txt\n M nested/tracked.txt\nM  tracked.txt\n?? new.txt\n",
                );

                await ops.rollbackFiles([
                    "tracked.txt",
                    "nested/tracked.txt",
                    "new.txt",
                    "added.txt",
                ]);

                expect(await status(repo)).toBe("");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("rolls back all staged, unstaged, and untracked changes", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "tracked.txt"), "staged\n", "utf8");
                await git(repo, ["add", "tracked.txt"]);
                await writeFile(path.join(repo, "nested", "tracked.txt"), "unstaged\n", "utf8");
                await writeFile(path.join(repo, "new.txt"), "new\n", "utf8");
                await writeFile(path.join(repo, "added.txt"), "added\n", "utf8");
                await git(repo, ["add", "added.txt"]);

                await ops.rollbackAll();

                expect(await status(repo)).toBe("");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("rolls back staged renames and staged-add-then-deleted files", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await git(repo, ["mv", "tracked.txt", "renamed.txt"]);
                await writeFile(path.join(repo, "transient.txt"), "transient\n", "utf8");
                await git(repo, ["add", "transient.txt"]);
                await rm(path.join(repo, "transient.txt"));

                expect(await status(repo)).toBe(
                    "R  tracked.txt -> renamed.txt\nAD transient.txt\n",
                );

                await ops.rollbackFiles(["renamed.txt", "transient.txt"]);

                expect(await status(repo)).toBe("");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("deletes tracked option-like filenames through git rm", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);
                await writeFile(path.join(repo, "--weird.txt"), "dash\n", "utf8");
                await git(repo, ["add", "--", "--weird.txt"]);
                await git(repo, ["commit", "-m", "add weird path"]);

                await ops.deleteFile("--weird.txt");

                expect(await status(repo)).toBe("D  --weird.txt\n");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("stages, unstages, and rolls back renamed files through git mv", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                // Stage a rename via git mv
                await git(repo, ["mv", "tracked.txt", "renamed.txt"]);
                expect(await status(repo)).toBe("R  tracked.txt -> renamed.txt\n");

                // Rollback the rename (unstage + restore original file)
                await ops.rollbackFiles(["renamed.txt"]);
                expect(await status(repo)).toBe("");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("shelves and restores files with option-like and spaces-in-names", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);
                await writeFile(path.join(repo, "--dash.txt"), "dash content\n", "utf8");
                await writeFile(path.join(repo, "space file.txt"), "space content\n", "utf8");
                await writeFile(path.join(repo, "nested", "tracked.txt"), "modified\n", "utf8");

                await ops.shelveSave(
                    ["--dash.txt", "space file.txt", "nested/tracked.txt"],
                    "shelve test",
                );

                // Working tree should be clean after shelving
                expect(await status(repo)).toBe("");

                // Pop the shelve back
                await ops.shelvePop(0);
                const rawStatus = await status(repo);
                expect(rawStatus).toContain("--dash.txt");
                expect(rawStatus).toContain("space file.txt");
                expect(rawStatus).toContain("nested/tracked.txt");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("commits staged changes and checks post-commit status is clean", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "tracked.txt"), "new content\n", "utf8");
                await git(repo, ["add", "tracked.txt"]);
                expect(await status(repo)).toBe("M  tracked.txt\n");

                await ops.commit("feat: update tracked");
                expect(await status(repo)).toBe("");

                const lastMsg = await ops.getLastCommitMessage();
                expect(lastMsg).toContain("feat: update tracked");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("commits with --amend and verifies message is updated", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "tracked.txt"), "amend me\n", "utf8");
                await git(repo, ["add", "tracked.txt"]);
                await ops.commit("original message");

                await writeFile(path.join(repo, "tracked.txt"), "amended content\n", "utf8");
                await git(repo, ["add", "tracked.txt"]);
                await ops.commit("amended message", true);

                const lastMsg = await ops.getLastCommitMessage();
                expect(lastMsg).toContain("amended message");

                // Amending replaces the tip, so we still have:
                // initial commit (from createTempGitRepo) + amended commit = 2
                const log = await git(repo, ["log", "--oneline"]);
                const lines = log.trim().split("\n").filter(Boolean);
                expect(lines).toHaveLength(2);
                expect(lines[0]).toContain("amended message");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("handles staged-delete: deleteFile fails correctly and status stays unchanged", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                // Create a file, commit it, then delete from disk and stage the deletion
                await writeFile(path.join(repo, "to-remove.txt"), "remove me\n", "utf8");
                await git(repo, ["add", "to-remove.txt"]);
                await git(repo, ["commit", "-m", "add to-remove"]);

                await rm(path.join(repo, "to-remove.txt"));
                await git(repo, ["add", "to-remove.txt"]);
                expect(await status(repo)).toBe("D  to-remove.txt\n");

                // git rm (even with -f) fails for already-staged deletions
                // because the file is no longer on disk or in the index as a tracked entry.
                // The deletion is already complete — status stays D.
                await expect(ops.deleteFile("to-remove.txt", true)).rejects.toThrow(
                    "did not match any files",
                );
                expect(await status(repo)).toBe("D  to-remove.txt\n");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("reads file content at HEAD for option-like paths via getFileContentAtRef", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                await writeFile(path.join(repo, "--ref-file.txt"), "ref content\n", "utf8");
                await git(repo, ["add", "--", "--ref-file.txt"]);
                await git(repo, ["commit", "-m", "add ref file"]);

                const content = await ops.getFileContentAtRef("--ref-file.txt", "HEAD");
                expect(content).toBe("ref content\n");
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });
    });

    describe("unstageFiles", () => {
        it("calls git reset HEAD with paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.unstageFiles(["src/a.ts"]);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["reset", "HEAD", "--", "src/a.ts"]);
        });

        it("skips empty paths array", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.unstageFiles([]);
            expect(executor.run).not.toHaveBeenCalled();
        });
    });

    describe("commit", () => {
        it("calls git commit with message", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.commit("test message");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["commit", "-m", "test message"]);
        });

        it("includes --amend flag when amend is true", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.commit("amend message", true);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("--amend");
        });
    });

    describe("getAmendBranchCommits", () => {
        const FS = "\x1f";
        const RS = "\x1e";
        const rec = (h: string, s: string, d: string): string => `${h}${FS}${s}${FS}${d}${RS}`;

        it("returns commits from merge-base..HEAD when upstream resolves", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") return "origin/main";
                    if (k === "merge-base HEAD @{upstream}") return "deadbeef0\n";
                    if (k.startsWith("log ") && k.includes("deadbeef0..HEAD")) {
                        return (
                            rec("a111111", "msg one", "2024-01-01T00:00:00Z") +
                            rec("b222222", "msg two", "2024-01-02T00:00:00Z")
                        );
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const rows = await ops.getAmendBranchCommits(10);
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({ shortHash: "a111111", subject: "msg one" });
            expect(rows[1]).toMatchObject({ shortHash: "b222222", subject: "msg two" });
        });

        it("falls back to git log HEAD when upstream rev-parse fails", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") throw new Error("no upstream");
                    if (k.startsWith("log HEAD"))
                        return rec("z999999", "root", "2024-03-01T00:00:00Z");
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const rows = await ops.getAmendBranchCommits(5);
            expect(rows).toEqual([
                { shortHash: "z999999", subject: "root", date: "2024-03-01T00:00:00Z" },
            ]);
        });

        it("falls back to HEAD history when upstream range is empty", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") return "origin/main";
                    if (k === "merge-base HEAD @{upstream}") return "same\n";
                    if (k.startsWith("log ") && k.includes("same..HEAD")) return "";
                    if (k.startsWith("log HEAD"))
                        return rec("only", "local", "2024-01-01T00:00:00Z");
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const rows = await ops.getAmendBranchCommits(5);
            expect(rows).toHaveLength(1);
            expect(rows[0].shortHash).toBe("only");
        });

        it("parses subjects that contain tab characters without trimming subject whitespace", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") throw new Error("no upstream");
                    if (k.startsWith("log HEAD")) {
                        return rec("cafecafe", "\tfeat:\tindented\tmsg ", "2024-05-01T00:00:00Z");
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const rows = await ops.getAmendBranchCommits(5);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                shortHash: "cafecafe",
                subject: "\tfeat:\tindented\tmsg ",
                date: "2024-05-01T00:00:00Z",
            });
        });

        it("includes commits with an empty subject", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") throw new Error("no upstream");
                    if (k.startsWith("log HEAD")) {
                        return rec("abc1234", "", "2024-06-01T12:00:00Z");
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const rows = await ops.getAmendBranchCommits(5);
            expect(rows).toEqual([
                { shortHash: "abc1234", subject: "", date: "2024-06-01T12:00:00Z" },
            ]);
        });
    });

    describe("push", () => {
        it("calls git push", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.push();

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["push"]);
        });

        it("retries with --set-upstream when push fails due to missing upstream and user confirms", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push --set-upstream origin feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "push") throw noUpstreamError;
                    if (key === "push --set-upstream origin feature/no-upstream") return "ok";
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => true);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).resolves.toBe("ok");

            expect(confirmSetUpstream).toHaveBeenCalledWith("origin", "feature/no-upstream");
            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toEqual([
                ["push"],
                ["push", "--set-upstream", "origin", "feature/no-upstream"],
            ]);
        });

        it("parses short -u upstream suggestion", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push -u origin feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "push") throw noUpstreamError;
                    if (key === "push --set-upstream origin feature/no-upstream") return "ok";
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => true);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).resolves.toBe("ok");
            expect(confirmSetUpstream).toHaveBeenCalledWith("origin", "feature/no-upstream");
        });

        it("parses --set-upstream=remote upstream suggestion", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push --set-upstream=origin feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "push") throw noUpstreamError;
                    if (key === "push --set-upstream origin feature/no-upstream") return "ok";
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => true);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).resolves.toBe("ok");
            expect(confirmSetUpstream).toHaveBeenCalledWith("origin", "feature/no-upstream");
        });

        it("throws UpstreamPushDeclinedError when upstream setup is declined", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push --set-upstream origin feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.join(" ") === "push") throw noUpstreamError;
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => false);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).rejects.toThrow(UpstreamPushDeclinedError);
            expect(confirmSetUpstream).toHaveBeenCalledTimes(1);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
        });
    });

    describe("pullRebase", () => {
        it("calls git pull --rebase", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.pullRebase();

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["pull", "--rebase"]);
        });
    });

    describe("commitAndPush", () => {
        it("calls commit then push", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.commitAndPush("msg");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls;
            expect(calls[0][0]).toEqual(["rev-parse", "--abbrev-ref", "@{upstream}"]);
            expect(calls[1][0]).toEqual(["commit", "-m", "msg"]);
            expect(calls[2][0]).toEqual(["push"]);
        });

        it("checks the upstream remote before committing", async () => {
            const executor = createMockExecutor({
                "rev-parse --abbrev-ref @{upstream}": "origin/main\n",
                "ls-remote --exit-code origin": "feed1234\trefs/heads/main\n",
            });
            const ops = new GitOps(executor);
            await ops.commitAndPush("msg");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toEqual([
                ["rev-parse", "--abbrev-ref", "@{upstream}"],
                ["ls-remote", "--exit-code", "origin"],
                ["commit", "-m", "msg"],
                ["push"],
            ]);
        });

        it("does not commit when the upstream remote repository is unavailable", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "rev-parse --abbrev-ref @{upstream}") return "origin/main\n";
                    if (key === "ls-remote --exit-code origin") {
                        throw new Error(
                            "remote: Repository not found.\nfatal: repository 'https://github.com/MaheshKok/practice.git/' not found",
                        );
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.commitAndPush("msg")).rejects.toThrow(
                'Push remote "origin" is unavailable.',
            );

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toEqual([
                ["rev-parse", "--abbrev-ref", "@{upstream}"],
                ["ls-remote", "--exit-code", "origin"],
            ]);
        });
    });

    describe("getLastCommitMessage", () => {
        it("returns last commit message", async () => {
            const executor = createMockExecutor({ log: "Previous commit message\n" });
            const ops = new GitOps(executor);
            const msg = await ops.getLastCommitMessage();
            expect(msg).toBe("Previous commit message");
        });

        it("returns empty string on error", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("no commits");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const msg = await ops.getLastCommitMessage();
            expect(msg).toBe("");
        });
    });

    describe("rollbackFiles", () => {
        it("unstages and checks out tracked paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["src/a.ts"]);

            expect(executor.run).toHaveBeenCalledWith(["status", "--porcelain=v1", "-z", "-uall"]);
            expect(executor.run).toHaveBeenCalledWith(["reset", "HEAD", "--", "src/a.ts"]);
            expect(executor.run).toHaveBeenCalledWith(["checkout", "--", "src/a.ts"]);
        });

        it("cleans untracked paths without sending them to reset or checkout", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "?? new.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["new.txt"]);

            expect(executor.run).toHaveBeenCalledWith(["clean", "-fd", "--", "new.txt"]);
            expect(executor.run).not.toHaveBeenCalledWith(["reset", "HEAD", "--", "new.txt"]);
            expect(executor.run).not.toHaveBeenCalledWith(["checkout", "--", "new.txt"]);
        });

        it("resets and cleans staged added paths without checking them out", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "A  added.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["added.txt"]);

            expect(executor.run).toHaveBeenCalledWith(["reset", "HEAD", "--", "added.txt"]);
            expect(executor.run).toHaveBeenCalledWith(["clean", "-fd", "--", "added.txt"]);
            expect(executor.run).not.toHaveBeenCalledWith(["checkout", "--", "added.txt"]);
        });

        it("resets both sides of a staged rename and restores the source path", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "R  renamed.txt\0tracked.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["renamed.txt"]);

            expect(executor.run).toHaveBeenCalledWith([
                "reset",
                "HEAD",
                "--",
                "renamed.txt",
                "tracked.txt",
            ]);
            expect(executor.run).toHaveBeenCalledWith(["checkout", "--", "tracked.txt"]);
            expect(executor.run).toHaveBeenCalledWith(["clean", "-fd", "--", "renamed.txt"]);
        });

        it("skips empty paths array", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackFiles([]);
            expect(executor.run).not.toHaveBeenCalled();
        });
    });

    describe("rollbackAll", () => {
        it("calls reset --hard HEAD and clean -fd", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackAll();

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls;
            expect(calls[0][0]).toEqual(["reset", "--hard", "HEAD"]);
            expect(calls[1][0]).toEqual(["clean", "-fd"]);
        });
    });

    describe("merge conflict helpers", () => {
        it("returns conflicted files from diff-filter=U output", async () => {
            const executor = createMockExecutor({
                "diff --name-only --diff-filter=U": "src/a.ts\nsrc/b.ts\n\n",
            });
            const ops = new GitOps(executor);
            await expect(ops.getConflictedFiles()).resolves.toEqual(["src/a.ts", "src/b.ts"]);
        });

        it("returns detailed conflict file metadata from porcelain status", async () => {
            const statusOutput = "UU src/a.ts\0DU src/b.ts\0UA src/c.ts\0 M src/ok.ts\0";
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--porcelain=v1")) return statusOutput;
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getConflictFilesDetailed()).resolves.toEqual([
                { path: "src/a.ts", code: "UU", ours: "Modified", theirs: "Modified" },
                { path: "src/b.ts", code: "DU", ours: "Deleted", theirs: "Modified" },
                { path: "src/c.ts", code: "UA", ours: "Modified", theirs: "Added" },
            ]);
        });

        it("acceptConflictSide checks out chosen side and stages file", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.acceptConflictSide("src/conflicted.ts", "ours");
            await ops.acceptConflictSide("src/conflicted.ts", "theirs");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toContainEqual(["checkout", "--ours", "--", "src/conflicted.ts"]);
            expect(calls).toContainEqual(["checkout", "--theirs", "--", "src/conflicted.ts"]);
            expect(
                calls.filter((args) => args.join(" ") === "add -- src/conflicted.ts"),
            ).toHaveLength(2);
        });
    });

    describe("shelveSave", () => {
        it("calls git stash push with message", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelveSave(undefined, "my stash");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "push", "--include-untracked", "-m", "my stash"]);
        });

        it("includes paths when provided", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelveSave(["src/a.ts", "src/b.ts"], "partial");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual([
                "stash",
                "push",
                "--include-untracked",
                "-m",
                "partial",
                "--",
                "src/a.ts",
                "src/b.ts",
            ]);
        });
    });

    describe("shelvePop", () => {
        it("calls git stash pop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelvePop(2);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "pop", "stash@{2}"]);
        });
    });

    describe("shelveApply", () => {
        it("calls git stash apply with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelveApply(1);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "apply", "stash@{1}"]);
        });
    });

    describe("listShelved", () => {
        it("parses stash list output", async () => {
            const output = [
                "aaa111\tstash@{0}\tOn main: WIP\t2024-01-15T10:30:00Z",
                "bbb222\tstash@{1}\tOn main: Feature work\t2024-01-14T09:00:00Z",
            ].join("\n");

            const executor = createMockExecutor({ stash: output });
            const ops = new GitOps(executor);
            const stashes = await ops.listShelved();

            expect(stashes).toHaveLength(2);
            expect(stashes[0].index).toBe(0);
            expect(stashes[0].message).toBe("On main: WIP");
            expect(stashes[0].hash).toBe("aaa111");
            expect(stashes[1].index).toBe(1);
            expect(stashes[1].message).toBe("On main: Feature work");
        });

        it("returns empty array on error", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("no stashes");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const stashes = await ops.listShelved();
            expect(stashes).toEqual([]);
        });
    });

    describe("shelveDelete", () => {
        it("calls git stash drop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelveDelete(0);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "drop", "stash@{0}"]);
        });
    });

    describe("getUnpushedCommitHashes", () => {
        it("returns hash list when rev-list succeeds", async () => {
            const executor = createMockExecutor({
                "rev-list --branches --not --remotes": "a1b2c3d4\nfeed1234\n",
            });
            const ops = new GitOps(executor);
            await expect(ops.getUnpushedCommitHashes()).resolves.toEqual(["a1b2c3d4", "feed1234"]);
        });

        it("returns empty array when rev-list fails", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("rev-list failed");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            await expect(ops.getUnpushedCommitHashes()).resolves.toEqual([]);
        });
    });

    describe("shelved files helpers", () => {
        it("parses shelved file status and numstat", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.join(" ") === "stash show --name-status stash@{1}") {
                        return "M\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/new.ts\n";
                    }
                    if (args.join(" ") === "stash show --numstat stash@{1}") {
                        return "3\t1\tsrc/a.ts\n2\t0\tsrc/{old.ts => new.ts}\n";
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const files = await ops.getShelvedFiles(1);

            expect(files).toEqual([
                {
                    path: "src/a.ts",
                    status: "M",
                    staged: false,
                    additions: 3,
                    deletions: 1,
                },
                {
                    path: "src/new.ts",
                    status: "R",
                    staged: false,
                    additions: 2,
                    deletions: 0,
                },
            ]);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "--name-status", "stash@{1}"],
            ]);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "--numstat", "stash@{1}"],
            ]);
        });

        it("returns partial/empty results when stash show commands fail", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("stash show failed");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            await expect(ops.getShelvedFiles(0)).resolves.toEqual([]);
        });

        it("returns shelved patch with expected git args", async () => {
            const executor = createMockExecutor({
                "diff stash@{0}^ stash@{0} -- src/a.ts": "diff --git a/src/a.ts b/src/a.ts",
            });
            const ops = new GitOps(executor);

            await expect(ops.getShelvedFilePatch(0, "src/a.ts")).resolves.toContain("diff --git");
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["diff", "stash@{0}^", "stash@{0}", "--", "src/a.ts"],
            ]);
        });

        it("returns file history with expected git args", async () => {
            const executor = createMockExecutor({
                "log --max-count=25": "a1b2c3  author  date  msg",
            });
            const ops = new GitOps(executor);

            await expect(ops.getFileHistory("src/a.ts", 25)).resolves.toContain("a1b2c3");
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                [
                    "log",
                    "--max-count=25",
                    "--pretty=format:%h  %<(12,trunc)%an  %<(20)%ai  %s",
                    "--follow",
                    "--",
                    "src/a.ts",
                ],
            ]);
        });

        it("reads file content at a ref for option-like repo-relative paths", async () => {
            const executor = createMockExecutor({
                "show HEAD:--weird.txt": "content",
            });
            const ops = new GitOps(executor);

            await expect(ops.getFileContentAtRef("--weird.txt", "HEAD")).resolves.toBe("content");
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["show", "HEAD:--weird.txt"],
            ]);
        });

        it("rejects traversal paths before reading file content at a ref", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await expect(ops.getFileContentAtRef("../secret.txt", "HEAD")).rejects.toThrow(
                "escaping repo root",
            );
            expect(executor.run).not.toHaveBeenCalled();
        });

        it("runs shelve pop/apply/delete commands for valid indexes", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await expect(ops.shelvePop(0)).resolves.toBe("");
            await expect(ops.shelveApply(0)).resolves.toBe("");
            await expect(ops.shelveDelete(0)).resolves.toBe("");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toContainEqual(["stash", "pop", "stash@{0}"]);
            expect(calls).toContainEqual(["stash", "apply", "stash@{0}"]);
            expect(calls).toContainEqual(["stash", "drop", "stash@{0}"]);
        });

        it("honors force flag when deleting files", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.deleteFile("src/a.ts");
            await ops.deleteFile("src/b.ts", true);

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toContainEqual(["rm", "--", "src/a.ts"]);
            expect(calls).toContainEqual(["rm", "-f", "--", "src/b.ts"]);
        });

        it("rejects invalid stash indexes", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await expect(ops.shelvePop(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.shelveApply(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.shelveDelete(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.getShelvedFiles(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.getShelvedFilePatch(-1, "x")).rejects.toThrow("Invalid stash index");
        });
    });

    describe("getLog --fixed-strings (SEC-M2)", () => {
        it("includes --fixed-strings when filterText is provided", async () => {
            const run = vi.fn(async () => "");
            const executor = { run } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await ops.getLog(10, undefined, "search(term");

            const args = run.mock.calls[0][0] as string[];
            expect(args).toContain("--fixed-strings");
            expect(args.some((a: string) => a.startsWith("--grep="))).toBe(true);
        });

        it("does not include --fixed-strings when no filterText", async () => {
            const run = vi.fn(async () => "");
            const executor = { run } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await ops.getLog(10);

            const args = run.mock.calls[0][0] as string[];
            expect(args).not.toContain("--fixed-strings");
        });

        it("passes filterText as literal string (no regex interpretation)", async () => {
            const run = vi.fn(async () => "");
            const executor = { run } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            // Regex metacharacters that would cause ReDoS without --fixed-strings
            await ops.getLog(10, undefined, "(a+)+$");

            const args = run.mock.calls[0][0] as string[];
            expect(args).toContain("--fixed-strings");
            expect(args).toContain("--grep=(a+)+$");
        });
    });
});
