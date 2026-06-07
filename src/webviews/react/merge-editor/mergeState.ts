// State management and resolution helpers for the merge editor.
// Contains the reducer, conflict resolution logic, and result builder.

import type { MergeEditorData, MergeSegment, ConflictSegment, HunkResolution } from "./types";

/**
 * Reducer state for the merge editor, keeping immutable conflict input separate
 * from local hunk-resolution choices and load errors.
 */
export interface State {
    data: MergeEditorData | null;
    error: string | null;
    resolutions: Record<number, HunkResolution>;
}

/** Message-shaped reducer actions emitted by the merge editor app shell. */
export type Action =
    | { type: "SET_DATA"; data: MergeEditorData }
    | { type: "SET_ERROR"; message: string }
    | { type: "RESOLVE_HUNK"; id: number; resolution: HunkResolution };

/**
 * Applies merge-editor state transitions, resetting hunk resolutions whenever
 * fresh conflict data arrives from the extension.
 */
export function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "SET_DATA":
            return { ...state, data: action.data, error: null, resolutions: {} };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "RESOLVE_HUNK":
            return {
                ...state,
                resolutions: { ...state.resolutions, [action.id]: action.resolution },
            };
        default:
            return state;
    }
}

/**
 * Resolves the lines displayed in the result pane for one conflict segment,
 * including auto-resolution defaults for one-sided changes.
 */
export function getResultLines(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
): string[] {
    switch (resolution) {
        case "ours":
            return segment.oursLines;
        case "theirs":
            return segment.theirsLines;
        case "both":
            return [...segment.oursLines, ...segment.theirsLines];
        case "none":
            return [];
        default:
            // Non-conflicting changes auto-resolve to the changed side
            if (segment.changeKind === "ours-only") return segment.oursLines;
            if (segment.changeKind === "theirs-only") return segment.theirsLines;
            return segment.baseLines;
    }
}

/**
 * Builds the final file content from common segments and chosen hunk resolutions
 * while preserving the source file's EOL and trailing-newline contract.
 */
export function buildResultContent(
    data: MergeEditorData,
    resolutions: Record<number, HunkResolution>,
): string {
    const { segments } = data;
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...getResultLines(seg, resolutions[seg.id]));
        }
    }
    if (lines.length === 0) return "";
    const eol = data.eol ?? "\n";
    const joined = lines.join(eol);
    return data.hasTrailingNewline ? joined + eol : joined;
}

/** Returns whether every true conflict has an explicit resolution choice. */
export function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): boolean {
    return segments.every(
        (seg) =>
            seg.type === "common" ||
            seg.changeKind !== "conflict" ||
            resolutions[seg.id] !== undefined,
    );
}

/** Counts only hunks where both sides changed the same base region. */
export function trueConflictCount(segments: MergeSegment[]): number {
    return segments.filter((seg) => seg.type === "conflict" && seg.changeKind === "conflict")
        .length;
}

/** Counts true conflicts that already have a selected hunk resolution. */
export function resolvedTrueConflictCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): number {
    return segments.filter(
        (seg) =>
            seg.type === "conflict" &&
            seg.changeKind === "conflict" &&
            resolutions[seg.id] !== undefined,
    ).length;
}

/** Counts merge-editor hunks that contribute changes to the requested side pane. */
export function paneChangeCount(segments: MergeSegment[], side: "ours" | "theirs"): number {
    return segments.filter((seg) => {
        if (seg.type !== "conflict") return false;
        if (side === "ours") return seg.changeKind !== "theirs-only";
        return seg.changeKind !== "ours-only";
    }).length;
}
