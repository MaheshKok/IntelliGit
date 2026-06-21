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

        it("reads a remote URL for host-side provider metadata", async () => {
            const executor = createMockExecutor({
                "remote get-url origin": "https://github.com/user/repo.git\n",
            });
            const ops = new GitOps(executor);

            await expect(ops.getRemoteUrl("origin")).resolves.toBe(
                "https://github.com/user/repo.git",
            );
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
                "remote",
                "get-url",
                "origin",
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
    describe("getAmendBranchCommits", () => {
        const FS = "\0";
        const rec = (h: string, s: string, d: string): string => `${h}${FS}${s}${FS}${d}${FS}`;

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

        it("parses amend summary records separated by git log -z record NULs", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const k = args.join(" ");
                    if (k === "rev-parse --abbrev-ref @{upstream}") throw new Error("no upstream");
                    if (k.startsWith("log HEAD")) {
                        return (
                            rec("a111111", "msg one", "2024-01-01T00:00:00Z") +
                            FS +
                            rec("b222222", "msg two", "2024-01-02T00:00:00Z")
                        );
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            const rows = await ops.getAmendBranchCommits(10);

            expect(rows.map((row) => row.shortHash)).toEqual(["a111111", "b222222"]);
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
    describe("rollbackFiles", () => {
        it("unstages and checks out tracked paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["src/a.ts"]);

            expect(executor.run).toHaveBeenCalledWith(["status", "--porcelain=v1", "-z", "-uall"]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "reset",
                "HEAD",
                "--",
                "src/a.ts",
            ]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "checkout",
                "--",
                "src/a.ts",
            ]);
        });

        it("cleans untracked paths without sending them to reset or checkout", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "?? new.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["new.txt"]);

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "clean",
                "-fd",
                "--",
                "new.txt",
            ]);
            expect(executor.run).not.toHaveBeenCalledWith([
                "--literal-pathspecs",
                "reset",
                "HEAD",
                "--",
                "new.txt",
            ]);
            expect(executor.run).not.toHaveBeenCalledWith([
                "--literal-pathspecs",
                "checkout",
                "--",
                "new.txt",
            ]);
        });

        it("resets and cleans staged added paths without checking them out", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "A  added.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["added.txt"]);

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "reset",
                "HEAD",
                "--",
                "added.txt",
            ]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "clean",
                "-fd",
                "--",
                "added.txt",
            ]);
            expect(executor.run).not.toHaveBeenCalledWith([
                "--literal-pathspecs",
                "checkout",
                "--",
                "added.txt",
            ]);
        });

        it("resets both sides of a staged rename and restores the source path", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": "R  renamed.txt\0tracked.txt\0",
            });
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["renamed.txt"]);

            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "reset",
                "HEAD",
                "--",
                "renamed.txt",
                "tracked.txt",
            ]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "checkout",
                "--",
                "tracked.txt",
            ]);
            expect(executor.run).toHaveBeenCalledWith([
                "--literal-pathspecs",
                "clean",
                "-fd",
                "--",
                "renamed.txt",
            ]);
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
});
