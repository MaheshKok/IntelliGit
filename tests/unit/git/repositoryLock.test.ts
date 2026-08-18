import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

    it("replaces the lock record instead of rewriting the file a reader already opened", async () => {
        const common = await commonDir();
        const lockPath = path.join(common, "intelligit", "repo.lock");
        const release = await new RepositoryLock({ heartbeatIntervalMs: 10 }).acquire(common);
        try {
            // Rewriting in place is what makes a live owner briefly indistinguishable from
            // abandoned residue: `writeFile` truncates at open and writes the bytes as a
            // separate step, so an owner whose thread stalls between the two leaves an empty
            // file -- unparseable, and with no pid left in it for the liveness probe to rescue
            // the owner with. Publishing by rename is the difference, and file identity at the
            // path is what witnesses it: comparing contents would pass either way, because both
            // forms do update the record.
            const claimed = await stat(lockPath, { bigint: true });
            await new Promise<void>((resolve) => setTimeout(resolve, 40));

            expect(
                (await stat(lockPath, { bigint: true })).ino,
                "each heartbeat must publish a new file, never rewrite the one in place",
            ).not.toBe(claimed.ino);
        } finally {
            await release();
        }
    });

    it("does not hold a claim another process reclaimed before the record landed", async () => {
        const common = await commonDir();
        const lockPath = path.join(common, "intelligit", "repo.lock");

        await expect(
            new RepositoryLock({
                // Stands in for a contender that found this process's zero-length claim old
                // enough to be residue and took it over. The exclusive create wins the path
                // before the record is in it, so a claimant stalled between the two has to read
                // the path back to learn it lost. Otherwise both processes hold the lock, and
                // this one starts a heartbeat that overwrites the other's record.
                beforeClaimConfirmed: async () => {
                    await writeFile(
                        lockPath,
                        JSON.stringify({
                            nonce: "reclaimed",
                            pid: process.pid,
                            heartbeatAt: Date.now(),
                        }),
                    );
                },
            }).acquire(common),
        ).rejects.toBeInstanceOf(RepositoryLockBusyError);

        expect(
            JSON.parse(await readFile(lockPath, "utf8")),
            "the process that reclaimed the path must keep it",
        ).toMatchObject({ nonce: "reclaimed" });
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

    it("declines a takeover of an owner that heartbeated after being judged stale", async () => {
        // The takeover decision is made on a record read before the rename, and the identity
        // check on the renamed file is the only thing between that decision and overwriting a
        // live owner. A nonce cannot carry that check alone: an owner keeps its nonce for life,
        // so a record it rewrote after being judged stale still matches while no longer being
        // the record the decision was made about. The gap is reachable whenever the liveness
        // probe is wrong -- a lock on a network share, an owner alive on another host whose pid
        // means nothing here -- and a fresh heartbeat is the evidence that it was wrong. Only
        // the heartbeat discriminates, so the decoy keeps the nonce it was judged under.
        const common = await commonDir();
        const lockPath = path.join(common, "intelligit", "repo.lock");
        await mkdir(path.dirname(lockPath), { recursive: true });
        const owner = { nonce: "still-alive", pid: process.pid, heartbeatAt: 0 };
        await writeFile(lockPath, JSON.stringify(owner));

        await expect(
            new RepositoryLock({
                staleAfterMs: 0,
                livenessProbe: async () => false,
                beforeTakeover: async () => {
                    const heartbeat = { ...owner, heartbeatAt: Date.now() };
                    await writeFile(lockPath, JSON.stringify(heartbeat));
                },
            }).acquire(common),
        ).rejects.toBeInstanceOf(RepositoryLockBusyError);

        expect(
            JSON.parse(await readFile(lockPath, "utf8")),
            "an owner that proved itself alive mid-takeover must keep the lock it holds",
        ).toMatchObject({ nonce: "still-alive" });
    });

    describe("a lock file that exists but cannot be parsed", () => {
        /** Plants an unparseable lock file and returns the common directory holding it. */
        async function plantUnreadableLock(contents: string): Promise<string> {
            const common = await commonDir();
            await mkdir(path.join(common, "intelligit"));
            await writeFile(path.join(common, "intelligit", "repo.lock"), contents);
            return common;
        }

        it("is taken over once nothing is writing to it any more", async () => {
            // The exact residue of a process that died between the truncate and the write of
            // one heartbeat: the file is there, holds no owner record, and nothing will ever
            // update it again. It used to wedge the repository permanently -- a parse failure
            // was reported as "no owner" exactly as a missing file is, and the busy check ran
            // BEFORE the staleness and liveness checks that would have released it, so the
            // takeover path was unreachable for this file no matter how old it got.
            const common = await plantUnreadableLock("");
            await new Promise<void>((resolve) => setTimeout(resolve, 2));

            const release = await new RepositoryLock({
                staleAfterMs: 0,
                // Reports every pid as alive. The takeover must still happen: an unreadable
                // file carries no pid, so this asserts the probe is skipped rather than called
                // with a fabricated argument.
                livenessProbe: async () => true,
            }).acquire(common);

            expect(
                JSON.parse(await readFile(path.join(common, "intelligit", "repo.lock"), "utf8")),
                "the taken-over lock must now record this process as its owner",
            ).toMatchObject({ pid: process.pid });
            await release();
        });

        it("is left alone until it has been lying there longer than the stale window", async () => {
            // The counterexample the fix must not break. Reclaiming an unreadable file means
            // deciding from its mtime alone that nothing is coming back for it, so one that has
            // only just appeared is declined -- exactly as a freshly heartbeated owner is.
            // Without this the takeover degenerates into "unreadable means free", and the age
            // check that makes it safe is unasserted.
            const common = await plantUnreadableLock("");

            await expect(
                new RepositoryLock({
                    staleAfterMs: 60_000,
                    livenessProbe: async () => false,
                }).acquire(common),
            ).rejects.toBeInstanceOf(RepositoryLockBusyError);
        });

        it("restores an owner that claimed the lock during the takeover", async () => {
            // An unreadable file has no nonce, so the post-rename identity check cannot match
            // one. "Unchanged" therefore has to mean "still unreadable": a parseable file at
            // this point is a peer that acquired the lock legitimately in the gap between the
            // read and the rename, and it must be put back rather than overwritten.
            const common = await plantUnreadableLock("");
            const lockPath = path.join(common, "intelligit", "repo.lock");
            await new Promise<void>((resolve) => setTimeout(resolve, 2));

            await expect(
                new RepositoryLock({
                    staleAfterMs: 0,
                    livenessProbe: async () => false,
                    beforeTakeover: async () => {
                        await writeFile(
                            lockPath,
                            JSON.stringify({
                                nonce: "arrived-late",
                                pid: process.pid,
                                heartbeatAt: Date.now(),
                            }),
                        );
                    },
                }).acquire(common),
            ).rejects.toBeInstanceOf(RepositoryLockBusyError);

            expect(
                JSON.parse(await readFile(lockPath, "utf8")),
                "the late owner must be restored to the lock path, not displaced by the takeover",
            ).toMatchObject({ nonce: "arrived-late" });
        });
    });
});
