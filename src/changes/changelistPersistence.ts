import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
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
    readonly filename: string;

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

    /** Synchronous bounded reads keep existing draft read APIs fresh across extension hosts. */
    read(parse: (value: unknown) => ChangelistState | undefined): ChangelistState | undefined {
        let bytes: string;
        try {
            const stat = lstatSync(this.filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                throw new Error("Changelist metadata requires review and will not be overwritten.");
            bytes = readFileSync(this.filename, "utf8");
        } catch (error) {
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

/** Error-code checks retain permission and malformed-state failures rather than treating them as absence. */
function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}
