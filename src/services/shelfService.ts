import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { RepositoryMutationGate } from "../git/repositoryMutationGate";
import { validateShelfManifestPath } from "../shelf/importValidation";
import { type ShelfFileEntry, type ShelfLayerBlock } from "../shelf/model";
import { replaceRegularWorktreeFile } from "../shelf/safeWorktreeWrite";
import {
    purgeRecoverySnapshots,
    ShelfReverter,
    type PendingShelfRecoveryResult,
} from "../shelf/recovery";
import type { ShelfStore } from "../shelf/store";
import {
    exportFlattenedPatch,
    importPatchFiles,
    pathFingerprint,
    resolveStructuralAction,
    type ShelfListResult,
    type StructuralResolutionInput,
} from "./shelfServiceOperations";
import { captureShelfArtifacts } from "./shelfServiceCapture";
import {
    ShelfConflictSessionService,
    type ApplyShelfConflictResolutionInput,
    type ApplyShelfConflictResolutionResult,
    type ShelfConflictSessionPayload,
} from "./shelfConflictSession";
import {
    assertShelfName,
    isNotFound,
    isStructural,
    repositoryPath,
    selectEntries,
    statusFor,
} from "./shelfServiceHelpers";
export { ShelfRecoveryFullError } from "../shelf/recovery";
export { ShelfStaleCatalogError, ShelfStaleShelfError } from "../shelf/store";
export type { ShelfListResult, ShelfSummary } from "./shelfServiceOperations";
/** One public per-entry outcome; later protocol code maps these without string parsing. */
export type PerEntryResult =
    | { readonly kind: "applied"; readonly changeId: string }
    | { readonly kind: "conflicted"; readonly changeId: string }
    | { readonly kind: "retained"; readonly changeId: string; readonly reason: string }
    | { readonly kind: "flattenedResidue"; readonly changeId: string }
    | { readonly kind: "refused"; readonly changeId: string; readonly reason: string }
    | {
          readonly kind: "structuralPending";
          readonly changeId: string;
          readonly reason: string;
          readonly path: string;
          readonly pathFingerprint: string;
      };
/** Aggregate state returned by a shelf mutation. */
export type ShelfMutationStatus =
    | "ok"
    | "partial"
    | "conflicts"
    | "staleShelf"
    | "staleCatalog"
    | "busy"
    | "recoveryFull"
    | "error";
/** Result returned by every mutating shelf operation. */
export interface ShelfMutationResult {
    readonly status: ShelfMutationStatus;
    readonly entries: readonly PerEntryResult[];
    readonly shelfId?: string;
    readonly newGeneration?: number;
}
/** Dependencies supplied by the repository host. */
export interface ShelfServiceOptions {
    readonly repositoryRoot: string;
    readonly executor: GitExecutor;
    readonly store: ShelfStore;
    readonly gate: RepositoryMutationGate;
    readonly gitOps?: GitOps;
    readonly reverter?: ShelfReverter;
    readonly recoveryMinimumRetentionMs?: number;
    /** Retain immutable captured base blobs; disabled shelves resolve bases through pinned history. */
    readonly recordBaseRevisions?: boolean;
}
/** Request for capturing selected repository changes. */
export interface ShelveInput {
    readonly name: string;
    readonly paths: readonly string[];
    readonly silent: boolean;
    readonly keepLocal: boolean;
    readonly expectedCatalogGeneration?: number;
    readonly idempotencyToken?: string;
}
/** Request for applying complete stored shelf entries. */
export interface UnshelveInput {
    readonly id: string;
    readonly changeIds?: readonly string[];
    readonly removeFromShelf: boolean;
    readonly mode: "flattened" | "exactState";
    readonly expectedShelfGeneration?: number;
}
/** Optimistic-concurrency selector for one shelf generation. */
export interface ShelfGenerationInput {
    readonly id: string;
    readonly expectedShelfGeneration?: number;
}
/** Request for importing one or more bounded patch files. */
export interface ImportPatchInput {
    readonly fileUris: readonly string[];
    readonly idempotencyToken?: string;
    readonly expectedCatalogGeneration?: number;
    readonly name?: string;
}
/** Repository host orchestration for persisted shelves; providers and protocol stay outside this module. */
export class ShelfService {
    private readonly gitOps: GitOps;
    private readonly reverter: ShelfReverter;
    private readonly recoveryMinimumRetentionMs: number;
    private readonly recordBaseRevisions: boolean;
    private readonly conflictSessions: ShelfConflictSessionService;
    /** Initializes host-owned Git and recovery collaborators. */
    constructor(private readonly options: ShelfServiceOptions) {
        this.gitOps = options.gitOps ?? new GitOps(options.executor);
        this.reverter =
            options.reverter ??
            new ShelfReverter({
                repositoryRoot: options.repositoryRoot,
                gitOps: this.gitOps,
                gate: options.gate,
                store: options.store,
            });
        this.recoveryMinimumRetentionMs = options.recoveryMinimumRetentionMs ?? 24 * 60 * 60 * 1000;
        this.recordBaseRevisions = options.recordBaseRevisions ?? true;
        this.conflictSessions = new ShelfConflictSessionService({
            repositoryRoot: options.repositoryRoot,
            store: options.store,
            executor: options.executor,
            withMutation: (operation) => this.withMutation(operation),
            readBase: (id, entry) => this.baseForEntry(id, entry),
            getGitDirectories: () => this.gitOps.getGitDirectories(),
        });
    }
    /** Captures selected layers durably; Save to Shelf deliberately skips the destructive reverter. */
    async shelve(input: ShelveInput): Promise<ShelfMutationResult> {
        assertShelfName(input.name);
        const payload = Buffer.from(JSON.stringify(input));
        return this.withMutation(async () => {
            const create = async (): Promise<ShelfMutationResult> => {
                const created = await this.options.store.withGenerationCas(
                    { expectedCatalogGeneration: input.expectedCatalogGeneration },
                    async () => this.captureShelf(input),
                );
                return created;
            };
            if (!input.idempotencyToken) return create();
            return this.options.store.runIdempotent(
                { token: input.idempotencyToken, operation: "shelve", payload },
                create,
            );
        });
    }
    /** Applies whole selected entries only; flattened mode never writes the Git index. */
    async unshelve(input: UnshelveInput): Promise<ShelfMutationResult> {
        return this.withMutation(async () =>
            this.options.store.withGenerationCas(
                { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
                async () => {
                    const manifest = await this.options.store.readCurrentShelfManifest(input.id);
                    const selected = selectEntries(manifest.files, input.changeIds);
                    const indexBefore =
                        input.mode === "flattened" ? await this.indexFingerprint() : undefined;
                    const entries: PerEntryResult[] = [];
                    for (const entry of selected) {
                        entries.push(await this.applyEntry(input.id, entry, input.mode));
                        if (indexBefore && (await this.indexFingerprint()) !== indexBefore) {
                            throw new Error("Flattened unshelve changed the Git index.");
                        }
                    }
                    const successful = new Set(
                        entries
                            .filter(
                                (entry) =>
                                    entry.kind === "applied" || entry.kind === "flattenedResidue",
                            )
                            .map((entry) => entry.changeId),
                    );
                    let nextGeneration = manifest.generation;
                    if (input.removeFromShelf && successful.size > 0) {
                        const files = manifest.files.map((entry) =>
                            successful.has(entry.changeId)
                                ? { ...entry, lifecycle: "applied" as const }
                                : entry,
                        );
                        const allApplied = files.every((entry) => entry.lifecycle === "applied");
                        const journalId = `unshelve-${randomUUID().replaceAll("-", "")}`;
                        await this.options.store.writeJournal({
                            id: journalId,
                            state: "unshelvePending",
                            pathProgress: Object.fromEntries(
                                [...successful].map((changeId) => [changeId, "applied"]),
                            ),
                            shelf: { id: input.id, generation: manifest.generation },
                        });
                        const next = await this.options.store.writeShelfGeneration(input.id, {
                            schemaVersion: manifest.schemaVersion,
                            objectHashes: manifest.objectHashes,
                            metadata: {
                                ...manifest.metadata,
                                lifecycle: allApplied ? "applied" : "shelved",
                                appliedAt: allApplied ? Date.now() : undefined,
                            },
                            files,
                        });
                        await this.options.store.transitionJournal(
                            journalId,
                            allApplied ? "ghost" : "applied",
                        );
                        nextGeneration = next.generation;
                    }
                    return {
                        status: statusFor(entries),
                        entries,
                        shelfId: input.id,
                        newGeneration: nextGeneration,
                    };
                },
            ),
        );
    }
    /** Deletes only shelf artifacts; recovery snapshots have independent retention. */
    async deleteShelf(input: ShelfGenerationInput): Promise<ShelfMutationResult> {
        return this.withMutation(async () =>
            this.options.store.withGenerationCas(
                { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
                async () => {
                    await this.options.store.deleteShelf(input.id);
                    return { status: "ok", entries: [], shelfId: input.id };
                },
            ),
        );
    }
    /** Renaming is a new immutable generation; patch objects remain content-addressed and unchanged. */
    async renameShelf(
        input: ShelfGenerationInput & { readonly name: string },
    ): Promise<ShelfMutationResult> {
        assertShelfName(input.name);
        return this.withMutation(async () =>
            this.options.store.withGenerationCas(
                { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
                async () => {
                    const manifest = await this.options.store.readCurrentShelfManifest(input.id);
                    const next = await this.options.store.writeShelfGeneration(input.id, {
                        schemaVersion: manifest.schemaVersion,
                        objectHashes: manifest.objectHashes,
                        metadata: { ...manifest.metadata, name: input.name },
                        files: manifest.files,
                    });
                    return {
                        status: "ok",
                        entries: [],
                        shelfId: input.id,
                        newGeneration: next.generation,
                    };
                },
            ),
        );
    }
    /** Creates the documented lossy content-only patch stream from whole selected entries. */
    async exportPatch(input: {
        readonly id: string;
        readonly changeIds?: readonly string[];
    }): Promise<Buffer> {
        const manifest = await this.options.store.readCurrentShelfManifest(input.id);
        return exportFlattenedPatch(
            this.options.store,
            input.id,
            selectEntries(manifest.files, input.changeIds),
        );
    }
    /** Imports bounded absolute patch files into a content-only shelf. */
    async importPatch(input: ImportPatchInput): Promise<ShelfMutationResult> {
        if (input.name !== undefined) assertShelfName(input.name);
        const payload = Buffer.from(JSON.stringify(input));
        return this.withMutation(async () => {
            const create = async (): Promise<ShelfMutationResult> =>
                this.options.store.withGenerationCas(
                    { expectedCatalogGeneration: input.expectedCatalogGeneration },
                    async () => {
                        const imported = await importPatchFiles(
                            this.options.store,
                            input.fileUris,
                            input.name,
                        );
                        return {
                            status: "ok",
                            entries: [],
                            shelfId: imported.shelfId,
                            newGeneration: imported.generation,
                        };
                    },
                );
            if (!input.idempotencyToken) return create();
            return this.options.store.runIdempotent(
                { token: input.idempotencyToken, operation: "importPatch", payload },
                create,
            );
        });
    }
    /** Restores a previously applied ghost shelf to its shelved lifecycle. */
    async restoreGhost(input: ShelfGenerationInput): Promise<ShelfMutationResult> {
        return this.withMutation(async () =>
            this.options.store.withGenerationCas(
                { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
                async () => {
                    const manifest = await this.options.store.readCurrentShelfManifest(input.id);
                    if (manifest.metadata.lifecycle !== "applied")
                        throw new Error("Shelf is not an already-unshelved ghost.");
                    const next = await this.options.store.writeShelfGeneration(input.id, {
                        schemaVersion: manifest.schemaVersion,
                        objectHashes: manifest.objectHashes,
                        metadata: { ...manifest.metadata, lifecycle: "shelved" },
                        files: manifest.files.map((file) => ({ ...file, lifecycle: "shelved" })),
                    });
                    return {
                        status: "ok",
                        entries: [],
                        shelfId: input.id,
                        newGeneration: next.generation,
                    };
                },
            ),
        );
    }
    /** Deletes selected already-applied ghost shelves. */
    async cleanUp(selection: {
        readonly shelfIds: readonly string[];
        readonly expectedCatalogGeneration?: number;
    }): Promise<ShelfMutationResult> {
        return this.withMutation(async () => this.cleanUpSelection(selection));
    }
    /** Deletes fully applied ghosts older than the configured age; zero preserves PyCharm's default. */
    async cleanUpExpiredGhosts(days: number, now = Date.now()): Promise<ShelfMutationResult> {
        if (!Number.isFinite(days) || days <= 0) return { status: "ok", entries: [] };
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        return this.withMutation(async () => {
            const listed = await this.options.store.listShelves();
            const shelfIds = (
                await Promise.all(
                    listed.shelfIds.map(async (id) => ({
                        id,
                        manifest: await this.options.store.readCurrentShelfManifest(id),
                    })),
                )
            )
                .filter(
                    ({ manifest }) =>
                        manifest.metadata.lifecycle === "applied" &&
                        manifest.metadata.appliedAt !== undefined &&
                        manifest.metadata.appliedAt < cutoff,
                )
                .map(({ id }) => id);
            if (shelfIds.length === 0) return { status: "ok", entries: [] };
            return this.cleanUpSelection({
                shelfIds,
                expectedCatalogGeneration: listed.catalogGeneration,
            });
        });
    }
    /** Applies one explicitly chosen structural resolution after fingerprint validation. */
    async resolveStructural(input: StructuralResolutionInput): Promise<ShelfMutationResult> {
        return this.withMutation(async () =>
            this.options.store.withGenerationCas(
                { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
                async () => {
                    const entry = (
                        await this.options.store.readCurrentShelfManifest(input.id)
                    ).files.find((file) => file.changeId === input.changeId);
                    if (!entry || !isStructural(entry))
                        throw new Error("Structural shelf entry does not exist.");
                    await resolveStructuralAction(input, this.options, entry);
                    return {
                        status: "ok",
                        entries: [{ kind: "applied", changeId: entry.changeId }],
                        shelfId: input.id,
                    };
                },
            ),
        );
    }
    /** Opens a read-only shelf text-conflict session without holding mutation serialization. */
    async openShelfConflictSession(
        id: string,
        changeId: string,
    ): Promise<ShelfConflictSessionPayload> {
        return this.conflictSessions.open({ id, changeId });
    }
    /** Applies a shelf merge result through the session's queue, CAS, and fingerprint guards. */
    async applyShelfConflictResolution(
        input: ApplyShelfConflictResolutionInput,
    ): Promise<ApplyShelfConflictResolutionResult> {
        return this.conflictSessions.apply(input);
    }
    /** Explicit recovery purge; deleting a shelf never reaches this path. */
    async purgeRecovery(): Promise<readonly string[]> {
        return this.withMutation(async () => {
            const directories = await this.gitOps.getGitDirectories();
            return purgeRecoverySnapshots({
                gitDir: directories.gitDir,
                minimumRetentionMs: this.recoveryMinimumRetentionMs,
            });
        });
    }
    /** Lists usable shelves with the lock-authoritative catalog generation. */
    async listShelves(): Promise<ShelfListResult> {
        const initial = await this.options.store.listShelves();
        await Promise.all(initial.shelfIds.map((id) => this.refreshHistoryBaseAvailability(id)));
        const listed = await this.options.store.listShelves();
        return {
            ...listed,
            shelves: await Promise.all(
                listed.shelfIds.map(async (id) => {
                    const manifest = await this.options.store.readCurrentShelfManifest(id);
                    return { id, generation: manifest.generation, metadata: manifest.metadata };
                }),
            ),
        };
    }
    /** Returns the immutable current entries for one shelf. */
    async getShelfFiles(id: string): Promise<readonly ShelfFileEntry[]> {
        return (await this.refreshHistoryBaseAvailability(id)).files;
    }
    /** Returns only immutable stored artifacts, never a fake current-file base. */
    async getShelfFileContents(
        id: string,
        changeId: string,
    ): Promise<{
        readonly indexPatch?: Buffer;
        readonly worktreePatch?: Buffer;
        readonly rawBefore?: Buffer;
        readonly rawAfter?: Buffer;
    }> {
        const entry = (await this.options.store.readCurrentShelfManifest(id)).files.find(
            (file) => file.changeId === changeId,
        );
        if (!entry) throw new Error("Shelf entry does not exist.");
        return {
            indexPatch: entry.indexBlock?.patchObjectHash
                ? await this.options.store.readObject(id, entry.indexBlock.patchObjectHash)
                : undefined,
            worktreePatch: entry.worktreeBlock?.patchObjectHash
                ? await this.options.store.readObject(id, entry.worktreeBlock.patchObjectHash)
                : undefined,
            rawBefore: entry.worktreeBlock?.rawBeforeObjectHash
                ? await this.options.store.readObject(id, entry.worktreeBlock.rawBeforeObjectHash)
                : undefined,
            rawAfter: entry.worktreeBlock?.rawAfterObjectHash
                ? await this.options.store.readObject(id, entry.worktreeBlock.rawAfterObjectHash)
                : undefined,
        };
    }
    /** Materializes immutable base and shelved bytes for read-only shelf diff documents. */
    async getShelfDiffContents(
        id: string,
        changeId: string,
    ): Promise<{
        readonly path: string;
        readonly binary: boolean;
        readonly base?: Buffer;
        readonly shelved: Buffer;
    }> {
        const manifest = await this.refreshHistoryBaseAvailability(id);
        const entry = manifest.files.find((file) => file.changeId === changeId);
        if (!entry) throw new Error("Shelf entry does not exist.");
        const block = entry.worktreeBlock ?? entry.indexBlock;
        if (!block) throw new Error("Shelf entry has no diffable file block.");
        const contents = await this.getShelfFileContents(id, changeId);
        if (!entry.exactReconstruction) {
            if (!contents.rawBefore || !contents.rawAfter) {
                throw new Error("Shelf entry is missing required raw diff bytes.");
            }
            return {
                path: block.path,
                binary: entry.binary,
                base: contents.rawBefore,
                shelved: contents.rawAfter,
            };
        }
        const base = await this.baseForEntry(id, entry);
        if (!base) {
            return {
                path: block.path,
                binary: entry.binary,
                base: undefined,
                shelved: Buffer.from(
                    "Shelved content is unavailable because its base is unavailable.",
                ),
            };
        }
        const shelved = await this.materializeEntry(
            block.path,
            base,
            contents.indexPatch,
            contents.worktreePatch,
        );
        return {
            path: block.path,
            binary: entry.binary,
            base,
            shelved:
                shelved ??
                Buffer.from("Shelved content could not be materialized from this shelf."),
        };
    }
    /** Rolls back incomplete destructive captures and removes their now-cancelled durable shelves. */
    async resumePendingRecovery(): Promise<PendingShelfRecoveryResult> {
        const links = new Map(
            (await this.options.store.readJournals())
                .filter((journal) => journal.state === "shelvePendingRevert" && journal.shelf)
                .map((journal) => [journal.id, journal.shelf!]),
        );
        const result = await this.reverter.resumePending();
        for (const id of result.rolledBackIds) {
            const shelf = links.get(id);
            if (!shelf) continue;
            await this.withMutation(async () => {
                await this.options.store.deleteShelf(shelf.id).catch((error: unknown) => {
                    if (!isNotFound(error)) throw error;
                });
            });
        }
        return result;
    }
    private async captureShelf(input: ShelveInput): Promise<ShelfMutationResult> {
        const captured = await captureShelfArtifacts(input, {
            repositoryRoot: this.options.repositoryRoot,
            executor: this.options.executor,
            store: this.options.store,
            recordBaseRevisions: this.recordBaseRevisions,
            materializeEntry: (relativePath, base, indexPatch, worktreePatch) =>
                this.materializeEntry(relativePath, base, indexPatch, worktreePatch),
        });
        if (!input.keepLocal) {
            await this.reverter.revertWithHeldLocks({
                transactionId: randomUUID().replaceAll("-", ""),
                baseOid: captured.baseCommit,
                files: captured.revertFiles,
                shelf: { id: captured.shelfId, generation: captured.generation },
            });
        }
        return {
            status: "ok",
            entries: [],
            shelfId: captured.shelfId,
            newGeneration: captured.generation,
        };
    }
    /** Shared catalog-CAS deletion path for explicit and activation-time ghost cleanup. */
    private async cleanUpSelection(selection: {
        readonly shelfIds: readonly string[];
        readonly expectedCatalogGeneration?: number;
    }): Promise<ShelfMutationResult> {
        return this.options.store.withGenerationCas(
            { expectedCatalogGeneration: selection.expectedCatalogGeneration },
            async () => {
                for (const id of selection.shelfIds) {
                    const manifest = await this.options.store.readCurrentShelfManifest(id);
                    if (manifest.metadata.lifecycle !== "applied")
                        throw new Error("Clean up only accepts already-unshelved ghosts.");
                    await this.options.store.deleteShelf(id);
                }
                return { status: "ok", entries: [] };
            },
        );
    }
    private async applyEntry(
        shelfId: string,
        entry: ShelfFileEntry,
        mode: UnshelveInput["mode"],
    ): Promise<PerEntryResult> {
        if (isStructural(entry)) {
            const block = entry.worktreeBlock ?? entry.indexBlock;
            if (!block) throw new Error("Structural shelf entry has no file path.");
            return {
                kind: "structuralPending",
                changeId: entry.changeId,
                reason: "Structural shelf change needs a choice.",
                path: block.path,
                pathFingerprint: await pathFingerprint(
                    repositoryPath(this.options.repositoryRoot, block.path),
                ),
            };
        }
        if (!entry.exactReconstruction) return this.applyRawEntry(shelfId, entry);
        if (mode === "exactState") return this.applyExactEntry(shelfId, entry);
        return this.applyFlattenedEntry(shelfId, entry);
    }
    private async applyRawEntry(shelfId: string, entry: ShelfFileEntry): Promise<PerEntryResult> {
        const block = entry.worktreeBlock;
        if (!block?.rawBeforeObjectHash || !block.rawAfterObjectHash) {
            return {
                kind: "retained",
                changeId: entry.changeId,
                reason: "Raw reconstruction artifacts are missing.",
            };
        }
        const target = repositoryPath(this.options.repositoryRoot, block.path);
        const [before, after, current] = await Promise.all([
            this.options.store.readObject(shelfId, block.rawBeforeObjectHash),
            this.options.store.readObject(shelfId, block.rawAfterObjectHash),
            readFile(target).catch((error: unknown) => {
                if (isNotFound(error)) return undefined;
                throw error;
            }),
        ]);
        if (!current?.equals(before)) {
            return {
                kind: "structuralPending",
                changeId: entry.changeId,
                reason: "Local bytes differ from raw shelf preimage.",
                path: block.path,
                pathFingerprint: await pathFingerprint(target),
            };
        }
        await replaceRegularWorktreeFile(this.options.repositoryRoot, block.path, after);
        return { kind: "applied", changeId: entry.changeId };
    }
    private async applyFlattenedEntry(
        shelfId: string,
        entry: ShelfFileEntry,
    ): Promise<PerEntryResult> {
        const indexPatch = await this.blockPatch(shelfId, entry.indexBlock);
        const worktreePatch = await this.blockPatch(shelfId, entry.worktreeBlock);
        if (
            indexPatch &&
            worktreePatch &&
            (await this.isCancellationResidue(shelfId, entry, indexPatch, worktreePatch))
        ) {
            if (!(await this.applyToWorktree(indexPatch))) {
                return {
                    kind: "retained",
                    changeId: entry.changeId,
                    reason: "Index residue does not apply cleanly.",
                };
            }
            return { kind: "flattenedResidue", changeId: entry.changeId };
        }
        const patch = Buffer.concat([
            indexPatch ?? Buffer.alloc(0),
            worktreePatch ?? Buffer.alloc(0),
        ]);
        if (patch.length === 0)
            return {
                kind: "retained",
                changeId: entry.changeId,
                reason: "Shelf entry has no patch.",
            };
        if (await this.applyToWorktree(patch)) return { kind: "applied", changeId: entry.changeId };
        const merged = await this.mergeTextEntry(shelfId, entry, indexPatch, worktreePatch);
        return (
            merged ?? {
                kind: "retained",
                changeId: entry.changeId,
                reason: "Patch does not apply cleanly.",
            }
        );
    }
    private async applyExactEntry(shelfId: string, entry: ShelfFileEntry): Promise<PerEntryResult> {
        const indexPatch = await this.blockPatch(shelfId, entry.indexBlock);
        const worktreePatch = await this.blockPatch(shelfId, entry.worktreeBlock);
        const exactPath = entry.indexBlock?.path ?? entry.worktreeBlock?.path;
        if (exactPath && (await this.pathHasStagedDivergence(exactPath))) {
            return {
                kind: "refused",
                changeId: entry.changeId,
                reason: "Index already diverges at this shelf path.",
            };
        }
        const combined = Buffer.concat([
            indexPatch ?? Buffer.alloc(0),
            worktreePatch ?? Buffer.alloc(0),
        ]);
        if (!(await this.checkWorktree(combined))) {
            return {
                kind: "retained",
                changeId: entry.changeId,
                reason: "Exact state patch does not apply cleanly.",
            };
        }
        if (indexPatch && !(await this.checkIndex(indexPatch))) {
            return {
                kind: "refused",
                changeId: entry.changeId,
                reason: "Index cannot accept the shelf layer.",
            };
        }
        if (indexPatch) {
            await this.applyWorktreeUnchecked(indexPatch);
            await this.applyIndexUnchecked(indexPatch);
            await this.assertExactIndex(shelfId, entry, indexPatch);
        }
        if (worktreePatch) await this.applyWorktreeUnchecked(worktreePatch);
        return { kind: "applied", changeId: entry.changeId };
    }
    private async mergeTextEntry(
        shelfId: string,
        entry: ShelfFileEntry,
        _indexPatch: Buffer | undefined,
        _worktreePatch: Buffer | undefined,
    ): Promise<PerEntryResult | undefined> {
        const kind = await this.conflictSessions.mergeTextEntry(shelfId, entry);
        return kind ? { kind, changeId: entry.changeId } : undefined;
    }
    private async isCancellationResidue(
        shelfId: string,
        entry: ShelfFileEntry,
        indexPatch: Buffer,
        worktreePatch: Buffer,
    ): Promise<boolean> {
        const base = await this.baseForEntry(shelfId, entry);
        const relativePath = entry.worktreeBlock?.path ?? entry.indexBlock?.path;
        if (!base || !relativePath) return false;
        const safeRelativePath = validateShelfManifestPath(relativePath);
        const temp = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-residue-"));
        try {
            await writeFile(path.join(temp, safeRelativePath), base).catch(async () => {
                await mkdir(path.dirname(path.join(temp, safeRelativePath)), {
                    recursive: true,
                    mode: 0o700,
                });
                await writeFile(path.join(temp, safeRelativePath), base);
            });
            if (
                !(await this.applyPatchUnder(
                    temp,
                    safeRelativePath,
                    Buffer.concat([indexPatch, worktreePatch]),
                ))
            )
                return false;
            return (await readFile(path.join(temp, safeRelativePath))).equals(base);
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    }
    private async baseForEntry(
        shelfId: string,
        entry: ShelfFileEntry,
    ): Promise<Buffer | undefined> {
        const block = entry.worktreeBlock ?? entry.indexBlock;
        if (!block) return undefined;
        if (block.baseObjectHash)
            return this.options.store.readObject(shelfId, block.baseObjectHash);
        const manifest = await this.options.store.readCurrentShelfManifest(shelfId);
        if (!manifest.metadata.baseCommit || entry.baseAvailability === "none") return undefined;
        const safeRelativePath = validateShelfManifestPath(block.renamedFrom ?? block.path);
        const result = await this.options.executor.runBinary(
            ["show", `${manifest.metadata.baseCommit}:${safeRelativePath}`],
            { expectedExitCodes: [0, 128] },
        );
        return result.exitCode === 0 ? result.stdout : undefined;
    }
    /** Persists unavailable history bases as `none` so snapshots never promise a missing base. */
    private async refreshHistoryBaseAvailability(id: string) {
        return this.withMutation(async () =>
            this.options.store.withLock(async () => {
                const manifest = await this.options.store.readCurrentShelfManifest(id);
                if (!manifest.metadata.baseCommit) return manifest;
                const unavailable = new Set<string>();
                for (const entry of manifest.files) {
                    if (entry.baseAvailability !== "history") continue;
                    const block = entry.worktreeBlock ?? entry.indexBlock;
                    if (!block) {
                        unavailable.add(entry.changeId);
                        continue;
                    }
                    const relativePath = validateShelfManifestPath(block.renamedFrom ?? block.path);
                    const result = await this.options.executor.runBinary(
                        ["show", `${manifest.metadata.baseCommit}:${relativePath}`],
                        { expectedExitCodes: [0, 128] },
                    );
                    if (result.exitCode !== 0) unavailable.add(entry.changeId);
                }
                if (unavailable.size === 0) return manifest;
                return this.options.store.writeShelfGeneration(id, {
                    schemaVersion: manifest.schemaVersion,
                    objectHashes: manifest.objectHashes,
                    metadata: manifest.metadata,
                    files: manifest.files.map((entry) =>
                        unavailable.has(entry.changeId)
                            ? { ...entry, baseAvailability: "none" as const }
                            : entry,
                    ),
                });
            }),
        );
    }
    private async applyPatchUnder(
        directory: string,
        relativePath: string,
        patch: Buffer,
    ): Promise<boolean> {
        const safeRelativePath = validateShelfManifestPath(relativePath);
        await mkdir(path.dirname(path.join(directory, safeRelativePath)), {
            recursive: true,
            mode: 0o700,
        });
        const checked = await this.options.executor.runBinary(
            ["-C", directory, "apply", "--check", "-"],
            { input: patch, expectedExitCodes: [0, 1] },
        );
        if (checked.exitCode !== 0) return false;
        await this.options.executor.runBinary(["-C", directory, "apply", "-"], {
            input: patch,
        });
        return true;
    }

    private async materializeEntry(
        relativePath: string,
        base: Buffer,
        indexPatch: Buffer | undefined,
        worktreePatch: Buffer | undefined,
    ): Promise<Buffer | undefined> {
        const temp = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-materialize-"));
        try {
            const safeRelativePath = validateShelfManifestPath(relativePath);
            const target = path.join(temp, safeRelativePath);
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, base);
            const patch = Buffer.concat([
                indexPatch ?? Buffer.alloc(0),
                worktreePatch ?? Buffer.alloc(0),
            ]);
            return (await this.applyPatchUnder(temp, safeRelativePath, patch))
                ? readFile(target)
                : undefined;
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    }

    private async assertExactIndex(
        shelfId: string,
        entry: ShelfFileEntry,
        indexPatch: Buffer,
    ): Promise<void> {
        const relativePath = entry.indexBlock?.path;
        if (!relativePath) return;
        const safeRelativePath = validateShelfManifestPath(relativePath);
        const temp = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-index-"));
        try {
            const target = path.join(temp, safeRelativePath);
            const base = await this.baseForEntry(shelfId, entry);
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            if (base) await writeFile(target, base);
            if (!(await this.applyPatchUnder(temp, safeRelativePath, indexPatch))) {
                throw new Error("Could not materialize expected exact-state index.");
            }
            const expected = await readFile(target).catch((error: unknown) => {
                if (isNotFound(error)) return undefined;
                throw error;
            });
            const actual = await this.options.executor.runBinary(["show", `:${safeRelativePath}`], {
                expectedExitCodes: [0, 128],
            });
            if (
                (actual.exitCode === 0 && (!expected || !actual.stdout.equals(expected))) ||
                (actual.exitCode !== 0 && expected)
            ) {
                throw new Error("Exact-state index did not match the captured layer.");
            }
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    }

    private async blockPatch(
        shelfId: string,
        block: ShelfLayerBlock | undefined,
    ): Promise<Buffer | undefined> {
        return block?.patchObjectHash
            ? this.options.store.readObject(shelfId, block.patchObjectHash)
            : undefined;
    }

    private async applyToWorktree(patch: Buffer): Promise<boolean> {
        if (!(await this.checkWorktree(patch))) return false;
        await this.applyWorktreeUnchecked(patch);
        return true;
    }

    private async checkWorktree(patch: Buffer): Promise<boolean> {
        const result = await this.options.executor.runBinary(["apply", "--check", "-"], {
            input: patch,
            expectedExitCodes: [0, 1],
        });
        return result.exitCode === 0;
    }

    private async checkIndex(patch: Buffer): Promise<boolean> {
        const result = await this.options.executor.runBinary(
            ["apply", "--check", "--cached", "-"],
            {
                input: patch,
                expectedExitCodes: [0, 1],
            },
        );
        return result.exitCode === 0;
    }

    private async applyWorktreeUnchecked(patch: Buffer): Promise<void> {
        await this.options.executor.runBinary(["apply", "-"], { input: patch });
    }

    private async applyIndexUnchecked(patch: Buffer): Promise<void> {
        await this.options.executor.runBinary(["apply", "--cached", "-"], { input: patch });
    }

    private async pathHasStagedDivergence(relativePath: string): Promise<boolean> {
        const safeRelativePath = validateShelfManifestPath(relativePath);
        const result = await this.options.executor.runBinary(
            ["diff", "--cached", "--quiet", "--", safeRelativePath],
            {
                expectedExitCodes: [0, 1],
            },
        );
        return result.exitCode !== 0;
    }

    private async indexFingerprint(): Promise<string> {
        const listing = await this.options.executor.runBinary(["ls-files", "--stage", "-v", "-z"]);
        return createHash("sha256").update(listing.stdout).digest("hex");
    }

    private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
        const directories = await this.gitOps.getGitDirectories();
        return this.options.gate.run(this.options.repositoryRoot, directories.commonDir, () =>
            this.options.store.withLock(operation),
        );
    }
}
