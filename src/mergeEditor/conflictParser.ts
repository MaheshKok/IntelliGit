// Parses three file versions (base, ours, theirs) into aligned segments
// for display in a 3-way merge editor. Each side is diffed against the base
// with an IntelliJ-style line diff (see lineDiff.ts), and the two pairwise
// diffs are intersected along the base axis to form merge ranges, matching
// how PyCharm groups changes.
//
// Merge grouping follows JetBrains intellij-community
// (ComparisonMergeUtil.kt FairMergeBuilder), Apache License 2.0.

import { tryAutoMergeLines } from "./autoMerge";
import {
    diffLinesFair,
    normalizeLineForDiff,
    type EqualRange,
    type MergeDiffOptions,
} from "./lineDiff";

export type { MergeDiffOptions } from "./lineDiff";

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
    /**
     * Merged result lines the hunk defaults to without user action: the
     * token-level composition when both sides' edits touch disjoint base
     * regions (IntelliJ-style "magic resolve"), or the ours-side text when
     * both sides made the same change differing only under the comparison
     * policy (e.g. whitespace). Present only on `changeKind === "conflict"`
     * hunks; such hunks do not block Apply and remain user-overridable.
     */
    autoResolvedLines?: string[];
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

    const oursEqual = diffLinesFair(baseLines, oursLines, options);
    const theirsEqual = diffLinesFair(baseLines, theirsLines, options);

    const ranges = buildMergeRanges(
        oursEqual,
        theirsEqual,
        oursLines.length,
        baseLines.length,
        theirsLines.length,
    );
    const segments = buildSegments(baseLines, oursLines, theirsLines, ranges, options);
    return mergeAdjacentCommon(segments);
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

// --- Merge range construction (FairMergeBuilder port) ---

/**
 * One divergent region across the three versions, expressed as half-open
 * spans into each version's line array. Base-equal regions live between
 * consecutive merge ranges.
 */
interface MergeRange {
    oursStart: number;
    oursEnd: number;
    baseStart: number;
    baseEnd: number;
    theirsStart: number;
    theirsEnd: number;
}

/**
 * Intersect the unchanged blocks of both pairwise diffs along the base axis.
 * Every base region not covered by an intersection becomes one merge range;
 * side spans are derived from how far each side's cursor advanced.
 */
function buildMergeRanges(
    oursEqual: EqualRange[],
    theirsEqual: EqualRange[],
    oursLen: number,
    baseLen: number,
    theirsLen: number,
): MergeRange[] {
    const ranges: MergeRange[] = [];
    let processedOurs = 0;
    let processedBase = 0;
    let processedTheirs = 0;

    const markEqual = (
        oursStart: number,
        baseStart: number,
        theirsStart: number,
        count: number,
    ): void => {
        if (count === 0) return;
        if (
            oursStart !== processedOurs ||
            baseStart !== processedBase ||
            theirsStart !== processedTheirs
        ) {
            ranges.push({
                oursStart: processedOurs,
                oursEnd: oursStart,
                baseStart: processedBase,
                baseEnd: baseStart,
                theirsStart: processedTheirs,
                theirsEnd: theirsStart,
            });
        }
        processedOurs = oursStart + count;
        processedBase = baseStart + count;
        processedTheirs = theirsStart + count;
    };

    let i = 0;
    let j = 0;
    while (i < oursEqual.length && j < theirsEqual.length) {
        const r1 = oursEqual[i]; // start1/end1 = base coords, start2/end2 = ours coords
        const r2 = theirsEqual[j]; // start1/end1 = base coords, start2/end2 = theirs coords
        if (r1.end1 <= r2.start1) {
            i++;
            continue;
        }
        if (r2.end1 <= r1.start1) {
            j++;
            continue;
        }
        const baseStart = Math.max(r1.start1, r2.start1);
        const baseEnd = Math.min(r1.end1, r2.end1);
        markEqual(
            r1.start2 + (baseStart - r1.start1),
            baseStart,
            r2.start2 + (baseStart - r2.start1),
            baseEnd - baseStart,
        );
        if (r1.end1 <= r2.end1) i++;
        else j++;
    }

    if (processedOurs !== oursLen || processedBase !== baseLen || processedTheirs !== theirsLen) {
        ranges.push({
            oursStart: processedOurs,
            oursEnd: oursLen,
            baseStart: processedBase,
            baseEnd: baseLen,
            theirsStart: processedTheirs,
            theirsEnd: theirsLen,
        });
    }
    return ranges;
}

// --- Segment builder ---

function buildSegments(
    baseLines: string[],
    oursLines: string[],
    theirsLines: string[],
    ranges: MergeRange[],
    options: MergeDiffOptions,
): MergeSegment[] {
    const segments: MergeSegment[] = [];
    let conflictId = 0;
    let baseCursor = 0;

    for (const range of ranges) {
        if (range.baseStart > baseCursor) {
            segments.push({ type: "common", lines: baseLines.slice(baseCursor, range.baseStart) });
        }
        conflictId = appendChangeSegments(
            segments,
            baseLines.slice(range.baseStart, range.baseEnd),
            oursLines.slice(range.oursStart, range.oursEnd),
            theirsLines.slice(range.theirsStart, range.theirsEnd),
            conflictId,
            options,
        );
        baseCursor = range.baseEnd;
    }
    if (baseCursor < baseLines.length) {
        segments.push({ type: "common", lines: baseLines.slice(baseCursor) });
    }
    return segments;
}

/**
 * Emit segments for one merge range. Byte-identical side spans become common
 * segments; spans equal only under the comparison policy (ignoreWhitespace)
 * stay user-overridable as auto-resolved hunks defaulting to ours (IntelliJ
 * applies the left side for equal changes). For true conflicts,
 * byte-identical ours/theirs lines at the hunk edges are split off as common
 * segments (PyCharm-style resolvable trim), keeping only the genuinely
 * divergent core in the conflict.
 */
function appendChangeSegments(
    segments: MergeSegment[],
    baseSpan: string[],
    oursSpan: string[],
    theirsSpan: string[],
    conflictId: number,
    options: MergeDiffOptions,
): number {
    // Both sides made the byte-identical change: not a conflict at all.
    if (arraysEqualStrict(oursSpan, theirsSpan)) {
        if (oursSpan.length > 0) {
            segments.push({ type: "common", lines: oursSpan });
        }
        return conflictId;
    }

    const oursChanged = !arraysEqual(oursSpan, baseSpan, options);
    const theirsChanged = !arraysEqual(theirsSpan, baseSpan, options);

    // Equal under the comparison policy but byte-different (only reachable
    // with ignoreWhitespace). Never silently drop one side's bytes: keep the
    // hunk user-overridable and default it to the ours representation.
    if (arraysEqual(oursSpan, theirsSpan, options)) {
        if (!oursChanged && !theirsChanged) {
            // Whitespace-only drift on every side: keep base's formatting,
            // matching how base-equal regions outside merge ranges render.
            if (baseSpan.length > 0) {
                segments.push({ type: "common", lines: baseSpan });
            }
            return conflictId;
        }
        const changeKind = getConflictChangeKind(oursChanged, theirsChanged);
        segments.push({
            type: "conflict",
            id: conflictId,
            changeKind,
            oursLines: oursSpan,
            theirsLines: theirsSpan,
            baseLines: baseSpan,
            ...(changeKind === "conflict" ? { autoResolvedLines: oursSpan } : {}),
        });
        return conflictId + 1;
    }

    let prefix = 0;
    let suffix = 0;
    if (oursChanged && theirsChanged) {
        ({ prefix, suffix } = computeEqualEnds(oursSpan, theirsSpan));
    }

    if (prefix > 0) {
        segments.push({ type: "common", lines: oursSpan.slice(0, prefix) });
    }

    const coreOurs = oursSpan.slice(prefix, oursSpan.length - suffix);
    const coreTheirs = theirsSpan.slice(prefix, theirsSpan.length - suffix);
    // Re-derive the kind after trimming: a shared insertion prefix/suffix can
    // reduce a conflict to a one-sided change (the base span stays with the core).
    const changeKind = getConflictChangeKind(
        !arraysEqual(coreOurs, baseSpan, options),
        !arraysEqual(coreTheirs, baseSpan, options),
    );
    const autoResolvedLines =
        changeKind === "conflict"
            ? (tryAutoMergeLines(baseSpan, coreOurs, coreTheirs) ?? undefined)
            : undefined;

    segments.push({
        type: "conflict",
        id: conflictId,
        changeKind,
        oursLines: coreOurs,
        theirsLines: coreTheirs,
        baseLines: baseSpan,
        ...(autoResolvedLines !== undefined ? { autoResolvedLines } : {}),
    });

    if (suffix > 0) {
        segments.push({ type: "common", lines: oursSpan.slice(oursSpan.length - suffix) });
    }
    return conflictId + 1;
}

/**
 * Longest byte-identical common prefix/suffix (in lines) between ours and
 * theirs, without overlap. Used to trim identical edges out of a conflict
 * hunk. Deliberately byte-strict even under ignoreWhitespace: policy-equal
 * but byte-different lines stay inside the conflict core so a "theirs"
 * resolution keeps theirs' exact bytes.
 */
function computeEqualEnds(ours: string[], theirs: string[]): { prefix: number; suffix: number } {
    const maxTrim = Math.min(ours.length, theirs.length);
    let prefix = 0;
    while (prefix < maxTrim && ours[prefix] === theirs[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < maxTrim - prefix &&
        ours[ours.length - 1 - suffix] === theirs[theirs.length - 1 - suffix]
    ) {
        suffix++;
    }
    return { prefix, suffix };
}

function getConflictChangeKind(hasOursEdit: boolean, hasTheirsEdit: boolean): ConflictChangeKind {
    if (hasOursEdit && hasTheirsEdit) return "conflict";
    return hasOursEdit ? "ours-only" : "theirs-only";
}

function arraysEqual(a: string[], b: string[], options: MergeDiffOptions): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (normalizeLineForDiff(a[i], options) !== normalizeLineForDiff(b[i], options))
            return false;
    }
    return true;
}

function arraysEqualStrict(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, i) => line === b[i]);
}

function mergeAdjacentCommon(segments: MergeSegment[]): MergeSegment[] {
    const result: MergeSegment[] = [];
    for (const seg of segments) {
        const last = result[result.length - 1];
        if (seg.type === "common" && last && last.type === "common") {
            result[result.length - 1] = { type: "common", lines: [...last.lines, ...seg.lines] };
        } else {
            result.push(seg);
        }
    }
    return result;
}
