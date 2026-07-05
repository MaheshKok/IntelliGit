// State management and resolution helpers for the merge editor.
// Contains the reducer, conflict resolution logic, manual result edits,
// and the final merged-content builder.

import type { MergeEditorData, MergeSegment, ConflictSegment, HunkResolution } from "./types";

/**
 * Reducer state for the merge editor, keeping immutable conflict input separate
 * from local hunk-resolution choices, manual result edits, and load errors.
 *
 * `edits` maps a conflict segment id to user-typed result lines. An empty array
 * is a meaningful edit (the block was deleted), so presence is tested with
 * `!== undefined` rather than truthiness.
 */
export interface State {
    data: MergeEditorData | null;
    error: string | null;
    resolutions: Record<number, HunkResolution>;
    edits: Record<number, string[]>;
}

/** Message-shaped reducer actions emitted by the merge editor app shell. */
export type Action =
    | { type: "SET_DATA"; data: MergeEditorData }
    | { type: "SET_ERROR"; message: string }
    | { type: "RESOLVE_HUNK"; id: number; resolution: HunkResolution }
    | { type: "EDIT_HUNK_RESULT"; id: number; lines: string[] }
    | { type: "CLEAR_HUNK_EDIT"; id: number };

/**
 * Applies merge-editor state transitions.
 *
 * Fresh conflict data resets both resolutions and manual edits because segment
 * ids are only stable within one parse. Choosing a side for a hunk discards any
 * manual edit on that hunk so the chosen side is what the result pane shows.
 */
export function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "SET_DATA":
            return { ...state, data: action.data, error: null, resolutions: {}, edits: {} };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "RESOLVE_HUNK": {
            const edits = removeKey(state.edits, action.id);
            return {
                ...state,
                resolutions: { ...state.resolutions, [action.id]: action.resolution },
                edits,
            };
        }
        case "EDIT_HUNK_RESULT":
            return {
                ...state,
                edits: { ...state.edits, [action.id]: action.lines },
            };
        case "CLEAR_HUNK_EDIT":
            return { ...state, edits: removeKey(state.edits, action.id) };
        default:
            return state;
    }
}

function removeKey(edits: Record<number, string[]>, id: number): Record<number, string[]> {
    if (edits[id] === undefined) return edits;
    const next = { ...edits };
    delete next[id];
    return next;
}

/**
 * Returns whether a segment is a conflict that still needs a human decision.
 * One-sided hunks and token-level auto-merged hunks resolve themselves, so
 * only dual-sided hunks without an auto-merge count as true conflicts.
 */
export function isTrueConflict(segment: MergeSegment): segment is ConflictSegment {
    return (
        segment.type === "conflict" &&
        segment.changeKind === "conflict" &&
        segment.autoResolvedLines === undefined
    );
}

/**
 * Resolves the lines displayed in the result pane for one conflict segment,
 * including auto-resolution defaults for one-sided changes and token-level
 * auto-merged hunks.
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
        case "both-reversed":
            return [...segment.theirsLines, ...segment.oursLines];
        case "none":
            return [];
        default:
            // Non-conflicting changes auto-resolve to the changed side
            if (segment.changeKind === "ours-only") return segment.oursLines;
            if (segment.changeKind === "theirs-only") return segment.theirsLines;
            // Token-level merged hunks default to the composed result
            if (segment.autoResolvedLines !== undefined) return segment.autoResolvedLines;
            return segment.baseLines;
    }
}

/**
 * Splits textarea text into result lines, treating fully empty text as an
 * intentional block deletion rather than a single empty line.
 */
export function splitEditedText(text: string): string[] {
    if (text === "") return [];
    return text.split(/\r?\n/);
}

/**
 * Resolves the result-pane lines for one hunk with manual edits taking priority
 * over side resolutions. An empty edited array intentionally drops the block.
 */
export function getEffectiveResultLines(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    editedLines: string[] | undefined,
): string[] {
    if (editedLines !== undefined) return editedLines;
    return getResultLines(segment, resolution);
}

/**
 * Builds the final file content from common segments, hunk resolutions, and
 * manual result edits while preserving the source file's EOL and
 * trailing-newline contract.
 */
export function buildResultContent(
    data: MergeEditorData,
    resolutions: Record<number, HunkResolution>,
    edits: Record<number, string[]> = {},
): string {
    const { segments } = data;
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...getEffectiveResultLines(seg, resolutions[seg.id], edits[seg.id]));
        }
    }
    if (lines.length === 0) return "";
    const eol = data.eol ?? "\n";
    const joined = lines.join(eol);
    return data.hasTrailingNewline ? joined + eol : joined;
}

/**
 * Returns whether every true conflict has an explicit resolution choice or a
 * manual result edit.
 */
export function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
    edits: Record<number, string[]> = {},
): boolean {
    return segments.every(
        (seg) =>
            !isTrueConflict(seg) ||
            resolutions[seg.id] !== undefined ||
            edits[seg.id] !== undefined,
    );
}

/** Counts only hunks that still need a human decision (no auto-merge). */
export function trueConflictCount(segments: MergeSegment[]): number {
    return segments.filter(isTrueConflict).length;
}

/** Counts true conflicts resolved by a side choice or a manual result edit. */
export function resolvedTrueConflictCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
    edits: Record<number, string[]> = {},
): number {
    return segments.filter(
        (seg) =>
            isTrueConflict(seg) &&
            (resolutions[seg.id] !== undefined || edits[seg.id] !== undefined),
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
