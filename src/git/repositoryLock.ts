import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Serialized ownership record stored in the lock file. */
interface LockOwner {
    nonce: string;
    pid: number;
    heartbeatAt: number;
}

/** Configuration and test seams for cross-process locking. */
export interface RepositoryLockOptions {
    heartbeatIntervalMs?: number;
    staleAfterMs?: number;
    livenessProbe?: (pid: number) => Promise<boolean>;
    beforeTakeover?: () => Promise<void>;
    /** Optional absolute lock directory for a separate lock domain, such as shelf storage. */
    lockDirectory?: string;
    /** File name within the selected lock directory. */
    lockFileName?: string;
}

/** Raised when a repository mutation is owned by another live extension process. */
export class RepositoryLockBusyError extends Error {
    /** Creates the stable busy error surfaced to callers. */
    constructor() {
        super("Repository mutation is already in progress.");
        this.name = "RepositoryLockBusyError";
    }
}

/** Cross-process repository lock rooted in Git's common directory. */
export class RepositoryLock {
    private readonly heartbeatIntervalMs: number;
    private readonly staleAfterMs: number;
    private readonly livenessProbe: (pid: number) => Promise<boolean>;
    private readonly beforeTakeover?: () => Promise<void>;
    private readonly lockDirectory?: string;
    private readonly lockFileName: string;

    /** Creates a lock using conservative heartbeat and stale thresholds. */
    constructor(options: RepositoryLockOptions = {}) {
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
        this.staleAfterMs = options.staleAfterMs ?? 30_000;
        this.livenessProbe = options.livenessProbe ?? isProcessLive;
        this.beforeTakeover = options.beforeTakeover;
        this.lockDirectory = options.lockDirectory;
        this.lockFileName = options.lockFileName ?? "repo.lock";
    }

    /** Acquires the configured lock domain and returns an idempotent release callback. */
    async acquire(commonDir: string): Promise<() => Promise<void>> {
        const lockDir = this.lockDirectory ?? path.join(commonDir, "intelligit");
        const lockPath = path.join(lockDir, this.lockFileName);
        await mkdir(lockDir, { recursive: true, mode: 0o700 });
        const owner: LockOwner = { nonce: randomUUID(), pid: process.pid, heartbeatAt: Date.now() };

        for (;;) {
            try {
                await writeFile(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
                return this.releaseCallback(lockPath, owner);
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
            }
            const existing = await readOwner(lockPath);
            if (!existing || Date.now() - existing.heartbeatAt <= this.staleAfterMs) {
                throw new RepositoryLockBusyError();
            }
            if (await this.livenessProbe(existing.pid)) throw new RepositoryLockBusyError();
            await this.beforeTakeover?.();
            const takeoverPath = path.join(lockDir, `takeover-${owner.nonce}`);
            try {
                await rename(lockPath, takeoverPath);
            } catch (error) {
                if (isNotFound(error)) continue;
                throw error;
            }
            const moved = await readOwner(takeoverPath);
            if (moved?.nonce !== existing.nonce) {
                await rename(takeoverPath, lockPath);
                throw new RepositoryLockBusyError();
            }
            try {
                await writeFile(lockPath, JSON.stringify(owner), {
                    encoding: "utf8",
                    flag: "wx",
                    mode: 0o600,
                });
            } catch (error) {
                if (isAlreadyExists(error)) {
                    await rm(takeoverPath, { force: true });
                    throw new RepositoryLockBusyError();
                }
                await rename(takeoverPath, lockPath).catch(() => undefined);
                throw error;
            }
            await rm(takeoverPath, { force: true });
            return this.releaseCallback(lockPath, owner);
        }
    }

    private releaseCallback(lockPath: string, owner: LockOwner): () => Promise<void> {
        let released = false;
        const heartbeat = setInterval(() => {
            owner.heartbeatAt = Date.now();
            void writeFile(lockPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 }).catch(
                () => undefined,
            );
        }, this.heartbeatIntervalMs);
        heartbeat.unref();
        return async () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            const existing = await readOwner(lockPath);
            // A read-compare-rm race remains only after a takeover contender has restored this owner;
            // rename-based takeover prevents it from deleting a fresh lock before this check.
            if (existing?.nonce === owner.nonce) await rm(lockPath, { force: true });
        };
    }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return undefined;
        const owner = parsed as Partial<LockOwner>;
        return typeof owner.nonce === "string" && typeof owner.pid === "number" && typeof owner.heartbeatAt === "number"
            ? { nonce: owner.nonce, pid: owner.pid, heartbeatAt: owner.heartbeatAt }
            : undefined;
    } catch {
        return undefined;
    }
}

function isAlreadyExists(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isProcessLive(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
        return Promise.resolve(true);
    } catch (error) {
        return Promise.resolve(
            typeof error === "object" && error !== null && "code" in error && error.code === "EPERM",
        );
    }
}
