const MERGE_CHOICES = ["ours", "theirs", "both", "both-reversed", "base", "none"] as const;

/** Available replacements for a merge hunk. */
export type MergeChoice = (typeof MERGE_CHOICES)[number];

/** Persisted result text and decisions, owned by one immutable conflict snapshot. */
export interface MergeDraft {
    snapshotId: string;
    content: string;
    hunks: Array<{
        id: number;
        from: number;
        to: number;
        resolved: boolean;
        decision?: MergeChoice;
        edited?: boolean;
        dismissedOurs?: boolean;
        dismissedTheirs?: boolean;
    }>;
    ignoreWhitespace?: boolean;
}

/** Accepts absent values and booleans without treating null as absent. */
function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === "boolean";
}

/** Validates and normalizes one hunk against the preceding range and IDs. */
function parseMergeDraftHunk(
    raw: unknown,
    previous: number,
    ids: Set<number>,
    contentLength: number,
): MergeDraft["hunks"][number] | null {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as Record<string, unknown>;
    if (
        typeof entry.id !== "number" ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 0 ||
        ids.has(entry.id) ||
        typeof entry.from !== "number" ||
        !Number.isSafeInteger(entry.from) ||
        typeof entry.to !== "number" ||
        !Number.isSafeInteger(entry.to) ||
        entry.from < previous ||
        entry.to < entry.from ||
        entry.to > contentLength ||
        typeof entry.resolved !== "boolean" ||
        (entry.decision !== undefined && !MERGE_CHOICES.includes(entry.decision as MergeChoice)) ||
        !isOptionalBoolean(entry.edited) ||
        !isOptionalBoolean(entry.dismissedOurs) ||
        !isOptionalBoolean(entry.dismissedTheirs)
    )
        return null;
    return {
        id: entry.id,
        from: entry.from,
        to: entry.to,
        resolved: entry.resolved,
        ...(entry.decision !== undefined ? { decision: entry.decision as MergeChoice } : {}),
        ...(entry.edited !== undefined ? { edited: entry.edited } : {}),
        ...(entry.dismissedOurs !== undefined ? { dismissedOurs: entry.dismissedOurs } : {}),
        ...(entry.dismissedTheirs !== undefined ? { dismissedTheirs: entry.dismissedTheirs } : {}),
    };
}

/** Bounded validation shared by the host and the result editor. */
export function parseMergeDraft(value: unknown): MergeDraft | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    if (
        typeof source.snapshotId !== "string" ||
        !/^[a-f\d]{64}$/.test(source.snapshotId) ||
        typeof source.content !== "string" ||
        new TextEncoder().encode(source.content).length > 2 * 1024 * 1024 ||
        !Array.isArray(source.hunks) ||
        source.hunks.length > 20_000 ||
        !isOptionalBoolean(source.ignoreWhitespace)
    )
        return null;
    const hunks: MergeDraft["hunks"] = [];
    const ids = new Set<number>();
    let previous = 0;
    for (const raw of source.hunks as unknown[]) {
        const entry = parseMergeDraftHunk(raw, previous, ids, source.content.length);
        if (!entry) return null;
        hunks.push(entry);
        ids.add(entry.id);
        previous = entry.to;
    }
    return {
        snapshotId: source.snapshotId,
        content: source.content,
        hunks,
        ...(source.ignoreWhitespace !== undefined
            ? { ignoreWhitespace: source.ignoreWhitespace }
            : {}),
    };
}

/** Draft persistence and immutable-snapshot Apply commands for Git merge sessions. */
export type MergeWorkbenchOutbound =
    | { type: "loadMergeDraft" }
    | { type: "saveMergeDraft"; draft: MergeDraft; revision: number }
    | { type: "discardMergeDraft"; snapshotId: string }
    | { type: "applyResolution"; content: string; snapshotId: string };

/** Apply failures leave the editable document mounted and its history intact. */
export type MergeWorkbenchInbound =
    | { type: "mergeDraft"; draft: MergeDraft | null }
    | { type: "mergeDraftSaved"; revision: number }
    | { type: "resolutionError"; message: string }
    | { type: "resolutionApplied" };
