import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Serialized ownership record stored in the lock file. */
interface LockOwner {
    nonce: string;
    pid: number;
    heartbeatAt: number;
}

/**
 * What the lock file looks like right now.
 *
 * `unreadable` is deliberately not folded into `absent`. A file that exists but cannot be
 * parsed has no owner to probe, yet it is still occupying the lock -- and treating that as
 * "no owner record" is what made a corrupt lock permanent: the busy check fired before the
 * staleness and liveness checks that would have released it.
 */
type LockFileState =
    | { readonly kind: "absent" }
    | { readonly kind: "unreadable"; readonly mtimeMs: number }
    | { readonly kind: "owned"; readonly owner: LockOwner };

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
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Exclusive create attempts are ordered lock-ownership transitions; parallel attempts could bypass takeover checks.
                await writeFile(lockPath, JSON.stringify(owner), {
                    encoding: "utf8",
                    flag: "wx",
                    mode: 0o600,
                });
                return this.releaseCallback(lockPath, owner);
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
            }
            const existing = await readLockFile(lockPath);
            if (!this.isStale(existing)) throw new RepositoryLockBusyError();
            // Only an owned lock has a pid to probe. An unreadable one is judged by its mtime
            // alone, which `isStale` has already ruled on.
            if (existing.kind === "owned" && (await this.livenessProbe(existing.owner.pid))) {
                throw new RepositoryLockBusyError();
            }
            await this.beforeTakeover?.();
            const takeoverPath = path.join(lockDir, `takeover-${owner.nonce}`);
            try {
                await rename(lockPath, takeoverPath);
            } catch (error) {
                if (isNotFound(error)) continue;
                throw error;
            }
            const moved = await readLockFile(takeoverPath);
            if (!isSameLockFile(moved, existing)) {
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

    /**
     * Whether the observed lock file is old enough to be a takeover candidate.
     *
     * An unreadable file has no heartbeat to read and no pid to probe, so its own mtime is
     * the only evidence about the owner -- and it is sufficient evidence, because a healthy
     * owner rewrites the file every `heartbeatIntervalMs`. That is also what makes it safe:
     * a heartbeat write truncates before it writes, so a perfectly live lock is briefly
     * zero-length and therefore unparseable, but its mtime is that very instant. Judging an
     * unreadable file by mtime declines exactly that window, and declines it for the same
     * reason a fresh heartbeat declines an owned one.
     */
    private isStale(state: LockFileState): boolean {
        switch (state.kind) {
            case "absent":
                // The owner released between the exclusive-create attempt and this read.
                // Reported busy rather than retried: the callers that care already retry
                // (`ShelfStore` for a second, `RepositoryMutationGate` for five), and looping
                // here would spin against a peer that keeps taking and releasing the lock.
                return false;
            case "owned":
                return Date.now() - state.owner.heartbeatAt > this.staleAfterMs;
            case "unreadable":
                return Date.now() - state.mtimeMs > this.staleAfterMs;
        }
    }

    private releaseCallback(lockPath: string, owner: LockOwner): () => Promise<void> {
        let released = false;
        // Each heartbeat write is chained onto the previous one and kept, never fired and
        // forgotten: `clearInterval` stops future ticks but cannot recall the write a tick has
        // already started. An untracked write that lands after the `rm` below recreates the lock
        // file with a FRESH `heartbeatAt`, so the next acquirer reads it as held and throws
        // `RepositoryLockBusyError` -- a repository that reports itself busy with no owner and
        // self-heals only after `staleAfterMs`. Chaining (rather than tracking the latest write)
        // also means release awaits every owed write, not just the last one started.
        let pendingWrite: Promise<void> = Promise.resolve();
        const heartbeat = setInterval(() => {
            owner.heartbeatAt = Date.now();
            const snapshot = JSON.stringify(owner);
            pendingWrite = pendingWrite
                .then(() => writeFile(lockPath, snapshot, { encoding: "utf8", mode: 0o600 }))
                .catch(() => undefined);
        }, this.heartbeatIntervalMs);
        heartbeat.unref();
        return async () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            await pendingWrite;
            const existing = await readLockFile(lockPath);
            // A read-compare-rm race remains only after a takeover contender has restored this owner;
            // rename-based takeover prevents it from deleting a fresh lock before this check.
            if (existing.kind === "owned" && existing.owner.nonce === owner.nonce) {
                await rm(lockPath, { force: true });
            }
        };
    }
}

/** Whether the renamed file is still the one the takeover decision was made about. */
function isSameLockFile(moved: LockFileState, expected: LockFileState): boolean {
    if (expected.kind === "owned") {
        return moved.kind === "owned" && moved.owner.nonce === expected.owner.nonce;
    }
    // An unreadable lock carries no nonce to match on, so "unchanged" can only mean still
    // unreadable. Anything parseable now is a fresh owner that arrived during the rename and
    // must not be displaced.
    return moved.kind === "unreadable";
}

async function readLockFile(lockPath: string): Promise<LockFileState> {
    try {
        const handle = await open(lockPath, "r");
        try {
            // One handle for both, so the bytes parsed below and the timestamp judging their
            // age describe the same file. A separate stat and read can straddle a heartbeat
            // write and pair fresh content with a stale mtime, or the reverse.
            const [stats, contents] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
            const owner = parseOwner(contents);
            return owner
                ? { kind: "owned", owner }
                : { kind: "unreadable", mtimeMs: stats.mtimeMs };
        } finally {
            // Never allowed to displace the result above: a close failure would otherwise be
            // caught below and reported as an unreadable lock this process might then seize.
            await handle.close().catch(() => undefined);
        }
    } catch (error) {
        if (isNotFound(error)) return { kind: "absent" };
        // Present but unreadable for some other reason (EACCES, EIO). Dated to now so the
        // staleness test fails closed: a file this process cannot even inspect is never one
        // it may take over.
        return { kind: "unreadable", mtimeMs: Date.now() };
    }
}

function parseOwner(contents: string): LockOwner | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const owner = parsed as Partial<LockOwner>;
    return typeof owner.nonce === "string" &&
        typeof owner.pid === "number" &&
        typeof owner.heartbeatAt === "number"
        ? { nonce: owner.nonce, pid: owner.pid, heartbeatAt: owner.heartbeatAt }
        : undefined;
}

function isAlreadyExists(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

/**
 * Reports whether a lock owner is still running.
 *
 * `ESRCH` is the only errno that proves the process is gone. `EPERM` means it exists
 * under another user, and an unrecognized errno proves nothing — both are reported as
 * live so an uncertain probe never lets a second window seize a held lock.
 */
function isProcessLive(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
        return Promise.resolve(true);
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? (error as { code?: unknown }).code
                : undefined;
        return Promise.resolve(code !== "ESRCH");
    }
}
