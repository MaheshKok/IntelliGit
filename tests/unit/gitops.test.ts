import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitOps } from "../../src/git/operations";
import type { GitExecutor } from "../../src/git/executor";

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

describe("GitOps", () => {
    describe("isRepository", () => {
        it("returns true when rev-parse succeeds", async () => {
            const executor = createMockExecutor({ "rev-parse": "true" });
            const ops = new GitOps(executor);
            expect(await ops.isRepository()).toBe(true);
        });

        it("returns false when rev-parse throws", async () => {
            const executor = {
                run: vi.fn(async () => { throw new Error("not a repo"); }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            expect(await ops.isRepository()).toBe(false);
        });
    });

    describe("getBranches", () => {
        it("parses local and remote branches", async () => {
            const output = [
                "refs/heads/main\tmain\tabc1234\torigin/main\tahead 2\t*",
                "refs/heads/feature\tfeature\tdef5678\torigin/feature\t\t ",
                "refs/remotes/origin/main\torigin/main\tabc1234\t\t\t ",
            ].join("\n");

            const executor = createMockExecutor({ "branch": output });
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
            const executor = createMockExecutor({ "branch": output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();
            expect(branches).toHaveLength(0);
        });

        it("parses behind count", async () => {
            const output = "refs/heads/main\tmain\tabc1234\torigin/main\tbehind 3\t*\n";
            const executor = createMockExecutor({ "branch": output });
            const ops = new GitOps(executor);
            const branches = await ops.getBranches();
            expect(branches[0].behind).toBe(3);
            expect(branches[0].ahead).toBe(0);
        });
    });

    describe("getLog", () => {
        const FIELD_SEP = "<<|>>";
        const RECORD_SEP = "<<||>>";

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
            return [hash, shortHash, message, author, email, date, parents, refs].join(FIELD_SEP) + RECORD_SEP;
        }

        it("parses commit records", async () => {
            const output = makeCommitRecord(
                "abc123full", "abc123", "Initial commit",
                "John", "john@test.com", "2024-01-01T00:00:00Z",
                "", "HEAD -> main",
            );
            const executor = createMockExecutor({ "log": output });
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

        it("parses parent hashes", async () => {
            const output = makeCommitRecord(
                "abc123", "abc", "Merge", "A", "a@b.com", "2024-01-01T00:00:00Z",
                "parent1 parent2", "",
            );
            const executor = createMockExecutor({ "log": output });
            const ops = new GitOps(executor);
            const commits = await ops.getLog();
            expect(commits[0].parentHashes).toEqual(["parent1", "parent2"]);
        });

        it("passes branch filter argument", async () => {
            const executor = createMockExecutor({ "log": "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, "feature");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("feature");
            expect(call).not.toContain("--all");
        });

        it("passes filter text argument", async () => {
            const executor = createMockExecutor({ "log": "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, undefined, "fix bug");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("--grep=fix bug");
            expect(call).toContain("-i");
        });

        it("passes skip argument for pagination", async () => {
            const executor = createMockExecutor({ "log": "" });
            const ops = new GitOps(executor);
            await ops.getLog(100, undefined, undefined, 200);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toContain("--skip=200");
        });
    });

    describe("getCommitDetail", () => {
        const FIELD_SEP = "<<|>>";

        it("parses commit detail with files", async () => {
            const showOutput = [
                "abc123full", "abc123", "Fix bug", "Body text",
                "John", "john@test.com", "2024-01-01T00:00:00Z",
                "parent1", "HEAD -> main",
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

            const unstaged = files.filter(f => !f.staged);
            const staged = files.filter(f => f.staged);

            expect(unstaged.some(f => f.path === "src/foo.ts" && f.status === "M")).toBe(true);
            expect(unstaged.some(f => f.path === "src/new.ts" && f.status === "?")).toBe(true);
            expect(staged.some(f => f.path === "src/added.ts" && f.status === "A")).toBe(true);
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

            const bothEntries = files.filter(f => f.path === "src/both.ts");
            expect(bothEntries).toHaveLength(2);
            expect(bothEntries.some(f => f.staged)).toBe(true);
            expect(bothEntries.some(f => !f.staged)).toBe(true);
        });

        it("parses rename entries from porcelain -z output", async () => {
            const statusOutput = "R  src/new-name.ts\0src/old-name.ts\0";
            const stagedStatOutput = "1\t0\tsrc/new-name.ts\n";

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

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["add", "--", "src/a.ts", "src/b.ts"]);
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

        it("throws original push error when upstream setup is declined", async () => {
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

            await expect(ops.push()).rejects.toThrow(noUpstreamError.message);
            expect(confirmSetUpstream).toHaveBeenCalledTimes(1);
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
        });
    });

    describe("commitAndPush", () => {
        it("calls commit then push", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.commitAndPush("msg");

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls;
            expect(calls[0][0]).toEqual(["commit", "-m", "msg"]);
            expect(calls[1][0]).toEqual(["push"]);
        });
    });

    describe("getLastCommitMessage", () => {
        it("returns last commit message", async () => {
            const executor = createMockExecutor({ "log": "Previous commit message\n" });
            const ops = new GitOps(executor);
            const msg = await ops.getLastCommitMessage();
            expect(msg).toBe("Previous commit message");
        });

        it("returns empty string on error", async () => {
            const executor = {
                run: vi.fn(async () => { throw new Error("no commits"); }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const msg = await ops.getLastCommitMessage();
            expect(msg).toBe("");
        });
    });

    describe("rollbackFiles", () => {
        it("calls git checkout -- with paths", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackFiles(["src/a.ts"]);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["checkout", "--", "src/a.ts"]);
        });

        it("skips empty paths array", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackFiles([]);
            expect(executor.run).not.toHaveBeenCalled();
        });
    });

    describe("rollbackAll", () => {
        it("calls checkout . and clean -fd", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.rollbackAll();

            const calls = (executor.run as ReturnType<typeof vi.fn>).mock.calls;
            expect(calls[0][0]).toEqual(["checkout", "."]);
            expect(calls[1][0]).toEqual(["clean", "-fd"]);
        });
    });

    describe("stashSave", () => {
        it("calls git stash push with message", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashSave("my stash");

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "push", "-m", "my stash"]);
        });

        it("includes paths when provided", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashSave("partial", ["src/a.ts", "src/b.ts"]);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "push", "-m", "partial", "--", "src/a.ts", "src/b.ts"]);
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
    });

    describe("stashApply", () => {
        it("calls git stash apply with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashApply(1);

            const call = (executor.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(call).toEqual(["stash", "apply", "stash@{1}"]);
        });
    });

    describe("stashList", () => {
        it("parses stash list output", async () => {
            const output = [
                "aaa111\tstash@{0}\tOn main: WIP\t2024-01-15T10:30:00Z",
                "bbb222\tstash@{1}\tOn main: Feature work\t2024-01-14T09:00:00Z",
            ].join("\n");

            const executor = createMockExecutor({ "stash": output });
            const ops = new GitOps(executor);
            const stashes = await ops.stashList();

            expect(stashes).toHaveLength(2);
            expect(stashes[0].index).toBe(0);
            expect(stashes[0].message).toBe("On main: WIP");
            expect(stashes[0].hash).toBe("aaa111");
            expect(stashes[1].index).toBe(1);
            expect(stashes[1].message).toBe("On main: Feature work");
        });

        it("returns empty array on error", async () => {
            const executor = {
                run: vi.fn(async () => { throw new Error("no stashes"); }),
            } as unknown as GitExecutor;
            const ops = new GitOps(executor);
            const stashes = await ops.stashList();
            expect(stashes).toEqual([]);
        });
    });

    describe("stashDrop", () => {
        it("calls git stash drop with index", async () => {
            const executor = createMockExecutor({});
            const ops = new GitOps(executor);
            await ops.stashDrop(0);

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
            await expect(ops.getUnpushedCommitHashes()).resolves.toEqual([
                "a1b2c3d4",
                "feed1234",
            ]);
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
                        return "3\t1\tsrc/a.ts\n2\t0\tsrc/new.ts\n";
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
                "stash show -p stash@{0} -- src/a.ts": "diff --git a/src/a.ts b/src/a.ts",
            });
            const ops = new GitOps(executor);

            await expect(ops.getShelvedFilePatch(0, "src/a.ts")).resolves.toContain("diff --git");
            expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
                ["stash", "show", "-p", "stash@{0}", "--", "src/a.ts"],
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
});
