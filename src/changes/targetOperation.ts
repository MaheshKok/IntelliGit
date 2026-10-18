import type { ShelfDraftChoice } from "../webviews/protocol/targetOperation";

const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CHANGE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SHELF_ID = /^[A-Za-z0-9_-]+$/;
const LIST_ID = /^(?:default|[a-f0-9-]{36})$/;

/** Durable checkpoints for one list-targeted operation. */
type TargetOperationPhase =
    | "prepared"
    | "gitApplied"
    | "conflicted"
    | "reviewRequired"
    | "ownershipPublished"
    | "shelfPublished"
    | "abortPrepared"
    | "abortPathsRestored"
    | "abortIndexRestored"
    | "abortNativeCleared";

/** Every checkpoint compares the durable operation identity, phase and metadata revision. */
export interface TargetOperationExpectedState {
    readonly id: string;
    readonly revision: number;
    readonly expectedPhase: TargetOperationPhase;
}

/** After evidence may record partial progress; it never authorizes executing Git again. */
export interface TargetOperationCheckpoint extends TargetOperationExpectedState {
    readonly phase: "prepared" | "gitApplied" | "conflicted";
    readonly evidenceHash: string;
}

/** Metadata published after the operation's successful ownership decision. */
interface TargetOperationCompletion {
    readonly appliedChangeIds: readonly string[];
    readonly ownershipRevision: number;
    readonly draft: "kept" | "copied" | "keptAfterReview";
    readonly shelfPublication: "pending" | "notRequired" | "published";
    readonly publishedGeneration?: number;
    readonly publishedChecksum?: string;
}

/** Validated replay fence retained through every required publication. */
export interface TargetOperationRecord {
    readonly version: 1;
    readonly id: string;
    /** Original request identity never depends on mutable phase or checkpoint evidence. */
    readonly requestHash: string;
    readonly beforeEvidenceHash: string;
    readonly kind: "shelfRestore" | "patchApply" | "undoCommit" | "cherryPick" | "revert";
    readonly phase: TargetOperationPhase;
    readonly destinationId: string;
    readonly createdDestination: boolean;
    readonly destinationCreation?: {
        readonly name: string;
        readonly description: string;
        readonly draft: "";
    };
    readonly headBefore: string;
    readonly headAfter?: string;
    readonly evidenceHash: string;
    readonly shelf?: {
        readonly id: string;
        readonly generation: number;
        readonly checksum: string;
        readonly changeIds: readonly string[];
        readonly removeFromShelf: boolean;
    };
    readonly completion?: TargetOperationCompletion;
    readonly commit?: string;
    readonly draftChoice?: ShelfDraftChoice;
    /** Captured shelf draft, present only for the explicit copy choice. */
    readonly sourceDraft?: string;
}

/** Compact terminal replay refusal retained after pending metadata is cleared. */
export interface TargetOperationReceipt {
    readonly version: 1;
    readonly id: string;
    readonly requestHash: string;
    readonly outcome:
        "notApplied" | "applied" | "appliedNeedsReview" | "conflicted" | "stale" | "aborted";
    readonly evidenceHash: string;
}

/** Browser-safe operation status without recovery evidence or source identifiers. */
export interface TargetOperationSummary {
    readonly id: string;
    readonly kind: TargetOperationRecord["kind"];
    readonly phase: TargetOperationPhase;
    readonly destinationId: string;
}

/** Immutable content object referenced by path recovery evidence. */
export interface TargetOperationBlobReference {
    readonly hash: string;
    readonly size: number;
}

/** One immutable attribution payload may cover only selected entries on its affected path. */
export interface TargetOperationAttributionReference {
    readonly path: string;
    readonly changeIds: readonly string[];
    readonly object: TargetOperationBlobReference;
}

/** Stable lstat identity captured around a guarded filesystem step. */
export interface TargetPathIdentity {
    readonly device: string;
    readonly inode: string;
    readonly size: number;
    readonly modifiedNs: string;
    readonly changedNs: string;
}

/** Exact supported worktree representation; file bytes remain in immutable content objects. */
export type TargetPathState =
    | { readonly kind: "absent" }
    | {
          readonly kind: "regular";
          readonly executable: boolean;
          readonly content: TargetOperationBlobReference;
          readonly identity: TargetPathIdentity;
      }
    | {
          readonly kind: "symlink";
          readonly target: TargetOperationBlobReference;
          readonly identity: TargetPathIdentity;
      };

/** One exact index stage plus the supported flags needed for targeted restoration. */
export interface TargetIndexEntry {
    readonly path: string;
    readonly stage: 0 | 1 | 2 | 3;
    readonly mode: "100644" | "100755" | "120000" | "160000";
    readonly oid: string;
    /** Durable raw Git object bytes keep this saved OID recoverable after repository GC. */
    readonly object: TargetOperationBlobReference;
    readonly assumeUnchanged: boolean;
    readonly skipWorktree: boolean;
    readonly intentToAdd: boolean;
}

/** One affected path's reviewed abort move and install progress. */
export interface TargetAbortPathEvidence {
    readonly path: string;
    /** Host-created path beneath this operation's private worktree recovery namespace. */
    readonly recoveryPath: string;
    readonly expectedCurrent: TargetPathState;
    readonly desiredBefore: TargetPathState;
    readonly move:
        | { readonly state: "planned" }
        | { readonly state: "moved"; readonly observed: TargetPathState };
    readonly install:
        | { readonly state: "pending" }
        | { readonly state: "installed"; readonly observed: TargetPathState };
}

/** Exact owner identity retained before a future recovery may inspect an index lock. */
interface TargetIndexLockEvidence {
    readonly identity: TargetPathIdentity;
    readonly operationId: string;
    readonly owner: {
        readonly pid: number;
        readonly processStart: string;
    };
}

/** Git-directory-bound candidate and owned lock evidence for targeted index publication. */
export interface TargetIndexPublicationEvidence {
    readonly state: "prepared" | "published";
    readonly liveIndexFingerprint: string;
    readonly candidate: {
        readonly path: string;
        readonly fingerprint: string;
        readonly identity: TargetPathIdentity;
    };
    readonly lock: TargetIndexLockEvidence;
}

/** Fingerprint of one known native control location. */
interface TargetNativeControl {
    readonly name: "cherryPickHead" | "revertHead" | "mergeHead" | "sequencer";
    readonly present: boolean;
    readonly hash?: string;
}

/** Per-entry result checkpointed as a shelf operation progresses. */
interface TargetOperationEntryEvidence {
    readonly changeId: string;
    readonly path?: string;
    readonly outcome: "pending" | "applied" | "conflicted" | "retained" | "refused";
    readonly reason?: string;
}

/** Concrete immutable checkpoint bound to one canonical worktree and repository identity. */
export interface TargetWholeFileBefore {
    readonly path: string;
    /** Captured by the trusted host at this envelope's HEAD; absence is an explicit observation. */
    readonly head:
        | { readonly kind: "absent" }
        | {
              readonly kind: "present";
              readonly mode: TargetIndexEntry["mode"];
              readonly oid: string;
              readonly object: TargetOperationBlobReference;
          };
    /** The store verifies this metadata observation at prepare; it does not imply Git cleanliness. */
    readonly unowned: boolean;
}

/** Explicit successful whole-file attribution; rename endpoints must never be inferred from missing data. */
interface TargetWholeFileAttribution {
    readonly path: string;
    readonly changeIds: readonly string[];
    readonly sourcePath?: string;
}

/** Concrete immutable checkpoint bound to one canonical worktree and repository identity. */
export interface TargetOperationEvidence {
    readonly version: 1;
    readonly operationId: string;
    readonly root: string;
    readonly gitDir: string;
    readonly checkpoint:
        | "before"
        | "after"
        | "abortPrepared"
        | "abortPath"
        | "abortPathsRestored"
        | "abortIndexPrepared"
        | "abortIndexRestored"
        | "abortNativeCleared";
    readonly head: string;
    readonly indexFingerprint: string;
    readonly paths: readonly { readonly path: string; readonly state: TargetPathState }[];
    readonly index: readonly TargetIndexEntry[];
    readonly native: readonly TargetNativeControl[];
    readonly entries: readonly TargetOperationEntryEvidence[];
    readonly attribution?: readonly TargetOperationAttributionReference[];
    readonly wholeFileBefore?: readonly TargetWholeFileBefore[];
    readonly wholeFileAttribution?: readonly TargetWholeFileAttribution[];
    readonly abortPaths?: readonly TargetAbortPathEvidence[];
    readonly indexPublication?: TargetIndexPublicationEvidence;
    readonly previousEvidenceHash?: string;
}

/** Parse a persisted replay fence, rejecting contradictory phase-specific fields. */
export function parseTargetOperationRecord(_input: unknown): TargetOperationRecord | undefined {
    const input = record(_input);
    if (!input || !validRecordHeader(input)) return undefined;
    const shelf = parseShelf(input.shelf);
    if (input.shelf !== undefined && !shelf) return undefined;
    const completion = parseCompletion(input.completion);
    if (input.completion !== undefined && !completion) return undefined;
    if (!validRecordPhase(input, shelf, completion)) return undefined;
    return structuredClone({
        ...input,
        ...(shelf ? { shelf } : {}),
        ...(completion ? { completion } : {}),
    }) as TargetOperationRecord;
}

/** Parse a retained terminal receipt and its immutable evidence reference. */
export function parseTargetOperationReceipt(_input: unknown): TargetOperationReceipt | undefined {
    const input = record(_input);
    if (
        !input ||
        !hasOnly(input, ["version", "id", "requestHash", "outcome", "evidenceHash"]) ||
        input.version !== 1 ||
        typeof input.id !== "string" ||
        !UUID.test(input.id) ||
        typeof input.requestHash !== "string" ||
        !HASH.test(input.requestHash) ||
        !isOneOf(input.outcome, [
            "notApplied",
            "applied",
            "appliedNeedsReview",
            "conflicted",
            "stale",
            "aborted",
        ]) ||
        typeof input.evidenceHash !== "string" ||
        !HASH.test(input.evidenceHash)
    )
        return undefined;
    return structuredClone(input) as unknown as TargetOperationReceipt;
}

/** Parse immutable evidence only when it belongs to the expected canonical worktree. */
export function parseTargetOperationEvidence(
    _input: unknown,
    _root: string,
    _gitDir: string,
): TargetOperationEvidence | undefined {
    const input = record(_input);
    if (!input || !validEvidenceHeader(input, _root, _gitDir)) return undefined;
    try {
        if (
            !validEvidencePaths(input.paths as unknown[]) ||
            !validEvidenceIndex(input.index as unknown[]) ||
            !validNativeControls(input.native as unknown[]) ||
            !validEntryEvidence(input.entries as unknown[]) ||
            !validAttributionReferences(input) ||
            !validWholeFileEvidence(input) ||
            !validAbortEvidence(input)
        )
            return undefined;
        return structuredClone(input) as unknown as TargetOperationEvidence;
    } catch {
        return undefined;
    }
}

/** Return every immutable object reference reachable from one evidence checkpoint. */
export function targetOperationEvidenceReferences(_evidence: TargetOperationEvidence): string[] {
    const references = new Set(
        targetOperationObjectReferences(_evidence).map((entry) => entry.hash),
    );
    if (_evidence.previousEvidenceHash) references.add(_evidence.previousEvidenceHash);
    return [...references];
}

/** Return every declared content object, retaining duplicate hashes so each size is validated. */
export function targetOperationObjectReferences(
    evidence: TargetOperationEvidence,
): TargetOperationBlobReference[] {
    const references: TargetOperationBlobReference[] = [];
    for (const entry of evidence.paths) addPathStateReference(references, entry.state);
    for (const entry of evidence.index) references.push(entry.object);
    for (const entry of evidence.attribution ?? []) references.push(entry.object);
    for (const entry of evidence.wholeFileBefore ?? [])
        if (entry.head.kind === "present") references.push(entry.head.object);
    for (const entry of evidence.abortPaths ?? []) {
        addPathStateReference(references, entry.expectedCurrent);
        addPathStateReference(references, entry.desiredBefore);
        if (entry.move.state === "moved") addPathStateReference(references, entry.move.observed);
        if (entry.install.state === "installed")
            addPathStateReference(references, entry.install.observed);
    }
    return references;
}

function addPathStateReference(
    references: TargetOperationBlobReference[],
    state: TargetPathState,
): void {
    if (state.kind === "regular") references.push(state.content);
    else if (state.kind === "symlink") references.push(state.target);
}

/** Project only the fields needed to route recovery UI. */
export function summarizeTargetOperation(record: TargetOperationRecord): TargetOperationSummary {
    return {
        id: record.id,
        kind: record.kind,
        phase: record.phase,
        destinationId: record.destinationId,
    };
}

function parseShelf(value: unknown): TargetOperationRecord["shelf"] | undefined {
    if (value === undefined) return undefined;
    const shelf = record(value);
    if (
        !shelf ||
        !hasOnly(shelf, ["id", "generation", "checksum", "changeIds", "removeFromShelf"]) ||
        typeof shelf.id !== "string" ||
        !SHELF_ID.test(shelf.id) ||
        !Number.isSafeInteger(shelf.generation) ||
        (shelf.generation as number) < 0 ||
        typeof shelf.checksum !== "string" ||
        !HASH.test(shelf.checksum) ||
        !validChangeIds(shelf.changeIds) ||
        typeof shelf.removeFromShelf !== "boolean"
    )
        return undefined;
    return structuredClone(shelf) as unknown as NonNullable<TargetOperationRecord["shelf"]>;
}

function validRecordHeader(input: Record<string, unknown>): boolean {
    if (
        !hasOnly(input, [
            "version",
            "id",
            "requestHash",
            "beforeEvidenceHash",
            "kind",
            "phase",
            "destinationId",
            "createdDestination",
            "destinationCreation",
            "headBefore",
            "headAfter",
            "evidenceHash",
            "shelf",
            "completion",
            "commit",
            "draftChoice",
            "sourceDraft",
        ]) ||
        input.version !== 1 ||
        typeof input.id !== "string" ||
        !UUID.test(input.id) ||
        !isOneOf(input.kind, [
            "shelfRestore",
            "patchApply",
            "undoCommit",
            "cherryPick",
            "revert",
        ]) ||
        !isPhase(input.phase) ||
        typeof input.destinationId !== "string" ||
        !LIST_ID.test(input.destinationId) ||
        typeof input.createdDestination !== "boolean" ||
        typeof input.headBefore !== "string" ||
        !OID.test(input.headBefore) ||
        typeof input.evidenceHash !== "string" ||
        !HASH.test(input.evidenceHash) ||
        !validDraftChoice(input.draftChoice) ||
        !validCapturedIntent(input)
    )
        return false;
    if (
        input.headAfter !== undefined &&
        (typeof input.headAfter !== "string" || !OID.test(input.headAfter))
    )
        return false;
    if (input.commit !== undefined && (typeof input.commit !== "string" || !OID.test(input.commit)))
        return false;
    const needsCommit = isOneOf(input.kind, ["undoCommit", "cherryPick", "revert"]);
    return needsCommit === (input.commit !== undefined);
}

/** Recovery may copy only captured text and remove only an unchanged operation-created list. */
function validCapturedIntent(input: Record<string, unknown>): boolean {
    if (
        typeof input.requestHash !== "string" ||
        !HASH.test(input.requestHash) ||
        typeof input.beforeEvidenceHash !== "string" ||
        !HASH.test(input.beforeEvidenceHash)
    )
        return false;
    const copiesDraft = record(input.draftChoice)?.kind === "copySource";
    if (copiesDraft !== (input.sourceDraft !== undefined)) return false;
    if (
        copiesDraft &&
        (typeof input.sourceDraft !== "string" || input.sourceDraft.length > 100_000)
    )
        return false;
    if (input.createdDestination !== (input.destinationCreation !== undefined)) return false;
    if (!input.createdDestination) return true;
    const creation = record(input.destinationCreation);
    return (
        !!creation &&
        hasOnly(creation, ["name", "description", "draft"]) &&
        typeof creation.name === "string" &&
        creation.name.length > 0 &&
        creation.name.length <= 80 &&
        creation.name === creation.name.normalize("NFC").trim() &&
        !/[\u0000-\u001f]/.test(creation.name) &&
        typeof creation.description === "string" &&
        creation.description.length <= 4_000 &&
        creation.draft === ""
    );
}

function validRecordPhase(
    input: Record<string, unknown>,
    shelf: TargetOperationRecord["shelf"],
    completion: TargetOperationCompletion | undefined,
): boolean {
    const phase = input.phase as TargetOperationPhase;
    const shelfOperation = input.kind === "shelfRestore";
    if (shelfOperation !== (shelf !== undefined)) return false;
    if (
        shelf &&
        completion &&
        completion.appliedChangeIds.some((id) => !shelf.changeIds.includes(id))
    )
        return false;
    const completed = phase === "ownershipPublished" || phase === "shelfPublished";
    if (phase === "reviewRequired" && completion) {
        return (
            input.headAfter !== undefined &&
            (shelf?.removeFromShelf === true
                ? completion.shelfPublication === "pending" ||
                  completion.shelfPublication === "published"
                : completion.shelfPublication === "notRequired")
        );
    }
    if (completed !== (completion !== undefined) || (isAbortPhase(phase) && completion))
        return false;
    if (!completion) return true;
    if (input.headAfter === undefined) return false;
    if (phase === "ownershipPublished")
        return (
            completion.shelfPublication ===
            (shelf?.removeFromShelf === true ? "pending" : "notRequired")
        );
    return (
        shelf?.removeFromShelf === true &&
        completion.shelfPublication === "published" &&
        completion.publishedGeneration !== undefined &&
        completion.publishedChecksum !== undefined
    );
}

function validEvidenceHeader(
    input: Record<string, unknown>,
    root: string,
    gitDir: string,
): boolean {
    return (
        hasOnly(input, [
            "version",
            "operationId",
            "root",
            "gitDir",
            "checkpoint",
            "head",
            "indexFingerprint",
            "paths",
            "index",
            "native",
            "entries",
            "attribution",
            "wholeFileBefore",
            "wholeFileAttribution",
            "abortPaths",
            "indexPublication",
            "previousEvidenceHash",
        ]) &&
        input.version === 1 &&
        typeof input.operationId === "string" &&
        UUID.test(input.operationId) &&
        input.root === root &&
        input.gitDir === gitDir &&
        isOneOf(input.checkpoint, [
            "before",
            "after",
            "abortPrepared",
            "abortPath",
            "abortPathsRestored",
            "abortIndexPrepared",
            "abortIndexRestored",
            "abortNativeCleared",
        ]) &&
        typeof input.head === "string" &&
        OID.test(input.head) &&
        typeof input.indexFingerprint === "string" &&
        HASH.test(input.indexFingerprint) &&
        (input.previousEvidenceHash === undefined ||
            (typeof input.previousEvidenceHash === "string" &&
                HASH.test(input.previousEvidenceHash))) &&
        Array.isArray(input.paths) &&
        input.paths.length <= 20_000 &&
        Array.isArray(input.index) &&
        input.index.length <= 80_000 &&
        Array.isArray(input.native) &&
        Array.isArray(input.entries) &&
        input.entries.length <= 100_000
    );
}

/** Bound attribution references to the operation's existing path and entry identities. */
function validAttributionReferences(input: Record<string, unknown>): boolean {
    if (input.attribution === undefined) return true;
    if (!Array.isArray(input.attribution) || input.attribution.length > 20_000) return false;
    const paths = new Set((input.paths as { path: string }[]).map((entry) => entry.path));
    const entries = new Map(
        (input.entries as TargetOperationEntryEvidence[]).map((entry) => [
            entry.changeId,
            entry.path,
        ]),
    );
    const used = new Set<string>();
    return input.attribution.every((value) => {
        const entry = record(value);
        if (
            !entry ||
            !hasOnly(entry, ["path", "changeIds", "object"]) ||
            typeof entry.path !== "string" ||
            !paths.delete(entry.path) ||
            !validChangeIds(entry.changeIds) ||
            !entry.changeIds.length ||
            !validBlob(entry.object)
        )
            return false;
        return entry.changeIds.every((id) => {
            if (used.has(id) || entries.get(id) !== entry.path) return false;
            used.add(id);
            return true;
        });
    });
}

/** Structural evidence is explicit, path-bound and disjoint from text attribution in the same checkpoint. */
function validWholeFileBefore(input: Record<string, unknown>, paths: ReadonlySet<string>): boolean {
    if (input.wholeFileBefore !== undefined) {
        if (
            input.checkpoint !== "before" ||
            !Array.isArray(input.wholeFileBefore) ||
            input.wholeFileBefore.length > paths.size
        )
            return false;
        const used = new Set<string>();
        for (const value of input.wholeFileBefore) {
            const entry = record(value);
            const head = record(entry?.head);
            if (
                !entry ||
                !hasOnly(entry, ["path", "head", "unowned"]) ||
                typeof entry.path !== "string" ||
                !paths.has(entry.path) ||
                used.has(entry.path) ||
                typeof entry.unowned !== "boolean" ||
                !head
            )
                return false;
            used.add(entry.path);
            if (head.kind === "absent") {
                if (!hasOnly(head, ["kind"])) return false;
            } else if (
                head.kind !== "present" ||
                !hasOnly(head, ["kind", "mode", "oid", "object"]) ||
                !isOneOf(head.mode, ["100644", "100755", "120000", "160000"]) ||
                typeof head.oid !== "string" ||
                !OID.test(head.oid) ||
                !validBlob(head.object)
            )
                return false;
        }
    }
    return true;
}

/** Successful structural entries cannot overlap text attribution or another rename endpoint. */
function validWholeFileEvidence(input: Record<string, unknown>): boolean {
    const paths = new Set((input.paths as { path: string }[]).map((entry) => entry.path));
    if (!validWholeFileBefore(input, paths)) return false;
    if (input.wholeFileAttribution === undefined) return true;
    if (
        input.checkpoint !== "after" ||
        !Array.isArray(input.wholeFileAttribution) ||
        input.wholeFileAttribution.length > paths.size
    )
        return false;
    const usedPaths = new Set(
        (input.attribution as TargetOperationAttributionReference[] | undefined)?.map(
            (entry) => entry.path,
        ),
    );
    const usedIds = new Set(
        (input.attribution as TargetOperationAttributionReference[] | undefined)?.flatMap(
            (entry) => [...entry.changeIds],
        ),
    );
    const entries = new Map(
        (input.entries as TargetOperationEntryEvidence[]).map((entry) => [
            entry.changeId,
            entry.path,
        ]),
    );
    return input.wholeFileAttribution.every((value) => {
        const entry = record(value);
        if (
            !entry ||
            !hasOnly(entry, ["path", "changeIds", "sourcePath"]) ||
            typeof entry.path !== "string" ||
            !paths.has(entry.path) ||
            usedPaths.has(entry.path) ||
            !validChangeIds(entry.changeIds) ||
            !entry.changeIds.length ||
            (entry.sourcePath !== undefined &&
                (typeof entry.sourcePath !== "string" ||
                    !paths.has(entry.sourcePath) ||
                    entry.sourcePath === entry.path))
        )
            return false;
        usedPaths.add(entry.path);
        if (entry.sourcePath !== undefined) {
            if (usedPaths.has(entry.sourcePath)) return false;
            usedPaths.add(entry.sourcePath);
        }
        return entry.changeIds.every((id) => {
            if (usedIds.has(id) || entries.get(id) !== entry.path) return false;
            usedIds.add(id);
            return true;
        });
    });
}

function validEvidencePaths(value: unknown[]): boolean {
    const paths = new Set<string>();
    for (const item of value) {
        const entry = record(item);
        if (
            !entry ||
            !hasOnly(entry, ["path", "state"]) ||
            typeof entry.path !== "string" ||
            paths.has(entry.path) ||
            !validPathState(entry.state)
        )
            return false;
        assertTargetPath(entry.path);
        paths.add(entry.path);
    }
    return true;
}

function validEvidenceIndex(value: unknown[]): boolean {
    const stages = new Set<string>();
    for (const item of value) {
        const entry = record(item);
        if (!entry || !validIndexEntry(entry)) return false;
        const file = entry.path as string;
        const stage = entry.stage as number;
        assertTargetPath(file);
        const key = `${file}\0${stage}`;
        if (stages.has(key)) return false;
        stages.add(key);
    }
    return true;
}

function validIndexEntry(entry: Record<string, unknown>): boolean {
    return (
        hasOnly(entry, [
            "path",
            "stage",
            "mode",
            "oid",
            "object",
            "assumeUnchanged",
            "skipWorktree",
            "intentToAdd",
        ]) &&
        typeof entry.path === "string" &&
        isOneOf(entry.stage, [0, 1, 2, 3]) &&
        isOneOf(entry.mode, ["100644", "100755", "120000", "160000"]) &&
        typeof entry.oid === "string" &&
        OID.test(entry.oid) &&
        validBlob(entry.object) &&
        typeof entry.assumeUnchanged === "boolean" &&
        typeof entry.skipWorktree === "boolean" &&
        typeof entry.intentToAdd === "boolean"
    );
}

function validAbortEvidence(input: Record<string, unknown>): boolean {
    const checkpoint = input.checkpoint as TargetOperationEvidence["checkpoint"];
    const abort = checkpoint.startsWith("abort");
    if (!abort) return input.abortPaths === undefined && input.indexPublication === undefined;
    if (
        !Array.isArray(input.abortPaths) ||
        input.abortPaths.length !== (input.paths as unknown[]).length
    )
        return false;
    const pathSet = new Set((input.paths as { path: string }[]).map((entry) => entry.path));
    const recoveries = new Set<string>();
    const parsed = input.abortPaths.map((value) =>
        parseAbortPath(value, input.operationId as string),
    );
    for (const entry of parsed) {
        if (!entry || !pathSet.delete(entry.path) || recoveries.has(entry.recoveryPath))
            return false;
        recoveries.add(entry.recoveryPath);
    }
    if (pathSet.size > 0) return false;
    const allInstalled = parsed.every(
        (entry) => entry!.move.state === "moved" && entry!.install.state === "installed",
    );
    const index = parseIndexPublication(input.indexPublication, input.operationId as string);
    if (checkpoint === "abortPrepared")
        return (
            input.indexPublication === undefined &&
            parsed.every(
                (entry) => entry!.move.state === "planned" && entry!.install.state === "pending",
            )
        );
    if (checkpoint === "abortPath") return input.indexPublication === undefined;
    if (checkpoint === "abortPathsRestored")
        return allInstalled && input.indexPublication === undefined;
    if (!allInstalled || !index) return false;
    if (checkpoint === "abortIndexPrepared") return index.state === "prepared";
    return index.state === "published";
}

function parseAbortPath(value: unknown, operationId: string): TargetAbortPathEvidence | undefined {
    const entry = record(value);
    if (
        !entry ||
        !hasOnly(entry, [
            "path",
            "recoveryPath",
            "expectedCurrent",
            "desiredBefore",
            "move",
            "install",
        ]) ||
        typeof entry.path !== "string" ||
        typeof entry.recoveryPath !== "string" ||
        !entry.recoveryPath.startsWith(`.intelligit-recovery/${operationId}/`) ||
        !validPathState(entry.expectedCurrent) ||
        !validPathState(entry.desiredBefore)
    )
        return undefined;
    assertTargetPath(entry.path);
    assertTargetPath(entry.recoveryPath);
    const move = record(entry.move);
    const install = record(entry.install);
    if (!move || !install || !validMove(move, entry.expectedCurrent)) return undefined;
    if (
        !validInstall(install, entry.desiredBefore) ||
        (install.state === "installed" && move.state !== "moved")
    )
        return undefined;
    return structuredClone(entry) as unknown as TargetAbortPathEvidence;
}

function validMove(value: Record<string, unknown>, expected: TargetPathState): boolean {
    if (value.state === "planned") return hasOnly(value, ["state"]);
    const observed = value.observed;
    return (
        value.state === "moved" &&
        hasOnly(value, ["state", "observed"]) &&
        validPathState(observed) &&
        samePathRepresentation(observed, expected) &&
        sameMovedIdentity(observed, expected)
    );
}

function validInstall(value: Record<string, unknown>, expected: TargetPathState): boolean {
    if (value.state === "pending") return hasOnly(value, ["state"]);
    const observed = value.observed;
    return (
        value.state === "installed" &&
        hasOnly(value, ["state", "observed"]) &&
        validPathState(observed) &&
        samePathRepresentation(observed, expected)
    );
}

function samePathRepresentation(left: TargetPathState, right: TargetPathState): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "absent" || right.kind === "absent") return true;
    if (left.kind === "regular" && right.kind === "regular")
        return (
            left.executable === right.executable &&
            left.content.hash === right.content.hash &&
            left.content.size === right.content.size
        );
    if (left.kind === "symlink" && right.kind === "symlink")
        return left.target.hash === right.target.hash && left.target.size === right.target.size;
    return false;
}

function sameMovedIdentity(left: TargetPathState, right: TargetPathState): boolean {
    if (left.kind === "absent" || right.kind === "absent") return left.kind === right.kind;
    return (
        left.identity.device === right.identity.device &&
        left.identity.inode === right.identity.inode &&
        left.identity.size === right.identity.size
    );
}

function parseIndexPublication(
    value: unknown,
    operationId: string,
): TargetIndexPublicationEvidence | undefined {
    if (value === undefined) return undefined;
    const publication = record(value);
    const candidate = record(publication?.candidate);
    const lock = record(publication?.lock);
    const owner = record(lock?.owner);
    if (
        !publication ||
        !candidate ||
        !lock ||
        !owner ||
        !hasOnly(publication, ["state", "liveIndexFingerprint", "candidate", "lock"]) ||
        !isOneOf(publication.state, ["prepared", "published"]) ||
        typeof publication.liveIndexFingerprint !== "string" ||
        !HASH.test(publication.liveIndexFingerprint) ||
        !validIndexCandidate(candidate, operationId) ||
        !validIndexLock(lock, owner, operationId)
    )
        return undefined;
    assertTargetPath(candidate.path as string);
    return structuredClone(publication) as unknown as TargetIndexPublicationEvidence;
}

function validIndexCandidate(candidate: Record<string, unknown>, operationId: string): boolean {
    return (
        hasOnly(candidate, ["path", "fingerprint", "identity"]) &&
        typeof candidate.path === "string" &&
        candidate.path.startsWith(`intelligit/target-operations/${operationId}/`) &&
        typeof candidate.fingerprint === "string" &&
        HASH.test(candidate.fingerprint) &&
        validIdentity(candidate.identity)
    );
}

function validIndexLock(
    lock: Record<string, unknown>,
    owner: Record<string, unknown>,
    operationId: string,
): boolean {
    return (
        hasOnly(lock, ["identity", "operationId", "owner"]) &&
        validIdentity(lock.identity) &&
        lock.operationId === operationId &&
        hasOnly(owner, ["pid", "processStart"]) &&
        Number.isSafeInteger(owner.pid) &&
        (owner.pid as number) > 0 &&
        typeof owner.processStart === "string" &&
        /^[1-9]\d*$/.test(owner.processStart)
    );
}

function validEntryEvidence(value: unknown[]): boolean {
    const changeIds = new Set<string>();
    for (const item of value) {
        const entry = record(item);
        if (!entry || !validEntryEvidenceItem(entry) || changeIds.has(entry.changeId as string))
            return false;
        if (entry.path !== undefined) assertTargetPath(entry.path as string);
        changeIds.add(entry.changeId as string);
    }
    return true;
}

function validEntryEvidenceItem(entry: Record<string, unknown>): boolean {
    return (
        hasOnly(entry, ["changeId", "path", "outcome", "reason"]) &&
        typeof entry.changeId === "string" &&
        CHANGE_ID.test(entry.changeId) &&
        isOneOf(entry.outcome, ["pending", "applied", "conflicted", "retained", "refused"]) &&
        (entry.path === undefined || typeof entry.path === "string") &&
        (entry.reason === undefined ||
            (typeof entry.reason === "string" &&
                entry.reason.length <= 4_000 &&
                !entry.reason.includes("\0")))
    );
}

function parseCompletion(value: unknown): TargetOperationCompletion | undefined {
    if (value === undefined) return undefined;
    const completion = record(value);
    if (
        !completion ||
        !hasOnly(completion, [
            "appliedChangeIds",
            "ownershipRevision",
            "draft",
            "shelfPublication",
            "publishedGeneration",
            "publishedChecksum",
        ]) ||
        !validChangeIds(completion.appliedChangeIds) ||
        !Number.isSafeInteger(completion.ownershipRevision) ||
        (completion.ownershipRevision as number) < 0 ||
        !isOneOf(completion.draft, ["kept", "copied", "keptAfterReview"]) ||
        !isOneOf(completion.shelfPublication, ["pending", "notRequired", "published"])
    )
        return undefined;
    const published = completion.shelfPublication === "published";
    if (
        published !== (completion.publishedGeneration !== undefined) ||
        published !== (completion.publishedChecksum !== undefined) ||
        (published &&
            (!Number.isSafeInteger(completion.publishedGeneration) ||
                (completion.publishedGeneration as number) < 0 ||
                typeof completion.publishedChecksum !== "string" ||
                !HASH.test(completion.publishedChecksum)))
    )
        return undefined;
    return structuredClone(completion) as unknown as TargetOperationCompletion;
}

function validDraftChoice(value: unknown): boolean {
    if (value === undefined) return true;
    const choice = record(value);
    if (!choice || typeof choice.kind !== "string") return false;
    if (choice.kind === "keep") return hasOnly(choice, ["kind"]);
    return (
        choice.kind === "copySource" &&
        hasOnly(choice, ["kind", "sourceListId", "expectedDestinationDraft"]) &&
        typeof choice.sourceListId === "string" &&
        LIST_ID.test(choice.sourceListId) &&
        typeof choice.expectedDestinationDraft === "string" &&
        choice.expectedDestinationDraft.length <= 100_000
    );
}

function validPathState(value: unknown): value is TargetPathState {
    const state = record(value);
    if (!state || typeof state.kind !== "string") return false;
    if (state.kind === "absent") return hasOnly(state, ["kind"]);
    if (state.kind === "regular")
        return (
            hasOnly(state, ["kind", "executable", "content", "identity"]) &&
            typeof state.executable === "boolean" &&
            validBlob(state.content) &&
            validIdentity(state.identity) &&
            state.identity.size === state.content.size
        );
    if (state.kind === "symlink")
        return (
            hasOnly(state, ["kind", "target", "identity"]) &&
            validBlob(state.target) &&
            validIdentity(state.identity) &&
            state.identity.size === state.target.size
        );
    return false;
}

function validBlob(value: unknown): value is TargetOperationBlobReference {
    const blob = record(value);
    return (
        !!blob &&
        hasOnly(blob, ["hash", "size"]) &&
        typeof blob.hash === "string" &&
        HASH.test(blob.hash) &&
        typeof blob.size === "number" &&
        Number.isSafeInteger(blob.size) &&
        blob.size >= 0 &&
        blob.size <= 64 * 1024 * 1024
    );
}

function validIdentity(value: unknown): value is TargetPathIdentity {
    const identity = record(value);
    return (
        !!identity &&
        hasOnly(identity, ["device", "inode", "size", "modifiedNs", "changedNs"]) &&
        [identity.device, identity.inode, identity.modifiedNs, identity.changedNs].every(
            (item) => typeof item === "string" && /^(?:0|[1-9]\d*)$/.test(item),
        ) &&
        typeof identity.size === "number" &&
        Number.isSafeInteger(identity.size) &&
        identity.size >= 0 &&
        identity.size <= 64 * 1024 * 1024
    );
}

function validNativeControls(value: unknown[]): boolean {
    if (value.length !== 4) return false;
    const expected = new Set(["cherryPickHead", "revertHead", "mergeHead", "sequencer"]);
    for (const item of value) {
        const control = record(item);
        if (
            !control ||
            !hasOnly(control, ["name", "present", "hash"]) ||
            typeof control.name !== "string" ||
            !expected.delete(control.name) ||
            typeof control.present !== "boolean" ||
            control.present !== (typeof control.hash === "string" && HASH.test(control.hash))
        )
            return false;
    }
    return expected.size === 0;
}

function validChangeIds(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 100_000 &&
        value.every((id) => typeof id === "string" && CHANGE_ID.test(id)) &&
        new Set(value).size === value.length
    );
}

function isPhase(value: unknown): value is TargetOperationPhase {
    return isOneOf(value, [
        "prepared",
        "gitApplied",
        "conflicted",
        "reviewRequired",
        "ownershipPublished",
        "shelfPublished",
        "abortPrepared",
        "abortPathsRestored",
        "abortIndexRestored",
        "abortNativeCleared",
    ]);
}

function isAbortPhase(value: TargetOperationPhase): boolean {
    return value.startsWith("abort");
}

function isOneOf<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
    return allowed.includes(value as T);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

/** Evidence paths use Git's already-normalized portable representation. */
function assertTargetPath(value: string): void {
    if (
        !value ||
        value.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        value.includes("\\") ||
        /[\0\r\n]/.test(value) ||
        value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    )
        throw new Error("Invalid target operation path.");
}
