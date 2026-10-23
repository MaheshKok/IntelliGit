import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { changeFingerprint } from "./parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import type { ChangelistTarget } from "../webviews/protocol/changelists";
import type {
    ChangelistState,
    ChangeOwnership,
    RangeSnapshot,
    RangeSnapshotReference,
} from "../webviews/protocol/changeSelection";
import {
    ChangelistPersistence,
    ChangelistEvidenceError,
    type TargetOperationEvidenceChain,
} from "./changelistPersistence";
import {
    reconcileRanges,
    type HydratedChangeOwnership,
    type HydratedChangelistState,
} from "./rangeMapping";
import { validRangeMetadata, validSnapshot, snapshotReference } from "./rangeMetadata";
import { attributeOperationChanges } from "./operationAttribution";
import { RepositoryLockBusyError } from "../git/repositoryLock";
import { mapWithConcurrency } from "../utils/concurrency";
import {
    ShelfStore,
    ShelfStoreCorruptionError,
    type ShelfTargetPublicationRequest,
} from "../shelf/store";
import { ShelfPersistenceContractError } from "../shelf/model";
import { resolveShelfPaths } from "../shelf/paths";
import {
    parseTargetOperationReceipt,
    parseTargetOperationRecord,
    summarizeTargetOperation,
    type TargetOperationRecord,
    type TargetOperationEvidence,
    type TargetOperationExpectedState,
    type TargetOperationCheckpoint,
    type TargetWholeFileBefore,
    type TargetPathState,
    type TargetIndexEntry,
} from "./targetOperation";

const targetOperationLeaseBrand: unique symbol = Symbol("targetOperationLease");

/** Host-captured intent retained independently of subsequent phase and evidence checkpoints. */
export interface PrepareTargetOperationRequest {
    readonly id: string;
    readonly kind: TargetOperationRecord["kind"];
    readonly target: ChangelistTarget;
    readonly headBefore: string;
    readonly evidenceHash: string;
    readonly shelf?: TargetOperationRecord["shelf"];
    readonly commit?: string;
    readonly draftChoice?: TargetOperationRecord["draftChoice"];
    readonly sourceDraft?: string;
}

/** Opaque metadata lease acquired before repository/shelf locks; release after those locks. */
export interface TargetOperationLease {
    readonly [targetOperationLeaseBrand]: true;
    /** Wait for queued metadata publications and release exactly once. */
    release(): Promise<void>;
}

/** Only a fresh prepared publication authorizes Git; known pending/terminal requests never replay. */
export interface TargetOperationPreparation {
    readonly status: "prepared" | "known";
    readonly state: ChangelistState;
}

/** Actual observations captured by the adapter under metadata → repository → shelf locks. */
export interface TargetOperationObservation extends TargetOperationExpectedState {
    readonly observedEvidenceHash: string;
    readonly shelf?: {
        readonly id: string;
        readonly generation: number;
        readonly checksum: string;
    };
}

/** Fresh revision-bound Keep consent changes only the draft decision, never original operation intent. */
export interface TargetOwnershipPublication extends TargetOperationObservation {
    readonly reviewedDraft?: { readonly kind: "keep"; readonly expectedDestinationDraft: string };
}

interface MetadataStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

interface CommitInclusion {
    path: string;
    contentId: string;
    lineIds: readonly string[];
    total: number;
}

// Keep the original key: schema 2 is also a downgrade sentinel that v1 clients refuse.
const STORAGE_KEY = "intelligit.changelists.v1";
const BACKUP_KEY = "intelligit.changelists.v1.backup";
const MAX_DRAFT = 100_000;
const MAX_DESCRIPTION = 4_000;
/** A stable fallback independent of locale or a user-created list name. */
const DEFAULT_CHANGELIST_ID = "default";
const instances = new WeakMap<MetadataStorage, ChangelistStore>();
const MAX_LISTS = 100;
const MAX_FILES = 20_000;
// Tuning constant: 8 overlapping files plus one directory barrier took a measured 1000-file macOS
// upgrade from 11.7 s to 4.9 s, while bounding open descriptors and payloads held in memory.
const MIGRATION_CONCURRENCY = 8;

/**
 * Bounded like `mapWithConcurrency`, but a failure stops new calls and waits for every started
 * call before rethrowing the first error, so no write outlives the caller's metadata lease.
 */
async function mapDrained<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T) => Promise<R>,
): Promise<R[]> {
    const failures: unknown[] = [];
    const results = await mapWithConcurrency(items, limit, async (item) => {
        if (failures.length) return undefined;
        try {
            return await mapper(item);
        } catch (error) {
            failures.push(error);
            return undefined;
        }
    });
    if (failures.length) throw failures[0];
    return results as R[];
}

/** A concurrent writer won the revision; callers must refresh rather than overwrite its decision. */
export class ChangelistRevisionError extends Error {
    /** Preserve the established user-visible conflict message across storage backends. */
    constructor() {
        super("Changelists changed. Refresh before retrying.");
    }
}

/** A targeted operation leases or holds this root's metadata; observers re-observe once it releases. */
export class TargetOperationLeaseHeldError extends Error {
    /** Keeps the message callers already showed for a write refused by another operation's lease. */
    constructor() {
        super("A targeted operation requires its owning metadata lease.");
    }
}

/** Creates a fresh worktree with one active list and independent empty list and All drafts. */
function emptyState(): ChangelistState {
    return {
        revision: 0,
        activeId: DEFAULT_CHANGELIST_ID,
        lists: [{ id: DEFAULT_CHANGELIST_ID, name: "Changes", description: "", draft: "" }],
        allDraft: "",
        files: Object.create(null) as Record<string, string>,
        changes: Object.create(null) as Record<string, ChangeOwnership>,
    };
}

/** Normalizes list names before comparison and rejects empty, oversized, or control-bearing text. */
function nameFor(value: string): string {
    const name = value.normalize("NFC").trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
        throw new Error("A changelist name must contain 1 to 80 printable characters.");
    }
    return name;
}

/** A stable validator identity permits reuse of already-validated authoritative schema-4 state. */
function parseDurableState(value: unknown): ChangelistState | undefined {
    return parseState(value, 2, false);
}

/** Legacy validation is isolated from compact schema-4 parsing. */
function parseLegacyState(value: unknown): HydratedChangelistState | undefined {
    return parseState(value, 2, true);
}

/** A replay fence permits only guarded drafts once the operation has published ownership. */
function assertTargetOperationWriteAllowed(state: ChangelistState, pendingWrite?: "draft"): void {
    const pending = state.pendingTargetOperation;
    if (
        pending &&
        !(
            pendingWrite === "draft" &&
            (pending.phase === "ownershipPublished" || pending.phase === "shelfPublished")
        )
    )
        throw new Error("A targeted operation is pending review.");
}

/** Fixed key order makes retries independent of object insertion order and mutable checkpoints. */
function targetRequestHash(request: PrepareTargetOperationRequest): string {
    const shelf = request.shelf;
    const choice = request.draftChoice;
    return changeFingerprint(
        JSON.stringify({
            id: request.id,
            kind: request.kind,
            target: request.target,
            headBefore: request.headBefore,
            evidenceHash: request.evidenceHash,
            shelf: shelf
                ? {
                      id: shelf.id,
                      generation: shelf.generation,
                      checksum: shelf.checksum,
                      changeIds: shelf.changeIds,
                      removeFromShelf: shelf.removeFromShelf,
                  }
                : undefined,
            commit: request.commit,
            draftChoice:
                choice?.kind === "copySource"
                    ? {
                          kind: choice.kind,
                          sourceListId: choice.sourceListId,
                          expectedDestinationDraft: choice.expectedDestinationDraft,
                      }
                    : choice
                      ? { kind: choice.kind }
                      : undefined,
            sourceDraft: request.sourceDraft,
        }),
    );
}

/** The target as prepare records it: a new list's name normalized exactly as list creation does. */
function preparedTarget(target: ChangelistTarget): ChangelistTarget {
    return target.kind === "new"
        ? { kind: "new", name: nameFor(target.name), revision: target.revision }
        : { kind: "existing", id: target.id, revision: target.revision };
}

/** The request hash prepare stores, so a caller can prove a later request is the same one. */
export function preparedTargetRequestHash(request: PrepareTargetOperationRequest): string {
    return targetRequestHash({ ...request, target: preparedTarget(request.target) });
}

/** Checkpoints cannot select a different operation or move from an unexpected durable phase. */
function requireTargetOperation(
    state: ChangelistState,
    expected: TargetOperationExpectedState,
): TargetOperationRecord {
    const pending = state.pendingTargetOperation;
    if (!pending || pending.id !== expected.id)
        throw new Error("Target operation identity changed.");
    if (pending.phase !== expected.expectedPhase)
        throw new Error("Target operation phase changed.");
    return pending;
}

/** Compare unordered identities without permitting missing, duplicate, or unrelated members. */
function sameTargetSet(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        new Set(left).size === left.length &&
        new Set(right).size === right.length &&
        isDeepStrictEqual([...left].sort(), [...right].sort())
    );
}

/** Evidence is captured before Git and can cover only the explicitly frozen operation paths. */
function assertPreparedEvidence(
    pending: TargetOperationRecord,
    before: TargetOperationEvidence,
): void {
    const paths = new Set(before.paths.map((entry) => entry.path));
    if (
        before.operationId !== pending.id ||
        before.checkpoint !== "before" ||
        before.previousEvidenceHash !== undefined ||
        before.head !== pending.headBefore ||
        before.native.some((entry) => entry.present) ||
        before.index.some((entry) => entry.stage !== 0) ||
        before.entries.some((entry) => entry.outcome !== "pending") ||
        before.index.some((entry) => !paths.has(entry.path)) ||
        before.entries.some((entry) => entry.path !== undefined && !paths.has(entry.path)) ||
        (pending.shelf &&
            !sameTargetSet(
                pending.shelf.changeIds,
                before.entries.map((entry) => entry.changeId),
            ))
    )
        throw new Error("Target operation before evidence does not match the request.");
}

/**
 * Receipts are written only once review is resolved, so finished evidence is released to collection.
 * shortcut: shelf restore replay still rebuilds its request and entry results from this chain
 * (shelfTargetRestore.ts run); drop this exception once that replay no longer reads it.
 */
function retainedReceiptEvidence(pending: TargetOperationRecord): { evidenceHash?: string } {
    return pending.kind === "shelfRestore" ? { evidenceHash: pending.evidenceHash } : {};
}

/** Only forward application progress is accepted; review and completion use separate named methods. */
function assertCheckpointPhase(
    from: TargetOperationRecord["phase"],
    to: TargetOperationCheckpoint["phase"],
): void {
    if (
        (from === "prepared" && ["prepared", "gitApplied", "conflicted"].includes(to)) ||
        (from === "conflicted" && ["gitApplied", "conflicted"].includes(to))
    )
        return;
    throw new Error("Invalid target operation checkpoint phase transition.");
}

/** Every chained checkpoint preserves affected identities and successful entries, never silently replaying them. */
function assertCheckpointEvidence(
    pending: TargetOperationRecord,
    before: TargetOperationEvidence,
    after: TargetOperationEvidence,
    phase: TargetOperationCheckpoint["phase"],
): void {
    const paths = new Set(before.paths.map((entry) => entry.path));
    const entries = new Map(before.entries.map((entry) => [entry.changeId, entry]));
    if (
        after.operationId !== pending.id ||
        after.checkpoint !== "after" ||
        after.previousEvidenceHash !== pending.evidenceHash ||
        (pending.kind !== "undoCommit" && after.head !== pending.headBefore) ||
        !sameTargetSet(
            [...paths],
            after.paths.map((entry) => entry.path),
        ) ||
        !sameTargetSet(
            [...entries.keys()],
            after.entries.map((entry) => entry.changeId),
        ) ||
        after.index.some((entry) => !paths.has(entry.path)) ||
        after.entries.some((entry) => {
            const previous = entries.get(entry.changeId);
            return (
                !previous ||
                entry.path !== previous.path ||
                (["applied", "retained", "refused"].includes(previous.outcome) &&
                    entry.outcome !== previous.outcome)
            );
        }) ||
        (phase === "gitApplied" &&
            (after.index.some((entry) => entry.stage !== 0) ||
                after.entries.some((entry) =>
                    ["pending", "conflicted"].includes(entry.outcome),
                ))) ||
        (phase === "conflicted" && !after.entries.some((entry) => entry.outcome === "conflicted"))
    )
        throw new Error(
            "Target operation checkpoint evidence changed its affected set or progress.",
        );
}

/**
 * Compare concrete adapter observations, including markerless conflicts and path identities. The
 * whole-index fingerprint is left out: an outside `git status` rewrites it with stat data alone.
 */
function sameTargetObservation(
    saved: TargetOperationEvidence,
    observed: TargetOperationEvidence,
): boolean {
    return (
        saved.operationId === observed.operationId &&
        saved.head === observed.head &&
        isDeepStrictEqual(saved.index, observed.index) &&
        isDeepStrictEqual(saved.paths, observed.paths) &&
        isDeepStrictEqual(saved.native, observed.native)
    );
}

/** Same generation alone is insufficient when an external client replaces the shelf manifest. */
function sameTargetShelf(
    pending: TargetOperationRecord,
    observed: TargetOwnershipPublication["shelf"],
): boolean {
    return pending.shelf
        ? observed?.id === pending.shelf.id &&
              observed.generation === pending.shelf.generation &&
              observed.checksum === pending.shelf.checksum
        : observed === undefined;
}

/** Copy consent applies only to the exact destination draft captured before Git ran. */
function targetDraftMatches(
    pending: TargetOperationRecord,
    draft: string | undefined,
    reviewed: TargetOwnershipPublication["reviewedDraft"],
): boolean {
    if (reviewed) return reviewed.kind === "keep" && draft === reviewed.expectedDestinationDraft;
    return (
        pending.draftChoice?.kind !== "copySource" ||
        draft === pending.draftChoice.expectedDestinationDraft
    );
}

/** Reviewed Keep may revisit a rejected publication but cannot convert incomplete Git evidence. */
function targetOwnershipPhaseAllowed(
    pending: TargetOperationRecord,
    request: TargetOwnershipPublication,
): boolean {
    return (
        pending.phase === "gitApplied" ||
        (pending.phase === "reviewRequired" && request.reviewedDraft?.kind === "keep")
    );
}

/** The completion records the final choice while captured request identity and source draft remain unchanged. */
function targetDraftDecision(
    pending: TargetOperationRecord,
    request: TargetOwnershipPublication,
): "kept" | "copied" | "keptAfterReview" {
    return request.reviewedDraft?.kind === "keep"
        ? "keptAfterReview"
        : pending.draftChoice?.kind === "copySource"
          ? "copied"
          : "kept";
}

/** Attribution starts only from a complete saved result that still matches both observed authorities. */
function validOwnershipObservation(
    pending: TargetOperationRecord,
    captured: TargetOwnershipPublication,
    after: TargetOperationEvidence,
    observed: TargetOperationEvidence,
): boolean {
    return (
        sameTargetShelf(pending, captured.shelf) &&
        validAppliedObservation(pending, after, observed)
    );
}

/** Later completion validates Git evidence independently of the source pointer that publication advances. */
function validAppliedObservation(
    pending: TargetOperationRecord,
    after: TargetOperationEvidence,
    observed: TargetOperationEvidence,
): boolean {
    return (
        sameTargetObservation(after, observed) &&
        after.head === pending.headAfter &&
        !after.entries.some(
            (entry) => entry.outcome === "pending" || entry.outcome === "conflicted",
        ) &&
        !after.index.some((entry) => entry.stage !== 0)
    );
}

/** Only corruption and missing artifacts become review; transient I/O or injected failures retain their phase. */
function shelfPublicationRequiresReview(error: unknown): boolean {
    return (
        error instanceof ShelfStoreCorruptionError ||
        error instanceof ShelfPersistenceContractError ||
        error instanceof SyntaxError ||
        (!!error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    );
}

/** Phase text alone never admits removal completion; the concrete receipt is verified under its lock later. */
function assertTargetShelfCheckpoint(
    pending: TargetOperationRecord,
    shelfStore?: ShelfStore,
): void {
    if (
        pending.shelf?.removeFromShelf &&
        (!shelfStore ||
            pending.phase !== "shelfPublished" ||
            pending.completion?.shelfPublication !== "published")
    ) {
        throw new Error("Target completion requires a concrete shelf publication receipt.");
    }
}

/** Text attribution is bound to the exact captured bytes, HEAD and index, never just line coordinates. */
function snapshotMatchesOperationPath(
    snapshot: RangeSnapshot,
    evidence: TargetOperationEvidence,
    file: string,
): boolean {
    const state = evidence.paths.find((entry) => entry.path === file)?.state;
    return (
        state?.kind === "regular" &&
        snapshot.workingHash === state.content.hash &&
        snapshot.head === evidence.head &&
        snapshot.indexHash === evidence.indexFingerprint
    );
}

/** No counted change, line or base-anchored history is live; selections alone are remembered checkbox state. */
function ownsNoLiveChange(change: ChangeOwnership): boolean {
    return (
        !change.stale &&
        change.totalChanges === 0 &&
        Object.keys(change.lines).length === 0 &&
        !change.history?.some(
            ({ snapshot }) =>
                snapshot.baseHash === change.tracking?.baseHash && snapshot.anchorCount > 0,
        )
    );
}

/** A whole owner without a record, or a record owning a live change, prevents whole-file replacement. */
export function targetPathUnowned(state: ChangelistState, file: string): boolean {
    return Object.hasOwn(state.changes, file)
        ? ownsNoLiveChange(state.changes[file])
        : !Object.hasOwn(state.files, file);
}

/** Captured HEAD, index and worktree must represent the same file, independently of metadata ownership. */
function cleanWholeFileBefore(
    captured: TargetWholeFileBefore | undefined,
    working: TargetPathState | undefined,
    index: TargetIndexEntry | undefined,
): boolean {
    if (!captured || !captured.unowned || !working) return false;
    if (captured.head.kind === "absent") return !index && working.kind === "absent";
    const head = captured.head;
    if (
        !index ||
        index.stage !== 0 ||
        index.intentToAdd ||
        index.skipWorktree ||
        index.assumeUnchanged ||
        index.mode !== head.mode ||
        index.oid !== head.oid ||
        !isDeepStrictEqual(index.object, head.object)
    )
        return false;
    if (head.mode === "120000")
        return working.kind === "symlink" && isDeepStrictEqual(working.target, head.object);
    return (
        (head.mode === "100644" || head.mode === "100755") &&
        working.kind === "regular" &&
        working.executable === (head.mode === "100755") &&
        isDeepStrictEqual(working.content, head.object)
    );
}

/** Validate both rename endpoints and every ownership surface in one pass over captured path evidence. */
function validWholeFileOwnership(
    state: ChangelistState,
    before: TargetOperationEvidence,
    after: TargetOperationEvidence,
): boolean {
    const captured = new Map(before.wholeFileBefore?.map((entry) => [entry.path, entry]));
    const beforePaths = new Map(before.paths.map((entry) => [entry.path, entry.state]));
    const afterPaths = new Map(after.paths.map((entry) => [entry.path, entry.state]));
    const index = new Map(before.index.map((entry) => [entry.path, entry]));
    return (after.wholeFileAttribution ?? []).every((entry) => {
        const endpoints = entry.sourcePath ? [entry.path, entry.sourcePath] : [entry.path];
        if (
            entry.sourcePath !== undefined &&
            (beforePaths.get(entry.sourcePath)?.kind === "absent" ||
                afterPaths.get(entry.sourcePath)?.kind !== "absent" ||
                afterPaths.get(entry.path)?.kind === "absent")
        )
            return false;
        return endpoints.every(
            (file) =>
                targetPathUnowned(state, file) &&
                cleanWholeFileBefore(captured.get(file), beforePaths.get(file), index.get(file)),
        );
    });
}

/** Publish all validated structural owners, including a rename's removed source, in the caller's metadata CAS. */
interface OwnershipPublication {
    readonly ownership: HydratedChangeOwnership;
    /** The file had no change before the operation, so every change in it is the destination's. */
    readonly whole: boolean;
}

function publishFileOwner(
    state: ChangelistState,
    file: string,
    publication: OwnershipPublication,
    destinationId: string,
): HydratedChangeOwnership {
    if (publication.whole) state.files[file] = destinationId;
    else state.files[file] ??= state.activeId;
    const owner = state.files[file];
    // Like reconcileRanges, keep only lines owned apart from the file; any stored line owner shows
    // the file as Partial.
    const lines = Object.fromEntries(
        Object.entries(publication.ownership.lines).filter(([, id]) => id !== owner),
    );
    return { ...publication.ownership, lines };
}

function publishWholeFileOwners(
    state: ChangelistState,
    entries: NonNullable<TargetOperationEvidence["wholeFileAttribution"]>,
    destinationId: string,
): void {
    for (const file of entries.flatMap((entry) =>
        entry.sourcePath ? [entry.path, entry.sourcePath] : [entry.path],
    )) {
        state.files[file] = destinationId;
        // Validated to own no live change; a consumed record's history must not reassign lines later.
        delete state.changes[file];
    }
}

/** Serialized, revisioned worktree metadata shared by docked and undocked providers. */
export class ChangelistStore {
    private readonly roots = new Map<string, ChangelistState>();
    private writes = Promise.resolve();
    private readonly listeners = new Set<(root: string, state: ChangelistState) => void>();
    private loadError?: string;
    private migrationSource?: unknown;
    private readonly commitLeases = new Map<string, string>();
    private readonly targetLeases = new Map<
        string,
        { handle: TargetOperationLease; closing: boolean; released: Promise<void> }
    >();
    private readonly mirrorScopes = new Map<string, string>();
    private readonly durable = new Map<string, ChangelistPersistence>();
    private requiresConnection = false;
    private readonly seeds = new Map<string, HydratedChangelistState>();
    private readonly hydratedReferences = new WeakMap<RangeSnapshot, RangeSnapshotReference>();
    private readonly evidence = new Map<string, Map<string, RangeSnapshot>>();
    private readonly observations = new Map<string, Set<Promise<unknown>>>();
    private readonly holds = new Map<
        string,
        { count: number; released: Promise<void>; end: () => void }
    >();
    private readonly epochs = new Map<string, number>();

    /** Reuses the workspace store so independent panels cannot overwrite each other's lists. */
    static forStorage(storage?: MetadataStorage): ChangelistStore {
        if (!storage) return new ChangelistStore();
        const previous = instances.get(storage);
        if (previous) return previous;
        const store = new ChangelistStore(storage);
        instances.set(storage, store);
        return store;
    }

    /** Loads only bounded, well-formed metadata; corrupt records never redirect Git. */
    constructor(private readonly storage?: MetadataStorage) {
        const saved = storage?.get<unknown>(STORAGE_KEY);
        if (saved === undefined) return;
        if (
            !saved ||
            typeof saved !== "object" ||
            !("entries" in saved) ||
            !("schemaVersion" in saved) ||
            ![1, 2, 3, 4, 5].includes(saved.schemaVersion as number)
        ) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        const entries = (saved as { entries?: unknown }).entries;
        this.requiresConnection = [3, 4, 5].includes(saved.schemaVersion as number);
        if (!Array.isArray(entries) || entries.length > 128) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        for (const value of entries as unknown[]) {
            const entry = metadataRecord(value);
            if (
                !entry ||
                typeof entry.root !== "string" ||
                !entry.state ||
                this.roots.has(entry.root)
            ) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            const state = parseState(entry.state, saved.schemaVersion === 1 ? 1 : 2, true);
            if (!state) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            if (saved.schemaVersion === 1) {
                const legacyDraft = storage?.get<unknown>(`commitDraft:${entry.root}`);
                if (
                    legacyDraft !== undefined &&
                    (typeof legacyDraft !== "string" || legacyDraft.length > MAX_DRAFT)
                ) {
                    this.loadError = "Changelist draft is invalid and will not be overwritten.";
                    return;
                }
                state.allDraft = typeof legacyDraft === "string" ? legacyDraft : "";
            }
            this.seeds.set(entry.root, state);
            this.roots.set(entry.root, this.compactMemoryState(entry.root, state));
        }
        if (saved.schemaVersion === 1) this.migrationSource = structuredClone(saved);
    }

    /** Native inputs must wait for authoritative hydration after a schema-3 workspace reload. */
    needsConnection(root: string): boolean {
        return this.requiresConnection && !this.durable.has(root);
    }

    /** Returns an independent snapshot without exposing mutable host-owned maps. */
    get(root: string): ChangelistState {
        return structuredClone(this.authoritative(root));
    }

    /** Revision polling validates authoritative metadata without cloning any ownership or evidence. */
    revision(root: string): number {
        return this.authoritative(root).revision;
    }

    /** Registers a host prerequisite (connection, recovery) target prompts wait for; returns it unchanged. */
    observe<T>(root: string, observation: Promise<T>): Promise<T> {
        const pending = this.observations.get(root) ?? new Set<Promise<unknown>>();
        this.observations.set(root, pending);
        pending.add(observation);
        const settle = () => pending.delete(observation);
        observation.then(settle, settle);
        return observation;
    }

    /**
     * Resolves once every prerequisite already in flight settles. A rejected one never blocks; the
     * revision fence still guards. Observer writes are held by `holdObservers`, never awaited here.
     */
    async settled(root: string): Promise<void> {
        await Promise.allSettled([...(this.observations.get(root) ?? [])]);
    }

    /** Changes whenever a hold starts or ends; an observation begun at an older value is discarded. */
    observerEpoch(root: string): number {
        return this.epochs.get(root) ?? 0;
    }

    /**
     * Holds this root's observer writes for a target prompt and its apply. Writes already admitted
     * drain first; later ones are refused, never queued, so the operation cannot wait on its own
     * hold. Another window's writes are not held; the exact revision fence still refuses them.
     */
    async holdObservers(root: string): Promise<() => void> {
        let hold = this.holds.get(root);
        if (!hold) {
            let end!: () => void;
            const released = new Promise<void>((resolve) => (end = resolve));
            hold = { count: 0, released, end };
            this.holds.set(root, hold);
        }
        const active = hold;
        active.count++;
        this.epochs.set(root, this.observerEpoch(root) + 1);
        let open = true;
        const release = () => {
            if (!open) return;
            open = false;
            this.epochs.set(root, this.observerEpoch(root) + 1);
            if (--active.count > 0) return;
            this.holds.delete(root);
            active.end();
        };
        // Every writer replaces the tail with a settled continuation, so this never rejects.
        await this.writes;
        return release;
    }

    /** Resolves once no targeted operation leases or holds this root's metadata. */
    async targetOperationReleased(root: string): Promise<void> {
        await Promise.all([this.targetLeases.get(root)?.released, this.holds.get(root)?.released]);
    }

    /** Refuses an observer write while held, or once a hold began or ended after it observed. */
    private admitObserver(root: string, epoch: number | undefined): void {
        if (this.holds.has(root) || (epoch !== undefined && epoch !== this.observerEpoch(root)))
            throw new TargetOperationLeaseHeldError();
    }

    /** Borrowed compact state remains private; callers receive independent snapshots through get. */
    private authoritative(root: string): ChangelistState {
        if (this.loadError) throw new Error(this.loadError);
        const persistence = this.durable.get(root);
        if (persistence) {
            const saved = persistence.read(parseDurableState);
            if (!saved) throw new Error("Changelist metadata disappeared and requires review.");
            this.roots.set(root, saved);
        }
        const existing = this.roots.get(root);
        if (existing) return existing;
        const state = emptyState();
        const legacy = this.storage?.get<unknown>(`commitDraft:${root}`);
        if (legacy !== undefined && (typeof legacy !== "string" || legacy.length > MAX_DRAFT))
            throw new Error("Changelist draft is invalid and will not be overwritten.");
        state.allDraft = typeof legacy === "string" ? legacy : "";
        return state;
    }

    /**
     * Migrate under the worktree's metadata lock, retaining the original complete workspace
     * record and a downgrade sentinel. Every later writer reloads the authoritative file.
     */
    async connect(root: string, gitDir: string): Promise<void> {
        const operation = this.writes.then(async () => {
            if (this.durable.has(root)) return;
            const seed = this.seeds.get(root) ?? (await this.hydrateState(root, this.get(root)));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const release = await persistence.acquire();
            try {
                const legacy = await persistence.readLegacy(parseLegacyState, parseDurableState);
                const existing = legacy ? undefined : persistence.read(parseDurableState);
                const existingMatches =
                    !this.roots.has(root) ||
                    persistence.migratedFrom(root, seed) ||
                    (legacy
                        ? legacy.schemaVersion === 4
                            ? await this.matchesSeed(root, legacy.state, seed, persistence)
                            : isDeepStrictEqual(legacy.state, seed)
                        : existing
                          ? await this.matchesSeed(root, existing, seed, persistence)
                          : true);
                if (!existingMatches) {
                    await persistence.preserveConflict({
                        legacy: this.storage?.get(STORAGE_KEY),
                        root,
                        state: seed,
                    });
                    throw new Error("Conflicting changelist migration metadata requires review.");
                }
                if (!existing && !legacy)
                    await persistence.backup({
                        legacy: this.storage?.get(STORAGE_KEY),
                        root,
                        state: seed,
                    });
                if (legacy) await persistence.backupLegacy(legacy.bytes, legacy.schemaVersion);
                const state =
                    existing ??
                    (legacy?.schemaVersion === 4
                        ? legacy.state
                        : await this.compactState(root, legacy?.state ?? seed, persistence));
                await persistence.validateEvidence(state);
                if (this.migrationSource !== undefined) await this.backupMigration();
                const hasSeed = this.roots.has(root) || (!existing && !legacy);
                await this.publishConnectionSentinel(root, seed, hasSeed);
                this.requiresConnection = true;
                if (!existing) await persistence.write(state);
                await persistence.collect(undefined, state);
                if (hasSeed) this.seeds.set(root, seed);
                this.durable.set(root, persistence);
                this.roots.set(root, state);
                this.evidence.delete(root);
                this.migrationSource = undefined;
            } finally {
                await release();
            }
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Preserves real workspace seeds, omits invented adoption intent, and avoids unchanged sentinel writes. */
    private async publishConnectionSentinel(
        root: string,
        seed: HydratedChangelistState,
        hasSeed: boolean,
    ): Promise<void> {
        const seeds = new Map(this.seeds);
        if (hasSeed && !seeds.has(root)) seeds.set(root, seed);
        // Detached references never enter workspace storage; old clients refuse the new sentinel.
        const sentinel = {
            schemaVersion: 5,
            entries: [...seeds].map(([key, value]) => ({ root: key, state: value })),
        };
        if (JSON.stringify(this.storage?.get(STORAGE_KEY)) !== JSON.stringify(sentinel))
            await this.storage?.update(STORAGE_KEY, sentinel);
    }

    /** Browser snapshots omit potentially large host-only range evidence and undo history. */
    view(root: string): ChangelistState {
        const state = this.get(root);
        for (const ownership of Object.values(state.changes)) {
            delete ownership.tracking;
            delete ownership.history;
        }
        if (state.pendingTargetOperation)
            state.targetOperationSummary = summarizeTargetOperation(state.pendingTargetOperation);
        delete state.pendingTargetOperation;
        delete state.targetOperationReceipts;
        return state;
    }

    /** Reconciles one host-captured snapshot atomically with the current active list and revision. */
    track(
        root: string,
        file: string,
        snapshot: RangeSnapshot,
        revision?: number,
        epoch?: number,
    ): Promise<ChangelistState> {
        return this.trackBatch(root, [{ file, snapshot }], revision, epoch);
    }

    /** Reconciles several host-captured snapshots in one write: one revision, save and notification. */
    trackBatch(
        root: string,
        entries: readonly { file: string; snapshot: RangeSnapshot }[],
        revision?: number,
        epoch?: number,
    ): Promise<ChangelistState> {
        const safe = entries.map(({ file, snapshot }) => ({
            file: assertRepoRelativePath(file),
            snapshot,
        }));
        this.admitObserver(root, epoch);
        return this.write(root, revision, async (state) => {
            let changed = false;
            for (const { file, snapshot } of safe) {
                const owner = state.files[file];
                const ownership = JSON.stringify(state.changes[file]);
                const fallback = owner ?? state.activeId;
                state.files[file] = fallback;
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Evidence is hydrated and stored one file at a time under the lease.
                const previous = await this.hydrate(root, file, state.changes[file]);
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Evidence is hydrated and stored one file at a time under the lease.
                state.changes[file] = await this.compact(
                    root,
                    file,
                    reconcileRanges(previous, snapshot, fallback, state.activeId),
                );
                // Only these two entries change, so comparing them matches a whole-state comparison.
                changed ||= owner !== fallback || JSON.stringify(state.changes[file]) !== ownership;
            }
            return changed;
        });
    }

    /** Failed lifecycle reads retain evidence and prevent implicit whole-file commits. */
    requireReview(
        root: string,
        file: string,
        unknown = false,
        epoch?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        this.admitObserver(root, epoch);
        return this.write(root, undefined, (state) => {
            const previous = state.changes[safe];
            if (previous || unknown)
                state.changes[safe] = {
                    ...(previous ?? { contentId: "", lines: {} }),
                    stale: true,
                };
        });
    }

    /** Subscriptions report metadata changes only, never Git or filesystem mutations. */
    subscribe(listener: (root: string, state: ChangelistState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Reserves authoritative metadata, refusing a targeted operation before a commit can mutate Git. */
    async beginCommit(root: string): Promise<() => Promise<void>> {
        const operation = this.writes.then(async () => {
            if (this.targetLeases.has(root))
                throw new Error("A targeted operation holds the metadata lease.");
            if (this.commitLeases.has(root))
                throw new Error("A selected commit is already in progress.");
            const release = await this.durable.get(root)?.acquire();
            let state: ChangelistState;
            try {
                state = this.get(root);
                assertTargetOperationWriteAllowed(state);
            } catch (error) {
                await release?.();
                throw error;
            }
            const token = randomUUID();
            this.commitLeases.set(root, token);
            this.notify(root, state);
            return async () => {
                if (this.commitLeases.get(root) !== token) return;
                this.commitLeases.delete(root);
                await release?.();
                this.notify(root, this.get(root));
            };
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Shared providers expose the same root's semantic commit fence. */
    isCommitting(root: string): boolean {
        return this.commitLeases.has(root);
    }

    /** Acquire metadata first; named transaction methods reuse this lease without nested acquisition. */
    async acquireTargetOperationLease(root: string): Promise<TargetOperationLease> {
        const operation = this.writes.then(async () => {
            if (this.commitLeases.has(root) || this.targetLeases.has(root))
                throw new RepositoryLockBusyError();
            const persistence = this.durable.get(root);
            if (!persistence)
                throw new Error("Target operations require connected durable metadata.");
            const release = await persistence.acquire();
            try {
                this.get(root);
            } catch (error) {
                await release();
                throw error;
            }
            let releasing: Promise<void> | undefined;
            let ended!: () => void;
            const released = new Promise<void>((resolve) => (ended = resolve));
            const handle: TargetOperationLease = Object.freeze({
                [targetOperationLeaseBrand]: true as const,
                release: () => {
                    if (releasing) return releasing;
                    this.targetLeases.get(root)!.closing = true;
                    releasing = this.writes.then(async () => {
                        try {
                            await release();
                        } finally {
                            this.targetLeases.delete(root);
                            ended();
                        }
                    });
                    this.writes = releasing.catch(() => undefined);
                    return releasing;
                },
            });
            this.targetLeases.set(root, { handle, closing: false, released });
            return handle;
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Prepare exactly one request, publishing any new inactive list with its durable replay fence. */
    async prepareTargetOperation(
        lease: TargetOperationLease,
        request: PrepareTargetOperationRequest,
    ): Promise<TargetOperationPreparation> {
        const root = this.targetOperationRoot(lease);
        const intent = structuredClone(request);
        if (
            !Number.isSafeInteger(intent.target.revision) ||
            intent.target.revision < 0 ||
            (intent.target.kind !== "existing" && intent.target.kind !== "new")
        )
            throw new Error("Invalid target operation request.");
        const target = preparedTarget(intent.target);
        const requestHash = targetRequestHash({ ...intent, target });
        let status: TargetOperationPreparation["status"] = "prepared";
        const state = await this.write(
            root,
            undefined,
            async (state) => {
                const known =
                    state.pendingTargetOperation?.id === intent.id
                        ? state.pendingTargetOperation
                        : state.targetOperationReceipts?.[intent.id];
                if (known) {
                    if (known.requestHash !== requestHash)
                        throw new Error("Target operation request identity changed.");
                    status = "known";
                    return;
                }
                if (state.pendingTargetOperation)
                    throw new Error("A targeted operation is pending review.");
                if (state.revision !== target.revision) throw new ChangelistRevisionError();
                let destinationId: string;
                let destinationCreation: TargetOperationRecord["destinationCreation"];
                if (target.kind === "existing") {
                    destinationId = requireList(state, target.id).id;
                } else {
                    if (state.lists.length >= MAX_LISTS) throw new Error("Too many changelists.");
                    if (
                        state.lists.some(
                            (list) =>
                                list.name.normalize("NFC").toLowerCase() ===
                                target.name.toLowerCase(),
                        )
                    )
                        throw new Error("A changelist with this name already exists.");
                    destinationId = randomUUID();
                    destinationCreation = { name: target.name, description: "", draft: "" };
                }
                const pending = parseTargetOperationRecord({
                    version: 1,
                    id: intent.id,
                    requestHash,
                    kind: intent.kind,
                    phase: "prepared",
                    destinationId,
                    createdDestination: target.kind === "new",
                    ...(destinationCreation ? { destinationCreation } : {}),
                    headBefore: intent.headBefore,
                    evidenceHash: intent.evidenceHash,
                    beforeEvidenceHash: intent.evidenceHash,
                    ...(intent.shelf ? { shelf: intent.shelf } : {}),
                    ...(intent.commit ? { commit: intent.commit } : {}),
                    ...(intent.draftChoice ? { draftChoice: intent.draftChoice } : {}),
                    ...(intent.sourceDraft !== undefined
                        ? { sourceDraft: intent.sourceDraft }
                        : {}),
                });
                if (!pending) throw new Error("Invalid target operation request.");
                const before = await this.durable
                    .get(root)!
                    .loadTargetOperationEvidence(intent.evidenceHash);
                assertPreparedEvidence(pending, before);
                if (
                    before.wholeFileBefore?.some(
                        (entry) => entry.unowned !== targetPathUnowned(state, entry.path),
                    )
                )
                    throw new Error(
                        "Target operation ownership observation changed before preparation.",
                    );
                const destinationDraft =
                    destinationCreation?.draft ?? requireList(state, destinationId).draft;
                if (
                    intent.draftChoice?.kind === "copySource" &&
                    intent.draftChoice.expectedDestinationDraft !== destinationDraft
                )
                    throw new Error("The destination draft changed. Review before copying.");
                if (destinationCreation)
                    state.lists.push({ id: destinationId, ...destinationCreation });
                state.pendingTargetOperation = pending;
            },
            true,
            undefined,
            lease,
        );
        return { status, state };
    }

    /** Advance only the recorded operation and its exact affected set; no Git work runs here. */
    async checkpointTargetOperation(
        lease: TargetOperationLease,
        checkpoint: TargetOperationCheckpoint,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const expected = structuredClone(checkpoint);
        return this.write(
            root,
            expected.revision,
            async (state) => {
                const pending = requireTargetOperation(state, expected);
                assertCheckpointPhase(pending.phase, expected.phase);
                const persistence = this.durable.get(root)!;
                const [before, after] = await Promise.all([
                    persistence.loadTargetOperationEvidence(pending.evidenceHash),
                    persistence.loadTargetOperationEvidence(expected.evidenceHash),
                ]);
                assertCheckpointEvidence(pending, before, after, expected.phase);
                const next = parseTargetOperationRecord({
                    ...pending,
                    phase: expected.phase,
                    evidenceHash: expected.evidenceHash,
                    headAfter: after.head,
                });
                if (!next) throw new Error("Invalid target operation checkpoint phase.");
                state.pendingTargetOperation = next;
            },
            true,
            undefined,
            lease,
        );
    }

    /** Acknowledge native cleanup without changing the accepted history result or attribution. */
    async checkpointTargetNativeCompletionCleanup(
        lease: TargetOperationLease,
        request: TargetOperationExpectedState & { readonly evidenceHash: string },
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(request);
        return this.write(
            root,
            captured.revision,
            async (state) => {
                const pending = requireTargetOperation(state, captured);
                if (
                    pending.phase !== "gitApplied" ||
                    !["cherryPick", "revert"].includes(pending.kind) ||
                    pending.completion
                )
                    throw new Error(
                        "Native completion cleanup requires an accepted history result.",
                    );
                const persistence = this.durable.get(root)!;
                const [before, after] = await Promise.all([
                    persistence.loadTargetOperationEvidence(pending.evidenceHash),
                    persistence.loadTargetOperationEvidence(captured.evidenceHash),
                ]);
                const marker = pending.kind === "cherryPick" ? "cherryPickHead" : "revertHead";
                if (
                    after.previousEvidenceHash !== pending.evidenceHash ||
                    !before.native.some((entry) => entry.present) ||
                    before.native.some(
                        (entry) =>
                            entry.present && entry.name !== marker && entry.name !== "sequencer",
                    ) ||
                    after.native.some((entry) => entry.present) ||
                    !isDeepStrictEqual(
                        { ...before, native: [], previousEvidenceHash: undefined },
                        { ...after, native: [], previousEvidenceHash: undefined },
                    )
                )
                    throw new Error("Native cleanup changed the accepted history evidence.");
                state.pendingTargetOperation = { ...pending, evidenceHash: captured.evidenceHash };
            },
            true,
            undefined,
            lease,
        );
    }

    /**
     * Publish proven operation-only ownership and the guarded captured draft in one CAS, retaining
     * pending. The adapter supplies actual current evidence under its Git/shelf gates; this method
     * does not observe or mutate Git. A durable completion makes every later call a metadata no-op.
     */
    async publishTargetOwnership(
        lease: TargetOperationLease,
        request: TargetOwnershipPublication,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(request);
        return this.write(
            root,
            captured.revision,
            async (state) => {
                const pending = requireTargetOperation(state, captured);
                if (pending.completion) return;
                if (!targetOwnershipPhaseAllowed(pending, captured))
                    throw new Error("Target ownership requires a completed Git checkpoint.");
                const persistence = this.durable.get(root)!;
                const chain = await persistence.loadTargetOperationEvidenceChain(
                    pending.evidenceHash,
                );
                const after = chain.evidence;
                const applied = after.entries
                    .filter((entry) => entry.outcome === "applied")
                    .map((entry) => entry.changeId);
                if (!applied.length)
                    throw new Error("Target ownership has no successful entries to publish.");
                const review = () => {
                    state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                };
                const observed = await persistence.loadTargetOperationEvidence(
                    captured.observedEvidenceHash,
                );
                const before = this.targetOperationBefore(pending, chain.root);
                if (!before || !validOwnershipObservation(pending, captured, after, observed)) {
                    review();
                    return;
                }
                const references = after.attribution ?? [];
                const wholeFiles = after.wholeFileAttribution ?? [];
                if (
                    !sameTargetSet(
                        [...references, ...wholeFiles].flatMap((entry) => [...entry.changeIds]),
                        applied,
                    )
                ) {
                    review();
                    return;
                }
                const updates = new Map<string, OwnershipPublication>();
                if (!validWholeFileOwnership(state, before, after)) {
                    review();
                    return;
                }
                const ids = new Set(state.lists.map((list) => list.id));
                for (const reference of references) {
                    const payload = await persistence.loadTargetOperationAttribution(
                        reference,
                        pending.id,
                    );
                    const prior = await this.hydrate(
                        root,
                        reference.path,
                        state.changes[reference.path],
                    );
                    const fallback = state.files[reference.path] ?? state.activeId;
                    if (
                        payload.priorFileOwner !== fallback ||
                        !validOwnership(payload.previous, ids, true) ||
                        !isDeepStrictEqual(
                            payload.previous,
                            prior ?? reconcileRanges(undefined, payload.before, fallback, fallback),
                        ) ||
                        !snapshotMatchesOperationPath(payload.before, before, reference.path) ||
                        !snapshotMatchesOperationPath(payload.after, after, reference.path)
                    ) {
                        review();
                        return;
                    }
                    const attributed = attributeOperationChanges({
                        ...payload,
                        // A held observer may not have recorded the captured bytes; reconcile as it would.
                        previous: reconcileRanges(
                            payload.previous,
                            payload.before,
                            fallback,
                            state.activeId,
                        ),
                        destinationId: pending.destinationId,
                    });
                    if (attributed.reviewRequired) {
                        review();
                        return;
                    }
                    updates.set(reference.path, {
                        ownership: attributed.ownership,
                        whole: !payload.before.anchors.length,
                    });
                }
                const destination = requireList(state, pending.destinationId);
                if (!targetDraftMatches(pending, destination.draft, captured.reviewedDraft)) {
                    review();
                    return;
                }
                for (const [file, publication] of updates) {
                    const ownership = publishFileOwner(
                        state,
                        file,
                        publication,
                        pending.destinationId,
                    );
                    state.changes[file] = await this.compact(root, file, ownership);
                }
                publishWholeFileOwners(state, wholeFiles, pending.destinationId);
                const draft = targetDraftDecision(pending, captured);
                if (draft === "copied") destination.draft = pending.sourceDraft!;
                state.pendingTargetOperation = {
                    ...pending,
                    phase: "ownershipPublished",
                    completion: {
                        appliedChangeIds: applied,
                        ownershipRevision: state.revision + 1,
                        draft,
                        shelfPublication: pending.shelf?.removeFromShelf
                            ? "pending"
                            : "notRequired",
                    },
                };
            },
            true,
            undefined,
            lease,
        );
    }

    /**
     * Checkpoints the concrete terminal shelf receipt while retaining pending and the original
     * ownership/draft decision. Caller holds the metadata lease then repository gate; the shelf
     * lock spans storage publication, receipt validation, and the metadata CAS.
     */
    async publishTargetShelf(
        lease: TargetOperationLease,
        request: TargetOperationObservation,
        shelfStore: ShelfStore,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(request);
        await this.assertTargetShelfRepository(root, shelfStore);
        return shelfStore.withLock(() =>
            this.write(
                root,
                captured.revision,
                async (state) => {
                    const pending = requireTargetOperation(state, captured);
                    if (
                        !pending.shelf?.removeFromShelf ||
                        !pending.completion ||
                        (pending.phase !== "ownershipPublished" &&
                            pending.phase !== "shelfPublished")
                    )
                        throw new Error(
                            "Shelf publication requires the frozen ownership completion.",
                        );
                    const persistence = this.durable.get(root)!;
                    const chain = await persistence.loadTargetOperationEvidenceChain(
                        pending.evidenceHash,
                    );
                    const observed = await persistence.loadTargetOperationEvidence(
                        captured.observedEvidenceHash,
                    );
                    const applied = chain.evidence.entries
                        .filter((entry) => entry.outcome === "applied")
                        .map((entry) => entry.changeId);
                    if (
                        !this.targetOperationBefore(pending, chain.root) ||
                        !validAppliedObservation(pending, chain.evidence, observed) ||
                        !applied.length ||
                        !sameTargetSet(applied, pending.completion.appliedChangeIds)
                    ) {
                        state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                        return;
                    }
                    try {
                        const publication = this.targetShelfRequest(pending);
                        const manifest =
                            pending.phase === "shelfPublished"
                                ? await shelfStore.readTargetOperationReceipt(publication)
                                : await shelfStore.publishTargetOperation(publication);
                        // A successful callback is not proof: read the actual durable terminal receipt.
                        const receipt = await shelfStore.readTargetOperationReceipt(publication);
                        if (
                            manifest.generation !== receipt.generation ||
                            manifest.checksum !== receipt.checksum ||
                            (pending.phase === "shelfPublished" &&
                                (pending.completion.publishedGeneration !== receipt.generation ||
                                    pending.completion.publishedChecksum !== receipt.checksum))
                        ) {
                            state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                            return;
                        }
                        state.pendingTargetOperation = {
                            ...pending,
                            phase: "shelfPublished",
                            completion: {
                                ...pending.completion,
                                shelfPublication: "published",
                                publishedGeneration: receipt.generation,
                                publishedChecksum: receipt.checksum,
                            },
                        };
                    } catch (error) {
                        if (!shelfPublicationRequiresReview(error)) throw error;
                        state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                    }
                },
                true,
                undefined,
                lease,
            ),
        );
    }

    /** Bind the concrete store to the canonical metadata worktree, never caller-provided path labels. */
    private async assertTargetShelfRepository(root: string, shelfStore: ShelfStore): Promise<void> {
        const paths = await resolveShelfPaths({
            repositoryRoot: this.durable.get(root)!.root,
            globalStoragePath: root,
        });
        if (shelfStore.repositoryId !== paths.repoId)
            throw new Error("Shelf store belongs to another repository.");
    }

    /** Derives publication authority solely from durable intent and the frozen completion set. */
    private targetShelfRequest(pending: TargetOperationRecord): ShelfTargetPublicationRequest {
        if (!pending.shelf || !pending.completion)
            throw new Error("Missing target shelf completion.");
        return {
            targetOperationId: pending.id,
            shelfId: pending.shelf.id,
            sourceGeneration: pending.shelf.generation,
            sourceChecksum: pending.shelf.checksum,
            appliedChangeIds: pending.completion.appliedChangeIds,
        };
    }

    /** Publish a terminal receipt with pending clear only while actual shelf evidence remains locked and verified. */
    async finishTargetOperation(
        lease: TargetOperationLease,
        request: TargetOperationObservation,
        shelfStore?: ShelfStore,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(request);
        if (shelfStore) await this.assertTargetShelfRepository(root, shelfStore);
        const finish = () =>
            this.write(
                root,
                captured.revision,
                async (state) => {
                    if (
                        !state.pendingTargetOperation &&
                        state.targetOperationReceipts?.[captured.id]
                    )
                        return;
                    const pending = requireTargetOperation(state, captured);
                    const persistence = this.durable.get(root)!;
                    const chain = await persistence.loadTargetOperationEvidenceChain(
                        pending.evidenceHash,
                    );
                    const before = this.targetOperationBefore(pending, chain.root);
                    const observed = await persistence.loadTargetOperationEvidence(
                        captured.observedEvidenceHash,
                    );
                    const applied = chain.evidence.entries
                        .filter((entry) => entry.outcome === "applied")
                        .map((entry) => entry.changeId);
                    let outcome: "notApplied" | "applied";
                    if (
                        pending.phase === "prepared" ||
                        (pending.phase === "gitApplied" && !applied.length)
                    ) {
                        if (
                            !before ||
                            !sameTargetObservation(before, observed) ||
                            !sameTargetObservation(before, chain.evidence)
                        ) {
                            state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                            return;
                        }
                        outcome = "notApplied";
                    } else {
                        if (!pending.completion)
                            throw new Error("Target completion requires published ownership.");
                        assertTargetShelfCheckpoint(pending, shelfStore);
                        if (
                            !before ||
                            !validAppliedObservation(pending, chain.evidence, observed) ||
                            (!shelfStore && !sameTargetShelf(pending, captured.shelf)) ||
                            (!pending.shelf?.removeFromShelf &&
                                pending.completion.shelfPublication !== "notRequired") ||
                            !applied.length ||
                            !sameTargetSet(applied, pending.completion.appliedChangeIds)
                        ) {
                            state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                            return;
                        }
                        outcome = "applied";
                    }
                    if (
                        shelfStore &&
                        !(await this.matchesTargetCompletionShelf(pending, outcome, shelfStore))
                    ) {
                        state.pendingTargetOperation = { ...pending, phase: "reviewRequired" };
                        return;
                    }
                    if (outcome === "notApplied")
                        this.removeUnchangedTargetDestination(state, pending);
                    state.targetOperationReceipts ??= {};
                    state.targetOperationReceipts[pending.id] = {
                        version: 1,
                        id: pending.id,
                        requestHash: pending.requestHash,
                        outcome,
                        ...retainedReceiptEvidence(pending),
                    };
                    delete state.pendingTargetOperation;
                },
                true,
                undefined,
                lease,
            );
        return shelfStore ? shelfStore.withLock(finish) : finish();
    }

    /** Reads concrete storage while its lock is held; missing/corrupt evidence preserves pending for review. */
    private async matchesTargetCompletionShelf(
        pending: TargetOperationRecord,
        outcome: "applied" | "notApplied",
        shelfStore: ShelfStore,
    ): Promise<boolean> {
        if (!pending.shelf) return true;
        try {
            if (outcome === "applied" && pending.shelf.removeFromShelf) {
                const receipt = await shelfStore.readTargetOperationReceipt(
                    this.targetShelfRequest(pending),
                );
                return (
                    receipt.generation === pending.completion!.publishedGeneration &&
                    receipt.checksum === pending.completion!.publishedChecksum
                );
            }
            const source = await shelfStore.readCurrentShelfManifest(pending.shelf.id);
            return (
                source.generation === pending.shelf.generation &&
                source.checksum === pending.shelf.checksum
            );
        } catch (error) {
            if (!shelfPublicationRequiresReview(error)) throw error;
            return false;
        }
    }

    /** Recover metadata only: never repeat Git, overwrite a later draft, or infer shelf publication from phase text. */
    async recoverTargetOperation(
        lease: TargetOperationLease,
        request: TargetOperationObservation,
        shelfStore?: ShelfStore,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(request);
        if (shelfStore) await this.assertTargetShelfRepository(root, shelfStore);
        let current = await this.write(
            root,
            captured.revision,
            (state) => {
                if (!state.pendingTargetOperation && state.targetOperationReceipts?.[captured.id])
                    return;
                requireTargetOperation(state, captured);
            },
            true,
            undefined,
            lease,
        );
        let pending = current.pendingTargetOperation;
        if (!pending || pending.phase === "prepared")
            return this.finishTargetOperation(lease, captured, shelfStore);
        if (pending.phase === "gitApplied") {
            const saved = await this.durable
                .get(root)!
                .loadTargetOperationEvidence(pending.evidenceHash);
            if (!saved.entries.some((entry) => entry.outcome === "applied"))
                return this.finishTargetOperation(lease, captured, shelfStore);
            current = await this.publishTargetOwnership(lease, captured);
            pending = current.pendingTargetOperation!;
        }
        if (
            pending.phase === "ownershipPublished" &&
            pending.shelf?.removeFromShelf &&
            shelfStore
        ) {
            current = await this.publishTargetShelf(
                lease,
                { ...captured, revision: current.revision, expectedPhase: pending.phase },
                shelfStore,
            );
            pending = current.pendingTargetOperation!;
        }
        if (
            pending.completion &&
            (pending.phase === "ownershipPublished" || pending.phase === "shelfPublished") &&
            (!pending.shelf?.removeFromShelf || shelfStore)
        )
            return this.finishTargetOperation(
                lease,
                { ...captured, revision: current.revision, expectedPhase: pending.phase },
                shelfStore,
            );
        return current;
    }

    /** Bind native recovery to this exact live metadata lease, root, operation and revision. */
    readTargetOperationRecovery(
        lease: TargetOperationLease,
        root: string,
        expected: TargetOperationExpectedState,
    ): ChangelistState {
        if (this.targetOperationRoot(lease) !== root)
            throw new Error("Recovery lease root changed.");
        const state = this.get(root);
        if (state.revision !== expected.revision) throw new ChangelistRevisionError();
        const pending = requireTargetOperation(state, expected);
        if (!["cherryPick", "revert"].includes(pending.kind) || pending.completion)
            throw new Error("Native abort is unavailable after ownership publication.");
        return state;
    }

    /** Publish only forward abort evidence; ordinary application checkpoints cannot enter this path. */
    async checkpointTargetAbort(
        lease: TargetOperationLease,
        request: TargetOperationExpectedState & { readonly evidenceHash: string },
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const expected = structuredClone(request);
        this.readTargetOperationRecovery(lease, root, expected);
        return this.write(
            root,
            expected.revision,
            async (state) => {
                const pending = requireTargetOperation(state, expected);
                const persistence = this.durable.get(root)!;
                const chain = await persistence.loadTargetOperationEvidenceChain(
                    expected.evidenceHash,
                );
                const next = chain.evidence;
                const before = this.targetOperationBefore(pending, chain.root);
                const previous = await persistence.loadTargetOperationEvidence(
                    pending.evidenceHash,
                );
                const allowed: Record<string, readonly string[]> = {
                    after: ["abortPrepared"],
                    abortPrepared: ["abortPath", "abortPathsRestored"],
                    abortPath: ["abortPath", "abortPathsRestored"],
                    abortPathsRestored: ["abortIndexPrepared"],
                    abortIndexPrepared: ["abortIndexPrepared", "abortIndexRestored"],
                    abortIndexRestored: ["abortNativeCleared"],
                };
                if (
                    !before ||
                    pending.completion ||
                    !["cherryPick", "revert"].includes(pending.kind) ||
                    !allowed[previous.checkpoint]?.includes(next.checkpoint) ||
                    next.previousEvidenceHash !== pending.evidenceHash ||
                    next.operationId !== pending.id ||
                    next.head !== pending.headBefore ||
                    !sameTargetSet(
                        before.paths.map((entry) => entry.path),
                        next.paths.map((entry) => entry.path),
                    ) ||
                    !isDeepStrictEqual(previous.entries, next.entries) ||
                    next.abortPaths?.some(
                        (entry) =>
                            !isDeepStrictEqual(
                                entry.desiredBefore,
                                before.paths.find((saved) => saved.path === entry.path)?.state,
                            ),
                    ) ||
                    (previous.abortPaths &&
                        next.abortPaths?.some((entry) => {
                            const old = previous.abortPaths!.find(
                                (saved) => saved.path === entry.path,
                            );
                            return (
                                !old ||
                                old.recoveryPath !== entry.recoveryPath ||
                                !isDeepStrictEqual(old.expectedCurrent, entry.expectedCurrent) ||
                                (old.move.state === "moved" &&
                                    !isDeepStrictEqual(old.move, entry.move)) ||
                                (old.install.state === "installed" &&
                                    !isDeepStrictEqual(old.install, entry.install))
                            );
                        }))
                )
                    throw new Error("Native abort checkpoint evidence changed.");
                if (
                    next.checkpoint === "abortPrepared" &&
                    next.abortPaths?.some(
                        (entry) =>
                            !isDeepStrictEqual(
                                entry.expectedCurrent,
                                previous.paths.find((saved) => saved.path === entry.path)?.state,
                            ),
                    )
                )
                    throw new Error("Native abort review changed.");
                const phase =
                    next.checkpoint === "abortPath"
                        ? "abortPrepared"
                        : next.checkpoint === "abortIndexPrepared"
                          ? "abortPathsRestored"
                          : next.checkpoint;
                const record = parseTargetOperationRecord({
                    ...pending,
                    phase,
                    evidenceHash: expected.evidenceHash,
                });
                if (!record) throw new Error("Invalid native abort phase.");
                state.pendingTargetOperation = record;
            },
            true,
            undefined,
            lease,
        );
    }

    /** Clear pending and write the aborted receipt atomically only after exact restoration and cleanup. */
    async finishTargetAbort(
        lease: TargetOperationLease,
        expected: TargetOperationExpectedState,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        this.readTargetOperationRecovery(lease, root, expected);
        return this.write(
            root,
            expected.revision,
            async (state) => {
                const pending = requireTargetOperation(state, expected);
                const chain = await this.durable
                    .get(root)!
                    .loadTargetOperationEvidenceChain(pending.evidenceHash);
                const evidence = chain.evidence;
                const before = this.targetOperationBefore(pending, chain.root);
                if (
                    !before ||
                    pending.phase !== "abortNativeCleared" ||
                    evidence.checkpoint !== "abortNativeCleared" ||
                    pending.completion ||
                    evidence.head !== before.head ||
                    evidence.native.some((entry) => entry.present) ||
                    !isDeepStrictEqual(evidence.index, before.index) ||
                    evidence.abortPaths?.some(
                        (entry) =>
                            entry.install.state !== "installed" ||
                            !isDeepStrictEqual(
                                entry.install.observed,
                                evidence.paths.find((saved) => saved.path === entry.path)?.state,
                            ),
                    )
                )
                    throw new Error("Native abort is not durably complete.");
                this.removeUnchangedTargetDestination(state, pending);
                state.targetOperationReceipts ??= {};
                state.targetOperationReceipts[pending.id] = {
                    version: 1,
                    id: pending.id,
                    requestHash: pending.requestHash,
                    outcome: "aborted",
                    ...retainedReceiptEvidence(pending),
                };
                delete state.pendingTargetOperation;
            },
            true,
            undefined,
            lease,
        );
    }

    /** Cleanup is limited to an unchanged, inactive, unused list created by this operation. */
    private removeUnchangedTargetDestination(
        state: ChangelistState,
        pending: TargetOperationRecord,
    ): void {
        const id = pending.destinationId;
        if (
            !pending.createdDestination ||
            !pending.destinationCreation ||
            state.activeId === id ||
            !isDeepStrictEqual(
                state.lists.find((list) => list.id === id),
                { id, ...pending.destinationCreation },
            ) ||
            Object.values(state.files).includes(id) ||
            Object.values(state.changes).some(
                (change) =>
                    Object.values(change.lines).includes(id) ||
                    Object.hasOwn(change.selections ?? {}, id) ||
                    change.history?.some((history) => Object.values(history.lines).includes(id)),
            )
        )
            return;
        state.lists = state.lists.filter((list) => list.id !== id);
    }

    /** A before reference is authoritative only when it is the root of this retained operation chain. */
    private targetOperationBefore(
        pending: TargetOperationRecord,
        validated: TargetOperationEvidenceChain["root"],
    ): TargetOperationEvidence | undefined {
        const { hash, evidence: current } = validated;
        if (hash !== pending.beforeEvidenceHash) return undefined;
        assertPreparedEvidence(pending, current);
        return current;
    }

    /** Preserve intent and evidence when an uncertain mutation requires explicit review. */
    async markTargetOperationReview(
        lease: TargetOperationLease,
        expected: TargetOperationExpectedState,
    ): Promise<ChangelistState> {
        const root = this.targetOperationRoot(lease);
        const captured = structuredClone(expected);
        return this.write(
            root,
            captured.revision,
            (state) => {
                const pending = requireTargetOperation(state, captured);
                const next = parseTargetOperationRecord({ ...pending, phase: "reviewRequired" });
                if (!next) throw new Error("This operation phase requires completion review.");
                state.pendingTargetOperation = next;
            },
            true,
            undefined,
            lease,
        );
    }

    /** Returns authoritative cloned metadata only for this store's live lease and exact root. */
    inspectTargetOperationLease(root: string, lease: TargetOperationLease): ChangelistState {
        if (this.targetOperationRoot(lease) !== root)
            throw new Error("The metadata lease belongs to another repository.");
        return this.get(root);
    }

    /** Hydrates only captured paths under a live metadata lease, rejecting concurrent revision changes. */
    async readTargetOperationOwnership(
        root: string,
        lease: TargetOperationLease,
        paths: readonly string[],
    ): Promise<Readonly<Record<string, HydratedChangeOwnership | undefined>>> {
        const state = this.inspectTargetOperationLease(root, lease);
        const entries = await Promise.all(
            paths.map(async (file) => {
                const safe = assertRepoRelativePath(file);
                return [safe, await this.hydrate(root, safe, state.changes[safe])] as const;
            }),
        );
        if (this.inspectTargetOperationLease(root, lease).revision !== state.revision)
            throw new ChangelistRevisionError();
        return structuredClone(Object.fromEntries(entries));
    }

    /** An opaque handle authorizes only its owning store/root while still open. */
    private targetOperationRoot(lease: TargetOperationLease): string {
        for (const [root, active] of this.targetLeases)
            if (active.handle === lease && !active.closing) return root;
        throw new Error("The target operation metadata lease is invalid or released.");
    }

    /** Only a validated operation handle or the existing commit lease can avoid reacquiring metadata. */
    private async acquireWriteLease(
        root: string,
        persistence: ChangelistPersistence | undefined,
        targetLease: TargetOperationLease | undefined,
    ): Promise<(() => Promise<void>) | undefined> {
        const active = this.targetLeases.get(root);
        if (targetLease ? active?.handle !== targetLease : active !== undefined)
            throw new TargetOperationLeaseHeldError();
        if (this.commitLeases.has(root) || targetLease) return undefined;
        return persistence?.acquire();
    }

    /** Assigns new files and prunes consumed records, retaining clean history for stash/undo restoration. */
    async reconcileFiles(
        root: string,
        paths: readonly string[],
        epoch?: number,
    ): Promise<ChangelistState> {
        this.admitObserver(root, epoch);
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        const safe = [...new Set(paths.map(assertRepoRelativePath))];
        if (safe.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(
            root,
            undefined,
            (state) => {
                const current = new Set(safe);
                for (const file of Object.keys(state.files)) {
                    const change = state.changes[file];
                    const consumed =
                        change &&
                        ownsNoLiveChange(change) &&
                        Object.keys(change.selections ?? {}).length === 0;
                    if (!current.has(file) && (!change || consumed)) {
                        delete state.files[file];
                        delete state.changes[file];
                    }
                }
                for (const file of safe) {
                    if (!Object.hasOwn(state.files, file)) state.files[file] = state.activeId;
                }
            },
            false,
        );
    }

    /** Creates a named list under revision compare-and-swap. */
    create(
        root: string,
        revision: number,
        name: string,
        description = "",
        makeActive = false,
        movePaths: readonly string[] = [],
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            if (state.lists.length >= MAX_LISTS) throw new Error("Too many changelists.");
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (list) => list.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            ) {
                throw new Error("A changelist with this name already exists.");
            }
            const id = randomUUID();
            state.lists.push({
                id,
                name: accepted,
                description: descriptionFor(description),
                draft: "",
            });
            moveWholeFiles(state, id, movePaths);
            if (makeActive) state.activeId = id;
        });
    }

    /** Renames any list without changing its stable identity or saved intent. */
    rename(root: string, revision: number, id: string, name: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const list = requireList(state, id);
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (item) =>
                        item.id !== id &&
                        item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            ) {
                throw new Error("A changelist with this name already exists.");
            }
            list.name = accepted;
        });
    }

    /** Changes where subsequently discovered files are assigned, not Git's index. */
    activate(root: string, revision: number, id: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            state.activeId = id;
        });
    }

    /** Moves only whole files atomically, preserving every saved inclusion and partial owner. */
    moveFiles(
        root: string,
        revision: number,
        id: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            moveWholeFiles(state, id, paths);
        });
    }

    /** Edits description and name atomically; cancellation belongs to the host before this call. */
    edit(
        root: string,
        revision: number,
        id: string,
        name: string,
        description: string,
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const list = requireList(state, id);
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (item) =>
                        item.id !== id &&
                        item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            )
                throw new Error("A changelist with this name already exists.");
            list.name = accepted;
            list.description = descriptionFor(description);
        });
    }

    /** Reads one exact scope; a removed ID never falls back to All or the active list. */
    draft(root: string, scope: string): string {
        const state = this.get(root);
        return scope === "all" ? (state.allDraft ?? "") : (requireList(state, scope).draft ?? "");
    }

    /** The last focused composer owns the native SCM mirror; selection never activates a list. */
    selectDraft(root: string, scope: string): void {
        this.draft(root, scope);
        this.mirrorScopes.set(root, scope);
    }

    /** Removed mirror scopes follow their destination; delayed writes still carry the original ID. */
    mirrorScope(root: string): string {
        const scope = this.mirrorScopes.get(root) ?? "all";
        return scope === "all" || this.get(root).lists.some((list) => list.id === scope)
            ? scope
            : (this.get(root).removedScopes?.[scope] ?? "all");
    }

    /** Clears only the exact successfully committed draft while the host owns the commit lease. */
    clearCommittedDraft(root: string, scope: string, expected: string): Promise<ChangelistState> {
        return this.write(
            root,
            undefined,
            (state) => {
                const list = scope === "all" ? undefined : requireList(state, scope);
                if (list) {
                    if ((list.draft ?? "").trim() === expected.trim()) list.draft = "";
                } else if ((state.allDraft ?? "").trim() === expected.trim()) state.allDraft = "";
            },
            false,
        );
    }

    /** Compare-and-swap protects later drafts; a pending operation permits guarded edits only after ownership publication. */
    saveDraft(
        root: string,
        scope: string,
        expected: string | undefined,
        text: string,
    ): Promise<ChangelistState> {
        if (text.length > MAX_DRAFT)
            return Promise.reject(new Error("The commit draft is too long."));
        return this.write(
            root,
            undefined,
            (state) => {
                const list = scope === "all" ? undefined : requireList(state, scope);
                const previous = list ? (list.draft ?? "") : (state.allDraft ?? "");
                if (expected !== undefined && previous !== expected)
                    throw new Error(
                        "The commit draft changed. Review the latest text before retrying.",
                    );
                if (list) list.draft = text;
                else state.allDraft = text;
            },
            true,
            expected !== undefined ? "draft" : undefined,
        );
    }

    /** Removes metadata only, remapping every owner and fencing ambiguous inclusion atomically. */
    remove(
        root: string,
        revision: number,
        id: string,
        targetId?: string,
        draftChoice?: "source" | "target" | "append",
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const source = requireList(state, id);
            const survivors = state.lists.filter((list) => list.id !== id);
            if (targetId === id) throw new Error("Choose a surviving destination changelist.");
            let target = targetId
                ? survivors.find((list) => list.id === targetId)
                : (survivors.find((list) => list.id === state.activeId) ?? survivors[0]);
            if (targetId && !target)
                throw new Error("The destination changelist no longer exists.");
            if (!target) {
                // Never reuse the removed ID: stale panes must fail, including after deleting the last list.
                target = { id: randomUUID(), name: "Changes", description: "", draft: "" };
                survivors.push(target);
            }
            const incoming = source.draft ?? "";
            const existing = target.draft ?? "";
            if (incoming && existing && !draftChoice)
                throw new Error(
                    "Choose which commit draft to keep or append before removing the list.",
                );
            if (!existing || draftChoice === "source") target.draft = incoming;
            else if (draftChoice === "append" && incoming)
                target.draft = `${existing}\n\n${incoming}`;
            if ((target.draft?.length ?? 0) > MAX_DRAFT)
                throw new Error("The combined commit draft is too long.");
            for (const [file, ownership] of Object.entries(state.changes)) {
                mergeScopeSelection(ownership, state.files[file], id, target.id);
                remapOwners(ownership, id, target.id);
            }
            for (const file of Object.keys(state.files)) {
                if (state.files[file] === id) state.files[file] = target.id;
            }
            redirectRemovedScope(state, id, target.id);
            state.lists = survivors;
            if (state.activeId === id) state.activeId = target.id;
        });
    }

    /** Pins line ownership to a content identity and marks changed assignments for review. */
    registerChanges(
        root: string,
        file: string,
        contentId: string,
        totalChanges?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(
            root,
            undefined,
            (state) => {
                if (!Object.hasOwn(state.files, safe)) state.files[safe] = state.activeId;
                const previous = state.changes[safe];
                if (!previous) state.changes[safe] = { contentId, lines: {}, totalChanges };
                else if (previous.contentId !== contentId) {
                    state.changes[safe] = {
                        ...previous,
                        contentId,
                        stale: Object.keys(previous.lines).length > 0,
                        totalChanges,
                    };
                }
            },
            false,
        );
    }

    /** Explicitly reviewed line assignments replace the current snapshot's metadata only. */
    assignChanges(
        root: string,
        revision: number,
        file: string,
        contentId: string,
        id: string,
        fingerprints: readonly string[],
        validFingerprints: ReadonlySet<string>,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(root, revision, (state) => {
            requireList(state, id);
            const ownership = state.changes[safe];
            if (!ownership || ownership.contentId !== contentId)
                throw new Error("The change snapshot is stale.");
            if (ownership.stale && new Set(fingerprints).size !== validFingerprints.size) {
                throw new Error(
                    "Review all current changes before replacing outdated assignments.",
                );
            }
            const lines = ownership.stale ? {} : { ...ownership.lines };
            for (const fingerprint of fingerprints) {
                if (!validFingerprints.has(fingerprint))
                    throw new Error("Unknown change assignment.");
                lines[fingerprint] = id;
            }
            state.changes[safe] = { ...ownership, contentId, lines, stale: false };
        });
    }

    /** Records explicit commit inclusion separately from list membership or the Git index. */
    recordSelection(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        lineIds: readonly string[],
        total: number,
    ): Promise<ChangelistState> {
        return this.writeSelection(root, file, contentId, scope, lineIds, total);
    }

    /** Persists staging inclusion under the same root lease used by explicit commits. */
    prepareStageInclusion(
        root: string,
        revision: number,
        scope: string,
        file: CommitInclusion,
    ): Promise<ChangelistState> {
        return this.writeSelection(
            root,
            file.path,
            file.contentId,
            scope,
            file.lineIds,
            file.total,
            revision,
        );
    }

    private writeSelection(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        lineIds: readonly string[],
        total: number,
        leaseRevision?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        if (lineIds.length > 100_000 || !Number.isSafeInteger(total) || total < lineIds.length) {
            throw new Error("Invalid partial commit selection.");
        }
        return this.write(
            root,
            leaseRevision,
            (state) => {
                if (leaseRevision !== undefined && !this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                if (scope !== "all") requireList(state, scope);
                const previous = state.changes[safe] ?? { contentId, lines: {} };
                state.changes[safe] = {
                    ...previous,
                    selections: {
                        ...previous.selections,
                        [scope]: { contentId, lineIds: [...lineIds], total },
                    },
                };
            },
            leaseRevision === undefined,
        );
    }

    /** The explicit whole-file action removes only the current view's partial inclusion. */
    resetSelection(
        root: string,
        revision: number,
        scope: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(root, revision, (state) => {
            if (scope !== "all") requireList(state, scope);
            for (const file of paths.map(assertRepoRelativePath)) {
                const selections = state.changes[file]?.selections;
                if (selections) delete selections[scope];
            }
        });
    }

    /** Persists exclusion fences before Git can publish, including the whole-file All view. */
    prepareCommitInclusion(
        root: string,
        revision: number,
        scope: string,
        files: readonly CommitInclusion[],
    ): Promise<ChangelistState> {
        if (!files.length || files.length > 64) throw new Error("Invalid selected commit files.");
        return this.write(
            root,
            revision,
            (state) => {
                if (!this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                if (scope !== "all") requireList(state, scope);
                for (const file of files) {
                    const safe = assertRepoRelativePath(file.path);
                    if (
                        !Number.isSafeInteger(file.total) ||
                        file.total > 100_000 ||
                        file.lineIds.length === 0 ||
                        file.lineIds.length > file.total ||
                        new Set(file.lineIds).size !== file.lineIds.length
                    ) {
                        throw new Error("Invalid selected commit inclusion.");
                    }
                    const previous = state.changes[safe] ?? {
                        contentId: file.contentId,
                        lines: {},
                    };
                    const inclusion = {
                        contentId: file.contentId,
                        lineIds: [...file.lineIds],
                        total: file.total,
                    };
                    state.changes[safe] = {
                        ...previous,
                        selections: { ...previous.selections, all: inclusion, [scope]: inclusion },
                    };
                }
            },
            false,
        );
    }

    /** Rolls back only this attempt's scope fields, retaining unrelated observations and choices. */
    restoreCommitInclusion(
        root: string,
        previous: ChangelistState,
        attempted: ChangelistState,
        scope: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        return this.write(
            root,
            undefined,
            (state) => {
                if (!this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                for (const file of paths.map(assertRepoRelativePath)) {
                    const current = state.changes[file];
                    if (!current?.selections) continue;
                    for (const key of new Set(["all", scope])) {
                        if (
                            JSON.stringify(current.selections[key]) !==
                            JSON.stringify(attempted.changes[file]?.selections?.[key])
                        )
                            continue;
                        const before = previous.changes[file]?.selections?.[key];
                        if (before === undefined) delete current.selections[key];
                        else current.selections[key] = structuredClone(before);
                    }
                    if (Object.keys(current.selections).length === 0) delete current.selections;
                    if (
                        !previous.changes[file] &&
                        !current.selections &&
                        current.contentId === attempted.changes[file]?.contentId &&
                        Object.keys(current.lines).length === 0 &&
                        current.totalChanges === undefined &&
                        current.stale === undefined
                    )
                        delete state.changes[file];
                }
            },
            false,
        );
    }

    /** Serializes lease-protected writes; pending target operations fence every observer and mutation except guarded post-ownership drafts. */
    private async write(
        root: string,
        revision: number | undefined,
        // A mutation that knows whether it changed anything returns it; the rest are compared whole.
        mutate: (state: ChangelistState) => void | boolean | Promise<void | boolean>,
        userMutation = true,
        pendingWrite?: "draft",
        targetLease?: TargetOperationLease,
    ): Promise<ChangelistState> {
        const operation = this.writes
            .catch(() => undefined)
            .then(async () => {
                if (userMutation && this.commitLeases.has(root)) {
                    throw new Error("Changelists cannot change during a selected commit.");
                }
                const persistence = this.durable.get(root);
                if (this.requiresConnection && !persistence)
                    throw new Error(
                        "Changelist metadata requires a connected worktree before writing.",
                    );
                const release = await this.acquireWriteLease(root, persistence, targetLease);
                try {
                    const before = this.get(root);
                    if (revision !== undefined && revision !== before.revision) {
                        throw new ChangelistRevisionError();
                    }
                    if (!targetLease) assertTargetOperationWriteAllowed(before, pendingWrite);
                    const next = structuredClone(before);
                    next.files = Object.assign(Object.create(null), next.files) as Record<
                        string,
                        string
                    >;
                    next.changes = Object.assign(Object.create(null), next.changes) as Record<
                        string,
                        ChangeOwnership
                    >;
                    const changed = await mutate(next);
                    if (
                        (changed === false ||
                            (changed === undefined &&
                                JSON.stringify(before) === JSON.stringify(next))) &&
                        this.migrationSource === undefined &&
                        this.roots.has(root)
                    )
                        return before;
                    next.revision++;
                    if (persistence) {
                        await persistence.write(next);
                        await persistence.collect(before, next);
                        this.roots.set(root, next);
                        this.notify(root, next);
                        return structuredClone(next);
                    }
                    if (this.storage) {
                        const entries = [];
                        for (const [key, value] of this.roots) {
                            if (key !== root)
                                entries.push({
                                    root: key,
                                    state: await this.hydrateState(key, value),
                                });
                        }
                        const seed = await this.hydrateState(root, next);
                        entries.push({ root, state: seed });
                        if (entries.length > 128)
                            throw new Error("Too many changelist repositories.");
                        if (Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024)
                            throw new Error("Changelist metadata exceeds its storage budget.");
                        if (this.migrationSource !== undefined) await this.backupMigration();
                        await this.storage.update(STORAGE_KEY, { schemaVersion: 2, entries });
                        this.seeds.set(root, seed);
                    }
                    this.migrationSource = undefined;
                    this.roots.set(root, next);
                    const live = new Set(
                        Object.values(next.changes).flatMap((ownership) => [
                            ...(ownership.tracking ? [ownership.tracking.blob] : []),
                            ...(ownership.history ?? []).map((entry) => entry.snapshot.blob),
                        ]),
                    );
                    for (const blob of this.evidence.get(root)?.keys() ?? [])
                        if (!live.has(blob)) this.evidence.get(root)!.delete(blob);
                    this.notify(root, next);
                    return structuredClone(next);
                } finally {
                    await release?.();
                }
            });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** A pre-existing backup must describe this migration; never replace unrelated recovery evidence. */
    private async backupMigration(): Promise<void> {
        const backup = this.storage?.get(BACKUP_KEY);
        if (backup !== undefined && JSON.stringify(backup) !== JSON.stringify(this.migrationSource))
            throw new Error("A different changelist migration backup requires review.");
        if (backup === undefined) await this.storage?.update(BACKUP_KEY, this.migrationSource);
    }

    /** Consumes known completed identities; an optional live lease permits selected removal reconciliation, never a pending target operation. */
    consumeCommitted(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        committed: ReadonlySet<string>,
        available: ReadonlySet<string>,
        total: number,
        snapshot?: RangeSnapshot,
        lease?: TargetOperationLease,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        if (lease) this.inspectTargetOperationLease(root, lease);
        return this.write(
            root,
            undefined,
            async (state) => {
                if (lease && state.pendingTargetOperation)
                    throw new Error("A pending target operation prevents selected consumption.");
                const previous = snapshot
                    ? await this.compact(
                          root,
                          safe,
                          reconcileRanges(
                              await this.hydrate(root, safe, state.changes[safe]),
                              snapshot,
                              state.files[safe] ?? state.activeId,
                              state.activeId,
                          ),
                      )
                    : (state.changes[safe] ?? { contentId, lines: {} });
                const lines = Object.fromEntries(
                    Object.entries(previous.lines).filter(([id]) => snapshot || !committed.has(id)),
                );
                state.changes[safe] = {
                    ...previous,
                    contentId,
                    lines,
                    stale:
                        (snapshot && previous.stale) ||
                        Object.keys(lines).some((id) => !available.has(id)),
                    totalChanges: total,
                    selections: {
                        ...previous.selections,
                        all: { contentId, lineIds: [], total },
                        [scope]: { contentId, lineIds: [], total },
                    },
                };
            },
            false,
            undefined,
            lease,
        );
    }

    /** Keeps detached evidence private and independently owned until a canonical worktree is connected. */
    private remember(root: string, file: string, snapshot: RangeSnapshot): RangeSnapshotReference {
        if (!validSnapshot(snapshot)) throw new ChangelistEvidenceError();
        const blob = changeFingerprint(JSON.stringify([root, file, snapshot]));
        let snapshots = this.evidence.get(root);
        if (!snapshots) this.evidence.set(root, (snapshots = new Map<string, RangeSnapshot>()));
        if (!snapshots.has(blob)) snapshots.set(blob, structuredClone(snapshot));
        return snapshotReference(snapshot, blob);
    }

    /** Constructor conversion is synchronous; only validated legacy snapshots reach this path. */
    private compactMemoryState(root: string, state: HydratedChangelistState): ChangelistState {
        return {
            ...state,
            changes: Object.fromEntries(
                Object.entries(state.changes).map(([file, ownership]) => {
                    const { tracking, history, ...metadata } = ownership;
                    return [
                        file,
                        {
                            ...metadata,
                            ...(tracking ? { tracking: this.remember(root, file, tracking) } : {}),
                            ...(history
                                ? {
                                      history: history.map((entry) => ({
                                          snapshot: this.remember(root, file, entry.snapshot),
                                          lines: entry.lines,
                                      })),
                                  }
                                : {}),
                        },
                    ];
                }),
            ),
        };
    }

    /** Hydrates just one file and each distinct snapshot once while the caller holds its metadata lease. */
    private async hydrate(
        root: string,
        file: string,
        ownership: ChangeOwnership | undefined,
        persistence = this.durable.get(root),
    ): Promise<HydratedChangeOwnership | undefined> {
        if (!ownership) return undefined;
        const cache = new Map<string, Promise<RangeSnapshot>>();
        const load = async (reference: RangeSnapshotReference): Promise<RangeSnapshot> => {
            let pending = cache.get(reference.blob);
            if (!pending) {
                pending = (async () => {
                    const snapshot = persistence
                        ? await persistence.loadSnapshot(file, reference)
                        : this.evidence.get(root)?.get(reference.blob);
                    if (!snapshot) throw new ChangelistEvidenceError();
                    const value = persistence ? snapshot : structuredClone(snapshot);
                    if (persistence) this.hydratedReferences.set(value, reference);
                    return value;
                })();
                cache.set(reference.blob, pending);
            }
            const value = await pending;
            const expected = snapshotReference(value, reference.blob);
            if (
                Object.keys(expected).some(
                    (key) =>
                        expected[key as keyof RangeSnapshotReference] !==
                        reference[key as keyof RangeSnapshotReference],
                )
            )
                throw new ChangelistEvidenceError();
            return value;
        };
        const { tracking, history, ...metadata } = ownership;
        return {
            ...metadata,
            ...(tracking ? { tracking: await load(tracking) } : {}),
            ...(history
                ? {
                      history: await Promise.all(
                          history.map(async (entry) => ({
                              snapshot: await load(entry.snapshot),
                              lines: entry.lines,
                          })),
                      ),
                  }
                : {}),
        };
    }

    /** Replaces complete immutable snapshots with descriptors before any global clone or publication. */
    private async compact(
        root: string,
        file: string,
        ownership: HydratedChangeOwnership,
        persistence = this.durable.get(root),
    ): Promise<ChangeOwnership> {
        const { tracking, history, ...metadata } = ownership;
        const save = (snapshot: RangeSnapshot) => {
            const known = this.hydratedReferences.get(snapshot);
            return (
                known ??
                (persistence
                    ? persistence.storeSnapshot(file, snapshot)
                    : this.remember(root, file, snapshot))
            );
        };
        return {
            ...metadata,
            ...(tracking ? { tracking: await save(tracking) } : {}),
            ...(history
                ? {
                      history: await mapDrained(history, history.length, async (entry) => ({
                          snapshot: await save(entry.snapshot),
                          lines: entry.lines,
                      })),
                  }
                : {}),
        };
    }

    /** Compares an unproved migration seed one file at a time without retaining all durable payloads. */
    private async matchesSeed(
        root: string,
        state: ChangelistState,
        seed: HydratedChangelistState,
        persistence: ChangelistPersistence,
    ): Promise<boolean> {
        const { changes, ...metadata } = state;
        const { changes: original, ...legacy } = seed;
        if (
            !isDeepStrictEqual(
                { ...metadata, files: { ...metadata.files } },
                { ...legacy, files: { ...legacy.files } },
            ) ||
            Object.keys(changes).length !== Object.keys(original).length
        )
            return false;
        for (const [file, ownership] of Object.entries(changes)) {
            if (
                !Object.hasOwn(original, file) ||
                !isDeepStrictEqual(
                    await this.hydrate(root, file, ownership, persistence),
                    original[file],
                )
            )
                return false;
        }
        return true;
    }

    /** Whole-state hydration is restricted to connection and legacy workspace serialization. */
    private async hydrateState(
        root: string,
        state: ChangelistState,
        persistence = this.durable.get(root),
    ): Promise<HydratedChangelistState> {
        const changes = Object.create(null) as Record<string, HydratedChangeOwnership>;
        for (const [file, ownership] of Object.entries(state.changes))
            changes[file] = (await this.hydrate(root, file, ownership, persistence))!;
        return { ...state, changes };
    }

    /** Migration converts each file once without changing logical revisions, history order or owners. */
    private async compactState(
        root: string,
        state: HydratedChangelistState,
        persistence: ChangelistPersistence,
    ): Promise<ChangelistState> {
        const entries = Object.entries(state.changes);
        const compacted = await persistence.storeSnapshotBatch(() =>
            mapDrained(entries, MIGRATION_CONCURRENCY, ([file, ownership]) =>
                this.compact(root, file, ownership, persistence),
            ),
        );
        const changes = Object.create(null) as Record<string, ChangeOwnership>;
        entries.forEach(([file], index) => {
            changes[file] = compacted[index];
        });
        return { ...state, changes };
    }

    private notify(root: string, state: ChangelistState): void {
        for (const listener of this.listeners) {
            try {
                listener(root, structuredClone(state));
            } catch (error) {
                console.error("[IntelliGit] Changelist delivery failed:", error);
            }
        }
    }
}

function requireList(state: ChangelistState, id: string) {
    const list = state.lists.find((entry) => entry.id === id);
    if (!list) throw new Error("The changelist no longer exists.");
    return list;
}

/** Removed IDs cannot survive in current ownership or bounded undo/redo evidence. */
function remapOwners(ownership: ChangeOwnership, from: string, to: string): void {
    for (const lines of [
        ownership.lines,
        ...(ownership.history ?? []).map((entry) => entry.lines),
    ]) {
        for (const fingerprint of Object.keys(lines)) {
            if (lines[fingerprint] === from) lines[fingerprint] = to;
        }
    }
}

/** Validates persisted ownership and scope identities before cloning them; v1 gains empty draft fields without changing inclusion or IDs. */
function parseState(
    value: unknown,
    version: 1 | 2,
    inline: true,
): HydratedChangelistState | undefined;
function parseState(value: unknown, version: 1 | 2, inline: false): ChangelistState | undefined;
function parseState(
    value: unknown,
    version: 1 | 2,
    inline: boolean,
): ChangelistState | HydratedChangelistState | undefined {
    if (!metadataRecord(value)) return undefined;
    const state = value as ChangelistState | HydratedChangelistState;
    if (!validStateHeader(state)) return undefined;
    try {
        const ids = new Set<string>();
        for (const list of state.lists) {
            if (
                typeof list.id !== "string" ||
                typeof list.name !== "string" ||
                (list.id !== DEFAULT_CHANGELIST_ID && !/^[a-f0-9-]{36}$/.test(list.id))
            )
                return undefined;
            nameFor(list.name);
            if (!validListText(list.description, list.draft, version)) return undefined;
            if (ids.has(list.id)) return undefined;
            ids.add(list.id);
        }
        if (!ids.has(state.activeId)) return undefined;
        if (version === 1 && !ids.has(DEFAULT_CHANGELIST_ID)) return undefined;
        if (
            version === 2 &&
            (typeof state.allDraft !== "string" || state.allDraft.length > MAX_DRAFT)
        )
            return undefined;
        if (!validRedirects(state.removedScopes, ids)) return undefined;
        if (Object.keys(state.files).length > MAX_FILES) return undefined;
        for (const [file, id] of Object.entries(state.files)) {
            assertRepoRelativePath(file);
            if (!ids.has(id)) return undefined;
        }
        const changes: Record<string, ChangeOwnership | HydratedChangeOwnership> = state.changes;
        for (const [file, ownership] of Object.entries(changes)) {
            assertRepoRelativePath(file);
            if (!validOwnership(ownership, ids, inline)) return undefined;
        }
        const parsed = structuredClone(state);
        if (version === 1) {
            parsed.lists = parsed.lists.map((list) => ({ ...list, description: "", draft: "" }));
            parsed.allDraft = "";
        }
        return parsed;
    } catch {
        return undefined;
    }
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Rejects unbounded lists, invalid revisions, and non-record ownership maps before reading nested persisted values. */
function validStateHeader(state: ChangelistState | HydratedChangelistState): boolean {
    return (
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        Array.isArray(state.lists) &&
        state.lists.length > 0 &&
        state.lists.length <= MAX_LISTS &&
        metadataRecord(state.files) !== undefined &&
        metadataRecord(state.changes) !== undefined &&
        validTargetOperationMetadata(state)
    );
}

/** Rejects malformed persisted ownership, unknown list references, and invalid inclusion or range metadata. */
function validOwnership(
    ownership: ChangeOwnership | HydratedChangeOwnership,
    ids: ReadonlySet<string>,
    inline: boolean,
): boolean {
    if (
        !metadataRecord(ownership) ||
        typeof ownership.contentId !== "string" ||
        !metadataRecord(ownership.lines) ||
        (ownership.stale !== undefined && typeof ownership.stale !== "boolean")
    )
        return false;
    if (
        ownership.totalChanges !== undefined &&
        (!Number.isSafeInteger(ownership.totalChanges) ||
            ownership.totalChanges < 0 ||
            ownership.totalChanges > 100_000)
    )
        return false;
    for (const [fingerprint, id] of Object.entries(ownership.lines)) {
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !ids.has(id)) return false;
    }
    return validCommitSelections(ownership, ids) && validRangeMetadata(ownership, ids, inline);
}

/** Accepts bounded, exact-scope inclusion records, including explicit empty selections and stale-review fences. */
function validCommitSelections(
    ownership: ChangeOwnership | HydratedChangeOwnership,
    ids: ReadonlySet<string>,
): boolean {
    if (ownership.selections === undefined) return true;
    if (!metadataRecord(ownership.selections)) return false;
    for (const [scope, selection] of Object.entries(ownership.selections)) {
        if (scope !== "all" && !ids.has(scope)) return false;
        if (
            !metadataRecord(selection) ||
            typeof selection.contentId !== "string" ||
            (selection.reviewRequired !== undefined &&
                typeof selection.reviewRequired !== "boolean") ||
            !Array.isArray(selection.lineIds) ||
            selection.lineIds.length > 100_000 ||
            selection.lineIds.some(
                (id) => typeof id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(id),
            ) ||
            !Number.isSafeInteger(selection.total) ||
            selection.total < selection.lineIds.length ||
            selection.total > 100_000
        )
            return false;
    }
    return true;
}

/** Descriptions are bounded plain text and may contain line breaks. */
function descriptionFor(value: string): string {
    if (value.length > MAX_DESCRIPTION || value.includes("\0"))
        throw new Error("A changelist description must contain at most 4000 characters.");
    return value;
}

/** Preserve exact explicit unions; unknown implicit ranges keep their fence and require review. */
function mergeScopeSelection(
    ownership: ChangeOwnership,
    fallback: string | undefined,
    source: string,
    target: string,
): void {
    const selections = ownership.selections;
    if (!selections) return;
    const incoming = selections[source];
    const existing = selections[target];
    const sourceOwns = fallback === source || Object.values(ownership.lines).includes(source);
    const targetOwns = fallback === target || Object.values(ownership.lines).includes(target);
    if (
        incoming &&
        existing &&
        incoming.contentId === existing.contentId &&
        incoming.total === existing.total &&
        !incoming.reviewRequired &&
        !existing.reviewRequired &&
        incoming.lineIds.length === existing.lineIds.length &&
        incoming.lineIds.every((line) => existing.lineIds.includes(line))
    ) {
        selections[target] = {
            ...existing,
            lineIds: [...new Set([...existing.lineIds, ...incoming.lineIds])],
        };
    } else if (incoming || (sourceOwns && existing)) {
        const preserved = existing ?? incoming;
        selections[target] = {
            ...preserved,
            lineIds: [...preserved.lineIds],
            ...(incoming && !targetOwns && !existing ? {} : { reviewRequired: true }),
        };
    }
    delete selections[source];
}

/** Validate new text fields without inventing content for a corrupt version-2 record. */
function validListText(description: unknown, draft: unknown, version: 1 | 2): boolean {
    if (version === 1) return true;
    if (typeof description !== "string" || typeof draft !== "string" || draft.length > MAX_DRAFT)
        return false;
    descriptionFor(description);
    return true;
}

/** Redirects can only name removed IDs and currently surviving destinations. */
function validRedirects(value: unknown, ids: ReadonlySet<string>): boolean {
    if (value === undefined) return true;
    const entries = metadataRecord(value);
    return (
        !!entries &&
        Object.keys(entries).length <= 100 &&
        Object.entries(entries).every(
            ([from, to]) =>
                (from === DEFAULT_CHANGELIST_ID || /^[a-f0-9-]{36}$/.test(from)) &&
                !ids.has(from) &&
                typeof to === "string" &&
                ids.has(to),
        )
    );
}

/** Host-only operation state is exact, internally consistent and never accepts a public projection. */
function validTargetOperationMetadata(state: ChangelistState | HydratedChangelistState): boolean {
    if (state.targetOperationSummary !== undefined) return false;
    const pending =
        state.pendingTargetOperation === undefined
            ? undefined
            : parseTargetOperationRecord(state.pendingTargetOperation);
    if (state.pendingTargetOperation !== undefined && !pending) return false;
    if (state.targetOperationReceipts === undefined) return true;
    const receipts = metadataRecord(state.targetOperationReceipts);
    if (!receipts) return false;
    for (const [id, value] of Object.entries(receipts)) {
        const receipt = parseTargetOperationReceipt(value);
        if (!receipt || receipt.id !== id || pending?.id === id) return false;
    }
    return true;
}

/** Creation-with-move and existing-list moves share the same atomic safety checks. */
function moveWholeFiles(state: ChangelistState, id: string, paths: readonly string[]): void {
    if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
    for (const value of paths) {
        const file = assertRepoRelativePath(value);
        if (!Object.hasOwn(state.files, file)) throw new Error("The file list changed.");
        const ownership = state.changes[file];
        if (
            ownership &&
            (Object.keys(ownership.lines).length || Object.keys(ownership.selections ?? {}).length)
        )
            throw new Error("Move partial selections through their partial editor.");
        state.files[file] = id;
    }
}

/** Keep recent deleted view scopes pointed at surviving lists, including chained deletions. */
function redirectRemovedScope(state: ChangelistState, removed: string, target: string): void {
    const redirects = Object.fromEntries(
        Object.entries(state.removedScopes ?? {})
            .slice(-99)
            .map(([from, to]) => [from, to === removed ? target : to]),
    );
    redirects[removed] = target;
    state.removedScopes = redirects;
}
