import {
    resolveTargetedShelfConflict,
    restoreTargetedShelf,
    type ShelfRestoreTarget,
    type TargetShelfMutationResult,
    type PerEntryResult,
    type UnshelveInput,
} from "./shelfTargetRestore";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChangelistStore, TargetOperationLease } from "../changes/changelistStore";
import type { PartialChanges } from "../git/partialChanges";
import type { ChangelistState, SelectedFileChanges } from "../webviews/protocol/changeSelection";
import { captureSelectedShelf, type SelectedShelfInput } from "./shelfSelectedCapture";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { RepositoryLockBusyError } from "../git/repositoryLock";
import type { RepositoryMutationGate } from "../git/repositoryMutationGate";
import { validateShelfManifestPath } from "../shelf/importValidation";
import { type ShelfFileEntry, type ShelfLayerBlock } from "../shelf/model";
import { replaceRegularWorktreeFile } from "../shelf/safeWorktreeWrite";
import {
    purgeRecoverySnapshots,
    ShelfRecoveryFullError,
    ShelfReverter,
    ShelfWorktreeRemovalCompletedError,
    type PendingShelfRecoveryResult,
} from "../shelf/recovery";
import {
    ShelfMutationAdmissionError,
    ShelfStoreCorruptionError,
    ShelfStaleShelfError,
    type ShelfManifest,
    type ShelfPersistenceManifest,
    type ShelfStore,
} from "../shelf/store";
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
export type { PerEntryResult, UnshelveInput } from "./shelfTargetRestore";
/** Aggregate state returned by a shelf mutation. */
type ShelfMutationStatus =
    | "ok"
    | "partial"
    | "conflicts"
    | "staleShelf"
    | "staleCatalog"
    | "busy"
    | "recoveryFull"
    | "error";
/** Advisory shelf warning derived only from already-observed shelf state. */
export type ShelfHealthWarning = {
    readonly kind:
        "corruptShelf" | "lockBusy" | "checksumMismatch" | "pendingRecovery" | "recoveryFull";
    readonly detail: string;
};
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
    /** Shared, durably connected metadata store; its lease precedes repository and shelf locks. */
    readonly changelists: ChangelistStore;
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
    private readonly scopedCaptures = new WeakMap<
        SelectedShelfInput,
        Awaited<ReturnType<typeof captureSelectedShelf>> & {
            readonly planDigest: string;
            readonly revision: number;
            readonly scope: string;
        }
    >();
    private mutationTail: Promise<void> = Promise.resolve();
    private healthWarnings = new Map<ShelfHealthWarning["kind"], readonly ShelfHealthWarning[]>();
    private readonly rewriteListeners = new Set<() => void>();
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
    /** Absolute repository root this service mutates; safe for logs and health rows. */
    get repositoryRoot(): string {
        return this.options.repositoryRoot;
    }
    /** Reports a host-side rewrite that published a shelf generation no caller asked for. */
    subscribeToRewrites(listener: () => void): () => void {
        this.rewriteListeners.add(listener);
        return () => this.rewriteListeners.delete(listener);
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

    /** Saves under an actual held metadata lease without removal; cleanup errors retain the durable shelf identity. */
    async saveSelectedChanges(
        input: SelectedShelfInput,
        lease: TargetOperationLease,
        revision: number,
        scope: string,
        guard: Parameters<PartialChanges["validate"]>[1],
    ): Promise<ShelfMutationResult> {
        assertShelfName(input.name);
        let savedId: string | undefined;
        return this.withRepositoryStore<ShelfMutationResult>(lease, async () => {
            await this.options.store.migrateWithHeldLocks();
            this.assertSelectedMetadata(input, lease, revision, scope);
            await guard([
                ...input.selected.map((entry) => entry.snapshot.view.path),
                ...input.whole.map((entry) => entry.path),
            ]);
            // Digest the intent before the async capture so an edit during capture cannot become the saved plan.
            const planDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
            const captured = await captureSelectedShelf(input, {
                repositoryRoot: this.options.repositoryRoot,
                executor: this.options.executor,
                store: this.options.store,
                recordBaseRevisions: this.recordBaseRevisions,
                materializeEntry: (file, base, index, working) =>
                    this.materializeEntry(file, base, index, working),
            });
            savedId = captured.shelfId;
            this.scopedCaptures.set(input, { ...captured, planDigest, revision, scope });
            return {
                status: "ok",
                entries: [],
                shelfId: captured.shelfId,
                newGeneration: captured.generation,
            };
        }).catch((error: unknown) => {
            if (savedId)
                throw new Error(
                    `Shelf ${savedId} was saved. Lock cleanup failed; do not repeat the save.`,
                    {
                        cause: error,
                    },
                );
            throw error;
        });
    }

    /** Rejects stale source names, drafts and owners before capture; the caller cannot certify its own lease. */
    private assertSelectedMetadata(
        input: SelectedShelfInput,
        lease: TargetOperationLease,
        revision: number,
        scope: string,
    ): void {
        const state = this.options.changelists.inspectTargetOperationLease(
            this.repositoryRoot,
            lease,
        );
        if (state.pendingTargetOperation || state.revision !== revision)
            throw new Error("Changelists changed. Reopen the selected changes.");
        if (!["selection", "list", "files"].includes(input.scope))
            throw new Error("Unknown shelf selection scope.");
        const draft =
            scope === "all"
                ? (state.allDraft ?? "")
                : (state.lists.find((list) => list.id === scope)?.draft ?? "");
        if (
            (scope !== "all" && !state.lists.some((list) => list.id === scope)) ||
            input.scopeDraft !== draft
        )
            throw new Error("The captured selection draft changed.");
        const owners = new Set<string>();
        for (const entry of input.whole) {
            const expected = this.wholeShelfOwners(state, entry);
            if (input.scope === "list" && [...expected].some((id) => id !== scope))
                throw new Error("List save cannot capture another source owner.");
            expected.forEach((id) => owners.add(id));
        }
        for (const entry of input.selected) {
            const file = entry.snapshot.view.path;
            const ownership = state.changes[file];
            if (ownership?.stale) throw new Error("Change assignments need review.");
            for (const [fingerprint, owner] of Object.entries(entry.owners)) {
                if (
                    (ownership?.lines[fingerprint] ?? state.files[file] ?? state.activeId) !== owner
                )
                    throw new Error("The captured selection owner changed.");
                owners.add(owner);
                if (input.scope === "list" && owner !== scope)
                    throw new Error("List save cannot capture another source owner.");
            }
        }
        this.assertShelfSourceLists(state, input, owners);
    }

    /** Requires the complete source-list set and exact captured names, descriptions and drafts. */
    private assertShelfSourceLists(
        state: ChangelistState,
        input: SelectedShelfInput,
        owners: ReadonlySet<string>,
    ): void {
        if (
            input.sourceLists.length !== owners.size ||
            input.sourceLists.some((source) => {
                const list = state.lists.find((item) => item.id === source.id);
                return (
                    !owners.has(source.id) ||
                    !list ||
                    list.name !== source.name ||
                    (list.description ?? "") !== source.description ||
                    (list.draft ?? "") !== source.draft
                );
            })
        )
            throw new Error("The captured source lists changed.");
    }

    /** Derives every whole-file owner from current metadata and complete working evidence, never caller declarations alone. */
    private wholeShelfOwners(
        state: ChangelistState,
        entry: SelectedShelfInput["whole"][number],
    ): Set<string> {
        const tracking = state.changes[entry.path];
        if (tracking?.stale) throw new Error("Change assignments need review.");
        const fallback = state.files[entry.path] ?? state.activeId;
        const expected = new Set<string>();
        if (tracking && Object.keys(tracking.lines).length > 0) {
            const evidence = entry.ownership;
            if (!evidence || evidence.snapshot.contentId !== tracking.contentId)
                throw new Error("Whole-file source ownership requires current evidence.");
            const lines = evidence.snapshot.view.blocks
                .flatMap((block) => block.lines)
                .filter((line) => line.kind !== "context");
            if (Object.keys(evidence.owners).length !== lines.length)
                throw new Error("Whole-file source owners changed.");
            for (const line of lines) {
                const owner = tracking.lines[line.fingerprint] ?? fallback;
                if (evidence.owners[line.fingerprint] !== owner)
                    throw new Error("Whole-file source owners changed.");
                expected.add(owner);
            }
        } else expected.add(fallback);
        if (
            entry.sourceListIds.length !== expected.size ||
            entry.sourceListIds.some((id) => !expected.has(id))
        )
            throw new Error("Whole-file source owners changed.");
        return expected;
    }

    /** Removes one durably saved host plan at most once; completed paths and the saved identity survive later failures. */
    async removeScopedChanges(
        input: SelectedShelfInput,
        shelfId: string,
        partial: PartialChanges,
        lease: TargetOperationLease,
        revision: number,
        scope: string,
        guard: Parameters<PartialChanges["validate"]>[1],
    ): Promise<{
        shelfId: string;
        completedPaths: string[];
        retainedPaths: string[];
        error?: string;
    }> {
        const captured = this.scopedCaptures.get(input);
        if (!captured || captured.shelfId !== shelfId)
            throw new Error("The saved removal plan expired or was already attempted.");
        if (
            captured.planDigest !==
                createHash("sha256").update(JSON.stringify(input)).digest("hex") ||
            captured.revision !== revision ||
            captured.scope !== scope
        )
            throw new Error("The captured removal plan changed after Save.");
        const selected = input.selected.map((entry) => ({ ...entry, lineIds: [...entry.lineIds] }));
        const wholePaths = input.whole.map((entry) => entry.path);
        this.assertSelectedMetadata(input, lease, revision, scope);
        if (wholePaths.length)
            await this.withRepositoryStore(lease, async () => {
                await guard(wholePaths);
                await captured.assertWholeCurrent!();
            });
        for (const entry of selected) {
            if (partial.snapshot(entry.snapshot.view.snapshotId) !== entry.snapshot)
                throw new Error("The captured removal snapshot changed.");
            await partial.validate(
                { snapshotId: entry.snapshot.view.snapshotId, lineIds: [...entry.lineIds] },
                guard,
            );
        }
        this.scopedCaptures.delete(input);
        const completedPaths: string[] = [];
        const paths = [...selected.map((entry) => entry.snapshot.view.path), ...wholePaths];
        for (const entry of selected) {
            try {
                await partial.rollbackCaptured(
                    entry.snapshot,
                    entry.lineIds,
                    async (files) => {
                        this.assertSelectedMetadata(input, lease, revision, scope);
                        await guard(files);
                    },
                    this.reverter,
                    randomUUID().replaceAll("-", ""),
                );
                completedPaths.push(entry.snapshot.view.path);
            } catch (error) {
                if (error instanceof ShelfWorktreeRemovalCompletedError)
                    completedPaths.push(entry.snapshot.view.path);
                return {
                    shelfId,
                    completedPaths,
                    retainedPaths: paths.filter((file) => !completedPaths.includes(file)),
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
        if (wholePaths.length) {
            const transactionId = randomUUID().replaceAll("-", "");
            try {
                await this.withRepositoryStore(lease, async () => {
                    this.assertSelectedMetadata(input, lease, revision, scope);
                    await guard(wholePaths);
                    await captured.assertWholeCurrent!();
                    try {
                        await this.reverter.revertWithHeldLocks({
                            transactionId,
                            baseOid: captured.baseCommit,
                            files: captured.revertFiles.flat(),
                        });
                        completedPaths.push(...wholePaths);
                    } catch (error) {
                        if (
                            (await this.options.store.readJournals()).some(
                                (journal) =>
                                    journal.id === transactionId && journal.state === "shelved",
                            )
                        )
                            completedPaths.push(...wholePaths);
                        throw error;
                    }
                });
            } catch (error) {
                return {
                    shelfId,
                    completedPaths,
                    retainedPaths: paths.filter((file) => !completedPaths.includes(file)),
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
        return { shelfId, completedPaths, retainedPaths: [] };
    }

    /** Removes only the captured selection through the service reverter's own gate; no outer gate is acquired. */
    async removeSelectedChanges(
        input: SelectedShelfInput,
        selection: SelectedFileChanges,
        partial: PartialChanges,
        lease: TargetOperationLease,
        revision: number,
        scope: string,
        guard: Parameters<PartialChanges["validate"]>[1],
    ): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        this.assertSelectedMetadata(input, lease, revision, scope);
        const entry = input.selected[0];
        if (
            input.selected.length !== 1 ||
            entry.snapshot !== partial.snapshot(selection.snapshotId) ||
            JSON.stringify(entry.lineIds) !== JSON.stringify(selection.lineIds)
        )
            throw new Error("The selected removal plan changed.");
        await guard([entry.snapshot.view.path]);
        return partial.rollback(
            selection,
            async (files) => {
                this.assertSelectedMetadata(input, lease, revision, scope);
                await guard(files);
            },
            this.reverter,
            randomUUID().replaceAll("-", ""),
        );
    }
    /** Applies whole selected entries only; flattened mode never writes the Git index. */
    async unshelve(
        input: UnshelveInput & { readonly targetOperation: ShelfRestoreTarget },
    ): Promise<TargetShelfMutationResult>;
    /** Legacy internal callers retain the existing non-list result contract. */
    async unshelve(
        input: UnshelveInput & { readonly targetOperation?: undefined },
    ): Promise<ShelfMutationResult>;
    /** Routes captured destination intent through the durable target-operation protocol. */
    async unshelve(input: UnshelveInput): Promise<ShelfMutationResult | TargetShelfMutationResult> {
        if (input.targetOperation)
            return restoreTargetedShelf(input, {
                ...this.options,
                gitOps: this.gitOps,
                applyEntry: (shelfId, entry, mode) => this.applyEntry(shelfId, entry, mode),
            });
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
                        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each apply mutates the worktree, and flattened mode verifies the index after every entry.
                        entries.push(await this.applyEntry(input.id, entry, input.mode));
                        if (indexBefore && (await this.indexFingerprint()) !== indexBefore) {
                            throw new Error("Flattened unshelve changed the Git index.");
                        }
                    }
                    const successful = new Set<string>();
                    for (const entry of entries) {
                        if (entry.kind === "applied" || entry.kind === "flattenedResidue")
                            successful.add(entry.changeId);
                    }
                    let nextGeneration = manifest.generation;
                    if (input.removeFromShelf && successful.size > 0) {
                        const files = manifest.files.map((entry) =>
                            successful.has(entry.changeId)
                                ? { ...entry, lifecycle: "applied" as const }
                                : entry,
                        );
                        const allApplied = files.every((entry) => entry.lifecycle === "applied");
                        const journalId = `unshelve-${randomUUID().replaceAll("-", "")}`;
                        // react-doctor-disable-next-line react-doctor/async-parallel -- Recovery requires the pending journal to be durable before its shelf generation changes.
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
    /** Reads one validated immutable generation without refreshing or rewriting history metadata. */
    async getShelfManifest(id: string): Promise<ShelfPersistenceManifest> {
        return this.options.store.readCurrentShelfManifest(id);
    }
    /** Exports only content, refusing a generation that changed while the user reviewed consent. */
    async exportPatch(input: {
        readonly id: string;
        readonly changeIds?: readonly string[];
        readonly expectedShelfGeneration?: number;
        readonly expectedShelfChecksum?: string;
    }): Promise<Buffer> {
        const manifest = await this.getShelfManifest(input.id);
        if (
            input.expectedShelfGeneration !== undefined &&
            input.expectedShelfGeneration !== manifest.generation
        ) {
            throw new ShelfStaleShelfError(input.expectedShelfGeneration, manifest.generation);
        }
        if (
            input.expectedShelfChecksum !== undefined &&
            input.expectedShelfChecksum !== manifest.checksum
        ) {
            throw new Error("Shelf contents changed. Review the shelf before exporting again.");
        }
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
            const manifests = await Promise.all(
                listed.shelfIds.map(async (id) => ({
                    id,
                    manifest: await this.options.store.readCurrentShelfManifest(id),
                })),
            );
            const shelfIds: string[] = [];
            for (const { id, manifest } of manifests) {
                if (
                    manifest.metadata.lifecycle === "applied" &&
                    manifest.metadata.appliedAt !== undefined &&
                    manifest.metadata.appliedAt < cutoff
                ) {
                    shelfIds.push(id);
                }
            }
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
        const payload = await this.conflictSessions.open({ id, changeId });
        // The host binds the editor to the durable pending restore it reads here, never to a webview value.
        const pending = this.options.changelists.get(this.repositoryRoot).pendingTargetOperation;
        return pending?.kind === "shelfRestore" &&
            pending.phase === "conflicted" &&
            pending.shelf?.id === id
            ? { ...payload, operationId: pending.id }
            : payload;
    }
    /** Applies a shelf merge result through the session's queue, CAS, and fingerprint guards. */
    async applyShelfConflictResolution(
        input: ApplyShelfConflictResolutionInput,
    ): Promise<ApplyShelfConflictResolutionResult> {
        if (input.operationId === undefined) return this.conflictSessions.apply(input);
        const result = await resolveTargetedShelfConflict(
            {
                operationId: input.operationId,
                shelfId: input.id,
                changeId: input.changeId,
                content: input.content,
                expectedPathFingerprint: input.expectedPathFingerprint,
            },
            {
                ...this.options,
                gitOps: this.gitOps,
                applyEntry: (shelfId, entry, mode) => this.applyEntry(shelfId, entry, mode),
            },
        );
        if (result.status === "busy")
            return {
                status: "refused",
                reason: "Another repository operation is running. Try again.",
            };
        if (result.status === "stale" || result.status === "notApplied")
            return { status: "stale", reason: "operation" };
        const newGeneration = await this.options.store
            .readCurrentShelfManifest(input.id)
            .then((manifest) => manifest.generation)
            .catch(() => input.expectedShelfGeneration);
        return result.status === "appliedNeedsReview"
            ? { status: "applied", newGeneration, needsReview: true }
            : { status: "applied", newGeneration };
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
        // react-doctor-disable-next-line react-doctor/async-parallel -- The authoritative catalog must be read before deriving the history-base refresh targets.
        const initial = await this.options.store.listShelves();
        await Promise.all(initial.shelfIds.map((id) => this.refreshHistoryBaseAvailability(id)));
        const listed = await this.options.store.listShelves();
        this.replaceHealth(
            "corruptShelf",
            listed.corruptShelfIds.map((id) => ({ kind: "corruptShelf" as const, detail: id })),
        );
        return {
            ...listed,
            shelves: await Promise.all(
                listed.shelfIds.map(async (id) => {
                    const manifest = await this.options.store.readCurrentShelfManifest(id);
                    return {
                        id,
                        generation: manifest.generation,
                        metadata: manifest.metadata,
                        files: manifest.files,
                    };
                }),
            ),
        };
    }
    /** Returns a fresh immutable snapshot of bounded advisory health state. */
    getHealthWarnings(): readonly ShelfHealthWarning[] {
        return Object.freeze(
            [...(this.healthWarnings?.values() ?? [])]
                .flat()
                .map((warning) => Object.freeze({ ...warning })),
        );
    }
    private replaceHealth(
        kind: ShelfHealthWarning["kind"],
        warnings: readonly ShelfHealthWarning[],
    ): void {
        this.healthWarnings.delete(kind);
        if (warnings.length)
            this.healthWarnings.set(
                kind,
                warnings.map((warning) => ({ ...warning })),
            );
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
    async resumePendingRecovery(): Promise<
        PendingShelfRecoveryResult & { readonly upgraded: boolean }
    > {
        return this.withLockedState(async () => {
            const journals = await this.options.store.readJournals();
            const links = new Map<string, { id: string; manifest: ShelfManifest }>();
            for (const journal of journals) {
                if (journal.state === "shelvePendingRevert" && journal.shelf) {
                    const manifest = await this.options.store.readCurrentManifest(journal.shelf.id);
                    if (manifest.generation !== journal.shelf.generation)
                        throw new ShelfStoreCorruptionError("Shelf recovery generation changed.");
                    links.set(journal.id, { id: journal.shelf.id, manifest });
                }
            }
            const result = await this.reverter.resumePendingWithHeldLocks();
            const upgraded = await this.options.store
                .migrateWithHeldLocks()
                .catch((error: unknown) => {
                    // Upgrading at startup lets panels list post-upgrade generations; a refused upgrade waits for the next write.
                    if (
                        result.rolledBackIds.length === 0 &&
                        error instanceof ShelfMutationAdmissionError
                    )
                        return false;
                    throw error;
                });
            for (const id of result.rolledBackIds) {
                const shelf = links.get(id);
                if (!shelf) continue;
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stop at the first failed deletion so later recovery shelves remain available for retry.
                await this.options.store.deleteRecoveredShelf(shelf.id, shelf.manifest);
            }
            const pending = await this.options.store.readJournals();
            this.replaceHealth(
                "pendingRecovery",
                pending.length
                    ? [
                          {
                              kind: "pendingRecovery",
                              detail: `${pending.length} pending recovery journal(s)`,
                          },
                      ]
                    : [],
            );
            return { ...result, upgraded };
        });
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
                files: captured.revertFiles.flat(),
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
                    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Verify each ghost and delete it under the same CAS before examining the next selection.
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
            const localPath = block.status === "R" ? (block.renamedFrom ?? block.path) : block.path;
            return {
                kind: "structuralPending",
                changeId: entry.changeId,
                reason: "Structural shelf change needs a choice.",
                path: localPath,
                pathFingerprint: await pathFingerprint(
                    repositoryPath(this.options.repositoryRoot, localPath),
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
        // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- Preserve the index-layer checksum failure before reading the worktree layer.
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
        // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- Preserve the index-layer checksum failure before reading the worktree layer.
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
            // react-doctor-disable-next-line react-doctor/async-parallel -- Exact restoration writes the worktree layer before the index and then verifies their combined state.
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
            // react-doctor-disable-next-line react-doctor/async-defer-await -- Attempt the direct write first so simple paths do not create an unnecessary nested directory.
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
        const persisted = await this.options.store.readCurrentShelfManifest(id);
        if (
            persisted.schemaVersion === 1 ||
            !persisted.metadata.baseCommit ||
            !persisted.files.some((entry) => entry.baseAvailability === "history")
        )
            return persisted;
        let rewritten = false;
        try {
            const refreshed = await this.withLockedState(async () =>
                this.options.store.withLock(async () => {
                    await this.options.store.assertMutationReady();
                    if (
                        (await this.options.store.readJournals()).some(
                            (journal) =>
                                journal.state === "shelvePendingRevert" ||
                                journal.state === "unshelvePending",
                        )
                    )
                        throw new ShelfMutationAdmissionError(
                            "Shelf recovery must finish before history refresh.",
                        );
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
                        const relativePath = validateShelfManifestPath(
                            block.renamedFrom ?? block.path,
                        );
                        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep Git history probes ordered while the repository mutation and store locks are held.
                        const result = await this.options.executor.runBinary(
                            ["show", `${manifest.metadata.baseCommit}:${relativePath}`],
                            { expectedExitCodes: [0, 128] },
                        );
                        if (result.exitCode !== 0) unavailable.add(entry.changeId);
                    }
                    if (unavailable.size === 0) return manifest;
                    rewritten = true;
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
            // The caller's result may never reach a view, so views re-list from the store instead.
            if (rewritten) this.notifyRewrite();
            return refreshed;
        } catch (error) {
            if (
                error instanceof ShelfMutationAdmissionError ||
                error instanceof RepositoryLockBusyError
            )
                return persisted;
            throw error;
        }
    }
    private notifyRewrite(): void {
        for (const listener of this.rewriteListeners) {
            try {
                listener();
            } catch (error) {
                console.error("[IntelliGit] Shelf rewrite delivery failed:", error);
            }
        }
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
            // Must await before the finally removes `temp`: returning the pending
            // readFile lets the rm win the race and surface a spurious ENOENT.
            return (await this.applyPatchUnder(temp, safeRelativePath, patch))
                ? await readFile(target)
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

    /** Orders the actual metadata lease before repository and shared-store serialization. */
    private async withLockedState<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationTail.then(async () => {
            const lease = await this.options.changelists.acquireTargetOperationLease(
                this.options.repositoryRoot,
            );
            try {
                return await this.withRepositoryStore(lease, operation);
            } finally {
                await lease.release();
            }
        });
        this.mutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** Reuses the existing repository/store order without reacquiring an actual caller-held metadata lease. */
    private async withRepositoryStore<T>(
        lease: TargetOperationLease,
        operation: () => Promise<T>,
    ): Promise<T> {
        const state = this.options.changelists.inspectTargetOperationLease(
            this.repositoryRoot,
            lease,
        );
        if (state.pendingTargetOperation)
            throw new ShelfMutationAdmissionError(
                "Pending target operation requires recovery before shelf migration.",
            );
        const directories = await this.gitOps.getGitDirectories();
        return this.options.gate.run(this.repositoryRoot, directories.commonDir, () =>
            this.options.store.withLock(async () => {
                this.options.changelists.inspectTargetOperationLease(this.repositoryRoot, lease);
                if ((await this.gitOps.getActiveOperation()) !== "none")
                    throw new ShelfMutationAdmissionError(
                        "Native Git operation must finish before shelf mutation.",
                    );
                return operation();
            }),
        );
    }

    /** Validates migration before any newly requested shelf mutation reaches its callback. */
    private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
        try {
            const result = await this.withLockedState(async () => {
                await this.options.store.migrateWithHeldLocks();
                return operation();
            });
            this.replaceHealth("lockBusy", []);
            this.replaceHealth("recoveryFull", []);
            return result;
        } catch (error) {
            if (error instanceof RepositoryLockBusyError) {
                this.replaceHealth("lockBusy", [{ kind: "lockBusy", detail: error.message }]);
            } else if (error instanceof ShelfRecoveryFullError) {
                this.replaceHealth("recoveryFull", [
                    { kind: "recoveryFull", detail: error.message },
                ]);
            } else if (error instanceof ShelfStoreCorruptionError) {
                this.replaceHealth("checksumMismatch", [
                    { kind: "checksumMismatch", detail: error.message },
                ]);
            }
            throw error;
        }
    }
}
