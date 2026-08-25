import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock, RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

function gate(options?: {
    acquireTimeoutMs?: number;
    acquireRetryDelayMs?: number;
}): RepositoryMutationGate {
    return new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
        options,
    );
}

describe("RepositoryMutationGate", () => {
    it("briefly waits for a busy cross-process lock instead of failing", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const holder = new RepositoryLock();
        const release = await holder.acquire(common);
        setTimeout(() => void release(), 200);

        const result = await gate({ acquireTimeoutMs: 2_000, acquireRetryDelayMs: 25 }).run(
            repoRoot,
            common,
            async () => "ran",
        );

        expect(result).toBe("ran");
    });

    it("surfaces busy when the lock stays held past the wait deadline", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const holder = new RepositoryLock();
        const release = await holder.acquire(common);

        await expect(
            gate({ acquireTimeoutMs: 200, acquireRetryDelayMs: 25 }).run(
                repoRoot,
                common,
                async () => "ran",
            ),
        ).rejects.toBeInstanceOf(RepositoryLockBusyError);
        await release();
    });

    it("gives up on a busy lock within its bounded wait, not the full uncapped retry delay", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const holder = new RepositoryLock();
        const release = await holder.acquire(common);
        const holderReleased = new Promise<void>((resolve) => {
            setTimeout(() => void release().then(resolve, resolve), 300);
        });

        // On the pre-fix code, the retry loop slept the FULL 1000ms retry delay after its
        // first busy failure regardless of how little of the 100ms deadline remained, so this
        // acquisition SUCCEEDED at ~1000ms -- a full order of magnitude past the 100ms window
        // the caller asked for, and 700ms after the holder actually released at 300ms.
        const attemptStartedAt = Date.now();

        await expect(
            gate({ acquireTimeoutMs: 100, acquireRetryDelayMs: 1000 }).run(
                repoRoot,
                common,
                async () => "ran",
            ),
        ).rejects.toBeInstanceOf(RepositoryLockBusyError);
        const elapsedMs = Date.now() - attemptStartedAt;

        // Bounded well below where an uncapped sleep lands rather than tight against the
        // deadline: the rejection above is what discriminates the defect, since the pre-fix
        // loop resolves and never reaches here. This only has to catch a later regression
        // that gives up too late, and a margin sized for that does not flake under load.
        expect(
            elapsedMs,
            "the bounded wait must give up near its 100ms deadline, not sleep the full 1000ms retry delay",
        ).toBeLessThan(700);
        await holderReleased;
    });

    it("serializes overlapping mutations for one repository root", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const shared = gate();
        const order: string[] = [];
        let releaseFirst: (() => void) | undefined;
        let signalFirstStart: (() => void) | undefined;
        const firstStarted = new Promise<void>((resolve) => {
            signalFirstStart = resolve;
        });
        const first = shared.run(repoRoot, common, async () => {
            order.push("first-start");
            signalFirstStart?.();
            await new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            order.push("first-end");
        });
        const second = shared.run(repoRoot, common, async () => {
            order.push("second");
        });

        // Anchor the grace period to the first callback actually starting: measured from
        // `run()` instead, a slow canonicalization eats the window and the assertion sees
        // an empty order under load.
        await firstStarted;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(order).toEqual(["first-start"]);
        releaseFirst?.();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });

    it("registers a caller before delayed canonicalization can invert mutation order", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const order: string[] = [];
        let resolveFirstCanonicalization: (() => void) | undefined;
        let resolveFirstOperation: (() => void) | undefined;
        let signalFirstCanonicalization: (() => void) | undefined;
        let signalFirstOperation: (() => void) | undefined;
        const firstCanonicalization = new Promise<void>((resolve) => {
            signalFirstCanonicalization = resolve;
        });
        const firstOperation = new Promise<void>((resolve) => {
            signalFirstOperation = resolve;
        });
        let canonicalizationCalls = 0;
        const shared = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
            {
                resolveRepositoryRoot: async (requestedRoot) => {
                    canonicalizationCalls += 1;
                    if (canonicalizationCalls === 1) {
                        signalFirstCanonicalization?.();
                        await new Promise<void>((resolve) => {
                            resolveFirstCanonicalization = resolve;
                        });
                    }
                    return requestedRoot;
                },
            },
        );
        const first = shared.run(repoRoot, common, async () => {
            order.push("first");
            signalFirstOperation?.();
            await new Promise<void>((resolve) => {
                resolveFirstOperation = resolve;
            });
        });
        await firstCanonicalization;
        const second = shared.run(repoRoot, common, async () => {
            order.push("second");
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(canonicalizationCalls).toBe(1);
        expect(order).toEqual([]);
        resolveFirstCanonicalization?.();
        await firstOperation;
        expect(order).toEqual(["first"]);
        resolveFirstOperation?.();
        await Promise.all([first, second]);
        expect(order).toEqual(["first", "second"]);
    });

    it("releases the cross-process lock when the operation throws", async () => {
        const repoRoot = await tempDir("intelligit-gate-root-");
        const common = await tempDir("intelligit-gate-common-");
        const shared = gate();

        await expect(
            shared.run(repoRoot, common, async () => {
                throw new Error("mutation failed");
            }),
        ).rejects.toThrow("mutation failed");
        const release = await new RepositoryLock().acquire(common);
        await release();
    });
});
