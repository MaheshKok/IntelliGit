import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    getRebaseStoragePaths,
    readLiveRebaseManifest,
    writeRebaseManifest,
} from "../../../../src/git/interactiveRebase/storage";
import type {
    RebaseSessionLifecycle,
    RebaseSessionManifest,
} from "../../../../src/git/interactiveRebase/types";

const REPO_ROOT = "/fixture-repository";
const SESSION_ID = "session-1";
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates an isolated storage root holding one manifest at the requested lifecycle. */
async function storageWithManifest(
    lifecycle: RebaseSessionLifecycle,
    sessionId: string = SESSION_ID,
): Promise<string> {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "intelligit-rebase-storage-"));
    roots.push(storageRoot);
    const manifest: RebaseSessionManifest = {
        version: 1,
        sessionId,
        repoRoot: REPO_ROOT,
        branch: "refs/heads/main",
        baseHash: "c".repeat(40),
        expectedHead: "d".repeat(40),
        createdAt: "2026-08-02T00:00:00.000Z",
        lifecycle,
    };
    await writeRebaseManifest(storageRoot, manifest);
    return storageRoot;
}

/** Writes the exclusive reservation pointer that correlates a manifest with the live rebase. */
async function writeReservation(storageRoot: string, contents: string): Promise<void> {
    await writeFile(getRebaseStoragePaths(storageRoot, REPO_ROOT).reservationPath, contents, {
        encoding: "utf8",
        mode: 0o600,
    });
}

describe("readLiveRebaseManifest", () => {
    it.each([["starting"], ["running"], ["paused"]] as const)(
        "returns the reserved manifest at the %s lifecycle",
        async (lifecycle) => {
            const storageRoot = await storageWithManifest(lifecycle);
            await writeReservation(storageRoot, JSON.stringify({ sessionId: SESSION_ID }));

            await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toMatchObject({
                sessionId: SESSION_ID,
                lifecycle,
            });
        },
    );

    it.each([["completed-pending-push"], ["done"]] as const)(
        "returns nothing for the terminal %s lifecycle",
        async (lifecycle) => {
            // A terminal session no longer controls the rebase directory, so correlating against
            // it would authorize injection into whatever rebase is running now.
            const storageRoot = await storageWithManifest(lifecycle);
            await writeReservation(storageRoot, JSON.stringify({ sessionId: SESSION_ID }));

            await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toBeUndefined();
        },
    );

    it("returns nothing without a storage root", async () => {
        await expect(readLiveRebaseManifest(undefined, REPO_ROOT)).resolves.toBeUndefined();
    });

    it("returns nothing when no reservation pointer exists", async () => {
        const storageRoot = await storageWithManifest("running");

        await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toBeUndefined();
    });

    it.each([
        ["malformed JSON", "{"],
        ["a missing session ID", JSON.stringify({})],
        ["an unsafe session ID", JSON.stringify({ sessionId: "../escape" })],
    ])("returns nothing for a reservation with %s", async (_name, contents) => {
        const storageRoot = await storageWithManifest("running");
        await writeReservation(storageRoot, contents);

        await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toBeUndefined();
    });

    it("returns nothing when the reservation points at a manifest that is not there", async () => {
        // The pointer is the correlation key: a manifest that does not answer to it cannot prove
        // which session owns the live rebase, whatever else is stored beside it.
        const storageRoot = await storageWithManifest("running");
        await writeReservation(storageRoot, JSON.stringify({ sessionId: "session-2" }));

        await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toBeUndefined();
    });

    it("returns nothing for a reserved manifest that fails validation", async () => {
        const storageRoot = await storageWithManifest("running");
        await writeFile(
            getRebaseStoragePaths(storageRoot, REPO_ROOT).manifestPath(SESSION_ID),
            JSON.stringify({ version: 1, sessionId: SESSION_ID, lifecycle: "running" }),
            "utf8",
        );
        await writeReservation(storageRoot, JSON.stringify({ sessionId: SESSION_ID }));

        await expect(readLiveRebaseManifest(storageRoot, REPO_ROOT)).resolves.toBeUndefined();
    });
});
