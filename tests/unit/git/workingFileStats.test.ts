import { describe, expect, it, vi } from "vitest";
import { GitOps } from "../../../src/git/operations";
import type { GitExecutor } from "../../../src/git/executor";
import type { WorkingFile } from "../../../src/types";

const file = (path: string, staged = false): WorkingFile => ({
    path,
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

describe("viewport working-file statistics", () => {
    it("returns large status snapshots without scanning their file contents", async () => {
        const run = vi.fn(async (args: string[]) =>
            args[0] === "status"
                ? Array.from({ length: 10_000 }, (_, i) => ` M file-${i}.txt\0`).join("")
                : "",
        );
        const git = new GitOps(binaryExecutor(run));
        const files = await git.getStatus({ withStats: "lazy" });
        expect(files).toHaveLength(10_000);
        expect(files.every((entry) => entry.statsState === "pending")).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("keeps the existing eager statistics for small lazy snapshots", async () => {
        const run = vi.fn(async (args: string[]) => {
            if (args[0] === "status") return " M small.txt\0";
            return args.includes("--cached") ? "" : "3\t2\tsmall.txt\n";
        });
        const git = new GitOps(binaryExecutor(run));
        expect(await git.getStatus({ withStats: "lazy" })).toEqual([
            { ...file("small.txt"), additions: 3, deletions: 2 },
        ]);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it("reads only literal requested paths and keeps index/worktree counts separate", async () => {
        const run = vi.fn(async (args: string[]) =>
            args.includes("--cached") ? "7\t4\t:(glob)*.txt\0" : "2\t1\t:(glob)*.txt\0",
        );
        const git = new GitOps(binaryExecutor(run));
        const rows = [file(":(glob)*.txt"), file(":(glob)*.txt", true), file("unrelated.txt")];
        const result = await git.getWorkingFileStats(rows, [":(glob)*.txt"]);
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

    it("parses NUL-delimited names and rename destinations without decoding them", async () => {
        const destination = "new\tname\n.txt";
        const run = vi.fn(async (_args: string[]) => `4\t3\t\0old name.txt\0${destination}\0`);
        const git = new GitOps(binaryExecutor(run));
        const renamed = {
            ...file(destination, true),
            status: "R" as const,
            sourcePath: "old name.txt",
        };
        expect(await git.getWorkingFileStats([renamed], [destination])).toEqual([
            { ...renamed, additions: 4, deletions: 3, statsState: "ready" },
        ]);
        for (const [args] of run.mock.calls) {
            expect(args.slice(args.indexOf("--") + 1)).toEqual([destination, "old name.txt"]);
        }
    });

    it("rejects unknown or oversized requests before running Git", async () => {
        const run = vi.fn(async () => "");
        const git = new GitOps(binaryExecutor(run));
        await expect(git.getWorkingFileStats([file("a")], ["outside"])).rejects.toThrow();
        const rows = Array.from({ length: 129 }, (_, i) => file(`${i}.txt`));
        await expect(
            git.getWorkingFileStats(
                rows,
                rows.map((entry) => entry.path),
            ),
        ).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
    });

    it("does not run an unscoped diff for an empty request", async () => {
        const run = vi.fn(async () => "");
        const git = new GitOps(binaryExecutor(run));
        expect(await git.getWorkingFileStats([file("a")], [])).toEqual([]);
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
