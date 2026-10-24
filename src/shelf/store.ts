import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import { RepositoryLock } from "../git/repositoryLock";
import {
    assertShelfInternalParent,
    ensureShelfInternalParent,
    ensureShelfRoot,
    resolveShelfInternalPath,
    ShelfPathError,
    type ShelfPaths,
} from "./paths";
import {
    parseShelfPersistenceContract,
    parseShelfTargetOperationReceipt,
    ShelfPersistenceContractError,
    type ShelfFileEntry,
    type ShelfMetadata,
    type ShelfPersistenceContract,
    type ShelfTargetOperationReceipt,
} from "./model";
import { assertPersistedObjectReferences, isShelfObjectHash } from "./persistence";
const SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 2;
const STORE_LOCK_FILE = "store.lock";
/** Reference to one content-addressed immutable shelf object. */
export interface ShelfObjectRef {
    readonly hash: string;
}
/** Unsealed fields for one immutable shelf manifest generation. */
export interface ShelfManifestInput {
    readonly schemaVersion: number;
    readonly objectHashes: readonly string[];
    readonly files: readonly unknown[];
    readonly metadata?: ShelfMetadata;
}
/** Checksummed immutable shelf manifest generation. */
export interface ShelfManifest extends ShelfManifestInput {
    readonly generation: number;
    readonly checksum: string;
}
/** Typed shelf manifest input persisted by host shelf services. */
export interface ShelfPersistenceManifestInput extends ShelfManifestInput {
    readonly metadata: ShelfMetadata;
    readonly files: readonly ShelfFileEntry[];
}
/** Typed parsed shelf manifest returned from persistent storage. */
export interface ShelfPersistenceManifest extends ShelfManifest {
    readonly metadata: ShelfMetadata;
    readonly files: readonly ShelfFileEntry[];
}
/** Optional catalog and shelf generation preconditions for one atomic mutation. */
export interface ShelfGenerationCas {
    readonly shelfId?: string;
    readonly expectedShelfGeneration?: number;
    readonly expectedCatalogGeneration?: number;
}
/** Durable replay key and canonical request bytes for idempotent mutations. */
export interface IdempotencyRequest {
    readonly token: string;
    readonly operation: string;
    readonly payload: Uint8Array;
}
/** Durable per-path state sufficient to roll a crashed revert back safely. */
export interface ShelfJournalIndexEntry {
    readonly mode: string;
    readonly oid: string;
}
/** Durable per-path state sufficient to roll a crashed revert back safely. */
export interface ShelfJournalPathProgress {
    readonly phase: "planned" | "moved" | "written" | "reverted";
    readonly target: string;
    readonly recoveryPath: string;
    readonly hadOriginal: boolean;
    readonly writtenFingerprint: string;
    readonly originalIndexEntry?: ShelfJournalIndexEntry;
    readonly writtenIndexEntry?: ShelfJournalIndexEntry;
    readonly originalIndexFingerprint?: string;
    readonly writtenIndexFingerprint?: string;
}
/** Durable transaction journal retained across capture, application, and recovery transitions. */
export interface ShelfJournal {
    readonly id: string;
    readonly state: "shelvePendingRevert" | "shelved" | "unshelvePending" | "applied" | "ghost";
    readonly pathProgress: Readonly<Record<string, string | ShelfJournalPathProgress>>;
    readonly expectedIndexFingerprint?: string;
    readonly recoveryObjectHashes?: readonly string[];
    readonly shelf?: ShelfJournalShelfLink;
    readonly targetPublication?: ShelfTargetPublication;
}
/** Host-frozen successful entries bound to an exact source shelf under the outer metadata lease. */
export interface ShelfTargetPublicationRequest extends ShelfTargetOperationReceipt {
    readonly shelfId: string;
}
/** Checksummed journal intent retains the exact next manifest across every crash boundary. */
interface ShelfTargetPublication {
    readonly request: ShelfTargetPublicationRequest;
    readonly manifest: ShelfPersistenceManifest;
    readonly checksum: string;
}
/** Link from a recovery journal to the immutable shelf generation it protects. */
export interface ShelfJournalShelfLink {
    readonly id: string;
    readonly generation: number;
}
/** Test seams for atomic current-pointer replacement, and store-lock wait tuning. */
export interface ShelfStoreOptions {
    /** Fault injection after each durable target-publication boundary. */
    readonly publicationCheckpoint?: (
        phase: "journal" | "manifest" | "pointer" | "terminal",
    ) => Promise<void>;
    /** Fault-injection seam after durable migration publications. */
    readonly migrationCheckpoint?: (checkpoint: {
        readonly phase: "pointer" | "catalog";
        readonly shelfId?: string;
    }) => Promise<void>;
    readonly beforeCurrentPointerRename?: () => Promise<void>;
    /** How long a busy store lock is retried before the caller sees busy. Defaults to 1s. */
    readonly acquireTimeoutMs?: number;
    /** Delay between attempts while the store lock is busy. Defaults to 150ms. */
    readonly acquireRetryDelayMs?: number;
}
/** Raised when a persisted shelf artifact cannot be safely parsed or verified. */
export class ShelfStoreCorruptionError extends Error {
    /** Creates a corruption error with a safe storage-facing message. */
    constructor(message: string) {
        super(message);
        this.name = "ShelfStoreCorruptionError";
    }
}
/** A known write-admission refusal that still permits validated persisted reads. */
export class ShelfMutationAdmissionError extends ShelfStoreCorruptionError {
    /** Identifies recovery or migration review without disguising malformed or unreadable bytes. */
    constructor(message: string) {
        super(message);
        this.name = "ShelfMutationAdmissionError";
    }
}
/** Raised when a caller's expected immutable shelf generation is no longer current. */
export class ShelfStaleShelfError extends Error {
    /** Records the caller's expected generation and the generation observed under the store lock. */
    constructor(
        readonly expectedGeneration: number,
        readonly actualGeneration: number | undefined,
    ) {
        super("Shelf generation is stale.");
        this.name = "ShelfStaleShelfError";
    }
}
/** Raised when a caller's expected catalog generation is no longer current. */
export class ShelfStaleCatalogError extends Error {
    /** Records the caller's expected and lock-observed catalog generations. */
    constructor(
        readonly expectedGeneration: number,
        readonly actualGeneration: number,
    ) {
        super("Shelf catalog generation is stale.");
        this.name = "ShelfStaleCatalogError";
    }
}

interface IdempotencyRecord {
    readonly operation: string;
    readonly payloadHash: string;
    readonly result: unknown;
}

interface Catalog {
    readonly schemaVersion: number;
    readonly catalogGeneration: number;
    readonly shelves: readonly string[];
    readonly ledger: Readonly<Record<string, IdempotencyRecord>>;
}

interface MigrationSnapshot {
    readonly catalog: string | null;
    readonly pointers: readonly {
        readonly id: string;
        readonly pointer: string;
        readonly checksum: string;
    }[];
}
interface MigrationRecord {
    readonly version: 1;
    readonly repoId: string;
    readonly state: "pending" | "complete";
    readonly backupChecksum: string;
    readonly observations: readonly MigrationSnapshot[];
    readonly checksum: string;
}
/**
 * Immutable shelf storage primitive. Callers compose repository-gate ownership
 * before this store lock; storage never replaces the repository mutation gate.
 */
export class ShelfStore {
    private readonly lock: RepositoryLock;
    private readonly lockContext = new AsyncLocalStorage<{
        active: boolean;
        admitted: boolean;
        publicationChecked: boolean;
    }>();
    private readonly recoveryContext = new AsyncLocalStorage<{
        readonly id: string;
        readonly checksum: string;
        readonly shelf?: {
            readonly id: string;
            readonly generation: number;
            readonly checksum: string;
        };
    }>();

    /** Creates a store rooted at one repository-scoped shelf path. */
    constructor(
        private readonly paths: ShelfPaths,
        private readonly options: ShelfStoreOptions = {},
    ) {
        this.lock = new RepositoryLock({
            lockDirectory: path.join(paths.root, ".store-lock"),
            lockFileName: STORE_LOCK_FILE,
        });
    }

    /** Canonical repository identity derived by resolveShelfPaths; completion must reject a foreign store. */
    get repositoryId(): string {
        return this.paths.repoId;
    }

    /** Runs one storage mutation with the reusable nonce/heartbeat store lock. */
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
        if (this.lockContext.getStore()?.active) return operation();
        // Ordered, not independent: the internal parent is created inside the root, and the
        // lock file is created inside that parent. Running them together races directory
        // creation against the very directories the next step needs to already exist.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await ensureShelfRoot(this.paths);
        await ensureShelfInternalParent(this.paths, path.join(".store-lock", STORE_LOCK_FILE));
        const release = await this.acquireWithBriefWait();
        const scope = { active: true, admitted: false, publicationChecked: false };
        try {
            return await this.lockContext.run(scope, operation);
        } finally {
            scope.active = false;
            await release();
        }
    }

    /**
     * Retries a busy store lock for a bounded window, mirroring the repository gate.
     *
     * Not every caller of this lock holds that gate first. `ShelfService.listShelves`
     * reads the catalog outside it, so without a wait an ordinary shelf mutation in
     * another window makes the panel's own read fail rather than queue behind it --
     * and the panel falls back to cached shelves, showing stale state with no error.
     * A persistent owner still surfaces busy once the window is spent.
     *
     * The window is deliberately shorter than the repository gate's 5s. That gate
     * guards a mutation the user just asked for, where waiting is the expected cost.
     * This one is reached from the commit panel's aggregate refresh, which acquires
     * twice per pass and runs alongside working-tree status, stashes and ahead/behind
     * -- so its wait is a stall on unrelated data. A second covers the shelf mutations
     * that actually caused this (hundreds of milliseconds); anything slower was always
     * going to land on the panel's cached-shelf fallback, and reaching it sooner beats
     * holding the whole refresh to find out.
     */
    private async acquireWithBriefWait(): Promise<() => Promise<void>> {
        return acquireWithBoundedWait(() => this.lock.acquire(this.paths.root), {
            timeoutMs: this.options.acquireTimeoutMs ?? 1_000,
            retryDelayMs: this.options.acquireRetryDelayMs ?? 150,
        });
    }

    /**
     * Promotes every live pointer while the caller holds metadata lease, repository gate,
     * then this store lock. The host must refuse native/pending target operations first.
     * Restart inventories actual disk state; immutable backups never resurrect deleted shelves.
     */
    async migrateWithHeldLocks(): Promise<boolean> {
        if (!this.lockContext.getStore()?.active)
            throw new Error("Shelf migration requires the store lock.");
        const journals = await this.readJournals();
        // A plain unshelve-pending journal is inert (nothing finishes it); only a publication one must resume first.
        if (
            journals.some(
                (journal) =>
                    journal.state === "shelvePendingRevert" ||
                    (journal.targetPublication && journal.state === "unshelvePending"),
            )
        ) {
            throw new ShelfMutationAdmissionError("Shelf recovery must finish before migration.");
        }
        const catalog = await this.readCatalog();
        const previous = await this.readMigrationRecord();
        if (previous?.state === "complete") {
            await this.assertMutationReady();
            return false;
        }
        if (!previous && catalog.schemaVersion !== SCHEMA_VERSION) {
            throw new ShelfStoreCorruptionError("Shelf migration evidence is missing.");
        }
        const inventory = await this.migrationInventory(catalog, true);
        if (
            catalog.schemaVersion === CURRENT_SCHEMA_VERSION &&
            [...inventory.values()].some(
                (manifest) => manifest.schemaVersion !== CURRENT_SCHEMA_VERSION,
            )
        ) {
            throw new ShelfStoreCorruptionError("Foreign shelf data requires migration review.");
        }
        const snapshot = await this.migrationSnapshot(inventory);
        const backupPath = this.migrationPath("backup");
        let backup: string;
        if (previous) {
            backup = await this.readMigrationBackup(previous.backupChecksum);
        } else {
            const sealed = sealMigration({
                version: 1,
                repoId: this.paths.repoId,
                snapshot,
                checksum: "",
            });
            try {
                await writeAtomicExclusive(
                    await this.writableTarget(backupPath),
                    encodeJson(sealed),
                );
                await fsyncDirectory(path.dirname(backupPath));
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
            }
            backup = await this.readMigrationBackup();
        }
        const pending = sealMigration({
            version: 1 as const,
            repoId: this.paths.repoId,
            state: "pending" as const,
            backupChecksum: hashBytes(Buffer.from(backup)),
            observations: [...(previous?.observations ?? []), snapshot],
            checksum: "",
        });
        await this.writeAtomic(this.migrationPath("journal"), encodeJson(pending));
        for (const [id, manifest] of inventory) {
            if (manifest.schemaVersion === CURRENT_SCHEMA_VERSION) continue;
            await this.promoteCurrent(id, manifest);
            await this.options.migrationCheckpoint?.({ phase: "pointer", shelfId: id });
        }
        const verified = await this.migrationInventory(await this.readCatalog(), true);
        if (
            [...verified.values()].some(
                (manifest) => manifest.schemaVersion !== CURRENT_SCHEMA_VERSION,
            )
        ) {
            throw new ShelfStoreCorruptionError(
                "Shelf migration left an unsupported current pointer.",
            );
        }
        if (catalog.schemaVersion !== CURRENT_SCHEMA_VERSION) {
            const currentCatalog = await this.readCatalog();
            const shelves = [...verified.keys()];
            // An unchanged list keeps a panel's pre-upgrade generation valid; each promoted shelf's own generation still moves.
            const unchanged =
                JSON.stringify([...currentCatalog.shelves].sort()) === JSON.stringify(shelves);
            await this.writeCatalog({
                ...currentCatalog,
                schemaVersion: CURRENT_SCHEMA_VERSION,
                catalogGeneration: currentCatalog.catalogGeneration + (unchanged ? 0 : 1),
                shelves,
            });
            await this.options.migrationCheckpoint?.({ phase: "catalog" });
        }
        await this.writeAtomic(
            this.migrationPath("journal"),
            encodeJson(sealMigration({ ...pending, state: "complete" as const })),
        );
        await this.assertMutationReady();
        return true;
    }

    /** Whether this store has a catalog on disk; without one there are no shelves to upgrade. */
    async hasCatalog(): Promise<boolean> {
        try {
            await lstat(await this.readableTarget(this.catalogPath()));
            return true;
        } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
        }
    }

    /** Validates all live schemas once per uninterrupted lock hold, after durable completion. */
    async assertMutationReady(): Promise<void> {
        await this.assertMigrationReady();
        const scope = this.lockContext.getStore()!;
        if (scope.publicationChecked) return;
        if (
            (await this.readJournals()).some(
                (journal) => journal.targetPublication && journal.state === "unshelvePending",
            )
        ) {
            throw new ShelfMutationAdmissionError("Shelf publication must finish before mutation.");
        }
        scope.publicationChecked = true;
    }

    /** The publication adapter may resume its own intent, but never bypasses migration admission. */
    private async assertMigrationReady(): Promise<void> {
        const scope = this.lockContext.getStore();
        if (!scope?.active) throw new Error("Shelf admission requires the store lock.");
        if (scope.admitted) return;
        const record = await this.readMigrationRecord();
        const catalog = await this.readCatalog();
        if (record?.state !== "complete" || catalog.schemaVersion !== CURRENT_SCHEMA_VERSION) {
            throw new ShelfMutationAdmissionError("Shelf migration must finish before mutation.");
        }
        await this.readMigrationBackup(record.backupChecksum);
        const inventory = await this.migrationInventory(catalog, false);
        if (
            [...inventory.values()].some(
                (manifest) => manifest.schemaVersion !== CURRENT_SCHEMA_VERSION,
            )
        ) {
            throw new ShelfMutationAdmissionError("Foreign shelf data requires migration review.");
        }
        scope.admitted = true;
    }

    /**
     * Admits rollback of one existing pending capture, never new legacy writes. The caller
     * holds metadata, repository and store locks; uncertain rollback retains its evidence.
     */
    async withPendingRecovery<T>(
        id: string,
        operation: (journal: ShelfJournal) => Promise<T>,
    ): Promise<T> {
        if (!this.lockContext.getStore()?.active)
            throw new Error("Shelf recovery requires the store lock.");
        const migration = await this.readMigrationRecord();
        const catalog = await this.readCatalog();
        if (migration?.state === "complete") await this.assertMutationReady();
        else if (migration) await this.readMigrationBackup(migration.backupChecksum);
        else if (catalog.schemaVersion !== SCHEMA_VERSION)
            throw new ShelfStoreCorruptionError("Shelf migration evidence is missing.");
        const bytes = await this.readJournalBytes(id);
        const journal = parseJournal(bytes);
        if (journal.id !== id || journal.state !== "shelvePendingRevert")
            throw new ShelfStoreCorruptionError("Shelf journal is not pending capture recovery.");
        let shelf: { id: string; generation: number; checksum: string } | undefined;
        if (journal.shelf) {
            const current = await this.readCurrentManifest(journal.shelf.id);
            if (current.generation !== journal.shelf.generation)
                throw new ShelfStoreCorruptionError("Shelf recovery generation changed.");
            shelf = { ...journal.shelf, checksum: current.checksum };
        }
        return this.recoveryContext.run(
            { id, checksum: hashBytes(Buffer.from(bytes)), shelf },
            () => operation(journal),
        );
    }

    /** Terminalizes only the unchanged pending journal admitted in this rollback callback. */
    async finishPendingRecovery(id: string, outcome: "retained" | "rolledBack"): Promise<void> {
        const admission = this.recoveryContext.getStore();
        if (!this.lockContext.getStore()?.active || admission?.id !== id)
            throw new ShelfStoreCorruptionError("Shelf recovery admission is missing.");
        const bytes = await this.readJournalBytes(id);
        const journal = parseJournal(bytes);
        if (
            journal.state !== "shelvePendingRevert" ||
            hashBytes(Buffer.from(bytes)) !== admission.checksum
        )
            throw new ShelfStoreCorruptionError("Shelf recovery journal changed.");
        if (admission.shelf) {
            const current = await this.readCurrentManifest(admission.shelf.id);
            if (
                current.generation !== admission.shelf.generation ||
                current.checksum !== admission.shelf.checksum
            )
                throw new ShelfStoreCorruptionError("Shelf recovery source changed.");
        }
        if (outcome === "retained")
            await this.writeAtomic(
                this.journalPath(id),
                encodeJson({ ...journal, state: "ghost" }),
            );
        else {
            await rm(await this.readableTarget(this.journalPath(id)), { force: false });
            await fsyncDirectory(path.dirname(this.journalPath(id)));
        }
    }

    /** Inventories valid IDs from both catalog and disk, preserving object-only orphan directories. */
    private async migrationInventory(
        catalog: Catalog,
        verifyObjects: boolean,
    ): Promise<Map<string, ShelfManifest>> {
        const ids = new Set(catalog.shelves);
        try {
            for (const id of await readdir(
                await this.readableDirectory(resolveShelfInternalPath(this.paths, "shelves")),
            )) {
                if (isShelfIdentifier(id)) ids.add(id);
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        const result = new Map<string, ShelfManifest>();
        for (const id of [...ids].sort()) {
            const generation = await this.currentGenerationOrUndefined(id);
            if (generation === undefined) continue;
            const manifest = await this.readManifest(id, generation);
            if (verifyObjects)
                for (const hash of manifest.objectHashes) await this.readObject(id, hash);
            result.set(id, manifest);
        }
        return result;
    }

    /** Captures exact catalog/pointer bytes alongside the manifest checksum observed under the lock. */
    private async migrationSnapshot(
        inventory: ReadonlyMap<string, ShelfManifest>,
    ): Promise<MigrationSnapshot> {
        let catalog: string | null = null;
        try {
            catalog = await readFile(await this.readableTarget(this.catalogPath()), "utf8");
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        const pointers: MigrationSnapshot["pointers"][number][] = [];
        for (const [id, manifest] of inventory) {
            pointers.push({
                id,
                pointer: await readFile(await this.readableTarget(this.currentPath(id)), "utf8"),
                checksum: manifest.checksum,
            });
        }
        return { catalog, pointers };
    }

    /** Writes a fresh immutable generation and CASes its pointer without publishing the v2 catalog. */
    private async promoteCurrent(shelfId: string, source: ShelfManifest): Promise<void> {
        const current = await this.readCurrentManifest(shelfId);
        if (
            current.generation !== source.generation ||
            current.checksum !== source.checksum ||
            current.schemaVersion !== 1
        ) {
            throw new ShelfStoreCorruptionError("Shelf changed during migration.");
        }
        const generation = await this.nextGeneration(shelfId);
        await this.writableTarget(this.generationDirectory(shelfId, generation));
        await mkdir(this.generationDirectory(shelfId, generation), { mode: 0o700 });
        const promoted = {
            ...source,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            generation,
            checksum: "",
        };
        promoted.checksum = checksumManifest(promoted);
        await this.writeAtomic(this.manifestPath(shelfId, generation), encodeJson(promoted));
        const latest = await this.readCurrentManifest(shelfId);
        if (latest.generation !== source.generation || latest.checksum !== source.checksum)
            throw new ShelfStoreCorruptionError("Shelf changed during migration.");
        await this.writeAtomic(this.currentPath(shelfId), Buffer.from(`${generation}\n`));
    }

    private migrationPath(kind: "backup" | "journal"): string {
        return resolveShelfInternalPath(this.paths, `migration-v2-${kind}.json`);
    }

    private async readMigrationBackup(expected?: string): Promise<string> {
        const target = await this.readableTarget(this.migrationPath("backup"));
        await assertNotSymlink(target);
        const bytes = await readFile(target, "utf8");
        const backup = parseMigrationArtifact(bytes);
        if (
            backup.repoId !== this.paths.repoId ||
            !validMigrationSnapshot(backup.snapshot) ||
            (expected !== undefined && hashBytes(Buffer.from(bytes)) !== expected)
        ) {
            throw new ShelfStoreCorruptionError("Invalid shelf migration backup.");
        }
        return bytes;
    }

    private async readMigrationRecord(): Promise<MigrationRecord | undefined> {
        try {
            const target = await this.readableTarget(this.migrationPath("journal"));
            await assertNotSymlink(target);
            const value = parseMigrationArtifact(await readFile(target, "utf8"));
            if (
                value.repoId !== this.paths.repoId ||
                (value.state !== "pending" && value.state !== "complete") ||
                !isShelfObjectHash(value.backupChecksum) ||
                !Array.isArray(value.observations) ||
                value.observations.length === 0 ||
                !value.observations.every(validMigrationSnapshot)
            ) {
                throw new ShelfStoreCorruptionError("Invalid shelf migration journal.");
            }
            return value as unknown as MigrationRecord;
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    }

    /** Stores a byte object once beneath its shelf and verifies pre-existing content. */
    async putObject(shelfId: string, contents: Uint8Array): Promise<ShelfObjectRef> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            const hash = hashBytes(contents);
            const target = await this.writableTarget(this.objectPath(shelfId, hash));
            try {
                await writeAtomicExclusive(target, contents);
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
                await assertNotSymlink(target);
                const existing = await readFile(target);
                if (hashBytes(existing) !== hash) {
                    throw new ShelfStoreCorruptionError("Object path content hash mismatch.");
                }
            }
            return { hash };
        });
    }

    /** Reads an immutable object only after verifying its address checksum. */
    async readObject(shelfId: string, hash: string): Promise<Buffer> {
        const target = await this.readableTarget(this.objectPath(shelfId, hash));
        await assertNotSymlink(target);
        const object = await readFile(target);
        if (hashBytes(object) !== hash) {
            throw new ShelfStoreCorruptionError("Shelf object checksum mismatch.");
        }
        return object;
    }

    /** Adds a manifest generation, then atomically advances the small current pointer. */
    async writeGeneration(shelfId: string, input: ShelfManifestInput): Promise<ShelfManifest> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            const persistence = validatePersistenceInput(input);
            if (persistence) assertPersistedObjectReferences(persistence, input.objectHashes);
            const sourceGeneration = await this.currentGenerationOrUndefined(shelfId);
            const source =
                sourceGeneration === undefined
                    ? undefined
                    : await this.readManifest(shelfId, sourceGeneration);
            if (source && source.schemaVersion !== CURRENT_SCHEMA_VERSION)
                throw new ShelfMutationAdmissionError(
                    "Foreign shelf data requires migration review.",
                );
            const complete = makeManifest(input, await this.nextGeneration(shelfId));
            await this.writeImmutableManifest(shelfId, complete);
            await this.publishManifest(shelfId, complete, source);
            return complete;
        });
    }

    /** Writes or verifies exactly one immutable manifest; a conflicting orphan is never overwritten. */
    private async writeImmutableManifest(shelfId: string, manifest: ShelfManifest): Promise<void> {
        const directory = this.generationDirectory(shelfId, manifest.generation);
        await this.writableTarget(directory);
        try {
            await mkdir(directory, { mode: 0o700 });
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            await this.readableDirectory(directory);
        }
        const target = this.manifestPath(shelfId, manifest.generation);
        try {
            await assertNotSymlink(target);
            const existing = await readFile(await this.readableTarget(target));
            if (!existing.equals(encodeJson(manifest))) throw publicationError();
            return;
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        await this.writeAtomic(target, encodeJson(manifest));
    }

    /** Advances the pointer only from the captured generation AND checksum after durable preparation. */
    private async publishManifest(
        shelfId: string,
        manifest: ShelfManifest,
        source?: ShelfManifest,
        journal?: ShelfJournal,
    ): Promise<void> {
        await this.options.beforeCurrentPointerRename?.();
        if (journal) await this.assertUnchangedPublicationJournal(journal);
        await this.assertExactManifest(shelfId, manifest);
        const actualGeneration = await this.currentGenerationOrUndefined(shelfId);
        if (
            actualGeneration !== source?.generation ||
            (source &&
                (await this.readManifest(shelfId, source.generation)).checksum !== source.checksum)
        ) {
            throw new ShelfStoreCorruptionError("Shelf changed before pointer publication.");
        }
        await this.writeAtomic(
            this.currentPath(shelfId),
            Buffer.from(String(manifest.generation) + "\n"),
        );
        await this.addShelfToCatalog(shelfId);
    }

    /**
     * Publishes or resumes the frozen lifecycle update without Git. The caller holds metadata
     * then repository locks; this method takes the shelf lock. Empty success returns the exact
     * source and creates no receipt. Any conflicting durable identity requires explicit review.
     */
    async publishTargetOperation(
        input: ShelfTargetPublicationRequest,
    ): Promise<ShelfPersistenceManifest> {
        return this.withLock(async () => {
            const request = parsePublicationRequest(input, true);
            await this.assertMigrationReady();
            const id = publicationJournalId(request);
            const journals = await this.readJournals();
            if (
                journals.some(
                    (journal) =>
                        journal.state === "unshelvePending" &&
                        journal.targetPublication &&
                        journal.id !== id,
                )
            )
                throw publicationError();
            let journal = journals.find((candidate) => candidate.id === id);
            if (request.appliedChangeIds.length === 0) {
                if (journal) throw publicationError();
                return this.readPublicationSource(request, true);
            }
            if (!journal) {
                const source = await this.readPublicationSource(request, true);
                if (
                    source.metadata.targetOperationReceipt?.targetOperationId ===
                    request.targetOperationId
                )
                    throw publicationError();
                const manifest = targetManifest(
                    source,
                    request,
                    await this.nextGeneration(request.shelfId),
                    Date.now(),
                );
                const intent = { request, manifest, checksum: "" };
                const targetPublication = { ...intent, checksum: hashBytes(encodeJson(intent)) };
                journal = {
                    id,
                    state: "unshelvePending",
                    pathProgress: Object.fromEntries(
                        request.appliedChangeIds.map((changeId) => [changeId, "applied"]),
                    ),
                    shelf: { id: request.shelfId, generation: request.sourceGeneration },
                    targetPublication,
                };
                // Invalidate ordinary admission even when this operation shares an already admitted hold.
                this.lockContext.getStore()!.publicationChecked = false;
                await this.writeAtomic(this.journalPath(id), encodeJson(journal));
                await this.options.publicationCheckpoint?.("journal");
            }
            await this.assertUnchangedPublicationJournal(journal);
            const intent = await this.verifyPublicationIntent(journal, request);
            let current = await this.readCurrentShelfManifest(request.shelfId);
            if (
                current.generation === request.sourceGeneration &&
                current.checksum === request.sourceChecksum
            ) {
                if (journal.state !== "unshelvePending") throw publicationError();
                await this.writeImmutableManifest(request.shelfId, intent);
                await this.options.publicationCheckpoint?.("manifest");
                await this.assertUnchangedPublicationJournal(journal);
                await this.publishManifest(request.shelfId, intent, current, journal);
                await this.options.publicationCheckpoint?.("pointer");
                current = await this.readCurrentShelfManifest(request.shelfId);
            }
            assertPublishedManifest(current, intent);
            await this.assertExactManifest(request.shelfId, intent);
            await this.assertUnchangedPublicationJournal(journal);
            if (journal.state === "unshelvePending") {
                await this.writeAtomic(
                    this.journalPath(id),
                    encodeJson({
                        ...journal,
                        state: intent.metadata.lifecycle === "applied" ? "ghost" : "applied",
                    }),
                );
                await this.options.publicationCheckpoint?.("terminal");
            }
            return current;
        });
    }

    /** Returns a verified durable publication, never an empty-success or caller-asserted receipt. */
    async readTargetOperationReceipt(
        input: ShelfTargetPublicationRequest,
    ): Promise<ShelfPersistenceManifest> {
        return this.withLock(async () => {
            const request = parsePublicationRequest(input);
            const journal = await this.readJournal(publicationJournalId(request));
            if (journal.state === "unshelvePending") throw publicationError();
            await this.assertUnchangedPublicationJournal(journal);
            const intended = await this.verifyPublicationIntent(journal, request);
            const current = await this.readCurrentShelfManifest(request.shelfId);
            assertPublishedManifest(current, intended);
            await this.assertExactManifest(request.shelfId, intended);
            return current;
        });
    }

    /** Parsed checksum equality alone does not prove that retained immutable bytes are unchanged. */
    private async assertExactManifest(shelfId: string, intended: ShelfManifest): Promise<void> {
        const target = await this.readableTarget(this.manifestPath(shelfId, intended.generation));
        await assertNotSymlink(target);
        if (!(await readFile(target)).equals(encodeJson(intended))) throw publicationError();
    }

    /** Source bytes remain authoritative even after pointer publication; deletion never creates a source. */
    private async readPublicationSource(
        request: ShelfTargetPublicationRequest,
        current: boolean,
    ): Promise<ShelfPersistenceManifest> {
        const manifest = current
            ? await this.readCurrentShelfManifest(request.shelfId)
            : await this.readManifest(request.shelfId, request.sourceGeneration);
        if (
            manifest.schemaVersion !== CURRENT_SCHEMA_VERSION ||
            manifest.generation !== request.sourceGeneration ||
            manifest.checksum !== request.sourceChecksum
        )
            throw publicationError();
        return { ...manifest, ...parseShelfPersistenceContract(manifest) };
    }

    /** Re-derives only validation from the immutable source, retaining the journal's original timestamp. */
    private async verifyPublicationIntent(
        journal: ShelfJournal,
        request: ShelfTargetPublicationRequest,
    ): Promise<ShelfPersistenceManifest> {
        const validated = parseJournal(encodeJson(journal).toString("utf8"));
        const intent = validated.targetPublication;
        if (!intent || JSON.stringify(intent.request) !== JSON.stringify(request))
            throw publicationError();
        const source = await this.readPublicationSource(request, false);
        const expected = targetManifest(
            source,
            request,
            intent.manifest.generation,
            intent.manifest.metadata.appliedAt,
        );
        if (JSON.stringify(expected) !== JSON.stringify(intent.manifest)) throw publicationError();
        return intent.manifest;
    }

    /** Refuses an externally altered intent rather than terminalizing replacement evidence. */
    private async assertUnchangedPublicationJournal(journal: ShelfJournal): Promise<void> {
        if ((await this.readJournalBytes(journal.id)) !== encodeJson(journal).toString("utf8"))
            throw publicationError();
    }

    /** Persists a typed shelf generation and advances its immutable current pointer. */
    async writeShelfGeneration(
        shelfId: string,
        input: ShelfPersistenceManifestInput,
    ): Promise<ShelfPersistenceManifest> {
        const manifest = await this.writeGeneration(shelfId, input);
        const persistence = parseShelfPersistenceContract({
            metadata: manifest.metadata,
            files: manifest.files,
        });
        return { ...manifest, ...persistence };
    }

    /** Reads and checks the generation selected by the atomic pointer. */
    async readCurrentManifest(shelfId: string): Promise<ShelfManifest> {
        return this.readManifest(shelfId, await this.readCurrentGeneration(shelfId));
    }

    /** Reads the typed immutable manifest selected by the current pointer. */
    async readCurrentShelfManifest(shelfId: string): Promise<ShelfPersistenceManifest> {
        const manifest = await this.readCurrentManifest(shelfId);
        const persistence = parseManifestPersistence(manifest.metadata, manifest.files);
        if (!persistence) throw new ShelfStoreCorruptionError("Missing persisted shelf contract.");
        return { ...manifest, ...persistence };
    }

    /** Runs a mutation after atomically verifying requested shelf and catalog generations. */
    async withGenerationCas<T>(
        expected: ShelfGenerationCas,
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            if (
                expected.expectedShelfGeneration !== undefined &&
                (!expected.shelfId || !isGeneration(expected.expectedShelfGeneration))
            ) {
                throw new Error("Shelf generation CAS requires a shelf ID and safe generation.");
            }
            if (
                expected.expectedCatalogGeneration !== undefined &&
                !isGeneration(expected.expectedCatalogGeneration)
            ) {
                throw new Error("Catalog generation CAS requires a safe generation.");
            }
            if (expected.expectedCatalogGeneration !== undefined) {
                const catalog = await this.readCatalog();
                if (catalog.catalogGeneration !== expected.expectedCatalogGeneration) {
                    throw new ShelfStaleCatalogError(
                        expected.expectedCatalogGeneration,
                        catalog.catalogGeneration,
                    );
                }
            }
            if (expected.expectedShelfGeneration !== undefined && expected.shelfId) {
                const actualGeneration = await this.currentGenerationOrUndefined(expected.shelfId);
                if (actualGeneration !== expected.expectedShelfGeneration) {
                    throw new ShelfStaleShelfError(
                        expected.expectedShelfGeneration,
                        actualGeneration,
                    );
                }
            }
            return operation();
        });
    }

    /** Lists usable shelves plus corrupt IDs which callers must surface. */
    async listShelves(): Promise<{
        readonly shelfIds: readonly string[];
        readonly corruptShelfIds: readonly string[];
        readonly catalogGeneration: number;
    }> {
        return this.withLock(async () => {
            const catalog = await this.readCatalog();
            const root = resolveShelfInternalPath(this.paths, "shelves");
            let entries: readonly string[];
            try {
                entries = await readdir(await this.readableDirectory(root));
            } catch (error) {
                if (isNotFound(error)) entries = [];
                else throw error;
            }
            const shelfIds: string[] = [];
            const corruptShelfIds: string[] = [];
            // Extension host target is ES2022, so retain the compatible immutable copy before sorting.
            // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
            for (const shelfId of [...entries].sort()) {
                try {
                    // Stable traversal preserves the first corrupt manifest observed by callers.
                    // react-doctor-disable-next-line react-doctor/async-await-in-loop
                    const manifest = await this.readCurrentManifest(shelfId);
                    if (
                        catalog.schemaVersion === CURRENT_SCHEMA_VERSION &&
                        manifest.schemaVersion !== CURRENT_SCHEMA_VERSION
                    )
                        throw new ShelfStoreCorruptionError(
                            "Foreign shelf data requires migration review.",
                        );
                    shelfIds.push(shelfId);
                } catch {
                    corruptShelfIds.push(shelfId);
                }
            }
            return { shelfIds, corruptShelfIds, catalogGeneration: catalog.catalogGeneration };
        });
    }

    /** Deletes one complete shelf generation tree while preserving separate recovery snapshots. */
    async deleteShelf(shelfId: string): Promise<void> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            const target = await this.writableTarget(this.shelfDirectory(shelfId));
            await assertNotSymlink(target);
            const current = await this.readCurrentManifest(shelfId);
            if (current.schemaVersion !== CURRENT_SCHEMA_VERSION)
                throw new ShelfMutationAdmissionError(
                    "Foreign shelf data requires migration review.",
                );
            const catalog = await this.readCatalog();
            await rm(target, { recursive: true, force: false });
            if (!catalog.shelves.includes(shelfId)) return;
            await this.writeCatalog({
                ...catalog,
                catalogGeneration: catalog.catalogGeneration + 1,
                shelves: catalog.shelves.filter((id) => id !== shelfId),
            });
        });
    }

    /** Deletes only the unchanged cancelled capture, allowing its own schema promotion. */
    async deleteRecoveredShelf(shelfId: string, captured: ShelfManifest): Promise<void> {
        if (!this.lockContext.getStore()?.active)
            throw new Error("Shelf recovery deletion requires the store lock.");
        await this.assertMutationReady();
        const current = await this.readCurrentManifest(shelfId);
        const expected =
            captured.schemaVersion === CURRENT_SCHEMA_VERSION
                ? captured.checksum
                : checksumManifest({
                      ...captured,
                      schemaVersion: CURRENT_SCHEMA_VERSION,
                      generation: current.generation,
                      checksum: "",
                  });
        if (
            current.checksum !== expected ||
            (captured.schemaVersion === SCHEMA_VERSION && current.generation <= captured.generation)
        )
            throw new ShelfStoreCorruptionError(
                "Cancelled shelf changed; recovery review is required.",
            );
        await this.deleteShelf(shelfId);
    }

    /** Records a durable result before returning so retried requests replay safely. */
    async runIdempotent<T>(request: IdempotencyRequest, operation: () => Promise<T>): Promise<T> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            const catalog = await this.readCatalog();
            const payloadHash = hashBytes(request.payload);
            const existing = catalog.ledger[request.token];
            if (existing) {
                if (
                    existing.operation !== request.operation ||
                    existing.payloadHash !== payloadHash
                ) {
                    throw new Error("Idempotency token already used with a different payload.");
                }
                return existing.result as T;
            }
            const result = await operation();
            // The operation may create a generation, which updates the catalog under this reentrant lock.
            // Re-read it so recording the idempotency result cannot erase that shelf membership.
            // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
            const catalogAfterOperation = await this.readCatalog();
            const next: Catalog = {
                ...catalogAfterOperation,
                catalogGeneration: catalogAfterOperation.catalogGeneration + 1,
                ledger: {
                    ...catalogAfterOperation.ledger,
                    [request.token]: {
                        operation: request.operation,
                        payloadHash,
                        result,
                    },
                },
            };
            await this.writeCatalog(next);
            return result;
        });
    }

    /** Removes only unreferenced immutable objects, never a current or journal reference. */
    async collectGarbage(shelfId: string): Promise<readonly string[]> {
        return this.withLock(async () => {
            await this.assertMutationReady();
            const reachable = new Set((await this.readCurrentManifest(shelfId)).objectHashes);
            for (const entry of await readdir(
                await this.readableDirectory(this.shelfDirectory(shelfId)),
            )) {
                const match = /^gen-([1-9]\d*)$/.exec(entry);
                if (!match) continue;
                let manifest: ShelfManifest;
                try {
                    manifest = await this.readManifest(shelfId, Number(match[1]));
                } catch (error) {
                    // A crash between a generation's mkdir and its manifest write leaves it empty.
                    if (isNotFound(error)) continue;
                    throw error;
                }
                for (const hash of manifest.objectHashes) reachable.add(hash);
            }
            for (const journal of await this.readJournals()) {
                for (const hash of journal.recoveryObjectHashes ?? []) reachable.add(hash);
            }
            const directory = this.objectsDirectory(shelfId);
            let candidates: readonly string[];
            try {
                candidates = await readdir(await this.readableDirectory(directory));
            } catch (error) {
                if (isNotFound(error)) return [];
                throw error;
            }
            const removed: string[] = [];
            // Extension host target is ES2022, so retain the compatible immutable copy before sorting.
            // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
            for (const hash of [...candidates].sort()) {
                if (!reachable.has(hash)) {
                    // Delete in stable order so a failure leaves a deterministic, auditable remainder.
                    // react-doctor-disable-next-line react-doctor/async-await-in-loop
                    await rm(await this.readableTarget(path.join(directory, hash)), {
                        force: true,
                    });
                    removed.push(hash);
                }
            }
            return removed;
        });
    }

    /** Stores a full journal snapshot for resume/rollback rather than mutating it in place. */
    async writeJournal(journal: ShelfJournal): Promise<void> {
        await this.withLock(async () => {
            await this.assertMutationReady();
            if (
                journal.targetPublication ||
                (await this.readJournals()).some(
                    (existing) => existing.id === journal.id && existing.targetPublication,
                )
            )
                throw publicationError();
            await this.writeAtomic(this.journalPath(journal.id), encodeJson(journal));
        });
    }

    /** Transitions an existing journal to its next durable state. */
    async transitionJournal(id: string, state: ShelfJournal["state"]): Promise<void> {
        await this.withLock(async () => {
            await this.assertMutationReady();
            const journal = await this.readJournal(id);
            if (journal.targetPublication) throw publicationError();
            await this.writeAtomic(this.journalPath(id), encodeJson({ ...journal, state }));
        });
    }

    /** Deletes a completed pending journal only after recovery has reached a terminal outcome. */
    async deleteJournal(id: string): Promise<void> {
        await this.withLock(async () => {
            await this.assertMutationReady();
            if (
                (await this.readJournals()).some(
                    (journal) => journal.id === id && journal.targetPublication,
                )
            )
                throw publicationError();
            await rm(await this.readableTarget(this.journalPath(id)), { force: true });
        });
    }

    /** Returns pending and retained transaction snapshots in deterministic order. */
    async readJournals(): Promise<readonly ShelfJournal[]> {
        const directory = resolveShelfInternalPath(this.paths, "journals");
        let files: readonly string[];
        try {
            files = await readdir(await this.readableDirectory(directory));
        } catch (error) {
            if (isNotFound(error)) return [];
            throw error;
        }
        return Promise.all(
            files
                .filter((file) => file.endsWith(".json"))
                .sort()
                .map((file) => this.readJournal(file.slice(0, -".json".length))),
        );
    }

    private async readJournal(id: string): Promise<ShelfJournal> {
        return parseJournal(await this.readJournalBytes(id));
    }

    /** Reads the exact admitted evidence so unknown fields and byte changes remain protected. */
    private async readJournalBytes(id: string): Promise<string> {
        const target = await this.readableTarget(this.journalPath(id));
        await assertNotSymlink(target);
        return readFile(target, "utf8");
    }

    private async readManifest(shelfId: string, generation: number): Promise<ShelfManifest> {
        const target = await this.readableTarget(this.manifestPath(shelfId, generation));
        await assertNotSymlink(target);
        const parsed = parseManifest(await readFile(target, "utf8"));
        if (
            parsed.generation !== generation ||
            parsed.checksum !== checksumManifest({ ...parsed, checksum: "" })
        ) {
            throw new ShelfStoreCorruptionError("Shelf manifest checksum mismatch.");
        }
        return parsed;
    }

    private async nextGeneration(shelfId: string): Promise<number> {
        let currentGeneration = 0;
        try {
            currentGeneration = await this.readCurrentGeneration(shelfId);
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        if (currentGeneration > 0) {
            // A present pointer is authoritative: validate its immutable target rather than
            // treating a missing/corrupt manifest as a fresh shelf.
            currentGeneration = (await this.readManifest(shelfId, currentGeneration)).generation;
        }
        let storedGeneration = 0;
        try {
            for (const entry of await readdir(
                await this.readableDirectory(this.shelfDirectory(shelfId)),
            )) {
                const match = /^gen-([1-9]\d*)$/.exec(entry);
                const generation = match ? Number(match[1]) : Number.NaN;
                if (Number.isSafeInteger(generation))
                    storedGeneration = Math.max(storedGeneration, generation);
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        return Math.max(currentGeneration, storedGeneration) + 1;
    }

    private async readCurrentGeneration(shelfId: string): Promise<number> {
        const target = await this.readableTarget(this.currentPath(shelfId));
        await assertNotSymlink(target);
        const pointer = (await readFile(target, "utf8")).trim();
        const generation = Number(pointer);
        if (!Number.isSafeInteger(generation) || generation < 1) {
            throw new ShelfStoreCorruptionError("Invalid shelf generation pointer.");
        }
        return generation;
    }

    private async currentGenerationOrUndefined(shelfId: string): Promise<number | undefined> {
        try {
            return await this.readCurrentGeneration(shelfId);
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    }

    private generationDirectory(shelfId: string, generation: number): string {
        return path.join(this.shelfDirectory(shelfId), "gen-" + String(generation));
    }

    private async addShelfToCatalog(shelfId: string): Promise<void> {
        const catalog = await this.readCatalog();
        if (catalog.shelves.includes(shelfId)) return;
        await this.writeCatalog({
            ...catalog,
            catalogGeneration: catalog.catalogGeneration + 1,
            shelves: [...catalog.shelves, shelfId].sort(),
        });
    }

    private async readCatalog(): Promise<Catalog> {
        try {
            const target = await this.readableTarget(this.catalogPath());
            await assertNotSymlink(target);
            return parseCatalog(await readFile(target, "utf8"));
        } catch (error) {
            if (isNotFound(error)) {
                return {
                    schemaVersion: SCHEMA_VERSION,
                    catalogGeneration: 0,
                    shelves: [],
                    ledger: {},
                };
            }
            throw error;
        }
    }
    private async writeCatalog(catalog: Catalog): Promise<void> {
        await this.writeAtomic(this.catalogPath(), encodeJson(catalog));
    }
    private catalogPath(): string {
        return resolveShelfInternalPath(this.paths, "catalog.json");
    }
    private shelfDirectory(shelfId: string): string {
        return resolveShelfInternalPath(this.paths, path.join("shelves", assertShelfId(shelfId)));
    }
    private objectsDirectory(shelfId: string): string {
        return path.join(this.shelfDirectory(shelfId), "objects");
    }
    private objectPath(shelfId: string, hash: string): string {
        return path.join(this.objectsDirectory(shelfId), assertHash(hash));
    }
    private manifestPath(shelfId: string, generation: number): string {
        return path.join(this.generationDirectory(shelfId, generation), "manifest.json");
    }
    private currentPath(shelfId: string): string {
        return path.join(this.shelfDirectory(shelfId), "current");
    }
    private journalPath(id: string): string {
        return resolveShelfInternalPath(
            this.paths,
            path.join("journals", assertShelfId(id) + ".json"),
        );
    }
    private async writableTarget(target: string): Promise<string> {
        return ensureShelfInternalParent(this.paths, this.relativeToShelfRoot(target));
    }
    private async readableTarget(target: string): Promise<string> {
        return assertShelfInternalParent(this.paths, this.relativeToShelfRoot(target));
    }
    private async readableDirectory(directory: string): Promise<string> {
        await this.readableTarget(path.join(directory, ".directory-guard"));
        const details = await lstat(directory);
        if (details.isSymbolicLink() || !details.isDirectory()) {
            throw new ShelfPathError(`Shelf artifact parent is not a real directory: ${directory}`);
        }
        return directory;
    }
    private async writeAtomic(target: string, contents: Uint8Array): Promise<void> {
        await writeAtomic(await this.writableTarget(target), contents);
    }
    private relativeToShelfRoot(target: string): string {
        const relative = path.relative(this.paths.root, target);
        if (
            !relative ||
            relative === ".." ||
            relative.startsWith(".." + path.sep) ||
            path.isAbsolute(relative)
        ) {
            throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
        }
        return relative;
    }
}
async function writeAtomic(target: string, contents: Uint8Array): Promise<void> {
    await assertNotSymlink(target);
    const temporary = path.join(
        path.dirname(target),
        "." + path.basename(target) + "." + randomUUID(),
    );
    await writeAtomicExclusive(temporary, contents);
    await rename(temporary, target);
    await fsyncDirectory(path.dirname(target));
}
async function writeAtomicExclusive(target: string, contents: Uint8Array): Promise<void> {
    const file = await open(target, "wx", 0o600);
    try {
        await file.writeFile(contents);
        await file.sync();
    } finally {
        await file.close();
    }
}
async function fsyncDirectory(directory: string): Promise<void> {
    // Windows has no directory-fsync equivalent. Opening the handle SUCCEEDS there and
    // `FlushFileBuffers` on it then fails with EPERM, so every shelf write threw before this
    // gate -- 206 of them in the first portability run that got far enough to execute the suite.
    // Gated by platform rather than by catching EPERM on purpose: catching would also swallow a
    // genuine I/O failure on POSIX, where this call is what makes the rename above durable. There
    // is nothing to fall back to on Windows, which is why SQLite and LevelDB skip it too.
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
async function assertNotSymlink(target: string): Promise<void> {
    try {
        if ((await lstat(target)).isSymbolicLink()) {
            throw new ShelfPathError(`Shelf artifact cannot replace a symbolic link: ${target}`);
        }
    } catch (error) {
        if (isNotFound(error)) return;
        throw error;
    }
}

function parseCatalog(value: string): Catalog {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
        throw new ShelfStoreCorruptionError("Invalid shelf catalog.");
    const catalog = parsed as Partial<Catalog>;
    if (
        (catalog.schemaVersion !== SCHEMA_VERSION &&
            catalog.schemaVersion !== CURRENT_SCHEMA_VERSION) ||
        typeof catalog.catalogGeneration !== "number" ||
        !Number.isSafeInteger(catalog.catalogGeneration) ||
        catalog.catalogGeneration < 0 ||
        !Array.isArray(catalog.shelves) ||
        !catalog.shelves.every(isShelfIdentifier) ||
        new Set(catalog.shelves).size !== catalog.shelves.length ||
        !catalog.ledger ||
        typeof catalog.ledger !== "object" ||
        Array.isArray(catalog.ledger)
    ) {
        throw new ShelfStoreCorruptionError("Invalid shelf catalog.");
    }
    return {
        schemaVersion: catalog.schemaVersion,
        catalogGeneration: catalog.catalogGeneration,
        shelves: catalog.shelves,
        ledger: catalog.ledger,
    };
}

function parseManifest(value: string): ShelfManifest {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
        throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
    const manifest = parsed as Partial<ShelfManifest>;
    if (
        (manifest.schemaVersion !== SCHEMA_VERSION &&
            manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) ||
        typeof manifest.generation !== "number" ||
        !Number.isSafeInteger(manifest.generation) ||
        !Array.isArray(manifest.objectHashes) ||
        !Array.isArray(manifest.files) ||
        typeof manifest.checksum !== "string"
    ) {
        throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
    }
    if (!manifest.objectHashes.every(isShelfObjectHash)) {
        throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
    }
    const persistence = parseManifestPersistence(manifest.metadata, manifest.files);
    if (persistence) assertPersistedObjectReferences(persistence, manifest.objectHashes);
    return {
        schemaVersion: manifest.schemaVersion,
        generation: manifest.generation,
        objectHashes: manifest.objectHashes,
        files: persistence ? persistence.files : manifest.files,
        metadata: persistence?.metadata,
        checksum: manifest.checksum,
    };
}

function parseJournal(value: string): ShelfJournal {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
        throw new ShelfStoreCorruptionError("Invalid shelf journal.");
    const journal = parsed as Partial<ShelfJournal>;
    if (
        typeof journal.id !== "string" ||
        !isJournalState(journal.state) ||
        !journal.pathProgress ||
        typeof journal.pathProgress !== "object"
    ) {
        throw new ShelfStoreCorruptionError("Invalid shelf journal.");
    }
    const shelf = parseJournalShelfLink(journal.shelf);
    const targetPublication =
        journal.targetPublication === undefined
            ? undefined
            : parseTargetPublication(journal.targetPublication);
    if (targetPublication) {
        const { request, manifest } = targetPublication;
        if (
            journal.id !== publicationJournalId(request) ||
            shelf?.id !== request.shelfId ||
            shelf.generation !== request.sourceGeneration ||
            (journal.state !== "unshelvePending" &&
                journal.state !==
                    (manifest.metadata.lifecycle === "applied" ? "ghost" : "applied")) ||
            JSON.stringify(journal.pathProgress) !==
                JSON.stringify(
                    Object.fromEntries(request.appliedChangeIds.map((id) => [id, "applied"])),
                ) ||
            journal.expectedIndexFingerprint !== undefined ||
            journal.recoveryObjectHashes !== undefined
        )
            throw publicationError();
    }
    return {
        id: journal.id,
        state: journal.state,
        pathProgress: journal.pathProgress,
        expectedIndexFingerprint:
            typeof journal.expectedIndexFingerprint === "string"
                ? journal.expectedIndexFingerprint
                : undefined,
        recoveryObjectHashes: Array.isArray(journal.recoveryObjectHashes)
            ? journal.recoveryObjectHashes.filter(
                  (hash): hash is string => typeof hash === "string",
              )
            : undefined,
        shelf,
        targetPublication,
    };
}

function parseManifestPersistence(
    metadata: unknown,
    files: readonly unknown[],
): ShelfPersistenceContract | undefined {
    if (metadata === undefined) return undefined;
    try {
        return parseShelfPersistenceContract({ metadata, files });
    } catch (error) {
        if (error instanceof ShelfPersistenceContractError) {
            throw new ShelfStoreCorruptionError("Invalid persisted shelf contract.");
        }
        throw error;
    }
}

function parseJournalShelfLink(value: unknown): ShelfJournalShelfLink | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ShelfStoreCorruptionError("Invalid shelf journal.");
    }
    const link = value as Partial<ShelfJournalShelfLink>;
    if (!isShelfIdentifier(link.id) || !isGeneration(link.generation) || link.generation < 1) {
        throw new ShelfStoreCorruptionError("Invalid shelf journal.");
    }
    return { id: link.id, generation: link.generation };
}
function validatePersistenceInput(input: ShelfManifestInput): ShelfPersistenceContract | undefined {
    if (input.schemaVersion !== SCHEMA_VERSION && input.schemaVersion !== CURRENT_SCHEMA_VERSION)
        throw new ShelfPersistenceContractError();
    if (input.metadata === undefined) return undefined;
    return parseShelfPersistenceContract({ metadata: input.metadata, files: input.files });
}

/** Checksums the complete migration evidence, including its schema and publication state. */
function sealMigration<T extends { readonly checksum: string }>(value: T): T {
    return { ...value, checksum: hashBytes(encodeJson({ ...value, checksum: "" })) };
}

/** Fails closed on unknown versions and malformed/tampered private migration artifacts. */
function parseMigrationArtifact(bytes: string): Record<string, unknown> {
    const value: unknown = JSON.parse(bytes);
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ShelfStoreCorruptionError("Invalid shelf migration evidence.");
    const record = value as Record<string, unknown>;
    if (
        record.version !== 1 ||
        !isShelfObjectHash(record.checksum) ||
        record.checksum !== hashBytes(encodeJson({ ...record, checksum: "" }))
    )
        throw new ShelfStoreCorruptionError("Invalid shelf migration evidence.");
    return record;
}

/** Validates retained exact pointer/catalog observations without interpreting them as restoration commands. */
function validMigrationSnapshot(value: unknown): value is MigrationSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const snapshot = value as Partial<MigrationSnapshot>;
    if (snapshot.catalog !== null && typeof snapshot.catalog !== "string") return false;
    if (snapshot.catalog !== null) parseCatalog(snapshot.catalog);
    if (!Array.isArray(snapshot.pointers)) return false;
    const ids = new Set<string>();
    for (const pointer of snapshot.pointers as MigrationSnapshot["pointers"]) {
        if (
            !pointer ||
            typeof pointer !== "object" ||
            !isShelfIdentifier(pointer.id) ||
            ids.has(pointer.id) ||
            typeof pointer.pointer !== "string" ||
            !isGeneration(Number(pointer.pointer.trim())) ||
            Number(pointer.pointer.trim()) < 1 ||
            !isShelfObjectHash(pointer.checksum)
        )
            return false;
        ids.add(pointer.id);
    }
    return true;
}
function isJournalState(value: unknown): value is ShelfJournal["state"] {
    return (
        value === "shelvePendingRevert" ||
        value === "shelved" ||
        value === "unshelvePending" ||
        value === "applied" ||
        value === "ghost"
    );
}
function checksumManifest(manifest: Omit<ShelfManifest, "checksum"> | ShelfManifest): string {
    const normalized = "checksum" in manifest ? { ...manifest, checksum: "" } : manifest;
    return hashBytes(Buffer.from(JSON.stringify(normalized)));
}

/** Constructs the same canonical immutable bytes for ordinary and target-operation publications. */
function makeManifest(input: ShelfManifestInput, generation: number): ShelfManifest {
    const persistence = validatePersistenceInput(input);
    if (persistence) assertPersistedObjectReferences(persistence, input.objectHashes);
    const manifest: ShelfManifest = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        generation,
        objectHashes: [...input.objectHashes],
        files: persistence ? persistence.files : [...input.files],
        metadata: persistence?.metadata,
        checksum: "",
    };
    return { ...manifest, checksum: checksumManifest(manifest) };
}

/** Canonicalizes a host-frozen set, rejecting duplicates and unsafe identifiers before durable writes. */
function parsePublicationRequest(
    value: ShelfTargetPublicationRequest,
    allowEmpty = false,
): ShelfTargetPublicationRequest {
    if (
        !value ||
        !isShelfIdentifier(value.shelfId) ||
        !Array.isArray(value.appliedChangeIds) ||
        new Set(value.appliedChangeIds).size !== value.appliedChangeIds.length
    )
        throw publicationError();
    const appliedChangeIds = Array.from(value.appliedChangeIds as readonly string[]).sort();
    // Empty successes require identity validation too, but deliberately cannot form a durable receipt.
    if (allowEmpty && appliedChangeIds.length === 0) {
        if (
            typeof value.targetOperationId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.targetOperationId) ||
            !isGeneration(value.sourceGeneration) ||
            value.sourceGeneration < 1 ||
            !isShelfObjectHash(value.sourceChecksum)
        )
            throw publicationError();
        return {
            targetOperationId: value.targetOperationId,
            sourceGeneration: value.sourceGeneration,
            sourceChecksum: value.sourceChecksum,
            appliedChangeIds,
            shelfId: value.shelfId,
        };
    }
    const receipt = parseShelfTargetOperationReceipt({ ...value, appliedChangeIds });
    return { ...receipt, appliedChangeIds, shelfId: value.shelfId };
}

/** Derives lifecycle only for the frozen successes while retaining every source object and draft. */
function targetManifest(
    source: ShelfPersistenceManifest,
    request: ShelfTargetPublicationRequest,
    generation: number,
    appliedAt?: number,
): ShelfPersistenceManifest {
    const successful = new Set(request.appliedChangeIds);
    const available = new Set(source.files.map((entry) => entry.changeId));
    if (successful.size === 0 || request.appliedChangeIds.some((id) => !available.has(id)))
        throw publicationError();
    const files = source.files.map((entry) =>
        successful.has(entry.changeId) ? { ...entry, lifecycle: "applied" as const } : entry,
    );
    const allApplied = files.every((entry) => entry.lifecycle === "applied");
    if (allApplied && appliedAt === undefined) throw publicationError();
    const targetOperationReceipt = parseShelfTargetOperationReceipt(request);
    const manifest = makeManifest(
        {
            ...source,
            files,
            metadata: {
                ...source.metadata,
                lifecycle: allApplied ? "applied" : "shelved",
                appliedAt: allApplied ? appliedAt : undefined,
                targetOperationReceipt,
            },
        },
        generation,
    );
    return { ...manifest, ...parseShelfPersistenceContract(manifest) };
}

/** Validates journal checksum, exact immutable manifest, source identity and nonempty receipt together. */
function parseTargetPublication(value: ShelfTargetPublication): ShelfTargetPublication {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !isShelfObjectHash(value.checksum) ||
        value.checksum !== hashBytes(encodeJson({ ...value, checksum: "" }))
    )
        throw publicationError();
    const request = parsePublicationRequest(value.request);
    const manifest = parseManifest(encodeJson(value.manifest).toString("utf8"));
    if (
        manifest.schemaVersion !== CURRENT_SCHEMA_VERSION ||
        manifest.generation <= request.sourceGeneration ||
        manifest.checksum !== checksumManifest(manifest) ||
        !manifest.metadata
    )
        throw publicationError();
    const receipt = parseShelfTargetOperationReceipt(request);
    if (JSON.stringify(manifest.metadata.targetOperationReceipt) !== JSON.stringify(receipt))
        throw publicationError();
    return {
        request,
        manifest: { ...manifest, ...parseShelfPersistenceContract(manifest) },
        checksum: value.checksum,
    };
}

/** Names the one existing journal owned by a host operation without accepting filesystem paths. */
function publicationJournalId(request: ShelfTargetPublicationRequest): string {
    return `target-${hashBytes(Buffer.from(request.targetOperationId))}`;
}

/** Publication acknowledgement requires the exact intended generation, checksum, and parsed bytes. */
function assertPublishedManifest(
    current: ShelfPersistenceManifest,
    intended: ShelfPersistenceManifest,
): void {
    if (JSON.stringify(current) !== JSON.stringify(intended)) throw publicationError();
}

/** Stable refusal leaves Git, foreign shelf bytes, and the durable intent available for explicit review. */
function publicationError(): ShelfStoreCorruptionError {
    return new ShelfStoreCorruptionError("Shelf target publication requires review.");
}
function encodeJson(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value));
}
function hashBytes(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}
function assertShelfId(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid shelf identifier.");
    return value;
}
function assertHash(value: string): string {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid shelf object hash.");
    return value;
}
function isShelfIdentifier(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
function isGeneration(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
function isAlreadyExists(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}
