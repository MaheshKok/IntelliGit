import type { RangeSnapshot, RangeSnapshotReference } from "../webviews/protocol/changeSelection";

const HASH = /^[a-f0-9]{64}$/;

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
