import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import type { WorkingFile } from "../../../src/types";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

const file = (filePath: string, staged = false): WorkingFile => ({
    path: filePath,
    status: "M",
    staged,
    additions: 0,
    deletions: 0,
});

function binaryExecutor(run: (args: string[]) => Promise<string>): GitExecutor {
    return {
        run,
        runBinary: async (args: string[]) => ({
            stdout: Buffer.from(await run(args)),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: false,
        }),
    } as unknown as GitExecutor;
}

async function git(root: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd: root });
}

describe("viewport working-file statistics", () => {
    it("returns large status snapshots without scanning their file contents", async () => {
        const run = vi.fn(async (args: string[]) =>
            args[0] === "status"
                ? Array.from({ length: 10_000 }, (_, index) => ` M file-${index}.txt\0`).join("")
                : "",
        );
        const gitOps = new GitOps(binaryExecutor(run));
        const files = await gitOps.getStatus({ withStats: "lazy" });
        expect(files).toHaveLength(10_000);
        expect(files.every((entry) => entry.statsState === "pending")).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("keeps the existing eager statistics for small lazy snapshots", async () => {
        const run = vi.fn(async (args: string[]) => {
            if (args[0] === "status") return " M small.txt\0";
            return args.includes("--cached") ? "" : "3\t2\tsmall.txt\n";
        });
        const gitOps = new GitOps(binaryExecutor(run));
        expect(await gitOps.getStatus({ withStats: "lazy" })).toEqual([
            { ...file("small.txt"), additions: 3, deletions: 2 },
        ]);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it("reads only literal requested paths and keeps index and worktree counts separate", async () => {
        const run = vi.fn(async (args: string[]) =>
            args.includes("--cached") ? "7\t4\t:(glob)*.txt\0" : "2\t1\t:(glob)*.txt\0",
        );
        const gitOps = new GitOps(binaryExecutor(run));
        const rows = [file(":(glob)*.txt"), file(":(glob)*.txt", true), file("unrelated.txt")];
        const result = await gitOps.getWorkingFileStats(rows, [":(glob)*.txt"]);
        expect(result).toEqual([
            { ...rows[0], additions: 2, deletions: 1, statsState: "ready" },
            { ...rows[1], additions: 7, deletions: 4, statsState: "ready" },
        ]);
        expect(run).toHaveBeenCalledTimes(2);
        for (const [args] of run.mock.calls) {
            expect(args[0]).toBe("--literal-pathspecs");
            expect(args).toContain("-z");
            expect(args.slice(args.indexOf("--") + 1)).toEqual([":(glob)*.txt"]);
        }
        expect(rows[0].additions).toBe(0);
    });

    it("returns actual Git counts for split staged and worktree rows", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-working-stats-"));
        directories.push(root);
        await git(root, ["init"]);
        await git(root, ["config", "--local", "user.name", "Test User"]);
        await git(root, ["config", "--local", "user.email", "test@example.invalid"]);
        await git(root, ["config", "--local", "user.useConfigOnly", "true"]);
        await writeFile(path.join(root, "split.txt"), "base\n");
        await git(root, ["add", "--", "split.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await writeFile(path.join(root, "split.txt"), "base\nstaged\n");
        await git(root, ["add", "--", "split.txt"]);
        await writeFile(path.join(root, "split.txt"), "base\nstaged\nworking\n");

        const gitOps = new GitOps(new GitExecutor(root));
        const rows = await gitOps.getStatus({ withStats: false });
        const result = await gitOps.getWorkingFileStats(rows, ["split.txt"]);

        expect(result.find((entry) => entry.staged)).toMatchObject({
            additions: 1,
            deletions: 0,
            statsState: "ready",
        });
        expect(result.find((entry) => !entry.staged)).toMatchObject({
            additions: 1,
            deletions: 0,
            statsState: "ready",
        });
    });

    it("parses NUL-delimited names and rename destinations without decoding them", async () => {
        const destination = "new\tname\n.txt";
        const run = vi.fn(async () => `4\t3\t\0old name.txt\0${destination}\0`);
        const gitOps = new GitOps(binaryExecutor(run));
        const renamed = {
            ...file(destination, true),
            status: "R" as const,
            sourcePath: "old name.txt",
        };
        expect(await gitOps.getWorkingFileStats([renamed], [destination])).toEqual([
            { ...renamed, additions: 4, deletions: 3, statsState: "ready" },
        ]);
        for (const [args] of run.mock.calls) {
            expect(args.slice(args.indexOf("--") + 1)).toEqual([destination, "old name.txt"]);
        }
    });

    it("rejects unknown, oversized-count, and oversized-byte requests before running Git", async () => {
        const run = vi.fn(async () => "");
        const gitOps = new GitOps(binaryExecutor(run));
        await expect(gitOps.getWorkingFileStats([file("a")], ["outside"])).rejects.toThrow();
        const rows = Array.from({ length: 129 }, (_, index) => file(`${index}.txt`));
        await expect(
            gitOps.getWorkingFileStats(
                rows,
                rows.map((entry) => entry.path),
            ),
        ).rejects.toThrow();
        const renamed = { ...file("short"), status: "R" as const, sourcePath: "x".repeat(65_536) };
        await expect(gitOps.getWorkingFileStats([renamed], ["short"])).rejects.toThrow(
            "path byte budget",
        );
        expect(run).not.toHaveBeenCalled();
    });

    it("does not run an unscoped diff for an empty request", async () => {
        const run = vi.fn(async () => "");
        const gitOps = new GitOps(binaryExecutor(run));
        expect(await gitOps.getWorkingFileStats([file("a")], [])).toEqual([]);
        expect(run).not.toHaveBeenCalled();
    });

    it("waits for both reads before releasing a failed batch", async () => {
        let release!: () => void;
        const companion = new Promise<string>((resolve) => {
            release = () => resolve("");
        });
        const run = vi.fn(async (args: string[]) => {
            if (args.includes("--cached")) return companion;
            throw new Error("worktree read failed");
        });
        let rejected: unknown;
        const result = new GitOps(binaryExecutor(run))
            .getWorkingFileStats([file("a")], ["a"])
            .catch((error: unknown) => {
                rejected = error;
            });
        try {
            await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(rejected).toBeUndefined();
        } finally {
            release();
            await result;
        }
        expect(rejected).toEqual(new Error("worktree read failed"));
    });
});
