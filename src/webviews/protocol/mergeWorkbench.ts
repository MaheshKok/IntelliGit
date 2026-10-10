/** Persisted result text and decisions, owned by one immutable conflict snapshot. */
export interface MergeDraft {
    snapshotId: string;
    content: string;
    hunks: Array<{ id: number; from: number; to: number; resolved: boolean }>;
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
        source.hunks.length > 20_000
    )
        return null;
    const hunks: MergeDraft["hunks"] = [];
    const ids = new Set<number>();
    let previous = 0;
    for (const raw of source.hunks as unknown[]) {
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
            entry.to > source.content.length ||
            typeof entry.resolved !== "boolean"
        )
            return null;
        hunks.push({ id: entry.id, from: entry.from, to: entry.to, resolved: entry.resolved });
        ids.add(entry.id);
        previous = entry.to;
    }
    return { snapshotId: source.snapshotId, content: source.content, hunks };
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
