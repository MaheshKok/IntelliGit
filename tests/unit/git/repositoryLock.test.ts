import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryLock, RepositoryLockBusyError } from "../../../src/git/repositoryLock";

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
