import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitOps, UpstreamPushDeclinedError } from "../../../../src/git/operations";
import type { GitExecutor } from "../../../../src/git/executor";
import { parseStashFiles } from "../../../../src/git/stashFiles";

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
    describe("stashSave", () => {
        it("calls git stash push with message", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashSave(undefined, "my stash");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "push", "--include-untracked", "-m", "my stash"]);
        });

        it("includes paths when provided", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashSave(["src/a.ts", "src/b.ts"], "partial");

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
    describe("stashDelete", () => {
        it("calls git stash drop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashDelete(0);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "drop", "stash@{0}"]);
        });
    });
    describe("stashApply", () => {
        it("calls git stash apply with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashApply(1);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "apply", "stash@{1}"]);
        });

        it("adds --index only when requested", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.stashApply(1, true);

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
                "stash",
                "apply",
                "--index",
                "stash@{1}",
            ]);
        });
    });
    describe("stashPop", () => {
        it("calls git stash pop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashPop(2);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "pop", "stash@{2}"]);
        });

        it("adds --index only when requested", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.stashPop(2, true);

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
                "stash",
                "pop",
                "--index",
                "stash@{2}",
            ]);
        });
    });
    describe("listStashes", () => {
        it("parses stash list output", async () => {
            const output = [
                "aaa111\tstash@{0}\tOn main: WIP\t2024-01-15T10:30:00Z",
                "bbb222\tstash@{1}\tOn main: Feature work\t2024-01-14T09:00:00Z",
            ].join("\n");

            const executor = createMockExecutor({ stash: output });
            const ops = new GitOps(executor);
            const stashes = await ops.listStashes();

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
            const stashes = await ops.listStashes();
            expect(stashes).toEqual([]);
        });
    });
    describe("stashed files helpers", () => {
        it("classifies authoritative untracked stash paths without relabeling tracked additions", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (
                        args.join(" ") ===
                        "stash show --include-untracked --name-status -z stash@{1}"
                    ) {
                        return "M\0src/a.ts\0A\0src/tracked-added.ts\0A\0src/untracked-added.ts\0";
                    }
                    if (
                        args.join(" ") === "stash show --include-untracked --numstat -z stash@{1}"
                    ) {
                        return [
                            "3\t1\tsrc/a.ts",
                            "2\t0\tsrc/tracked-added.ts",
                            "4\t0\tsrc/untracked-added.ts",
                            "",
                        ].join("\0");
                    }
                    if (args.join(" ") === "stash show --only-untracked --name-only -z stash@{1}") {
                        return "src/untracked-added.ts\0";
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const files = await ops.getStashFiles(1);

            expect(files).toEqual([
                {
                    path: "src/a.ts",
                    status: "M",
                    staged: false,
                    additions: 3,
                    deletions: 1,
                },
                {
                    path: "src/tracked-added.ts",
                    status: "A",
                    staged: false,
                    additions: 2,
                    deletions: 0,
                },
                {
                    path: "src/untracked-added.ts",
                    status: "?",
                    staged: false,
                    additions: 4,
                    deletions: 0,
                },
            ]);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "--include-untracked", "--name-status", "-z", "stash@{1}"],
            ]);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "--include-untracked", "--numstat", "-z", "stash@{1}"],
            ]);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "--only-untracked", "--name-only", "-z", "stash@{1}"],
            ]);
        });

        it("upserts authoritative untracked paths when primary stash metadata fails", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--only-untracked")) return "only-untracked.txt\0";
                    throw new Error("stash show failed");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getStashFiles(0)).resolves.toEqual([
                {
                    path: "only-untracked.txt",
                    status: "?",
                    staged: false,
                    additions: 0,
                    deletions: 0,
                },
            ]);
        });

        it("parses realistic NUL outputs without duplicating or corrupting special paths", () => {
            const leadingPath = " leading.txt";
            const trailingPath = "trailing.txt ";
            const newlinePath = "line\nbreak.txt";
            const nameStatus = [
                "M",
                "tracked.ts",
                "A",
                leadingPath,
                "A",
                trailingPath,
                "A",
                newlinePath,
                "R100",
                "old name.ts",
                "renamed name.ts",
                "C100",
                "source.ts",
                "copied name.ts",
                "",
            ].join("\0");
            const numstat = [
                "3\t1\ttracked.ts",
                `1\t0\t${leadingPath}`,
                `2\t0\t${trailingPath}`,
                `4\t0\t${newlinePath}`,
                "0\t0\t",
                "old name.ts",
                "renamed name.ts",
                "0\t0\t",
                "source.ts",
                "copied name.ts",
                "",
            ].join("\0");
            const untrackedPaths = [leadingPath, trailingPath, newlinePath, ""].join("\0");

            const files = parseStashFiles(nameStatus, numstat, untrackedPaths);

            expect(files).toHaveLength(6);
            expect(files).toEqual(
                expect.arrayContaining([
                    {
                        path: leadingPath,
                        status: "?",
                        staged: false,
                        additions: 1,
                        deletions: 0,
                    },
                    {
                        path: trailingPath,
                        status: "?",
                        staged: false,
                        additions: 2,
                        deletions: 0,
                    },
                    {
                        path: newlinePath,
                        status: "?",
                        staged: false,
                        additions: 4,
                        deletions: 0,
                    },
                    {
                        path: "tracked.ts",
                        status: "M",
                        staged: false,
                        additions: 3,
                        deletions: 1,
                    },
                    {
                        path: "renamed name.ts",
                        status: "R",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                    },
                    {
                        path: "copied name.ts",
                        status: "C",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                    },
                ]),
            );
        });

        it("preserves existing metadata when untracked classification fails", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--name-status")) return "A\0tracked-added.ts\0";
                    if (args.includes("--numstat")) return "2\t0\ttracked-added.ts\0";
                    if (args.includes("--only-untracked")) {
                        throw new Error("only-untracked unavailable");
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getStashFiles(0)).resolves.toEqual([
                {
                    path: "tracked-added.ts",
                    status: "A",
                    staged: false,
                    additions: 2,
                    deletions: 0,
                },
            ]);
        });

        it("returns partial/empty results when stash show commands fail", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("stash show failed");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            await expect(ops.getStashFiles(0)).resolves.toEqual([]);
        });

        it("builds a binary-safe tracked patch from the verified stable stash hash", async () => {
            const stashHash = "a".repeat(40);
            const executor = createMockExecutor({
                [`diff --binary --full-index --no-color ${stashHash}^1 ${stashHash} -- src/a.ts`]:
                    "diff --git a/src/a.ts b/src/a.ts",
            });
            const ops = new GitOps(executor);

            await expect(ops.getStashFilePatch(0, stashHash, "src/a.ts")).resolves.toContain(
                "diff --git",
            );
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                [
                    "--literal-pathspecs",
                    "diff",
                    "--binary",
                    "--full-index",
                    "--no-color",
                    `${stashHash}^1`,
                    stashHash,
                    "--",
                    "src/a.ts",
                ],
            ]);
        });

        it("falls back to the untracked parent only for an empty tracked patch", async () => {
            const stashHash = "b".repeat(40);
            const executor = {
                run: vi
                    .fn<(args: string[]) => Promise<string>>()
                    .mockResolvedValueOnce("")
                    .mockResolvedValueOnce("diff --git a/space name.txt b/space name.txt"),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getStashFilePatch(1, stashHash, "space name.txt")).resolves.toContain(
                "diff --git",
            );
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
                [
                    [
                        "--literal-pathspecs",
                        "diff",
                        "--binary",
                        "--full-index",
                        "--no-color",
                        `${stashHash}^1`,
                        stashHash,
                        "--",
                        "space name.txt",
                    ],
                ],
                [
                    [
                        "--literal-pathspecs",
                        "diff",
                        "--binary",
                        "--full-index",
                        "--no-color",
                        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
                        `${stashHash}^3`,
                        "--",
                        "space name.txt",
                    ],
                ],
            ]);
        });

        it("treats an absent untracked parent as no patch but propagates unrelated Git errors", async () => {
            const stashHash = "c".repeat(40);
            const missingParentExecutor = {
                run: vi
                    .fn<(args: string[]) => Promise<string>>()
                    .mockResolvedValueOnce("")
                    .mockRejectedValueOnce(new Error(`fatal: bad revision '${stashHash}^3'`)),
            } as unknown as GitExecutor;
            await expect(
                new GitOps(missingParentExecutor).getStashFilePatch(0, stashHash, "absent.txt"),
            ).resolves.toBe("");

            const unrelatedExecutor = {
                run: vi
                    .fn<(args: string[]) => Promise<string>>()
                    .mockResolvedValueOnce("")
                    .mockRejectedValueOnce(new Error("fatal: permission denied")),
            } as unknown as GitExecutor;
            await expect(
                new GitOps(unrelatedExecutor).getStashFilePatch(0, stashHash, "absent.txt"),
            ).rejects.toThrow("permission denied");
        });

        it("verifies the movable stash index before applying a stable-hash patch", async () => {
            const stashHash = "d".repeat(40);
            let patchFilePath = "";
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "rev-parse --verify stash@{2}^{commit}") return `${stashHash}\n`;
                    if (key.includes("diff --binary --full-index --no-color")) {
                        return "diff --git a/--odd name.bin b/--odd name.bin\n";
                    }
                    if (args[0] === "apply") {
                        patchFilePath = args.at(-1) ?? "";
                        await expect(access(patchFilePath)).resolves.toBeUndefined();
                        expect(await readFile(patchFilePath, "utf8")).toContain("diff --git");
                        return "";
                    }
                    throw new Error(`Unexpected Git command: ${key}`);
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await ops.applyStashFile(2, stashHash, "--odd name.bin");

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
                [["rev-parse", "--verify", "stash@{2}^{commit}"]],
                [
                    [
                        "--literal-pathspecs",
                        "diff",
                        "--binary",
                        "--full-index",
                        "--no-color",
                        `${stashHash}^1`,
                        stashHash,
                        "--",
                        "--odd name.bin",
                    ],
                ],
                [
                    [
                        "apply",
                        "--index",
                        "--3way",
                        "--whitespace=nowarn",
                        expect.stringContaining("selected-change.patch"),
                    ],
                ],
            ]);
            await expect(access(path.dirname(patchFilePath))).rejects.toThrow();
        });

        it("rejects invalid input and a stale stash index before patch generation", async () => {
            const stashHash = "e".repeat(40);
            const executor = createMockExecutor({ "rev-parse --verify": `${"f".repeat(40)}\n` });
            const ops = new GitOps(executor);

            await expect(ops.applyStashFile(-1, stashHash, "src/a.ts")).rejects.toThrow(
                "Invalid stash index",
            );
            await expect(ops.applyStashFile(0, "not-a-hash", "src/a.ts")).rejects.toThrow(
                "Invalid stash hash",
            );
            await expect(ops.applyStashFile(0, stashHash, "../secret.txt")).rejects.toThrow(
                "escaping repo root",
            );
            await expect(ops.applyStashFile(0, stashHash, "src/a.ts")).rejects.toThrow(
                "Stash entry changed",
            );
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
                [["rev-parse", "--verify", "stash@{0}^{commit}"]],
            ]);
        });

        it("applies and stages tracked, added, deleted, binary, and untracked stash files", async () => {
            const repo = await createTempGitRepo();
            try {
                await writeFile(path.join(repo, "delete.txt"), "delete me\n", "utf8");
                await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
                await git(repo, ["add", "."]);
                await git(repo, ["commit", "-m", "stash fixture"]);

                await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");
                await rm(path.join(repo, "delete.txt"));
                await writeFile(path.join(repo, "added.txt"), "added\n", "utf8");
                await git(repo, ["add", "added.txt"]);
                await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 255, 4, 5]));
                await writeFile(path.join(repo, "--odd name.txt"), "untracked\n", "utf8");
                await git(repo, ["stash", "push", "--include-untracked", "-m", "file fixture"]);
                const stashHash = (await git(repo, ["rev-parse", "stash@{0}"])).trim();
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);

                const cases = [
                    ["tracked.txt", "M  tracked.txt"],
                    ["added.txt", "A  added.txt"],
                    ["delete.txt", "D  delete.txt"],
                    ["binary.bin", "M  binary.bin"],
                    ["--odd name.txt", 'A  "--odd name.txt"'],
                ] as const;
                for (const [filePath, expectedStatus] of cases) {
                    await git(repo, ["reset", "--hard", "HEAD"]);
                    await git(repo, ["clean", "-fd"]);
                    await ops.applyStashFile(0, stashHash, filePath);
                    expect((await status(repo)).trim()).toBe(expectedStatus);
                    if (filePath === "binary.bin") {
                        expect(Array.from(await readFile(path.join(repo, "binary.bin")))).toEqual([
                            0, 255, 4, 5,
                        ]);
                    }
                }
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("reads before/after content with added, deleted, and untracked fallbacks", async () => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key === "show stash@{0}^1:modified.txt") return "base";
                    if (key === "show stash@{0}:modified.txt") return "stash";
                    if (key === "show stash@{0}^1:added.txt") {
                        throw new Error("fatal: path 'added.txt' does not exist in 'stash@{0}^1'");
                    }
                    if (key === "show stash@{0}:added.txt") return "added";
                    if (key === "show stash@{0}^1:deleted.txt") return "deleted";
                    if (key === "show stash@{0}:deleted.txt") {
                        throw new Error("fatal: path 'deleted.txt' does not exist in 'stash@{0}'");
                    }
                    if (key === "show stash@{0}^3:deleted.txt") {
                        throw new Error("fatal: path 'deleted.txt' does not exist in 'stash@{0}^3'");
                    }
                    if (key === "show stash@{0}^1:untracked.txt") {
                        throw new Error("fatal: path 'untracked.txt' does not exist in 'stash@{0}^1'");
                    }
                    if (key === "show stash@{0}:untracked.txt") {
                        throw new Error("fatal: path 'untracked.txt' does not exist in 'stash@{0}'");
                    }
                    if (key === "show stash@{0}^3:untracked.txt") return "untracked";
                    throw new Error(`Unexpected Git command: ${key}`);
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getStashFileContents(0, "modified.txt")).resolves.toEqual({
                before: "base",
                after: "stash",
            });
            await expect(ops.getStashFileContents(0, "added.txt")).resolves.toEqual({
                before: undefined,
                after: "added",
            });
            await expect(ops.getStashFileContents(0, "deleted.txt")).resolves.toEqual({
                before: "deleted",
                after: undefined,
            });
            await expect(ops.getStashFileContents(0, "untracked.txt")).resolves.toEqual({
                before: undefined,
                after: "untracked",
            });
        });

        it("does not hide non-missing errors while reading stash file contents", async () => {
            const executor = {
                run: vi.fn(async () => {
                    throw new Error("permission denied");
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await expect(ops.getStashFileContents(0, "src/a.ts")).rejects.toThrow(
                "permission denied",
            );
        });

        it("starts independent base and stash-tree content reads together", async () => {
            const started: string[] = [];
            const resolvers = new Map<string, (value: string) => void>();
            const executor = {
                run: vi.fn(
                    (args: string[]) =>
                        new Promise<string>((resolve) => {
                            const key = args.join(" ");
                            started.push(key);
                            resolvers.set(key, resolve);
                        }),
                ),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            const contents = ops.getStashFileContents(0, "src/a.ts");

            expect(started).toEqual([
                "show stash@{0}^1:src/a.ts",
                "show stash@{0}:src/a.ts",
            ]);
            resolvers.get("show stash@{0}^1:src/a.ts")?.("base");
            resolvers.get("show stash@{0}:src/a.ts")?.("stash");
            await expect(contents).resolves.toEqual({ before: "base", after: "stash" });
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

        it("runs stash pop/apply/delete commands for valid indexes", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await expect(ops.stashPop(0)).resolves.toBe("");
            await expect(ops.stashApply(0)).resolves.toBe("");
            await expect(ops.stashDelete(0)).resolves.toBe("");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toContainEqual(["stash", "pop", "stash@{0}"]);
            expect(calls).toContainEqual(["stash", "apply", "stash@{0}"]);
            expect(calls).toContainEqual(["stash", "drop", "stash@{0}"]);
        });

        it("runs stash branch and clear, rejecting invalid branch names before Git runs", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);

            await ops.stashBranch("feature/unstash", 0);
            await ops.stashClear();
            await expect(ops.stashBranch("--bad", 0)).rejects.toThrow("Invalid branch name");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(calls).toContainEqual(["stash", "branch", "feature/unstash", "stash@{0}"]);
            expect(calls).toContainEqual(["stash", "clear"]);
            expect(calls).toHaveLength(2);
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

            await expect(ops.stashPop(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.stashApply(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.stashDelete(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.getStashFiles(-1)).rejects.toThrow("Invalid stash index");
            await expect(ops.getStashFilePatch(-1, "a".repeat(40), "x")).rejects.toThrow(
                "Invalid stash index",
            );
        });
    });
});
