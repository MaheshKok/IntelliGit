import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryLock, RepositoryLockBusyError } from "../../../src/git/repositoryLock";

/** Delay applied to heartbeat writes only, so "the write is still in flight when release runs" is
 * a controlled fact rather than a race the test hopes to win. Zero for every other test here. */
const heartbeatWrite = vi.hoisted(() => ({ delayMs: 0 }));

// Node's built-in `node:fs/promises` exports non-configurable properties, so `vi.spyOn` cannot wrap
// them; `vi.mock` with a pass-through factory is vitest's standard workaround. Only the heartbeat's
// write is slowed: `acquire` creates the lock with an exclusive-create `flag`, the heartbeat never
// does, so the absence of `flag` identifies it without reaching into the implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const writeFileWithHeartbeatDelay: typeof actual.writeFile = async (file, data, options) => {
        const isHeartbeatWrite =
            heartbeatWrite.delayMs > 0 &&
            typeof options === "object" &&
            options !== null &&
            !("flag" in options);
        if (isHeartbeatWrite) {
            await new Promise((resolve) => setTimeout(resolve, heartbeatWrite.delayMs));
        }
        return actual.writeFile(file, data, options);
    };
    return { ...actual, writeFile: writeFileWithHeartbeatDelay };
});

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function commonDir(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-lock-"));
    directories.push(directory);
    return directory;
}

describe("RepositoryLock", () => {
    it("surfaces contention without stealing a live owner", async () => {
        const lock = new RepositoryLock();
        const common = await commonDir();
        const release = await lock.acquire(common);

        await expect(lock.acquire(common)).rejects.toBeInstanceOf(RepositoryLockBusyError);
        await release();
    });

    it("does not let an in-flight heartbeat write resurrect the lock it just released", async () => {
        const common = await commonDir();
        const lockPath = path.join(common, "intelligit", "repo.lock");
        // Ticks every 10ms; each write takes 300ms. Release therefore runs while at least one
        // heartbeat write is genuinely outstanding -- `clearInterval` stops the next tick but
        // cannot recall the write a previous tick already started.
        heartbeatWrite.delayMs = 300;
        try {
            const release = await new RepositoryLock({ heartbeatIntervalMs: 10 }).acquire(common);
            await new Promise((resolve) => setTimeout(resolve, 40));
            await release();
            // Every write still owed to the released lock lands inside this window.
            await new Promise((resolve) => setTimeout(resolve, heartbeatWrite.delayMs * 2));

            const lockAfterRelease = await readFile(lockPath, "utf8").catch(() => undefined);
            expect(lockAfterRelease).toBeUndefined();
            // The product symptom, asserted independently of the file check: a resurrected lock
            // carries a FRESH `heartbeatAt`, so the next acquirer reads it as held and reports the
            // repository busy -- with no owner, and self-healing only after `staleAfterMs`.
            const releaseNext = await new RepositoryLock().acquire(common);
            await releaseNext();
        } finally {
            heartbeatWrite.delayMs = 0;
        }
    });

    it("does not take over a stale lock while its PID is still live", async () => {
        const common = await commonDir();
        const first = new RepositoryLock({ heartbeatIntervalMs: 1_000, staleAfterMs: 0 });
        const release = await first.acquire(common);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        const contender = new RepositoryLock({
            staleAfterMs: 0,
            livenessProbe: async () => true,
        });

        await expect(contender.acquire(common)).rejects.toBeInstanceOf(RepositoryLockBusyError);
        await release();
    });

    it("takes over only when the lock is stale and the owner is dead", async () => {
        const common = await commonDir();
        const first = new RepositoryLock({ heartbeatIntervalMs: 1_000, staleAfterMs: 0 });
        const release = await first.acquire(common);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        const contender = new RepositoryLock({
            staleAfterMs: 0,
            livenessProbe: async () => false,
        });

        const releaseContender = await contender.acquire(common);
        await releaseContender();
        await release();
    });

    describe("default liveness probe", () => {
        /**
         * Drives the built-in probe by faking the errno `process.kill(pid, 0)` reports,
         * then asking a stale-immediately contender whether it may take the lock over.
         */
        async function takesOverWhenKillFails(code: string | undefined): Promise<boolean> {
            const common = await commonDir();
            const first = new RepositoryLock({ heartbeatIntervalMs: 1_000, staleAfterMs: 0 });
            const release = await first.acquire(common);
            await new Promise<void>((resolve) => setTimeout(resolve, 2));

            const kill = vi.spyOn(process, "kill").mockImplementation(() => {
                throw Object.assign(new Error("probe"), code ? { code } : {});
            });
            try {
                const releaseContender = await new RepositoryLock({ staleAfterMs: 0 }).acquire(
                    common,
                );
                await releaseContender();
                return true;
            } catch (error) {
                if (error instanceof RepositoryLockBusyError) return false;
                throw error;
            } finally {
                kill.mockRestore();
                await release();
            }
        }

        it("treats ESRCH as the only proof that the owner is gone", async () => {
            await expect(takesOverWhenKillFails("ESRCH")).resolves.toBe(true);
        });

        it("treats EPERM as a live owner running under another user", async () => {
            await expect(takesOverWhenKillFails("EPERM")).resolves.toBe(false);
        });

        it("refuses to take over when the probe fails in an unrecognized way", async () => {
            await expect(takesOverWhenKillFails("EINVAL")).resolves.toBe(false);
            await expect(takesOverWhenKillFails(undefined)).resolves.toBe(false);
        });
    });

    it("allows exactly one contender to take over the same stale dead lock", async () => {
        const common = await commonDir();
        const lockDir = path.join(common, "intelligit");
        await mkdir(lockDir);
        await writeFile(
            path.join(lockDir, "repo.lock"),
            JSON.stringify({ nonce: "dead-owner", pid: 1, heartbeatAt: 0 }),
        );
        let arrived = 0;
        let releaseBarrier: (() => void) | undefined;
        const barrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve;
        });
        const contender = () =>
            new RepositoryLock({
                // The planted lock is stale under any threshold because its heartbeat sits
                // at the epoch. A zero threshold would also make the winner's own fresh
                // lock stale the moment a millisecond passes, letting the loser take that
                // one over in turn and produce two winners — which is what happens once
                // coverage instrumentation slows the retry past the winner's write.
                staleAfterMs: 60_000,
                livenessProbe: async () => false,
                beforeTakeover: async () => {
                    arrived += 1;
                    if (arrived === 2) releaseBarrier?.();
                    await barrier;
                },
            }).acquire(common);

        const outcomes = await Promise.allSettled([contender(), contender()]);
        const winners = outcomes.filter(
            (outcome): outcome is PromiseFulfilledResult<() => Promise<void>> => outcome.status === "fulfilled",
        );
        const losers = outcomes.filter((outcome) => outcome.status === "rejected");

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0].reason).toBeInstanceOf(RepositoryLockBusyError);
        expect(JSON.parse(await readFile(path.join(lockDir, "repo.lock"), "utf8"))).not.toMatchObject({
            nonce: "dead-owner",
        });
        await winners[0].value();
    });
});
