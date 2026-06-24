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
    describe("push", () => {
        it("calls git push", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.push();

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toEqual([["rev-parse", "--abbrev-ref", "HEAD"], ["push"]]);
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
                    if (key === "rev-parse --abbrev-ref HEAD") return "feature/no-upstream\n";
                    if (key === "remote") return "origin\n";
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
                ["rev-parse", "--abbrev-ref", "HEAD"],
                ["rev-parse", "--abbrev-ref", "@{upstream}"],
                ["push"],
                ["rev-parse", "--abbrev-ref", "HEAD"],
                ["remote"],
                ["push", "--set-upstream", "origin", "feature/no-upstream"],
            ]);
        });

        it("ignores stderr upstream suggestions and derives retry args from local git state", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push -u --receive-pack=/tmp/pwn feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "push") throw noUpstreamError;
                    if (key === "rev-parse --abbrev-ref HEAD") return "feature/no-upstream\n";
                    if (key === "remote") return "origin\n";
                    if (key === "push --set-upstream origin feature/no-upstream") return "ok";
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => true);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).resolves.toBe("ok");
            expect(confirmSetUpstream).toHaveBeenCalledWith("origin", "feature/no-upstream");
            expect(executor.run).not.toHaveBeenCalledWith([
                "push",
                "--set-upstream",
                "--receive-pack=/tmp/pwn",
                "feature/no-upstream",
            ]);
        });

        it("uses the first valid configured remote for missing-upstream retries", async () => {
            const noUpstreamError = new Error(
                [
                    "fatal: The current branch feature/no-upstream has no upstream branch.",
                    "To push the current branch and set the remote as upstream, use",
                    "",
                    "    git push --set-upstream=evil feature/no-upstream",
                ].join("\n"),
            );
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "push") throw noUpstreamError;
                    if (key === "rev-parse --abbrev-ref HEAD") return "feature/no-upstream\n";
                    if (key === "remote") return "--bad\norigin\n";
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
                    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
                        return "feature/no-upstream\n";
                    }
                    if (args.join(" ") === "remote") return "origin\n";
                    return "";
                }),
            } as unknown as GitExecutor;
            const confirmSetUpstream = vi.fn(async () => false);
            const ops = new GitOps(executor, confirmSetUpstream);

            await expect(ops.push()).rejects.toThrow(UpstreamPushDeclinedError);
            expect(confirmSetUpstream).toHaveBeenCalledTimes(1);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
                ["rev-parse", "--abbrev-ref", "HEAD"],
                ["rev-parse", "--abbrev-ref", "@{upstream}"],
                ["push"],
                ["rev-parse", "--abbrev-ref", "HEAD"],
                ["remote"],
            ]);
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
                "--literal-pathspecs",
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
    describe("shelveDelete", () => {
        it("calls git stash drop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelveDelete(0);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "drop", "stash@{0}"]);
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
    describe("shelvePop", () => {
        it("calls git stash pop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.shelvePop(2);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "pop", "stash@{2}"]);
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
                ["--literal-pathspecs", "diff", "stash@{0}^", "stash@{0}", "--", "src/a.ts"],
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
                    "--literal-pathspecs",
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
            expect(calls).toContainEqual(["--literal-pathspecs", "rm", "--", "src/a.ts"]);
            expect(calls).toContainEqual(["--literal-pathspecs", "rm", "-f", "--", "src/b.ts"]);
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
});
