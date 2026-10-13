import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

/** Creates a real staged file so index writes are observable without authoring a commit. */
async function withStagedFile(
    run: (executor: GitExecutor, directory: string) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-index-refresh-"));
    try {
        const executor = new GitExecutor(directory);
        await executor.run(["init", "--quiet"]);
        await executor.run(["config", "core.autocrlf", "false"]);
        await writeFile(join(directory, "tracked.txt"), "original\n");
        await executor.run(["add", "--", "tracked.txt"]);
        await run(executor, directory);
    } finally {
        await removeScratchDirectories(directory);
    }
}

describe("GitExecutor background index refresh", () => {
    beforeEach(() => {
        vi.stubEnv("GIT_OPTIONAL_LOCKS", undefined);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("does not rewrite the index during a background status read", async () => {
        await withStagedFile(async (executor, directory) => {
            const args = ["status", "--porcelain=v1"];
            const indexPath = join(directory, ".git", "index");
            const originalIndex = await readFile(indexPath);
            // Force a stat-cache miss without changing file contents or racing filesystem clocks.
            const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
            await utimes(join(directory, "tracked.txt"), oldTimestamp, oldTimestamp);

            expect(await executor.run(args)).toBe("A  tracked.txt\n");
            expect(await readFile(indexPath)).toEqual(originalIndex);

            // Positive control: the same read really would refresh the index with locks enabled.
            // Merely testing status with an existing lock would miss the regression: Git can
            // silently skip a refresh when the lock is already held, but take it otherwise.
            expect(await executor.run(args, { env: { GIT_OPTIONAL_LOCKS: "1" } })).toBe(
                "A  tracked.txt\n",
            );
            expect(await readFile(indexPath)).not.toEqual(originalIndex);
        });
    });

    it("reads around an existing index lock while preserving a mutation's real lock error", async () => {
        await withStagedFile(async (executor, directory) => {
            const indexPath = join(directory, ".git", "index");
            const lockPath = `${indexPath}.lock`;
            const originalIndex = await readFile(indexPath);
            const lockContents = "another writer owns this lock\n";
            await writeFile(lockPath, lockContents);
            await writeFile(join(directory, "tracked.txt"), "modified\n");

            expect(await executor.run(["status", "--porcelain=v1"])).toBe("AM tracked.txt\n");
            const diff = await executor.runBinary(["diff", "--", "tracked.txt"]);
            expect(diff.stdout.toString("utf8")).toContain("+modified");
            await expect(executor.run(["add", "--", "tracked.txt"])).rejects.toThrow(
                /index\.lock.*File exists/,
            );
            expect(await readFile(lockPath, "utf8")).toBe(lockContents);
            expect(await readFile(indexPath)).toEqual(originalIndex);
        });
    });
});
