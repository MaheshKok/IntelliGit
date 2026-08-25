/**
 * Pins how `restoreIndexSnapshot` judges a contended `index.lock`.
 *
 * The defect is invisible on the host that runs this suite. On POSIX an occupied path answers
 * `EEXIST` and always did, so the sibling test in `operations.test.ts` -- which plants a real
 * `.lock` file and asserts the copy fallback -- passes identically with and without the fix. Only
 * the errno Windows substitutes tells them apart, and it has to be supplied rather than waited for.
 *
 * Kept out of `operations.test.ts` deliberately: `vi.mock` applies to a whole module for the whole
 * file, and that file has thirty-odd tests with no interest in a mocked filesystem.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";

/** Makes the exclusive create of an `index.lock` fail with a chosen errno for the next
 * `remaining` attempts, so the errno Windows answers with is reachable from a POSIX host, and
 * records how often the lock was renamed onto the index. That count is the only thing separating
 * the two restore paths: both end with the original bytes back in place and no `.lock` left
 * behind, so bytes alone cannot say whether the restore stayed atomic or degraded to a copy. */
const indexLockProbe = vi.hoisted(() => ({
    code: undefined as string | undefined,
    remaining: 0,
    renamesOntoIndex: 0,
}));

// Node's built-in `node:fs/promises` exports non-configurable properties, so `vi.spyOn` cannot wrap
// them; `vi.mock` with a pass-through factory is vitest's standard workaround. Keyed on the `.lock`
// suffix so the snapshot copy, the index read and this file's own fixture writes are untouched.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const writeFileWithInjectedLockFailure: typeof actual.writeFile = async (
        file,
        data,
        options,
    ) => {
        const injected = indexLockProbe.code;
        if (
            injected !== undefined &&
            indexLockProbe.remaining > 0 &&
            String(file).endsWith(".lock")
        ) {
            indexLockProbe.remaining -= 1;
            // Shaped like the real thing down to the syscall: the syscall name is what identifies
            // an exclusive create rather than a rename or an unlink in a captured failure.
            const failure: NodeJS.ErrnoException = new Error(
                `${injected}: operation not permitted, open '${String(file)}'`,
            );
            failure.code = injected;
            failure.syscall = "open";
            throw failure;
        }
        return actual.writeFile(file, data, options);
    };
    // `restoreIndexSnapshot` holds the only `rename` in the module under test and its source is
    // always the lock, so a `.lock` source identifies the atomic path with no ambiguity.
    const renameCountingLockRenames: typeof actual.rename = async (from, to) => {
        if (String(from).endsWith(".lock")) indexLockProbe.renamesOntoIndex += 1;
        return actual.rename(from, to);
    };
    return {
        ...actual,
        writeFile: writeFileWithInjectedLockFailure,
        rename: renameCountingLockRenames,
    };
});

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const originalPlatform = process.platform;

/** Supplies the platform rather than inheriting it, so the Windows branch is reachable on POSIX. */
function pretendPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(async () => {
    indexLockProbe.code = undefined;
    indexLockProbe.remaining = 0;
    indexLockProbe.renamesOntoIndex = 0;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function git(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout;
}

/** A staged repository plus the absolute path of its live index, resolved as production does. */
async function stagedRepository(): Promise<{ root: string; indexPath: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-index-lock-"));
    directories.push(root);
    await git(root, ["init"]);
    await writeFile(path.join(root, "a.txt"), "a\n");
    await git(root, ["add", "a.txt"]);
    const reported = (await git(root, ["rev-parse", "--git-path", "index"])).trim();
    return {
        root,
        indexPath: path.isAbsolute(reported) ? reported : path.resolve(root, reported),
    };
}

describe("GitOps.withIndexSnapshot against a delete-pending index.lock", () => {
    it("restores through the copy fallback when the lock keeps answering the Windows errno", async () => {
        // The whole point. Git removes `index.lock` on every write, and a removal whose handle is
        // still open leaves the name delete-pending -- where the exclusive create answers `EPERM`,
        // not `EEXIST`. Judged a fault rather than contention, that errno skipped the retry AND
        // the deliberate copy fallback, so the one path built to degrade gracefully failed
        // outright and left the index "with the commit's temporary unstaging applied".
        pretendPlatform("win32");
        indexLockProbe.code = "EPERM";
        indexLockProbe.remaining = Number.MAX_SAFE_INTEGER;
        const { root, indexPath } = await stagedRepository();
        const originalIndexBytes = await readFile(indexPath);

        const result = await new GitOps(new GitExecutor(root)).withIndexSnapshot(async () => {
            // A real `git` write would contend for the same lock, so the index bytes are mutated
            // directly to isolate this test to the restore.
            await writeFile(indexPath, "mutated-index-bytes-outside-git");
            return "operation-result";
        });

        expect(result).toBe("operation-result");
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
        expect(
            indexLockProbe.remaining,
            "the injected EPERM must actually have been served, or this test proves nothing",
        ).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(
            indexLockProbe.renamesOntoIndex,
            "the lock never opened, so the restore must have come from the copy fallback",
        ).toBe(0);
    });

    it("retries onto the atomic path when the delete-pending window closes", async () => {
        // The fallback above is the degraded outcome. This is the one that should normally happen:
        // the window is sub-second, so the second attempt creates the lock for real and the
        // restore stays atomic. A fix that only reached the fallback would pass the test above
        // and still have given up the atomicity the method exists to provide.
        pretendPlatform("win32");
        indexLockProbe.code = "EPERM";
        indexLockProbe.remaining = 1;
        const { root, indexPath } = await stagedRepository();
        const originalIndexBytes = await readFile(indexPath);

        await new GitOps(new GitExecutor(root)).withIndexSnapshot(async () => {
            await writeFile(indexPath, "mutated-index-bytes-outside-git");
        });

        expect(indexLockProbe.remaining, "the injected EPERM must have been served").toBe(0);
        expect(
            indexLockProbe.renamesOntoIndex,
            "the second attempt must rename the lock onto the index; a copy would restore the same bytes and leave no lock behind, so only this count tells the two apart",
        ).toBe(1);
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
        await expect(
            readFile(`${indexPath}.lock`),
            "the lock must be renamed onto the index, never left behind",
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("still reports a POSIX EPERM as a fault rather than degrading quietly", async () => {
        // The other direction, and the one that keeps the widening honest. POSIX answers `EEXIST`
        // for an occupied path, so an `EPERM` there is a real permission fault. Swallowing it
        // everywhere would turn a broken `.git` directory into a silent non-atomic copy -- or,
        // once the copy failed too, into a message about lock contention that never happened.
        pretendPlatform("linux");
        indexLockProbe.code = "EPERM";
        indexLockProbe.remaining = 1;
        const { root, indexPath } = await stagedRepository();

        await expect(
            new GitOps(new GitExecutor(root)).withIndexSnapshot(async () => {
                await writeFile(indexPath, "mutated-index-bytes-outside-git");
            }),
        ).rejects.toThrow(/EPERM/);
    });
});
