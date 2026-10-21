import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GitExecutor } from "../git/executor";
import { RepositoryLock } from "../git/repositoryLock";
import { PartialChangesUnsupportedError } from "../git/partialSnapshot";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import type {
    ChangelistState,
    RangeSnapshot,
    RangeSnapshotReference,
} from "../webviews/protocol/changeSelection";
import { changeFingerprint } from "./parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { resolveNoFollowFlag } from "../shelf/noFollowFlag";
import {
    snapshotReference,
    validSnapshot,
    validSnapshotReference,
    parseTargetOperationAttribution,
    type TargetOperationAttribution,
} from "./rangeMetadata";
import type { HydratedChangelistState } from "./rangeMapping";
import {
    parseTargetOperationEvidence,
    targetOperationObjectReferences,
    type TargetOperationEvidence,
    type TargetOperationAttributionReference,
    type TargetOperationBlobReference,
} from "./targetOperation";

const MAX_BYTES = 64 * 1024 * 1024;

/** Latest evidence and its original root, returned only after the complete chain validates. */
export interface TargetOperationEvidenceChain {
    readonly evidence: TargetOperationEvidence;
    readonly root: { readonly hash: string; readonly evidence: TargetOperationEvidence };
}

/** A validated checkpoint chain: its root and the identity of every file it was validated from. */
interface OperationChain {
    readonly operationId: string;
    readonly root: TargetOperationEvidenceChain["root"];
    readonly files: Map<string, string>;
}

/** Chains kept per operation; a restore step loads its previous checkpoint and the one before. */
const RECENT_OPERATION_CHAINS = 4;

/** A content object whose size and digest held under `identity`, and the checks it passed there. */
interface VerifiedObject {
    readonly identity: string;
    readonly size: number;
    readonly checks: Set<string>;
}

/** One validation pass's view of an object; `bytes` is read only when a check still needs them. */
interface PassObject {
    readonly name: string;
    readonly hash: string;
    verified: VerifiedObject;
    bytes?: Buffer;
}

/** Authoritative metadata is scoped to a canonical worktree and its own Git directory. */
interface Envelope {
    schemaVersion: 5;
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
    private readonly git: GitExecutor;
    private cached?: {
        identity: string;
        parse: (value: unknown) => ChangelistState | undefined;
        state: ChangelistState;
    };
    readonly filename: string;
    readonly evidenceDirectory: string;
    private evidenceDirectoryDurable = false;
    /** True only inside `storeSnapshotBatch`, whose final barrier replaces per-payload directory syncs. */
    private deferEvidenceDirectorySync = false;
    /** Validated chains by their newest checkpoint's hash, oldest first. */
    private readonly operationChains = new Map<string, OperationChain>();
    /** Content objects by file name, with the identity they were verified under and checks passed. */
    private readonly verifiedObjects = new Map<string, VerifiedObject>();
    /** A repository's object format is fixed when it is created; a failed lookup is not kept. */
    private objectAlgorithm?: Promise<"sha1" | "sha256">;

    /** Binds paths already canonicalized by open; metadata locking remains separate from Git's index lock. */
    private constructor(
        readonly root: string,
        readonly gitDir: string,
        readonly directory: string,
    ) {
        this.filename = path.join(directory, "state.json");
        this.evidenceDirectory = path.join(directory, "evidence");
        this.lock = new RepositoryLock({ lockDirectory: directory, lockFileName: "metadata.lock" });
        this.git = new GitExecutor(root);
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
            saved.schemaVersion !== 5 ||
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
            schemaVersion: 5,
            root: this.root,
            gitDir: this.gitDir,
            state,
        };
        await this.assertReferences(state);
        await this.publish(this.filename, envelope);
    }

    /** Reads the old inline envelope only during a lease-protected connection upgrade. */
    async readLegacy(
        parseInline: (value: unknown) => HydratedChangelistState | undefined,
        parseCompact: (value: unknown) => ChangelistState | undefined,
    ): Promise<
        | { schemaVersion: 3; state: HydratedChangelistState; bytes: string }
        | { schemaVersion: 4; state: ChangelistState; bytes: string }
        | undefined
    > {
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
        if (saved.schemaVersion === 5) return undefined;
        const state =
            saved.schemaVersion === 3
                ? parseInline(saved.state)
                : saved.schemaVersion === 4
                  ? parseCompact(saved.state)
                  : undefined;
        if (saved.root !== this.root || saved.gitDir !== this.gitDir || !state)
            throw new ChangelistEvidenceError();
        return { schemaVersion: saved.schemaVersion as 3 | 4, state, bytes } as
            | { schemaVersion: 3; state: HydratedChangelistState; bytes: string }
            | { schemaVersion: 4; state: ChangelistState; bytes: string };
    }

    /** Retains every interrupted legacy generation; a matching corrupt backup cannot be replaced. */
    async backupLegacy(bytes: string, schemaVersion: 3 | 4): Promise<void> {
        const filename = path.join(
            this.directory,
            `state-v${schemaVersion}.${changeFingerprint(bytes)}.backup.json`,
        );
        await this.publishImmutable(filename, bytes);
    }

    /** Publishes bound evidence before the manifest; unsupported fresh content stays in the whole-file workflow. */
    async storeSnapshot(file: string, snapshot: RangeSnapshot): Promise<RangeSnapshotReference> {
        try {
            const safe = assertRepoRelativePath(file);
            if (!validSnapshot(snapshot))
                throw new PartialChangesUnsupportedError("Unsupported tracked range content.");
            const bytes = JSON.stringify({
                schemaVersion: 1,
                root: this.root,
                gitDir: this.gitDir,
                path: safe,
                snapshot,
            });
            const reference = snapshotReference(snapshot, changeFingerprint(bytes));
            if (Buffer.byteLength(bytes) > MAX_BYTES)
                throw new PartialChangesUnsupportedError("Unsupported tracked range content.");
            await this.evidenceDirectoryReady(true);
            await this.publishImmutable(
                path.join(this.evidenceDirectory, `${reference.blob}.json`),
                bytes,
            );
            return reference;
        } catch (error) {
            if (error instanceof PartialChangesUnsupportedError) throw error;
            throw new ChangelistEvidenceError(error);
        }
    }

    /**
     * Migration publishes many individually fsynced payloads, then crosses one evidence-directory
     * barrier before any manifest can name them. `publish` must settle every write before resolving.
     */
    async storeSnapshotBatch<T>(publish: () => Promise<T>): Promise<T> {
        // One parent barrier up front; parallel first publications would each repeat it.
        await this.evidenceDirectoryReady(true).catch((error: unknown) => {
            throw new ChangelistEvidenceError(error);
        });
        this.deferEvidenceDirectorySync = true;
        let result: T;
        try {
            result = await publish();
        } finally {
            this.deferEvidenceDirectorySync = false;
        }
        await this.syncDirectory(this.evidenceDirectory).catch((error: unknown) => {
            throw new ChangelistEvidenceError(error);
        });
        return result;
    }

    /** Publish exact recovery bytes before an evidence checkpoint can reference them. */
    async storeTargetOperationObject(_contents: Uint8Array): Promise<string> {
        try {
            if (_contents.byteLength > MAX_BYTES) throw new ChangelistEvidenceError();
            const hash = changeFingerprint(_contents);
            await this.evidenceDirectoryReady(true);
            await this.publishImmutableBytes(
                path.join(this.evidenceDirectory, `${hash}.bin`),
                _contents,
            );
            return hash;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Read exact retained bytes through the existing no-follow boundary; reject wrong sizes and digests. */
    async loadTargetOperationObject(reference: TargetOperationBlobReference): Promise<Buffer> {
        try {
            if (
                !/^[a-f0-9]{64}$/.test(reference.hash) ||
                !Number.isSafeInteger(reference.size) ||
                reference.size < 0 ||
                reference.size > MAX_BYTES
            )
                throw new ChangelistEvidenceError();
            await this.evidenceDirectoryReady(false);
            const { bytes } = await this.readImmutableBytesWithIdentity(
                path.join(this.evidenceDirectory, `${reference.hash}.bin`),
            );
            if (bytes.length !== reference.size || changeFingerprint(bytes) !== reference.hash)
                throw new ChangelistEvidenceError();
            return bytes;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Read only a checksum-verified payload bound to this operation and affected path. */
    async loadTargetOperationAttribution(
        reference: TargetOperationAttributionReference,
        operationId: string,
    ): Promise<TargetOperationAttribution> {
        try {
            if (!/^[a-f0-9]{64}$/.test(reference.object.hash)) throw new ChangelistEvidenceError();
            const file = assertRepoRelativePath(reference.path);
            await this.evidenceDirectoryReady(false);
            const bytes = await this.readImmutableBytes(
                path.join(this.evidenceDirectory, `${reference.object.hash}.bin`),
            );
            if (
                bytes.byteLength !== reference.object.size ||
                changeFingerprint(bytes) !== reference.object.hash
            )
                throw new ChangelistEvidenceError();
            const payload = parseTargetOperationAttribution(
                JSON.parse(bytes.toString("utf8")),
                this.root,
                this.gitDir,
                operationId,
                file,
            );
            if (!payload) throw new ChangelistEvidenceError();
            return payload;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Publish one validated repository-bound operation checkpoint immutably. */
    async storeTargetOperationEvidence(_evidence: TargetOperationEvidence): Promise<string> {
        try {
            const evidence = parseTargetOperationEvidence(_evidence, this.root, this.gitDir);
            if (!evidence) throw new ChangelistEvidenceError();
            const algorithm = this.onceGitObjectAlgorithm();
            await this.validateOperationObjects(evidence, algorithm);
            if (evidence.previousEvidenceHash)
                await this.readOperationEvidence(
                    evidence.previousEvidenceHash,
                    evidence.operationId,
                    algorithm,
                );
            const bytes = JSON.stringify(evidence);
            const hash = changeFingerprint(bytes);
            await this.evidenceDirectoryReady(true);
            await this.publishImmutable(
                path.join(this.evidenceDirectory, `${hash}.operation.json`),
                bytes,
            );
            return hash;
        } catch (error) {
            throw new ChangelistEvidenceError(error);
        }
    }

    /** Load and validate one immutable operation checkpoint and all of its object references. */
    async loadTargetOperationEvidence(_hash: string): Promise<TargetOperationEvidence> {
        return (await this.loadTargetOperationEvidenceChain(_hash)).evidence;
    }

    /** Retains the root from the same full validation pass; callers need not reread ancestor suffixes. */
    async loadTargetOperationEvidenceChain(hash: string): Promise<TargetOperationEvidenceChain> {
        try {
            const { evidence, root } = await this.readOperationEvidence(hash);
            // The root is cached for later steps, so a caller must never hold the cached object.
            return structuredClone({ evidence, root });
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
        await this.operationEvidenceFiles(state, true);
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
        for (const name of await this.operationEvidenceFiles(state)) {
            if (!names.has(name)) throw new ChangelistEvidenceError();
        }
    }

    /** Collection is lease-protected and post-publication; failure leaves harmless recovery debris. */
    async collect(previous: ChangelistState | undefined, current: ChangelistState): Promise<void> {
        try {
            await this.evidenceDirectoryReady(false);
            const live = new Set([
                ...fileReferences(current).flatMap(([, refs]) =>
                    refs.map((ref) => `${ref.blob}.json`),
                ),
                ...(await this.operationEvidenceFiles(current)),
            ]);
            const candidates = previous
                ? [
                      ...new Set([
                          ...fileReferences(previous).flatMap(([, refs]) =>
                              refs.map((ref) => `${ref.blob}.json`),
                          ),
                          ...(await this.operationEvidenceFiles(previous)),
                      ]),
                  ]
                : await readdir(this.evidenceDirectory);
            // Evidence no live record names, including what another window collected, needs no cache.
            for (const hash of this.operationChains.keys())
                if (!live.has(`${hash}.operation.json`)) this.operationChains.delete(hash);
            for (const name of this.verifiedObjects.keys())
                if (!live.has(name)) this.verifiedObjects.delete(name);
            for (const name of candidates) {
                if (
                    live.has(name) ||
                    !/^[a-f0-9]{64}\.(?:json|operation\.json|bin)(?:\.[a-f0-9-]{36}\.tmp)?$/.test(
                        name,
                    )
                )
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
        return (await this.readImmutableBytes(filename)).toString("utf8");
    }

    /** Binary recovery objects use the same bounded no-follow identity checks as JSON evidence. */
    private async readImmutableBytes(filename: string): Promise<Buffer> {
        return (await this.readImmutableBytesWithIdentity(filename)).bytes;
    }

    /** Return the exact identity that remained stable for the complete immutable read. */
    private async readImmutableBytesWithIdentity(
        filename: string,
    ): Promise<{ bytes: Buffer; identity: string }> {
        const before = await lstat(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES)
            throw new ChangelistEvidenceError();
        const identity = recordIdentity(before);
        const handle = await open(filename, constants.O_RDONLY | resolveNoFollowFlag());
        try {
            if (recordIdentity(await handle.stat({ bigint: true })) !== identity)
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
                recordIdentity(await handle.stat({ bigint: true })) !== identity ||
                recordIdentity(await lstat(filename, { bigint: true })) !== identity
            )
                throw new ChangelistEvidenceError();
            return { bytes: Buffer.concat(chunks, total), identity };
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

    /** Create-only binary publication never replaces a same-name object with different bytes. */
    private async publishImmutableBytes(filename: string, bytes: Uint8Array): Promise<void> {
        try {
            if (!Buffer.from(await this.readImmutableBytes(filename)).equals(Buffer.from(bytes)))
                throw new ChangelistEvidenceError();
            await this.syncDirectory(path.dirname(filename));
            return;
        } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
        }
        try {
            await this.publish(filename, bytes, true, true);
        } catch (error) {
            if (!hasCode(error, "EEXIST")) throw error;
            if (!Buffer.from(await this.readImmutableBytes(filename)).equals(Buffer.from(bytes)))
                throw new ChangelistEvidenceError();
            await this.syncDirectory(path.dirname(filename));
        }
    }

    /** Resolves the full immutable evidence chain and content objects for GC and validation. */
    private async readOperationEvidence(
        hash: string,
        operationId?: string,
        algorithm = this.onceGitObjectAlgorithm(),
        fresh = false,
        seen = new Set<string>(),
    ): Promise<TargetOperationEvidenceChain & { files: Map<string, string> }> {
        if (!/^[a-f0-9]{64}$/.test(hash) || seen.has(hash)) throw new ChangelistEvidenceError();
        seen.add(hash);
        await this.evidenceDirectoryReady(false);
        const filename = `${hash}.operation.json`;
        const saved = await this.readImmutableBytesWithIdentity(
            path.join(this.evidenceDirectory, filename),
        );
        const bytes = saved.bytes.toString("utf8");
        if (changeFingerprint(bytes) !== hash) throw new ChangelistEvidenceError();
        const evidence = parseTargetOperationEvidence(JSON.parse(bytes), this.root, this.gitDir);
        if (!evidence || (operationId !== undefined && evidence.operationId !== operationId))
            throw new ChangelistEvidenceError();
        const files = new Map([
            [filename, saved.identity],
            ...(await this.validateOperationObjects(evidence, algorithm, fresh)),
        ]);
        let root = { hash, evidence };
        if (evidence.previousEvidenceHash) {
            const previous = await this.earlierOperationChain(
                evidence.previousEvidenceHash,
                evidence.operationId,
                algorithm,
                fresh,
                seen,
            );
            root = previous.root;
            for (const [name, identity] of previous.files) files.set(name, identity);
        }
        this.rememberOperationChain(hash, { operationId: evidence.operationId, root, files });
        return { evidence, root, files };
    }

    /** The chain below a checkpoint, re-read only when a file it was validated from has changed. */
    private async earlierOperationChain(
        hash: string,
        operationId: string,
        algorithm: () => Promise<"sha1" | "sha256">,
        fresh: boolean,
        seen: Set<string>,
    ): Promise<OperationChain> {
        const cached = fresh ? undefined : this.operationChains.get(hash);
        if (
            cached &&
            cached.operationId === operationId &&
            (await this.cachedOperationEvidenceIsCurrent(cached.files))
        )
            return cached;
        const { root, files } = await this.readOperationEvidence(
            hash,
            operationId,
            algorithm,
            fresh,
            seen,
        );
        return { operationId, root, files };
    }

    /** Keeps the newest chains of each operation; one restore step loads at most a few of them. */
    private rememberOperationChain(hash: string, chain: OperationChain): void {
        this.operationChains.delete(hash);
        this.operationChains.set(hash, chain);
        const heads = [...this.operationChains].filter(
            ([, other]) => other.operationId === chain.operationId,
        );
        for (const [old] of heads.slice(0, -RECENT_OPERATION_CHAINS))
            this.operationChains.delete(old);
    }

    /** Content references are exact checksums and sizes, never arbitrary evidence paths. */
    private async validateOperationObjects(
        evidence: TargetOperationEvidence,
        algorithm: () => Promise<"sha1" | "sha256">,
        fresh = false,
    ): Promise<Map<string, string>> {
        const files = new Map<string, string>();
        const objects = new Map<string, PassObject>();
        for (const reference of targetOperationObjectReferences(evidence)) {
            const known = objects.get(reference.hash);
            if (known) {
                if (known.verified.size !== reference.size) throw new ChangelistEvidenceError();
                continue;
            }
            const name = `${reference.hash}.bin`;
            const cached = fresh ? undefined : this.verifiedObjects.get(name);
            const object: PassObject =
                cached &&
                cached.size === reference.size &&
                (await this.cachedOperationEvidenceIsCurrent(new Map([[name, cached.identity]])))
                    ? { name, hash: reference.hash, verified: cached }
                    : await this.readVerifiedObject(name, reference.hash, reference.size);
            objects.set(reference.hash, object);
        }
        const gitEntries = [
            ...evidence.index,
            ...(evidence.wholeFileBefore ?? []).flatMap((entry) =>
                entry.head.kind === "present" ? [entry.head] : [],
            ),
        ];
        const format = gitEntries.length ? await algorithm() : undefined;
        for (const entry of gitEntries) {
            const object = objects.get(entry.object.hash);
            if (!object || !format) throw new ChangelistEvidenceError();
            await this.passObjectCheck(
                object,
                `git\0${format}\0${entry.oid}\0${entry.mode}`,
                (bytes) => matchesGitObject(entry.oid, entry.mode, bytes, format),
            );
        }
        for (const reference of evidence.attribution ?? []) {
            const object = objects.get(reference.object.hash);
            if (!object) throw new ChangelistEvidenceError();
            await this.passObjectCheck(
                object,
                `attribution\0${evidence.operationId}\0${reference.path}`,
                (bytes) =>
                    Boolean(
                        parseTargetOperationAttribution(
                            JSON.parse(bytes.toString("utf8")),
                            this.root,
                            this.gitDir,
                            evidence.operationId,
                            reference.path,
                        ),
                    ),
            );
        }
        for (const object of objects.values()) files.set(object.name, object.verified.identity);
        return files;
    }

    /** Reads one content object, checks its size and digest, and remembers it with no checks passed. */
    private async readVerifiedObject(
        name: string,
        hash: string,
        size: number,
    ): Promise<PassObject & { bytes: Buffer }> {
        this.verifiedObjects.delete(name);
        const saved = await this.readImmutableBytesWithIdentity(
            path.join(this.evidenceDirectory, name),
        );
        if (saved.bytes.byteLength !== size || changeFingerprint(saved.bytes) !== hash)
            throw new ChangelistEvidenceError();
        const verified = { identity: saved.identity, size, checks: new Set<string>() };
        this.verifiedObjects.set(name, verified);
        return { name, hash, verified, bytes: saved.bytes };
    }

    /** A check an object passed under its current identity is not repeated; its bytes cannot differ. */
    private async passObjectCheck(
        object: PassObject,
        check: string,
        passes: (bytes: Buffer) => boolean,
    ): Promise<void> {
        if (object.verified.checks.has(check)) return;
        let bytes = object.bytes;
        if (!bytes) {
            // Re-verify rather than refuse: another window may have collected and republished it.
            const reread = await this.readVerifiedObject(
                object.name,
                object.hash,
                object.verified.size,
            );
            object.verified = reread.verified;
            bytes = object.bytes = reread.bytes;
        }
        if (!passes(bytes)) throw new ChangelistEvidenceError();
        object.verified.checks.add(check);
    }

    /** One object-format lookup shared by every checkpoint this repository binding validates. */
    private onceGitObjectAlgorithm(): () => Promise<"sha1" | "sha256"> {
        return () =>
            (this.objectAlgorithm ??= this.gitObjectAlgorithm().catch((error: unknown) => {
                this.objectAlgorithm = undefined;
                throw error;
            }));
    }

    /** Ask the repository-bound Git runtime for the object format; unknown output fails closed. */
    private async gitObjectAlgorithm(): Promise<"sha1" | "sha256"> {
        const result = await this.git.runBinary(["rev-parse", "--show-object-format"], {
            maxOutputBytes: 16,
        });
        if (result.truncated) throw new ChangelistEvidenceError();
        const algorithm = result.stdout.toString("utf8").trim();
        if (!algorithm) throw new ChangelistEvidenceError();
        if (algorithm !== "sha1" && algorithm !== "sha256") throw new ChangelistEvidenceError();
        return algorithm;
    }

    /** Pending records and retained receipts are the only roots of operation evidence. */
    private async operationEvidenceFiles(
        state: ChangelistState,
        forceValidation = false,
    ): Promise<Set<string>> {
        const files = new Set<string>();
        const roots = [
            ...(state.pendingTargetOperation
                ? [
                      {
                          id: state.pendingTargetOperation.id,
                          hash: state.pendingTargetOperation.evidenceHash,
                      },
                  ]
                : []),
            ...Object.values(state.targetOperationReceipts ?? {}).flatMap((receipt) =>
                receipt.evidenceHash ? [{ id: receipt.id, hash: receipt.evidenceHash }] : [],
            ),
        ];
        for (const root of roots) {
            const resolved = await this.readOperationEvidence(
                root.hash,
                root.id,
                undefined,
                forceValidation,
            );
            for (const name of resolved.files.keys()) files.add(name);
        }
        return files;
    }

    /** Cached operation objects are reusable only while every immutable file identity is unchanged. */
    private async cachedOperationEvidenceIsCurrent(
        identities: ReadonlyMap<string, string>,
    ): Promise<boolean> {
        try {
            for (const [name, identity] of identities) {
                const details = await lstat(path.join(this.evidenceDirectory, name), {
                    bigint: true,
                });
                if (
                    !details.isFile() ||
                    details.isSymbolicLink() ||
                    details.size > MAX_BYTES ||
                    recordIdentity(details) !== identity
                )
                    return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    /** Existing orphan payloads also cross the directory durability barrier before being referenced. */
    private async syncDirectory(filename: string): Promise<void> {
        if (process.platform === "win32") return;
        if (this.deferEvidenceDirectorySync && filename === this.evidenceDirectory) return;
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
        const bytes = exactBytes
            ? typeof value === "string"
                ? Buffer.from(value)
                : Buffer.from(value as Uint8Array)
            : Buffer.from(JSON.stringify(value));
        if (bytes.byteLength > MAX_BYTES)
            throw new Error("Changelist metadata exceeds its storage budget.");
        const temporary = `${filename}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            if (createOnly) await link(temporary, filename);
            else await rename(temporary, filename);
            await this.syncDirectory(path.dirname(filename));
        } finally {
            await handle.close().catch(() => undefined);
            await rm(temporary, { force: true });
        }
    }
}

/** Git object IDs hash a type-and-length header plus the exact saved payload bytes. */
function matchesGitObject(
    oid: string,
    mode: TargetOperationEvidence["index"][number]["mode"],
    bytes: Buffer,
    algorithm: "sha1" | "sha256",
): boolean {
    if (oid.length !== (algorithm === "sha1" ? 40 : 64)) return false;
    const type = mode === "160000" ? "commit" : "blob";
    const header = Buffer.from(`${type} ${bytes.byteLength}\0`);
    return createHash(algorithm).update(header).update(bytes).digest("hex") === oid;
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
