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
    describe("merge conflict helpers", () => {
        it("returns conflicted files from diff-filter=U output", async () => {
            const executor = createMockExecutor({
                "diff --name-only -z --diff-filter=U": "src/a.ts\0src/b.ts\0",
            });
            const ops = new GitOps(executor);
            await expect(ops.getConflictedFiles()).resolves.toEqual(["src/a.ts", "src/b.ts"]);
        });

        it("preserves leading and trailing spaces in conflicted file paths", async () => {
            const executor = createMockExecutor({
                "diff --name-only -z --diff-filter=U": " leading.ts\0src/trailing.ts \0",
            });
            const ops = new GitOps(executor);
            await expect(ops.getConflictedFiles()).resolves.toEqual([
                " leading.ts",
                "src/trailing.ts ",
            ]);
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
            expect(calls).toContainEqual([
                "--literal-pathspecs",
                "checkout",
                "--ours",
                "--",
                "src/conflicted.ts",
            ]);
            expect(calls).toContainEqual([
                "--literal-pathspecs",
                "checkout",
                "--theirs",
                "--",
                "src/conflicted.ts",
            ]);
            expect(
                calls.filter(
                    (args) => args.join(" ") === "--literal-pathspecs add -- src/conflicted.ts",
                ),
            ).toHaveLength(2);
        });
    });
});
