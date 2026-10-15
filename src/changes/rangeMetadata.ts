import type { ChangeOwnership, RangeSnapshot } from "../webviews/protocol/changeSelection";

const HASH = /^[a-f0-9]{64}$/;

/** Reject malformed, unbounded or internally inconsistent persisted range evidence. */
export function validRangeMetadata(
    ownership: ChangeOwnership,
    owners: ReadonlySet<string>,
): boolean {
    if (ownership.tracking !== undefined && !validSnapshot(ownership.tracking)) return false;
    if (ownership.history === undefined) return true;
    if (!Array.isArray(ownership.history) || ownership.history.length > 2) return false;
    return ownership.history.every(
        (entry) =>
            record(entry) &&
            validSnapshot(entry.snapshot) &&
            record(entry.lines) &&
            Object.entries(entry.lines).every(
                ([hash, owner]) => HASH.test(hash) && owners.has(owner),
            ),
    );
}

/** Both coordinate systems must resolve to the captured hash; context is bounded evidence only. */
function validSnapshot(value: RangeSnapshot): boolean {
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
function record(value: unknown): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
