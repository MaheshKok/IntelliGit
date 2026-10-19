import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { readWorkingFileStats } from "../../../src/git/workingFileStats";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
};

/** Runs fixture-only Git commands without user configuration. */
function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
}

/** Git publishes every index write by renaming index.lock, so an unchanged identity means no lock. */
function indexIdentity(root: string): string {
    const stat = statSync(path.join(root, ".git", "index"), { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
}

describe("background working-tree statistics using real Git", () => {
    let root: string;
    let executor: GitExecutor;

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "intelligit-stats-lock-"));
        git(root, "init", "--initial-branch=main");
        git(root, "config", "user.name", "Fixture");
        git(root, "config", "user.email", "fixture@example.test");
        writeFileSync(path.join(root, "rewritten.txt"), "same\n");
        writeFileSync(path.join(root, "changed.txt"), "one\ntwo\n");
        git(root, "add", ".");
        git(root, "commit", "-m", "base");
        // A shelve or checkout rewrites files with identical bytes; only their stat data changes.
        writeFileSync(path.join(root, "rewritten.txt"), "same\n");
        writeFileSync(path.join(root, "changed.txt"), "one\nthree\nfour\n");
        const later = new Date(Date.now() + 5_000);
        utimesSync(path.join(root, "rewritten.txt"), later, later);
        utimesSync(path.join(root, "changed.txt"), later, later);
        executor = new GitExecutor(root, undefined, gitEnv);
    });

    afterEach(() => {
        removeScratchDirectoriesSync(root);
    });

    it("reads eager unstaged line counts without writing the index", async () => {
        const before = indexIdentity(root);

        const files = await new GitOps(executor).getStatus();

        expect(files.find((file) => file.path === "changed.txt")).toMatchObject({
            staged: false,
            additions: 2,
            deletions: 1,
        });
        expect(files.some((file) => file.path === "rewritten.txt")).toBe(false);
        expect(indexIdentity(root)).toBe(before);
    });

    it("reads lazy unstaged line counts without writing the index", async () => {
        const files = await new GitOps(executor).getStatus({ withStats: false });
        // A concurrent shelve restores the listed file to its indexed bytes after the snapshot.
        writeFileSync(path.join(root, "changed.txt"), "one\ntwo\n");
        const later = new Date(Date.now() + 10_000);
        utimesSync(path.join(root, "changed.txt"), later, later);
        const before = indexIdentity(root);

        const stats = await readWorkingFileStats(executor, files, ["changed.txt"]);

        expect(stats).toEqual([
            expect.objectContaining({ path: "changed.txt", additions: 0, deletions: 0 }),
        ]);
        expect(indexIdentity(root)).toBe(before);
    });
});
