// The Windows durability gate in `writeAtomic`, asserted on whether the directory fsync is
// ATTEMPTED rather than on whether it succeeds. A test that only checked "the write works" would
// pass on macOS and Linux either way -- the call succeeds there, so nothing separates a gated build
// from an ungated one. Only the presence of the call itself does.
//
// Reproduces run 32636185388 (2026-08-23), the first portability run that got far enough to execute
// the suite on Windows: 206 failures, every one `EPERM: operation not permitted, fsync` raised from
// `fsyncDirectory`, because Windows lets a directory handle be OPENED and then refuses to flush it.
import { statSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureShelfRoot, resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";

// Everything except `open` stays real: the point is to watch one call, not to simulate a store.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];
const originalPlatform = process.platform;

function setPlatform(platform: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(async () => {
    setPlatform(originalPlatform);
    vi.mocked(open).mockClear();
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

/**
 * Counts opens of a DIRECTORY, which `fsyncDirectory` is the only caller to perform.
 *
 * Mode alone is not enough to identify it: `RepositoryLock` opens its lock path `"r"` to sync it
 * too (`repositoryLock.ts:254`), and `withLock` wraps every write here, so filtering on `"r"`
 * counted two lock opens on both platforms and measured nothing.
 */
function directoryOpenCount(): number {
    return vi.mocked(open).mock.calls.filter((call) => {
        const target = call[0];
        if (call[1] !== "r" || typeof target !== "string") return false;
        return statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
    }).length;
}

/**
 * The platform is stubbed around the generation write only, and the temporary root is resolved
 * through `realpath` first.
 *
 * `ensureShelfRoot` consults the platform too: `paths.ts` allows a SYMLINKED storage root on
 * darwin, which is exactly how macOS `tmpdir()` resolves (`/var` -> `/private/var`). Stubbing the
 * platform to anything else then rejects the root for a reason that has nothing to do with fsync,
 * and `withLock` re-checks it inside the write path, so moving the stub alone does not avoid it.
 * A real path needs no allowance on any platform.
 */
async function writeOneGeneration(platform: string): Promise<void> {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-shelf-fsync-")));
    directories.push(temporary);
    const repositoryRoot = path.join(temporary, "repository");
    await mkdir(repositoryRoot);
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(temporary, "storage"),
    });
    await ensureShelfRoot(paths);
    const store = new ShelfStore(paths);
    const object = await store.putObject("shelf-one", Buffer.from("payload"));

    // Setup writes too. Count only the generation write.
    vi.mocked(open).mockClear();
    setPlatform(platform);
    try {
        await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [object.hash],
            files: [],
        });
    } finally {
        setPlatform(originalPlatform);
    }
}

describe("writeAtomic directory fsync", () => {
    it("does not attempt a directory fsync on Windows", async () => {
        await writeOneGeneration("win32");

        expect(
            directoryOpenCount(),
            "Windows opens the directory handle and then fails FlushFileBuffers with EPERM, so " +
                "every shelf write throws; no Windows API does this job, so there is nothing to " +
                "fall back to and the call has to be skipped outright",
        ).toBe(0);
    });

    // Stubbing `process.platform` changes what the CODE checks, not what the kernel does. Forcing
    // the POSIX branch while genuinely on Windows therefore attempts the real fsync and really
    // fails with the EPERM this whole commit exists to avoid -- run 32638093138 caught exactly
    // that, as the only two EPERMs left out of the original 206. The assertion is only meaningful
    // where the syscall works, and the ubuntu and macos legs are where it runs.
    it.skipIf(process.platform === "win32")(
        "still fsyncs the directory on POSIX, where the rename's durability depends on it",
        async () => {
            await writeOneGeneration("linux");

            expect(
                directoryOpenCount(),
                "skipping this everywhere would trade a Windows crash for silent data loss on " +
                    "the platforms where the call actually works",
            ).toBeGreaterThan(0);
        },
    );
});
