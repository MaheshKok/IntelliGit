// The Windows durability gate in `syncParent`, asserted on whether the directory fsync is
// ATTEMPTED, as `tests/unit/shelf/storeDirectoryFsync.test.ts` does for the shelf store: the call
// succeeds on macOS and Linux, so only its presence separates a gated build from an ungated one.
//
// Reproduces run 40031962961, where every native abort on Windows died with `EPERM: operation not
// permitted, fsync` raised from `syncParent` after moving or installing a restored path.
import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import {
    abortTargetNativeOperation,
    captureTargetNativeEvidence,
} from "../../../src/git/targetOperationRecovery";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

// Everything except `open` stays real: the point is to watch one call, not to simulate recovery.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
const originalPlatform = process.platform;

function setPlatform(platform: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(async () => {
    setPlatform(originalPlatform);
    vi.mocked(open).mockClear();
    await removeScratchDirectories(...roots.splice(0));
});

/**
 * Counts `syncParent`'s opens: a DIRECTORY opened with bare `O_RDONLY`.
 *
 * The changelist store syncs its own directories through `"r"` and has its own Windows gate, so
 * counting every directory open would let those stand in for `syncParent` on the POSIX leg.
 */
function parentSyncCount(): number {
    return vi.mocked(open).mock.calls.filter((call) => {
        const target = call[0];
        if (call[1] !== constants.O_RDONLY || typeof target !== "string") return false;
        return statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
    }).length;
}

/** Aborts one real cherry-pick conflict, which both moves the conflicted file and installs its saved bytes. */
async function abortOneConflict(platform: string): Promise<void> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "target-abort-fsync-")));
    roots.push(root);
    const git = new GitExecutor(root);
    await git.run(["init", "-q"]);
    await git.run(["config", "user.name", "Fixture"]);
    await git.run(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "affected"), "base\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-qm", "base"]);
    const base = (await git.run(["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(root, "affected"), "incoming\n");
    await git.run(["commit", "-qam", "incoming"]);
    const commit = (await git.run(["rev-parse", "HEAD"])).trim();
    await git.run(["checkout", "-q", base]);
    await writeFile(path.join(root, "affected"), "current\n");
    await git.run(["commit", "-qam", "current"]);
    const gitDir = path.join(root, ".git");
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const store = new ChangelistStore();
    await store.connect(root, gitDir);
    const lease = await store.acquireTargetOperationLease(root);
    try {
        const id = randomUUID();
        const before = {
            ...(await captureTargetNativeEvidence(git, persistence, id, ["affected"])),
            entries: [
                { changeId: "native:affected", path: "affected", outcome: "pending" as const },
            ],
        };
        const hash = await persistence.storeTargetOperationEvidence(before);
        const prepared = await store.prepareTargetOperation(lease, {
            id,
            kind: "cherryPick",
            commit,
            headBefore: before.head,
            evidenceHash: hash,
            target: { kind: "existing", id: "default", revision: store.get(root).revision },
        });
        await git.runBinary(["cherry-pick", "--no-commit", commit], { expectedExitCodes: [1] });
        const after = {
            ...(await captureTargetNativeEvidence(git, persistence, id, ["affected"])),
            checkpoint: "after" as const,
            previousEvidenceHash: hash,
            entries: [
                { changeId: "native:affected", path: "affected", outcome: "conflicted" as const },
            ],
        };
        const state = await store.checkpointTargetOperation(lease, {
            id,
            revision: prepared.state.revision,
            expectedPhase: "prepared",
            phase: "conflicted",
            evidenceHash: await persistence.storeTargetOperationEvidence(after),
        });

        // Setup writes too. Count only the abort.
        vi.mocked(open).mockClear();
        setPlatform(platform);
        try {
            await abortTargetNativeOperation(git, persistence, store, lease, {
                id,
                revision: state.revision,
                expectedPhase: "conflicted",
            });
        } finally {
            setPlatform(originalPlatform);
        }
        expect(store.get(root).pendingTargetOperation).toBeUndefined();
    } finally {
        await lease.release();
    }
}

describe("native abort directory fsync", () => {
    it("does not attempt a directory fsync on Windows", async () => {
        await abortOneConflict("win32");

        expect(
            parentSyncCount(),
            "Windows opens the directory handle and then fails FlushFileBuffers with EPERM, so " +
                "every native abort throws after moving the conflicted file",
        ).toBe(0);
    });

    // A stubbed platform changes what the code checks, not what the kernel does: forcing the POSIX
    // branch while genuinely on Windows would attempt the real fsync and fail with the same EPERM.
    it.skipIf(process.platform === "win32")(
        "still fsyncs the parent directory on POSIX, where the move's durability depends on it",
        async () => {
            await abortOneConflict("linux");

            expect(
                parentSyncCount(),
                "skipping this everywhere would trade a Windows crash for silent data loss on " +
                    "the platforms where the call actually works",
            ).toBeGreaterThan(0);
        },
    );
});
