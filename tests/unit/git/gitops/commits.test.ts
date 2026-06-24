import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitOps, UpstreamPushDeclinedError } from "../../../../src/git/operations";
import type { GitExecutor } from "../../../../src/git/executor";

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
    describe("getLog", () => {
        const FIELD_SEP = "\0";

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
                FIELD_SEP
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

        it("parses multiple git log -z records separated by an extra NUL", async () => {
            const output =
                makeCommitRecord(
                    "abc123full",
                    "abc123",
                    "First",
                    "John",
                    "john@test.com",
                    "2024-01-01T00:00:00Z",
                    "",
                    "",
                ) +
                FIELD_SEP +
                makeCommitRecord(
                    "def456full",
                    "def456",
                    "Second",
                    "Jane",
                    "jane@test.com",
                    "2024-01-02T00:00:00Z",
                    "abc123full",
                    "",
                );
            const executor = createMockExecutor({ log: output });
            const ops = new GitOps(executor);

            const commits = await ops.getLog();

            expect(commits.map((commit) => commit.hash)).toEqual(["abc123full", "def456full"]);
            expect(commits[1].parentHashes).toEqual(["abc123full"]);
        });

        it("preserves literal separator text in commit subjects", async () => {
            const output = makeCommitRecord(
                "abc123full",
                "abc123",
                "Handle \x1f and \x1e in subject",
                "John",
                "john@test.com",
                "2024-01-01T00:00:00Z",
                "",
                "",
            );
            const executor = createMockExecutor({ log: output });
            const ops = new GitOps(executor);
            const commits = await ops.getLog();

            expect(commits[0].message).toBe("Handle \x1f and \x1e in subject");
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
            expect(call).toContain("-z");
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
        const FIELD_SEP = "\0";

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
    describe("stageFiles", () => {
        it("calls git add with paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stageFiles(["src/a.ts", "src/b.ts"]);

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "status",
                "--porcelain=v1",
                "-z",
                "--",
                "src/a.ts",
                "src/b.ts",
            ]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "add",
                "--",
                "src/a.ts",
                "src/b.ts",
            ]);
        });

        it("does not rerun git add for an already staged deleted file", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -- ads.py": "D  ads.py\0",
            });
            const ops = new GitOps(executor);

            await ops.stageFiles(["ads.py"]);

            expect(executor.run).toHaveBeenCalledTimes(1);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
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

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "add",
                "--",
                "ads.py",
            ]);
        });

        it("stages other selected paths when one selected path is already a staged deletion", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -- ads.py src/a.ts": "D  ads.py\0 M src/a.ts\0",
            });
            const ops = new GitOps(executor);

            await ops.stageFiles(["ads.py", "src/a.ts"]);

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "add",
                "--",
                "src/a.ts",
            ]);
        });

        it("skips empty paths array", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stageFiles([]);
            expect(executor.run).not.toHaveBeenCalled();
        });
    });
    describe("unstageFiles", () => {
        it("calls git reset HEAD with paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.unstageFiles(["src/a.ts"]);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["--literal-pathspecs", "reset", "HEAD", "--", "src/a.ts"]);
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
    describe("commitAndPush", () => {
        it("calls commit then push", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.commitAndPush("msg");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls;
            expect(calls[0][0]).toEqual(["rev-parse", "--abbrev-ref", "@{upstream}"]);
            expect(calls[1][0]).toEqual(["commit", "-m", "msg"]);
            expect(calls[2][0]).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
            expect(calls[3][0]).toEqual(["push"]);
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
                ["rev-parse", "--abbrev-ref", "HEAD"],
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
});
