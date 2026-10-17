import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RepositoryLock } from "../git/repositoryLock";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import type {
    ChangelistState,
    RangeSnapshot,
    RangeSnapshotReference,
} from "../webviews/protocol/changeSelection";
import { changeFingerprint } from "./parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { resolveNoFollowFlag } from "../shelf/noFollowFlag";
import { snapshotReference, validSnapshot, validSnapshotReference } from "./rangeMetadata";
import type { HydratedChangelistState } from "./rangeMapping";

const MAX_BYTES = 64 * 1024 * 1024;

/** Authoritative metadata is scoped to a canonical worktree and its own Git directory. */
interface Envelope {
    schemaVersion: 4;
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
    readonly evidenceDirectory: string;
    private evidenceDirectoryDurable = false;

    /** Binds paths already canonicalized by open; metadata locking remains separate from Git's index lock. */
    private constructor(
        readonly root: string,
        readonly gitDir: string,
        readonly directory: string,
    ) {
        this.filename = path.join(directory, "state.json");
        this.evidenceDirectory = path.join(directory, "evidence");
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
            if (Buffer.byteLength(bytes) > MAX_BYTES) throw new ChangelistEvidenceError();
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
            saved.schemaVersion !== 4 ||
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
            schemaVersion: 4,
            root: this.root,
            gitDir: this.gitDir,
            state,
        };
        await this.assertReferences(state);
        await this.publish(this.filename, envelope);
    }

    /** Reads the old inline envelope only during a lease-protected connection upgrade. */
    async readLegacy(
        parse: (value: unknown) => HydratedChangelistState | undefined,
    ): Promise<{ state: HydratedChangelistState; bytes: string } | undefined> {
        let bytes: string;
        try {
            bytes = await this.readImmutable(this.filename);
        } catch (error) {
            if (hasCode(error, "ENOENT")) return undefined;
            throw error;
        }
        const saved = JSON.parse(bytes) as {
            schemaVersion?: unknown;
            root?: unknown;
            gitDir?: unknown;
            state?: unknown;
        };
        if (saved.schemaVersion === 4) return undefined;
        const state = parse(saved.state);
        if (
            saved.schemaVersion !== 3 ||
            saved.root !== this.root ||
            saved.gitDir !== this.gitDir ||
            !state
        )
            throw new ChangelistEvidenceError();
        return { state, bytes };
    }

    /** Retains every interrupted legacy generation; a matching corrupt backup cannot be replaced. */
    async backupLegacy(bytes: string): Promise<void> {
        const filename = path.join(
            this.directory,
            `state-v3.${changeFingerprint(bytes)}.backup.json`,
        );
        await this.publishImmutable(filename, bytes);
    }

    /** Publishes fully validated, file/worktree-bound immutable evidence before manifest publication. */
    async storeSnapshot(file: string, snapshot: RangeSnapshot): Promise<RangeSnapshotReference> {
        try {
            const safe = assertRepoRelativePath(file);
            if (!validSnapshot(snapshot)) throw new ChangelistEvidenceError();
            const bytes = JSON.stringify({
                schemaVersion: 1,
                root: this.root,
                gitDir: this.gitDir,
                path: safe,
                snapshot,
            });
            const reference = snapshotReference(snapshot, changeFingerprint(bytes));
            if (Buffer.byteLength(bytes) > MAX_BYTES)
                throw new Error("Changelist metadata exceeds its storage budget.");
            await this.evidenceDirectoryReady(true);
            await this.publishImmutable(
                path.join(this.evidenceDirectory, `${reference.blob}.json`),
                bytes,
            );
            return reference;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Loads one bound snapshot under the caller's metadata lease; mismatches never become defaults. */
    async loadSnapshot(file: string, reference: RangeSnapshotReference): Promise<RangeSnapshot> {
        try {
            const safe = assertRepoRelativePath(file);
            if (!validSnapshotReference(reference)) throw new ChangelistEvidenceError();
            await this.evidenceDirectoryReady(false);
            const bytes = await this.readImmutable(
                path.join(this.evidenceDirectory, `${reference.blob}.json`),
            );
            if (changeFingerprint(bytes) !== reference.blob) throw new ChangelistEvidenceError();
            const saved = JSON.parse(bytes) as {
                schemaVersion?: unknown;
                root?: unknown;
                gitDir?: unknown;
                path?: unknown;
                snapshot?: unknown;
            };
            if (
                saved.schemaVersion !== 1 ||
                saved.root !== this.root ||
                saved.gitDir !== this.gitDir ||
                saved.path !== safe ||
                !validSnapshot(saved.snapshot)
            )
                throw new ChangelistEvidenceError();
            const expected = snapshotReference(saved.snapshot, reference.blob);
            if (
                Object.keys(expected).some(
                    (key) =>
                        expected[key as keyof RangeSnapshotReference] !==
                        reference[key as keyof RangeSnapshotReference],
                )
            )
                throw new ChangelistEvidenceError();
            return saved.snapshot;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Connection validates all live payloads once; ordinary metadata reads remain payload-free. */
    async validateEvidence(state: ChangelistState): Promise<void> {
        for (const [file, references] of fileReferences(state)) {
            for (const reference of references) await this.loadSnapshot(file, reference);
        }
    }

    /** Counts names once per publication and refuses dangling references without hydrating payloads. */
    private async assertReferences(state: ChangelistState): Promise<void> {
        await this.evidenceDirectoryReady(true);
        const names = new Set(await readdir(this.evidenceDirectory));
        for (const [, references] of fileReferences(state)) {
            for (const reference of references) {
                if (!validSnapshotReference(reference) || !names.has(`${reference.blob}.json`))
                    throw new ChangelistEvidenceError();
            }
        }
    }

    /** Collection is lease-protected and post-publication; failure leaves harmless recovery debris. */
    async collect(previous: ChangelistState | undefined, current: ChangelistState): Promise<void> {
        try {
            await this.evidenceDirectoryReady(false);
            const live = new Set(
                fileReferences(current).flatMap(([, refs]) =>
                    refs.map((ref) => `${ref.blob}.json`),
                ),
            );
            const candidates = previous
                ? [
                      ...new Set(
                          fileReferences(previous).flatMap(([, refs]) =>
                              refs.map((ref) => `${ref.blob}.json`),
                          ),
                      ),
                  ]
                : await readdir(this.evidenceDirectory);
            for (const name of candidates) {
                if (live.has(name) || !/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name))
                    continue;
                const filename = path.join(this.evidenceDirectory, name);
                const stat = await lstat(filename).catch((error: unknown) => {
                    if (hasCode(error, "ENOENT")) return undefined;
                    throw error;
                });
                if (stat?.isFile() && !stat.isSymbolicLink()) await rm(filename);
            }
        } catch (error) {
            console.warn("[IntelliGit] Changelist evidence cleanup failed:", error);
        }
    }

    /** Revalidates the canonical parent chain before payload access; symbolic directories are refused. */
    private async evidenceDirectoryReady(create: boolean): Promise<void> {
        if ((await realpath(this.directory)) !== this.directory)
            throw new ChangelistEvidenceError();
        if (create)
            await mkdir(this.evidenceDirectory, { mode: 0o700 })
                .then(() => {
                    this.evidenceDirectoryDurable = false;
                })
                .catch((error: unknown) => {
                    if (!hasCode(error, "EEXIST")) throw error;
                });
        if ((await realpath(this.evidenceDirectory)) !== this.evidenceDirectory)
            throw new ChangelistEvidenceError();
        if (create && !this.evidenceDirectoryDurable) {
            // The child directory entry must survive a crash before any manifest can name its files.
            await this.syncDirectory(this.directory);
            this.evidenceDirectoryDurable = true;
        }
    }

    /** Bounded actual reads plus descriptor/path identity checks also protect platforms without O_NOFOLLOW. */
    private async readImmutable(filename: string): Promise<string> {
        const before = await lstat(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES)
            throw new ChangelistEvidenceError();
        const handle = await open(filename, constants.O_RDONLY | resolveNoFollowFlag());
        try {
            if (recordIdentity(await handle.stat({ bigint: true })) !== recordIdentity(before))
                throw new ChangelistEvidenceError();
            const chunks: Buffer[] = [];
            let total = 0;
            for (;;) {
                const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - total));
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
                if (!bytesRead) break;
                total += bytesRead;
                if (total > MAX_BYTES) throw new ChangelistEvidenceError();
                chunks.push(chunk.subarray(0, bytesRead));
            }
            if (
                recordIdentity(await handle.stat({ bigint: true })) !== recordIdentity(before) ||
                recordIdentity(await lstat(filename, { bigint: true })) !== recordIdentity(before)
            )
                throw new ChangelistEvidenceError();
            return Buffer.concat(chunks, total).toString("utf8");
        } finally {
            await handle.close();
        }
    }

    /** Create-only publication validates an existing digest instead of overwriting corrupt evidence. */
    private async publishImmutable(filename: string, bytes: string): Promise<void> {
        try {
            if ((await this.readImmutable(filename)) !== bytes) throw new ChangelistEvidenceError();
            await this.syncDirectory(path.dirname(filename));
            return;
        } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
        }
        try {
            await this.publish(filename, bytes, true, true);
        } catch (error) {
            if (!hasCode(error, "EEXIST")) throw error;
            if ((await this.readImmutable(filename)) !== bytes) throw new ChangelistEvidenceError();
            await this.syncDirectory(path.dirname(filename));
        }
    }

    /** Existing orphan payloads also cross the directory durability barrier before being referenced. */
    private async syncDirectory(filename: string): Promise<void> {
        if (process.platform === "win32") return;
        const directory = await open(filename, "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }

    /** Migration evidence is create-once and is never replaced by a later window's stale copy. */
    async backup(value: {
        legacy: unknown;
        root: string;
        state: HydratedChangelistState;
    }): Promise<void> {
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
    migratedFrom(root: string, state: HydratedChangelistState): boolean {
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
    private async publish(
        filename: string,
        value: unknown,
        createOnly = false,
        exactBytes = false,
    ): Promise<void> {
        const bytes = exactBytes ? String(value) : JSON.stringify(value);
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
                const directory = await open(path.dirname(filename), "r");
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

/** Integrity failures must escape tracker fallback instead of looking like a successful observation. */
export class ChangelistEvidenceError extends Error {
    /** Existing review wording is retained; the original I/O failure remains available for diagnostics. */
    constructor(cause?: unknown) {
        super("Changelist metadata requires review and will not be overwritten.", { cause });
    }
}

/** Every reference header is validated, including repeated digests with different claimed metadata. */
function fileReferences(state: ChangelistState): [string, RangeSnapshotReference[]][] {
    return Object.entries(state.changes).map(([file, ownership]) => {
        const refs = [
            ...(ownership.tracking ? [ownership.tracking] : []),
            ...(ownership.history ?? []).map((entry) => entry.snapshot),
        ];
        return [file, refs];
    });
}
