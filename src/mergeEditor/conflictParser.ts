// Parses three file versions (base, ours, theirs) into aligned segments
// for display in a 3-way merge editor. Uses a simple line-based diff to
// identify common regions and conflict hunks.

/**
 * A contiguous span that both sides resolve to the same content.
 * The merge editor renders these lines once because they do not need user choice.
 */
export interface CommonSegment {
    type: "common";
    lines: string[];
}

type ConflictChangeKind = "conflict" | "ours-only" | "theirs-only";

/**
 * A divergent span produced by comparing ours and theirs against the shared base.
 * `changeKind` records whether both sides changed or only one side diverged from base.
 */
export interface ConflictSegment {
    type: "conflict";
    id: number;
    changeKind: ConflictChangeKind;
    oursLines: string[];
    theirsLines: string[];
    baseLines: string[];
}

/**
 * Ordered line-based segment stream consumed by the React merge editor.
 */
export type MergeSegment = CommonSegment | ConflictSegment;

/**
 * Serialized merge-editor payload for one file and the labels used for each side.
 * End-of-line metadata lets the save path preserve the original file shape when possible.
 */
export interface MergeEditorData {
    filePath: string;
    segments: MergeSegment[];
    oursLabel: string;
    theirsLabel: string;
    eol?: "\n" | "\r\n";
    hasTrailingNewline?: boolean;
    diffOptions?: MergeDiffOptions;
}

/**
 * Options that alter line comparison without mutating the original displayed lines.
 */
export interface MergeDiffOptions {
    ignoreWhitespace?: boolean;
}

/**
 * Parse three file versions into merge segments by comparing each side against the base version.
 * Equal side output becomes a common segment; any side divergence is emitted as a conflict segment.
 */
export function parseConflictVersions(
    base: string,
    ours: string,
    theirs: string,
    options: MergeDiffOptions = {},
): MergeSegment[] {
    const baseLines = splitLines(base);
    const oursLines = splitLines(ours);
    const theirsLines = splitLines(theirs);

    const oursEdits = diffLines(baseLines, oursLines, options);
    const theirsEdits = diffLines(baseLines, theirsLines, options);

    return buildSegments(baseLines, oursLines, theirsLines, oursEdits, theirsEdits, options);
}

function splitLines(text: string): string[] {
    if (text === "") return [];
    // Drop exactly one trailing newline to avoid creating a synthetic empty
    // "last line" entry when the file ends with a newline terminator.
    let normalized = text;
    if (normalized.endsWith("\r\n")) normalized = normalized.slice(0, -2);
    else if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
    return normalized === "" ? [] : normalized.split(/\r?\n/);
}

/**
 * Detects the end-of-line style and trailing-newline contract for merge output.
 *
 * The first non-empty version wins so the merged result mirrors the dominant
 * input file shape. Empty inputs default to LF with a trailing newline, which
 * matches POSIX text-file conventions for newly written files.
 */
export function detectEolMetadata(...versions: string[]): {
    eol: "\n" | "\r\n";
    hasTrailingNewline: boolean;
} {
    const source = versions.find((text) => text.length > 0);
    if (source === undefined) {
        return { eol: "\n", hasTrailingNewline: true };
    }
    return {
        eol: source.includes("\r\n") ? "\r\n" : "\n",
        hasTrailingNewline: source.endsWith("\n"),
    };
}

// --- Simple LCS-based diff ---

interface EditRange {
    baseStart: number;
    baseEnd: number;
    modStart: number;
    modEnd: number;
}

function normalizeLineForDiff(line: string, options: MergeDiffOptions): string {
    if (options.ignoreWhitespace) {
        // Match editor "ignore whitespace" behavior approximately by collapsing
        // all whitespace runs and trimming line ends for line-level comparisons.
        return line.replace(/\s+/g, " ").trim();
    }
    return line;
}

function diffLines(base: string[], modified: string[], options: MergeDiffOptions): EditRange[] {
    const baseComparable = base.map((line) => normalizeLineForDiff(line, options));
    const modifiedComparable = modified.map((line) => normalizeLineForDiff(line, options));
    const lcs = computeLCS(baseComparable, modifiedComparable);
    const edits: EditRange[] = [];
    let bi = 0;
    let mi = 0;

    for (const [lb, lm] of lcs) {
        if (bi < lb || mi < lm) {
            edits.push({ baseStart: bi, baseEnd: lb, modStart: mi, modEnd: lm });
        }
        bi = lb + 1;
        mi = lm + 1;
    }

    if (bi < base.length || mi < modified.length) {
        edits.push({ baseStart: bi, baseEnd: base.length, modStart: mi, modEnd: modified.length });
    }

    return edits;
}

function computeLCS(a: string[], b: string[]): Array<[number, number]> {
    const m = a.length;
    const n = b.length;

    // For very large files, fall back to a simpler approach
    if (m * n > 10_000_000) {
        return greedyMonotonicLineMatch(a, b);
    }

    const stride = n + 1;
    const dp = new Int32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            const idx = i * stride + j;
            dp[idx] =
                a[i] === b[j]
                    ? dp[(i + 1) * stride + (j + 1)] + 1
                    : Math.max(dp[(i + 1) * stride + j], dp[i * stride + (j + 1)]);
        }
    }

    const result: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            result.push([i, j]);
            i++;
            j++;
        } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
            i++;
        } else {
            j++;
        }
    }
    return result;
}

// This is a fast greedy matcher, not a true LCS. It preserves increasing
// order and returns a useful approximation for very large inputs.
function greedyMonotonicLineMatch(a: string[], b: string[]): Array<[number, number]> {
    const bIndex = new Map<string, number[]>();
    for (let j = 0; j < b.length; j++) {
        const list = bIndex.get(b[j]);
        if (list) list.push(j);
        else bIndex.set(b[j], [j]);
    }

    const result: Array<[number, number]> = [];
    let lastJ = -1;
    for (let i = 0; i < a.length; i++) {
        const candidates = bIndex.get(a[i]);
        if (!candidates) continue;
        const idx = binarySearchFirstGT(candidates, lastJ);
        if (idx < candidates.length) {
            lastJ = candidates[idx];
            result.push([i, lastJ]);
        }
    }
    return result;
}

function binarySearchFirstGT(arr: number[], target: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// --- Segment builder ---

function buildSegments(
    baseLines: string[],
    oursLines: string[],
    theirsLines: string[],
    oursEdits: EditRange[],
    theirsEdits: EditRange[],
    options: MergeDiffOptions,
): MergeSegment[] {
    // Build a per-base-line edit map for each side
    const baseLen = baseLines.length;
    const oursMap = buildBaseEditMap(oursEdits);
    const theirsMap = buildBaseEditMap(theirsEdits);

    const segments: MergeSegment[] = [];
    let conflictId = 0;
    let bi = 0;

    while (bi <= baseLen) {
        const cursor = bi;
        const oursEdit = oursMap.get(bi);
        const theirsEdit = theirsMap.get(bi);

        if (!oursEdit && !theirsEdit) {
            // Both sides match base at this line
            if (bi < baseLen) {
                const commonStart = bi;
                while (bi < baseLen && !oursMap.has(bi) && !theirsMap.has(bi)) {
                    bi++;
                }
                segments.push({ type: "common", lines: baseLines.slice(commonStart, bi) });
            } else {
                bi++;
            }
            continue;
        }

        const { endBase, overlappingOurs, overlappingTheirs, hasOursEdit, hasTheirsEdit } =
            collectCoalescedEdits(oursMap, theirsMap, bi);

        const oLines = buildSideLinesForBaseSpan(
            baseLines,
            oursLines,
            bi,
            endBase,
            overlappingOurs,
        );
        const tLines = buildSideLinesForBaseSpan(
            baseLines,
            theirsLines,
            bi,
            endBase,
            overlappingTheirs,
        );

        conflictId = appendResolvedSegment(
            segments,
            {
                baseLines: baseLines.slice(bi, endBase),
                oursLines: oLines,
                theirsLines: tLines,
                hasOursEdit,
                hasTheirsEdit,
            },
            conflictId,
            options,
        );

        if (endBase === cursor) {
            // Pure insertion hunks do not consume base lines. Mark this position as
            // processed so the loop can continue with the same base cursor.
            for (const edit of overlappingOurs) oursMap.delete(edit.baseStart);
            for (const edit of overlappingTheirs) theirsMap.delete(edit.baseStart);
            // Unconditionally delete the cursor key to guarantee forward progress.
            // Without this, when both sides have pure-insertion hunks at the same
            // base position, the while loop could spin indefinitely.
            oursMap.delete(cursor);
            theirsMap.delete(cursor);
        } else {
            for (const edit of overlappingOurs) oursMap.delete(edit.baseStart);
            for (const edit of overlappingTheirs) theirsMap.delete(edit.baseStart);
            bi = endBase;
        }
    }

    return mergeAdjacentCommon(segments);
}

interface CoalescedEdits {
    endBase: number;
    overlappingOurs: EditRange[];
    overlappingTheirs: EditRange[];
    hasOursEdit: boolean;
    hasTheirsEdit: boolean;
}

function collectCoalescedEdits(
    oursMap: Map<number, EditRange>,
    theirsMap: Map<number, EditRange>,
    baseIndex: number,
): CoalescedEdits {
    // Coalesce overlapping edits across both sides so we do not skip a later
    // edit whose baseStart falls inside the range already expanded by the
    // opposite side.
    let endBase = Math.max(
        oursMap.get(baseIndex)?.baseEnd ?? baseIndex,
        theirsMap.get(baseIndex)?.baseEnd ?? baseIndex,
    );
    let overlappingOurs = collectOverlappingEdits(oursMap, baseIndex, endBase);
    let overlappingTheirs = collectOverlappingEdits(theirsMap, baseIndex, endBase);
    while (true) {
        const nextEndBase = Math.max(
            endBase,
            ...overlappingOurs.map((edit) => edit.baseEnd),
            ...overlappingTheirs.map((edit) => edit.baseEnd),
        );
        if (nextEndBase === endBase) break;
        endBase = nextEndBase;
        overlappingOurs = collectOverlappingEdits(oursMap, baseIndex, endBase);
        overlappingTheirs = collectOverlappingEdits(theirsMap, baseIndex, endBase);
    }

    return {
        endBase,
        overlappingOurs,
        overlappingTheirs,
        hasOursEdit: overlappingOurs.length > 0,
        hasTheirsEdit: overlappingTheirs.length > 0,
    };
}

interface SegmentResolution {
    baseLines: string[];
    oursLines: string[];
    theirsLines: string[];
    hasOursEdit: boolean;
    hasTheirsEdit: boolean;
}

function appendResolvedSegment(
    segments: MergeSegment[],
    resolution: SegmentResolution,
    conflictId: number,
    options: MergeDiffOptions,
): number {
    // If both sides made the same change, it's not a conflict
    if (arraysEqual(resolution.oursLines, resolution.theirsLines, options)) {
        if (resolution.oursLines.length > 0) {
            segments.push({ type: "common", lines: resolution.oursLines });
        }
        return conflictId;
    }

    segments.push({
        type: "conflict",
        id: conflictId,
        changeKind: getConflictChangeKind(resolution.hasOursEdit, resolution.hasTheirsEdit),
        oursLines: resolution.oursLines,
        theirsLines: resolution.theirsLines,
        baseLines: resolution.baseLines,
    });
    return conflictId + 1;
}

function getConflictChangeKind(hasOursEdit: boolean, hasTheirsEdit: boolean): ConflictChangeKind {
    if (hasOursEdit && hasTheirsEdit) return "conflict";
    return hasOursEdit ? "ours-only" : "theirs-only";
}

function buildBaseEditMap(edits: EditRange[]): Map<number, EditRange> {
    const map = new Map<number, EditRange>();
    for (const edit of edits) {
        // Map the edit to the base line where it starts.
        // Insertions (baseStart === baseEnd) are mapped to the insertion point.
        map.set(edit.baseStart, edit);
    }
    return map;
}

function editTouchesSpan(edit: EditRange, spanStart: number, spanEnd: number): boolean {
    if (edit.baseStart === edit.baseEnd) {
        if (spanEnd === spanStart) return edit.baseStart === spanStart;
        return edit.baseStart >= spanStart && edit.baseStart < spanEnd;
    }
    if (spanEnd === spanStart) return edit.baseStart === spanStart;
    return edit.baseStart < spanEnd && edit.baseEnd > spanStart;
}

function collectOverlappingEdits(
    editMap: Map<number, EditRange>,
    spanStart: number,
    spanEnd: number,
): EditRange[] {
    const edits: EditRange[] = [];
    for (const edit of editMap.values()) {
        if (editTouchesSpan(edit, spanStart, spanEnd)) {
            edits.push(edit);
        }
    }
    edits.sort((a, b) => a.baseStart - b.baseStart || a.modStart - b.modStart);
    return edits;
}

function buildSideLinesForBaseSpan(
    baseLines: string[],
    modifiedLines: string[],
    spanStart: number,
    spanEnd: number,
    edits: EditRange[],
): string[] {
    if (edits.length === 0) {
        return baseLines.slice(spanStart, spanEnd);
    }

    const lines: string[] = [];
    let baseCursor = spanStart;

    for (const edit of edits) {
        if (edit.baseStart > baseCursor) {
            lines.push(...baseLines.slice(baseCursor, Math.min(edit.baseStart, spanEnd)));
        }
        lines.push(...modifiedLines.slice(edit.modStart, edit.modEnd));
        if (edit.baseEnd > baseCursor) {
            baseCursor = edit.baseEnd;
        }
    }

    if (baseCursor < spanEnd) {
        lines.push(...baseLines.slice(baseCursor, spanEnd));
    }

    return lines;
}

function arraysEqual(a: string[], b: string[], options: MergeDiffOptions): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (normalizeLineForDiff(a[i], options) !== normalizeLineForDiff(b[i], options))
            return false;
    }
    return true;
}

function mergeAdjacentCommon(segments: MergeSegment[]): MergeSegment[] {
    const result: MergeSegment[] = [];
    for (const seg of segments) {
        if (
            seg.type === "common" &&
            result.length > 0 &&
            result[result.length - 1].type === "common"
        ) {
            (result[result.length - 1] as CommonSegment).lines.push(...seg.lines);
        } else {
            result.push(seg);
        }
    }
    return result;
}
