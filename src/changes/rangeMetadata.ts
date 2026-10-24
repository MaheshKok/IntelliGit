import type { RangeSnapshot, RangeSnapshotReference } from "../webviews/protocol/changeSelection";
import type { HydratedChangeOwnership } from "./rangeMapping";

const HASH = /^[a-f0-9]{64}$/;
const OWNER = /^(?:default|[a-f0-9-]{36})$/;

/** Immutable, repository-bound input to operation attribution; snapshots contain hashes, not file text. */
export interface TargetOperationAttribution {
    readonly version: 1;
    readonly root: string;
    readonly gitDir: string;
    readonly operationId: string;
    readonly path: string;
    readonly priorFileOwner: string;
    readonly previous: HydratedChangeOwnership;
    readonly before: RangeSnapshot;
    readonly after: RangeSnapshot;
    readonly operation: RangeSnapshot;
}

/** Reject a checksum-valid payload unless its binding and every inline ownership snapshot are valid. */
export function parseTargetOperationAttribution(
    input: unknown,
    root: string,
    gitDir: string,
    operationId: string,
    file: string,
): TargetOperationAttribution | undefined {
    if (
        !record(input) ||
        Object.keys(input).length !== 10 ||
        input.version !== 1 ||
        input.root !== root ||
        input.gitDir !== gitDir ||
        input.operationId !== operationId ||
        input.path !== file ||
        typeof input.priorFileOwner !== "string" ||
        !OWNER.test(input.priorFileOwner) ||
        !validSnapshot(input.before) ||
        !validSnapshot(input.after) ||
        !validSnapshot(input.operation) ||
        !validCapturedOwnership(input.previous)
    )
        return undefined;
    return input as unknown as TargetOperationAttribution;
}

/** Captured owners must be syntactically valid; the publishing transaction checks live list membership. */
function validCapturedOwnership(input: unknown): input is HydratedChangeOwnership {
    if (
        !record(input) ||
        !Object.keys(input).every((key) =>
            [
                "contentId",
                "lines",
                "stale",
                "totalChanges",
                "tracking",
                "history",
                "selections",
            ].includes(key),
        ) ||
        typeof input.contentId !== "string" ||
        !HASH.test(input.contentId) ||
        !record(input.lines) ||
        (input.stale !== undefined && typeof input.stale !== "boolean") ||
        (input.totalChanges !== undefined &&
            (!Number.isSafeInteger(input.totalChanges) ||
                (input.totalChanges as number) < 0 ||
                (input.totalChanges as number) > 100_000))
    )
        return false;
    const owners = new Set<string>();
    const lines = (value: unknown): boolean =>
        record(value) &&
        Object.entries(value).every(([hash, owner]) => {
            if (!HASH.test(hash) || typeof owner !== "string" || !OWNER.test(owner)) return false;
            owners.add(owner);
            return true;
        });
    if (!lines(input.lines)) return false;
    if (
        input.history !== undefined &&
        (!Array.isArray(input.history) ||
            input.history.length > 2 ||
            !input.history.every((entry) => record(entry) && lines(entry.lines)))
    )
        return false;
    return validCapturedSelections(input.selections) && validRangeMetadata(input, owners, true);
}

/** Explicit inclusion records remain bounded and cannot introduce malformed owner identifiers. */
function validCapturedSelections(selections: unknown): boolean {
    if (selections !== undefined) {
        if (!record(selections)) return false;
        for (const [scope, selection] of Object.entries(selections)) {
            if (
                (scope !== "all" && !OWNER.test(scope)) ||
                !record(selection) ||
                typeof selection.contentId !== "string" ||
                !HASH.test(selection.contentId) ||
                (selection.reviewRequired !== undefined &&
                    typeof selection.reviewRequired !== "boolean") ||
                !Array.isArray(selection.lineIds) ||
                selection.lineIds.length > 100_000 ||
                selection.lineIds.some(
                    (id) => typeof id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(id),
                ) ||
                !Number.isSafeInteger(selection.total) ||
                (selection.total as number) < selection.lineIds.length ||
                (selection.total as number) > 100_000
            )
                return false;
        }
    }
    return true;
}

/** Reject malformed, unbounded or internally inconsistent persisted range evidence. */
export function validRangeMetadata(
    ownership: { tracking?: unknown; history?: unknown },
    owners: ReadonlySet<string>,
    inline = false,
): boolean {
    const validate = inline ? validSnapshot : validSnapshotReference;
    if (ownership.tracking !== undefined && !validate(ownership.tracking)) return false;
    if (ownership.history === undefined) return true;
    if (!Array.isArray(ownership.history) || ownership.history.length > 2) return false;
    return (ownership.history as unknown[]).every(
        (entry) =>
            record(entry) &&
            validate(entry.snapshot) &&
            record(entry.lines) &&
            Object.entries(entry.lines).every(
                ([hash, owner]) =>
                    HASH.test(hash) && typeof owner === "string" && owners.has(owner),
            ),
    );
}

/** Both coordinate systems must resolve to the captured hash; context is bounded evidence only. */
export function validSnapshot(input: unknown): input is RangeSnapshot {
    const value = input as RangeSnapshot;
    if (
        !record(value) ||
        !HASH.test(value.contentId) ||
        !HASH.test(value.baseHash) ||
        !HASH.test(value.workingHash) ||
        !HASH.test(value.indexHash) ||
        typeof value.head !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(value.head)
    )
        return false;
    if (
        !hashes(value.baseLines) ||
        !hashes(value.workingLines) ||
        !Array.isArray(value.anchors) ||
        value.anchors.length > 100_000
    )
        return false;
    const fingerprints = new Set<string>();
    const ids = new Set<string>();
    return value.anchors.every((anchor) => {
        if (
            !record(anchor) ||
            (anchor.kind !== "add" && anchor.kind !== "remove") ||
            !Number.isSafeInteger(anchor.line) ||
            anchor.line < 0 ||
            !HASH.test(anchor.fingerprint) ||
            !HASH.test(anchor.hash) ||
            typeof anchor.id !== "string" ||
            !/^\d{1,5}:\d{1,6}$/.test(anchor.id)
        )
            return false;
        if (ids.has(anchor.id) || fingerprints.has(anchor.fingerprint)) return false;
        ids.add(anchor.id);
        fingerprints.add(anchor.fingerprint);
        const lines = anchor.kind === "add" ? value.workingLines : value.baseLines;
        return (
            lines[anchor.line] === anchor.hash &&
            hashes(anchor.context) &&
            anchor.context.length <= 5
        );
    });
}

/** A hash list cannot allocate beyond the existing partial-text line limit. */
function hashes(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 100_000 &&
        value.every((item) => typeof item === "string" && HASH.test(item))
    );
}

/** Persisted arrays and null are never accepted as records. */
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** References contain no inline evidence and accept only controlled digest filenames. */
export function validSnapshotReference(input: unknown): input is RangeSnapshotReference {
    const value = input as RangeSnapshotReference;
    return (
        record(value) &&
        Object.keys(value).length === 7 &&
        HASH.test(value.blob) &&
        HASH.test(value.contentId) &&
        HASH.test(value.baseHash) &&
        HASH.test(value.workingHash) &&
        HASH.test(value.indexHash) &&
        typeof value.head === "string" &&
        /^[a-f0-9]{40,64}$/.test(value.head) &&
        Number.isSafeInteger(value.anchorCount) &&
        value.anchorCount >= 0 &&
        value.anchorCount <= 100_000
    );
}

/** Copies only bounded headers; the full snapshot never enters mutable ownership metadata. */
export function snapshotReference(snapshot: RangeSnapshot, blob: string): RangeSnapshotReference {
    return {
        blob,
        contentId: snapshot.contentId,
        baseHash: snapshot.baseHash,
        workingHash: snapshot.workingHash,
        head: snapshot.head,
        indexHash: snapshot.indexHash,
        anchorCount: snapshot.anchors.length,
    };
}
