import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, type BigIntStats } from "node:fs";
import { link, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RepositoryLock } from "../git/repositoryLock";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import type { ChangelistState } from "../webviews/protocol/changeSelection";
import { changeFingerprint } from "./parseDiff";

const MAX_BYTES = 64 * 1024 * 1024;

/** Authoritative metadata is scoped to a canonical worktree and its own Git directory. */
interface Envelope {
    schemaVersion: 3;
    root: string;
    gitDir: string;
    state: ChangelistState;
}

/**
 * An atomic JSON record plus a separate cross-process metadata lease. No operation here
 * touches Git's index lock, refs, tracked files, or the shared common-directory state.
 */
export class ChangelistPersistence {
    private readonly lock: RepositoryLock;
    private cached?: {
        identity: string;
        parse: (value: unknown) => ChangelistState | undefined;
        state: ChangelistState;
    };
    readonly filename: string;

    /** Binds paths already canonicalized by open; metadata locking remains separate from Git's index lock. */
    private constructor(
        readonly root: string,
        readonly gitDir: string,
        readonly directory: string,
    ) {
        this.filename = path.join(directory, "state.json");
        this.lock = new RepositoryLock({ lockDirectory: directory, lockFileName: "metadata.lock" });
    }

    /** Refuse symlinked metadata directories before acquiring or writing any record. */
    static async open(root: string, gitDir: string): Promise<ChangelistPersistence> {
        const canonicalRoot = await realpath(root);
        const canonicalGit = await realpath(gitDir);
        const parent = path.join(canonicalGit, "intelligit");
        const directory = path.join(parent, "changelists");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        if ((await realpath(parent)) !== parent)
            throw new Error("Changelist storage requires review.");
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
            if (!hasCode(error, "EEXIST")) throw error;
        });
        if ((await realpath(directory)) !== directory)
            throw new Error("Changelist storage requires review.");
        return new ChangelistPersistence(canonicalRoot, canonicalGit, directory);
    }

    /** Brief contention retries; the acquired lease spans read/check/write or the selected commit. */
    acquire(): Promise<() => Promise<void>> {
        return acquireWithBoundedWait(() => this.lock.acquire(this.gitDir), {
            timeoutMs: 2_000,
            retryDelayMs: 25,
        });
    }

    /**
     * Reuses validated state only while the file identity and parser are unchanged. Callers
     * must not mutate the borrowed state; ChangelistStore returns independent snapshots.
     * Missing, unsafe, or unreadable records invalidate the cache and retain read failures.
     */
    read(parse: (value: unknown) => ChangelistState | undefined): ChangelistState | undefined {
        let bytes: string;
        let identity: string | undefined;
        try {
            const stat = lstatSync(this.filename, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                throw new Error("Changelist metadata requires review and will not be overwritten.");
            identity = recordIdentity(stat);
            if (this.cached?.identity === identity && this.cached.parse === parse)
                return this.cached.state;
            this.cached = undefined;
            bytes = readFileSync(this.filename, "utf8");
            // A rename during the read must not associate new bytes with the previous inode.
            if (recordIdentity(lstatSync(this.filename, { bigint: true })) !== identity)
                identity = undefined;
        } catch (error) {
            this.cached = undefined;
            if (hasCode(error, "ENOENT")) return undefined;
            throw error;
        }
        const saved = JSON.parse(bytes) as Partial<Envelope>;
        const state = parse(saved.state);
        if (
            saved.schemaVersion !== 3 ||
            saved.root !== this.root ||
            saved.gitDir !== this.gitDir ||
            !state
        )
            throw new Error("Changelist metadata requires review and will not be overwritten.");
        if (identity !== undefined) this.cached = { identity, parse, state };
        return state;
    }

    /** Publish only a complete fsynced record; a failed write leaves the previous file intact. */
    async write(state: ChangelistState): Promise<void> {
        const envelope: Envelope = {
            schemaVersion: 3,
            root: this.root,
            gitDir: this.gitDir,
            state,
        };
        await this.publish(this.filename, envelope);
    }

    /** Migration evidence is create-once and is never replaced by a later window's stale copy. */
    async backup(value: { legacy: unknown; root: string; state: ChangelistState }): Promise<void> {
        const filename = path.join(this.directory, "migration.json");
        try {
            await this.publish(filename, value, true);
        } catch (error) {
            if (hasCode(error, "EEXIST")) {
                const stat = lstatSync(filename);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                    throw new Error("Changelist migration backup requires review.");
                const saved = JSON.parse(readFileSync(filename, "utf8")) as typeof value;
                if (
                    saved.root !== value.root ||
                    JSON.stringify(saved.state) !== JSON.stringify(value.state)
                )
                    throw new Error("Changelist migration backup requires review.");
                return;
            }
            throw error;
        }
    }

    /** Only this root's immutable seed proves its migration; missing or corrupt evidence cannot authorize it. */
    migratedFrom(root: string, state: ChangelistState): boolean {
        const filename = path.join(this.directory, "migration.json");
        try {
            const stat = lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                throw new Error("Changelist migration backup requires review.");
            const saved = JSON.parse(readFileSync(filename, "utf8")) as {
                root?: unknown;
                state?: unknown;
            } | null;
            return saved?.root === root && JSON.stringify(saved.state) === JSON.stringify(state);
        } catch (error) {
            if (hasCode(error, "ENOENT")) return false;
            throw error;
        }
    }

    /** Preserve a conflicting workspace migration separately instead of overwriting either intent. */
    async preserveConflict(value: unknown): Promise<void> {
        await this.publish(
            path.join(
                this.directory,
                `migration-conflict-${changeFingerprint(JSON.stringify(value))}.json`,
            ),
            value,
        );
    }

    /** Fsync before publication; create-only links also preserve existing migration evidence. */
    private async publish(filename: string, value: unknown, createOnly = false): Promise<void> {
        const bytes = JSON.stringify(value);
        if (Buffer.byteLength(bytes) > MAX_BYTES)
            throw new Error("Changelist metadata exceeds its storage budget.");
        const temporary = `${filename}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            if (createOnly) await link(temporary, filename);
            else await rename(temporary, filename);
            if (process.platform !== "win32") {
                const directory = await open(this.directory, "r");
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            }
        } finally {
            await handle.close().catch(() => undefined);
            await rm(temporary, { force: true });
        }
    }
}

/** Nanosecond timestamps retain same-size edits; device and inode distinguish atomic replacements. */
function recordIdentity(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Error-code checks retain permission and malformed-state failures rather than treating them as absence. */
function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}
