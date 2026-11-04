/**
 * Pins what a shelf index write does when renaming its `index.lock` onto the index is refused.
 *
 * Windows refuses to rename onto a file another process has open, answering `EPERM`, and Git
 * readers open the index briefly, so there the write waits and retries; elsewhere the same errno
 * is a real fault. The refusal has to be supplied on a POSIX host, so `rename` is wrapped.
 *
 * Kept out of `shelve-index-lock.integration.test.ts`: `vi.mock` applies to a whole module for the
 * whole file, and those tests need the real `rename`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitExecutor } from "../../../src/git/executor";
import { GitExecutorRecoveryGit } from "../../../src/shelf/recoveryGit";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

/** Makes the next `remaining` renames of an `index.lock` fail with `code`. */
const renameProbe = vi.hoisted(() => ({
    code: undefined as string | undefined,
    remaining: 0,
}));

// Node's built-in `node:fs/promises` exports non-configurable properties, so `vi.spyOn` cannot wrap
// them; `vi.mock` with a pass-through factory is vitest's standard workaround.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const renameWithInjectedRefusal: typeof actual.rename = async (from, to) => {
        if (
            renameProbe.code !== undefined &&
            renameProbe.remaining > 0 &&
            String(from).endsWith("index.lock")
        ) {
            renameProbe.remaining -= 1;
            const failure: NodeJS.ErrnoException = new Error(
                `${renameProbe.code}: operation not permitted, rename '${String(from)}' -> '${String(to)}'`,
            );
            failure.code = renameProbe.code;
            failure.syscall = "rename";
            throw failure;
        }
        return actual.rename(from, to);
    };
    return { ...actual, rename: renameWithInjectedRefusal };
});

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const originalPlatform = process.platform;

/** Supplies the platform rather than inheriting it, so the Windows branch is reachable on POSIX. */
function pretendPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(async () => {
    renameProbe.code = undefined;
    renameProbe.remaining = 0;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function git(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout;
}

/** A repository with a.txt staged, plus the object ID of another blob to stage over it. */
async function stagedRepository(): Promise<{ root: string; oid: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-rename-"));
    directories.push(root);
    await git(root, ["init"]);
    await writeFile(path.join(root, "a.txt"), "a\n");
    await git(root, ["add", "a.txt"]);
    await writeFile(path.join(root, "b.txt"), "b\n");
    return { root, oid: (await git(root, ["hash-object", "-w", "--", "b.txt"])).trim() };
}

describe("GitExecutorRecoveryGit.writeIndexEntry when renaming index.lock onto the index is refused", () => {
    it("retries while Windows reports the index busy, then publishes the write", async () => {
        pretendPlatform("win32");
        renameProbe.code = "EPERM";
        renameProbe.remaining = 1;
        const { root, oid } = await stagedRepository();

        await new GitExecutorRecoveryGit(new GitExecutor(root)).writeIndexEntry("a.txt", {
            mode: "100644",
            oid,
        });

        expect(renameProbe.remaining, "the injected EPERM must have been served").toBe(0);
        expect(
            await git(root, ["ls-files", "--stage", "--", "a.txt"]),
            "the retried rename publishes the write",
        ).toBe(`100644 ${oid} 0\ta.txt\n`);
        expect(
            existsSync(path.join(root, ".git", "index.lock")),
            "the lock file became the index",
        ).toBe(false);
    });

    it("fails on the same refusal elsewhere, leaving the index as it was and no index.lock", async () => {
        pretendPlatform("linux");
        renameProbe.code = "EPERM";
        renameProbe.remaining = 1;
        const { root, oid } = await stagedRepository();
        const before = await git(root, ["ls-files", "--stage", "--", "a.txt"]);

        await expect(
            new GitExecutorRecoveryGit(new GitExecutor(root)).writeIndexEntry("a.txt", {
                mode: "100644",
                oid,
            }),
        ).rejects.toThrow(/^EPERM/);

        expect(
            await git(root, ["ls-files", "--stage", "--", "a.txt"]),
            "the index keeps its entry",
        ).toBe(before);
        expect(
            existsSync(path.join(root, ".git", "index.lock")),
            "a failed write removes the index.lock it took",
        ).toBe(false);
    });
});
