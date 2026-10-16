import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryLock, RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, rm: vi.fn(actual.rm) };
});

const directories: string[] = [];

afterEach(async () => {
    vi.mocked(rm).mockRestore();
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

/** Uses the same separate lock domain as changelist metadata, with real ownership records. */
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-lock-release-"));
    directories.push(directory);
    const options = { lockDirectory: directory, lockFileName: "metadata.lock" };
    const lock = new RepositoryLock(options);
    const release = await lock.acquire(directory);
    const lockPath = path.join(directory, "metadata.lock");
    const failure = Object.assign(new Error("injected lock cleanup failure"), { code: "EACCES" });
    return { directory, options, lockPath, release, failure };
}

describe("failed repository lock release", () => {
    it("retries the original release callback after a transient cleanup failure", async () => {
        const { lockPath, release, failure } = await fixture();
        vi.mocked(rm).mockRejectedValueOnce(failure);
        await expect(release()).rejects.toBe(failure);
        await release();
        expect(
            await readFile(lockPath, "utf8").catch(() => undefined),
            "retrying release must remove the abandoned owned lock",
        ).toBeUndefined();
    });

    it("repairs failed cleanup before another lock instance acquires the metadata domain", async () => {
        const { directory, options, release, failure } = await fixture();
        vi.mocked(rm).mockRejectedValueOnce(failure);
        await expect(release()).rejects.toBe(failure);
        const next = await new RepositoryLock(options).acquire(directory).catch(() => undefined);
        expect(
            next,
            "a released live-owner lock must not strand the next metadata write",
        ).toBeTypeOf("function");
        await next?.();
    });

    it("retains a replacement owner's record while retrying failed cleanup", async () => {
        const { directory, options, lockPath, release, failure } = await fixture();
        vi.mocked(rm).mockRejectedValueOnce(failure);
        await expect(release()).rejects.toBe(failure);
        const foreign = JSON.stringify({
            nonce: "replacement",
            pid: process.pid,
            heartbeatAt: Date.now(),
        });
        await writeFile(lockPath, foreign);
        await release();
        expect(
            await readFile(lockPath, "utf8"),
            "cleanup must preserve a different owner nonce",
        ).toBe(foreign);
        await expect(new RepositoryLock(options).acquire(directory)).rejects.toBeInstanceOf(
            RepositoryLockBusyError,
        );
    });

    it("makes concurrent release callers await the same cleanup", async () => {
        const { lockPath, release } = await fixture();
        const realRm = vi.mocked(rm).getMockImplementation()!;
        let allowRemoval!: () => void;
        const removal = new Promise<void>((resolve) => {
            allowRemoval = resolve;
        });
        let removalStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            removalStarted = resolve;
        });
        vi.mocked(rm).mockImplementationOnce(async (...args) => {
            removalStarted();
            await removal;
            return realRm(...args);
        });
        const first = release();
        await started;
        const second = release();
        let secondFinished = false;
        void second.then(() => {
            secondFinished = true;
        });
        try {
            await Promise.resolve();
            expect(secondFinished, "concurrent release must wait for the pending removal").toBe(
                false,
            );
        } finally {
            allowRemoval();
            await Promise.all([first, second]);
        }
        await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
});
