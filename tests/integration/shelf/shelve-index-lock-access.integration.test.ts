/**
 * Pins what the index-lock wait does when it cannot tell whether Git's `index.lock` is still there.
 *
 * Kept out of `shelve-index-lock.integration.test.ts`: `vi.mock` applies to a whole module for the
 * whole file, and those tests need the real `access`.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutorRecoveryGit } from "../../../src/shelf/recoveryGit";
import { cleanTemporaryRepositories, createShelfFixture } from "./shelfTestHarness";

/** While `onFirstDenial` is set, checking an existing `index.lock` fails with EACCES, the way it
 * does once this process loses search permission on a parent directory; `onFirstDenial` runs on
 * the first such failure, which always follows a refused write. */
const lockProbe = vi.hoisted(() => ({
    onFirstDenial: undefined as (() => void) | undefined,
    denials: 0,
}));

// Node's built-in `node:fs/promises` exports non-configurable properties, so `vi.spyOn` cannot wrap
// them; `vi.mock` with a pass-through factory is vitest's standard workaround.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const accessDeniedWhileLockExists: typeof actual.access = async (file, mode) => {
        await actual.access(file, mode);
        if (!lockProbe.onFirstDenial || !String(file).endsWith("index.lock")) return;
        if (lockProbe.denials++ === 0) lockProbe.onFirstDenial();
        const failure: NodeJS.ErrnoException = new Error(
            `EACCES: permission denied, access '${String(file)}'`,
        );
        failure.code = "EACCES";
        failure.syscall = "access";
        throw failure;
    };
    return { ...actual, access: accessDeniedWhileLockExists };
});

afterEach(async () => {
    lockProbe.onFirstDenial = undefined;
    lockProbe.denials = 0;
    await cleanTemporaryRepositories();
});

describe("index.lock wait when the lock cannot be checked", () => {
    it("keeps waiting on an access error other than not-found, re-checking only once the lock is gone", async () => {
        const f = await createShelfFixture();
        const recovery = new GitExecutorRecoveryGit(f.executor);
        const entry = await recovery.getIndexEntry("tracked.txt");
        const lock = path.join(f.root, ".git", "index.lock");
        await writeFile(lock, "", { flag: "wx" });
        const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        lockProbe.onFirstDenial = () => setTimeout(() => void rm(lock, { force: true }), 200);
        const lockHeldAtRecheck: boolean[] = [];
        const outcome = await recovery
            .writeIndexEntry("tracked.txt", entry, async () => {
                lockHeldAtRecheck.push(existsSync(lock));
            })
            .then(
                () => "written",
                (error: Error) => error.message,
            );
        expect(lockHeldAtRecheck, "the re-check runs only once the lock is gone").toEqual([false]);
        expect(outcome, "the write lands once the lock is released").toBe("written");
        expect(lockProbe.denials, "the lock check was denied").toBeGreaterThan(0);
    });
});
