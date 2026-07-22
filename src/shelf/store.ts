import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
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
    ShelfPersistenceContractError,
    type ShelfFileEntry,
    type ShelfMetadata,
    type ShelfPersistenceContract,
} from "./model";
import { assertPersistedObjectReferences, isShelfObjectHash } from "./persistence";
const SCHEMA_VERSION = 1;
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
}
/** Link from a recovery journal to the immutable shelf generation it protects. */
export interface ShelfJournalShelfLink {
    readonly id: string;
    readonly generation: number;
}
/** Test seams for atomic current-pointer replacement. */
export interface ShelfStoreOptions {
    readonly beforeCurrentPointerRename?: () => Promise<void>;
}
/** Raised when a persisted shelf artifact cannot be safely parsed or verified. */
export class ShelfStoreCorruptionError extends Error {
    /** Creates a corruption error with a safe storage-facing message. */
    constructor(message: string) {
        super(message);
        this.name = "ShelfStoreCorruptionError";
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
/**
 * Immutable shelf storage primitive. Callers compose repository-gate ownership
 * before this store lock; storage never replaces the repository mutation gate.
 */
export class ShelfStore {
    private readonly lock: RepositoryLock;
    private readonly lockContext = new AsyncLocalStorage<boolean>();

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

    /** Runs one storage mutation with the reusable nonce/heartbeat store lock. */
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
        if (this.lockContext.getStore()) return operation();
        await ensureShelfRoot(this.paths);
        await ensureShelfInternalParent(this.paths, path.join(".store-lock", STORE_LOCK_FILE));
        const release = await this.lock.acquire(this.paths.root);
        try {
            return await this.lockContext.run(true, operation);
        } finally {
            await release();
        }
    }

    /** Stores a byte object once beneath its shelf and verifies pre-existing content. */
    async putObject(shelfId: string, contents: Uint8Array): Promise<ShelfObjectRef> {
        return this.withLock(async () => {
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
            const persistence = validatePersistenceInput(input);
            if (persistence) assertPersistedObjectReferences(persistence, input.objectHashes);
            const generation = await this.nextGeneration(shelfId);
            await this.writableTarget(this.generationDirectory(shelfId, generation));
            // Reserve a fresh immutable generation directory before its manifest is written.
            // A crash before the current-pointer swap can leave an orphaned generation behind.
            await mkdir(this.generationDirectory(shelfId, generation), { mode: 0o700 });
            const manifest: ShelfManifest = {
                schemaVersion: SCHEMA_VERSION,
                generation,
                objectHashes: [...input.objectHashes],
                files: persistence ? persistence.files : [...input.files],
                metadata: persistence?.metadata,
                checksum: "",
            };
            const complete: ShelfManifest = {
                ...manifest,
                checksum: checksumManifest(manifest),
            };
            const manifestPath = this.manifestPath(shelfId, generation);
            await this.writeAtomic(manifestPath, encodeJson(complete));
            await this.options.beforeCurrentPointerRename?.();
            await this.writeAtomic(this.currentPath(shelfId), Buffer.from(String(generation) + "\n"));
            await this.addShelfToCatalog(shelfId);
            return complete;
        });
    }

    /** Persists a typed shelf generation and advances its immutable current pointer. */
    async writeShelfGeneration(
        shelfId: string,
        input: ShelfPersistenceManifestInput,
    ): Promise<ShelfPersistenceManifest> {
        const manifest = await this.writeGeneration(shelfId, input);
        const persistence = parseShelfPersistenceContract({ metadata: manifest.metadata, files: manifest.files });
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
                    throw new ShelfStaleShelfError(expected.expectedShelfGeneration, actualGeneration);
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
            for (const shelfId of [...entries].sort()) {
                try {
                    await this.readCurrentManifest(shelfId);
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
            const target = await this.writableTarget(this.shelfDirectory(shelfId));
            await assertNotSymlink(target);
            await this.readCurrentManifest(shelfId);
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

    /** Records a durable result before returning so retried requests replay safely. */
    async runIdempotent<T>(request: IdempotencyRequest, operation: () => Promise<T>): Promise<T> {
        return this.withLock(async () => {
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
            const reachable = new Set((await this.readCurrentManifest(shelfId)).objectHashes);
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
            for (const hash of [...candidates].sort()) {
                if (!reachable.has(hash)) {
                    await rm(await this.readableTarget(path.join(directory, hash)), { force: true });
                    removed.push(hash);
                }
            }
            return removed;
        });
    }

    /** Stores a full journal snapshot for resume/rollback rather than mutating it in place. */
    async writeJournal(journal: ShelfJournal): Promise<void> {
        await this.withLock(async () => {
            await this.writeAtomic(this.journalPath(journal.id), encodeJson(journal));
        });
    }

    /** Transitions an existing journal to its next durable state. */
    async transitionJournal(id: string, state: ShelfJournal["state"]): Promise<void> {
        await this.withLock(async () => {
            const journal = await this.readJournal(id);
            await this.writeAtomic(this.journalPath(id), encodeJson({ ...journal, state }));
        });
    }

    /** Deletes a completed pending journal only after recovery has reached a terminal outcome. */
    async deleteJournal(id: string): Promise<void> {
        await this.withLock(async () => {
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
        const target = await this.readableTarget(this.journalPath(id));
        await assertNotSymlink(target);
        return parseJournal(await readFile(target, "utf8"));
    }

    private async readManifest(shelfId: string, generation: number): Promise<ShelfManifest> {
        const target = await this.readableTarget(this.manifestPath(shelfId, generation));
        await assertNotSymlink(target);
        const parsed = parseManifest(
            await readFile(target, "utf8"),
        );
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
            for (const entry of await readdir(await this.readableDirectory(this.shelfDirectory(shelfId)))) {
                const match = /^gen-([1-9]\d*)$/.exec(entry);
                const generation = match ? Number(match[1]) : Number.NaN;
                if (Number.isSafeInteger(generation)) storedGeneration = Math.max(storedGeneration, generation);
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
        catalog.schemaVersion !== SCHEMA_VERSION ||
        typeof catalog.catalogGeneration !== "number" ||
        !Number.isSafeInteger(catalog.catalogGeneration) ||
        !Array.isArray(catalog.shelves) ||
        !catalog.ledger ||
        typeof catalog.ledger !== "object"
    ) {
        throw new ShelfStoreCorruptionError("Invalid shelf catalog.");
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        catalogGeneration: catalog.catalogGeneration,
        shelves: catalog.shelves.filter((item): item is string => typeof item === "string"),
        ledger: catalog.ledger,
    };
}

function parseManifest(value: string): ShelfManifest {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
        throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
    const manifest = parsed as Partial<ShelfManifest>;
    if (
        manifest.schemaVersion !== SCHEMA_VERSION ||
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
        schemaVersion: SCHEMA_VERSION,
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
    if (input.metadata === undefined) return undefined;
    if (input.schemaVersion !== SCHEMA_VERSION) throw new ShelfPersistenceContractError();
    return parseShelfPersistenceContract({ metadata: input.metadata, files: input.files });
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
