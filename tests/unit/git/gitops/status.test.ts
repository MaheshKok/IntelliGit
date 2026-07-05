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

        it("returns false when rev-parse reports false", async () => {
            const executor = createMockExecutor({ "rev-parse": "false\n" });
            const ops = new GitOps(executor);
            expect(await ops.isRepository()).toBe(false);
        });
    });
    describe("abortMerge", () => {
        it.each([
            ["MERGE_HEAD", ["merge", "--abort"]],
            ["REBASE_HEAD", ["rebase", "--abort"]],
            ["CHERRY_PICK_HEAD", ["cherry-pick", "--abort"]],
        ])("uses the abort command for %s", async (activeRef, expectedCommand) => {
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    const key = args.join(" ");
                    if (key.startsWith("rev-parse --verify --quiet ")) {
                        if (key.endsWith(activeRef)) return "";
                        throw new Error("missing ref");
                    }
                    return "";
                }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);

            await ops.abortMerge();

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toEqual(
                expectedCommand,
            );
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

        it("marks default branches and parses branch tip dates", async () => {
            const output = [
                "refs/remotes/origin/HEAD\torigin\tabc1234\t\t\t \torigin/main\t1700000000",
                "refs/heads/main\tmain\tabc1234\torigin/main\t\t \t\t1700000000",
                "refs/heads/codex/work\tcodex/work\tdef5678\t\t\t*\t\t1700000100",
                "refs/remotes/origin/main\torigin/main\tabc1234\t\t\t \t\t1700000000",
                "refs/remotes/origin/codex/work\torigin/codex/work\tdef5678\t\t\t \t\t1700000100",
            ].join("\n");

            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();

            expect(branches.find((branch) => branch.name === "main")?.isDefault).toBe(true);
            expect(branches.find((branch) => branch.name === "origin/main")?.isDefault).toBe(true);
            expect(
                branches.find((branch) => branch.name === "codex/work")?.isDefault,
            ).toBeUndefined();
            expect(branches.find((branch) => branch.name === "codex/work")?.committerDate).toBe(
                1700000100,
            );
        });

        it("leaves missing branch tip dates undefined", async () => {
            const output = "refs/heads/main\tmain\tabc1234\torigin/main\t\t*\t\t\n";
            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();

            expect(branches[0].committerDate).toBeUndefined();
        });

        it("does not pin main when Git reports a different default branch", async () => {
            const output = [
                "refs/remotes/origin/HEAD\torigin\tabc1234\t\t\t \torigin/trunk\t1700000000",
                "refs/heads/main\tmain\tabc1234\torigin/main\t\t \t\t1700000000",
                "refs/heads/trunk\ttrunk\tdef5678\torigin/trunk\t\t*\t\t1700000100",
                "refs/remotes/origin/main\torigin/main\tabc1234\t\t\t \t\t1700000000",
                "refs/remotes/origin/trunk\torigin/trunk\tdef5678\t\t\t \t\t1700000100",
            ].join("\n");

            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();

            expect(branches.find((branch) => branch.name === "trunk")?.isDefault).toBe(true);
            expect(branches.find((branch) => branch.name === "origin/trunk")?.isDefault).toBe(true);
            expect(branches.find((branch) => branch.name === "main")?.isDefault).toBeUndefined();
            expect(
                branches.find((branch) => branch.name === "origin/main")?.isDefault,
            ).toBeUndefined();
        });

        it("ignores malformed remote HEAD mappings when deriving local defaults", async () => {
            const output = [
                "refs/remotes/bad@/HEAD\tbad@\tabc1234\t\t\t \tbad@/trunk\t1700000000",
                "refs/heads/trunk\ttrunk\tdef5678\t\t\t*\t\t1700000100",
            ].join("\n");

            const executor = createMockExecutor({ branch: output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();

            expect(branches.find((branch) => branch.name === "trunk")?.isDefault).toBeUndefined();
        });
    });

    describe("hasUncommittedChanges", () => {
        it("checks porcelain status without loading numstat", async () => {
            const executor = createMockExecutor({
                "status --porcelain=v1 -z -uall": " M src/foo.ts\0",
            });
            const ops = new GitOps(executor);

            await expect(ops.hasUncommittedChanges()).resolves.toBe(true);
            expect(executor.run).toHaveBeenCalledTimes(1);
            expect(executor.run).toHaveBeenCalledWith(["status", "--porcelain=v1", "-z", "-uall"]);
        });

        it("returns false for a clean porcelain status", async () => {
            const executor = createMockExecutor({ "status --porcelain=v1 -z -uall": "" });
            const ops = new GitOps(executor);

            await expect(ops.hasUncommittedChanges()).resolves.toBe(false);
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

        it("parses ignored files only when requested", async () => {
            const statusOutput = "!! dist/bundle.js\0";
            const executor = {
                run: vi.fn(async (args: string[]) => {
                    if (args.includes("--porcelain=v1")) return statusOutput;
                    return "";
                }),
            } as unknown as GitExecutor;

            const ops = new GitOps(executor);
            const files = await ops.getStatus({ includeIgnored: true });

            expect(executor.run).toHaveBeenCalledWith([
                "status",
                "--porcelain=v1",
                "-z",
                "-uall",
                "--ignored",
            ]);
            expect(files).toEqual([
                {
                    path: "dist/bundle.js",
                    status: "!",
                    staged: false,
                    additions: 0,
                    deletions: 0,
                },
            ]);
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

        it("treats Git pathspec magic syntax as a literal selected path", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(new RealGitExecutor(repo) as unknown as GitExecutor);
                const magicPath = ":(glob)*";
                await writeFile(path.join(repo, magicPath), "magic\n", "utf8");
                await writeFile(path.join(repo, "victim.txt"), "victim\n", "utf8");

                await ops.stageFiles([magicPath]);

                const staged = (await git(repo, ["diff", "--cached", "--name-only", "-z"]))
                    .split("\0")
                    .filter(Boolean);
                expect(staged).toEqual([magicPath]);

                await ops.rollbackFiles([magicPath]);

                const remaining = (await git(repo, ["status", "--porcelain=v1", "-z"]))
                    .split("\0")
                    .filter(Boolean);
                expect(remaining).toEqual(["?? victim.txt"]);
            } finally {
                await rm(repo, { recursive: true, force: true });
            }
        });

        it("marks unversioned paths intent-to-add with literal pathspec handling", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor) as GitOps & {
                intentToAddFiles(paths: string[]): Promise<void>;
            };

            await ops.intentToAddFiles(["space name.txt", "--weird.txt", ":(glob)*"]);

            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
                "--literal-pathspecs",
                "add",
                "--intent-to-add",
                "--",
                "space name.txt",
                "--weird.txt",
                ":(glob)*",
            ]);
        });

        it("moves unversioned files into the unstaged changes group without staging contents", async () => {
            const repo = await createTempGitRepo();
            try {
                const ops = new GitOps(
                    new RealGitExecutor(repo) as unknown as GitExecutor,
                ) as GitOps & {
                    intentToAddFiles(paths: string[]): Promise<void>;
                };
                await writeFile(path.join(repo, "new-file.txt"), "draft\n", "utf8");

                await ops.intentToAddFiles(["new-file.txt"]);

                expect(await status(repo)).toBe(" A new-file.txt\n");
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
