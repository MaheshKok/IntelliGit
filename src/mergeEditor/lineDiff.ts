// Line-level diff pipeline modeled on IntelliJ IDEA's merge diff so the merge
// editor groups changes the way PyCharm does. Important (information-carrying)
// lines are matched first as anchors, gaps are re-diffed with all lines, and
// chunk boundaries are optimized toward unimportant-line boundaries.
//
// Algorithm design follows JetBrains intellij-community (ByLineRt.kt,
// ChangeCorrector.kt, ChunkOptimizer.kt), Apache License 2.0.

/**
 * Options that alter line comparison without mutating the original displayed lines.
 */
export interface MergeDiffOptions {
    ignoreWhitespace?: boolean;
}

/**
 * A block of lines matched as equal between two versions.
 * Half-open ranges; `end1 - start1 === end2 - start2` always holds.
 */
export interface EqualRange {
    start1: number;
    end1: number;
    start2: number;
    end2: number;
}

// Lines with at most this many non-whitespace characters ("}", "};", ");",
// blanks) are "unimportant": they never act as diff anchors on their own and
// are preferred chunk-boundary positions. Mirrors IntelliJ's
// UNIMPORTANT_LINE_CHAR_COUNT default.
const UNIMPORTANT_LINE_CHAR_COUNT = 3;

// DP table size guard shared by all LCS passes; beyond it we fall back to a
// fast greedy monotonic matcher.
const MAX_LCS_CELLS = 10_000_000;

// Cap on a line's anchor weight so one very long line cannot outvote several
// distinct meaningful lines. Deliberate deviation from IntelliJ's ByLineRt.kt,
// which LCS-matches important lines unweighted: weighting anchors by
// information content (non-space chars) reproduces PyCharm's observed anchor
// choices when candidate common runs cross and tie on plain match count.
const MAX_ANCHOR_WEIGHT = 20;

export function normalizeLineForDiff(line: string, options: MergeDiffOptions): string {
    if (options.ignoreWhitespace) {
        // Match editor "ignore whitespace" behavior approximately by collapsing
        // all whitespace runs and trimming line ends for line-level comparisons.
        return line.replace(/\s+/g, " ").trim();
    }
    return line;
}

function nonSpaceCharCount(line: string): number {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line.charCodeAt(i);
        if (ch !== 32 /* space */ && ch !== 9 /* tab */ && ch !== 13 /* CR */) count++;
    }
    return count;
}

/**
 * Diff two line arrays and return the matched (equal) blocks in order.
 *
 * Pipeline: (1) match important lines only, weighted by information content so
 * anchors land on meaningful lines (`return this.config;`) instead of
 * structural noise (`database: {`); (2) re-diff the gaps between anchors with
 * all lines; (3) optimize chunk boundaries toward unimportant lines.
 */
export function diffLinesFair(
    lines1: string[],
    lines2: string[],
    options: MergeDiffOptions = {},
): EqualRange[] {
    const cmp1 = lines1.map((line) => normalizeLineForDiff(line, options));
    const cmp2 = lines2.map((line) => normalizeLineForDiff(line, options));
    const nonSpace1 = lines1.map(nonSpaceCharCount);
    const nonSpace2 = lines2.map(nonSpaceCharCount);

    const anchors = matchImportantLines(cmp1, cmp2, nonSpace1, nonSpace2);
    const ranges = fillGaps(cmp1, cmp2, anchors);
    const coalesced = coalesceRanges(ranges);
    return optimizeLineChunks(coalesced, cmp1, cmp2, nonSpace1, nonSpace2);
}

// --- Pass 1: anchor matching over important lines ---

function matchImportantLines(
    cmp1: string[],
    cmp2: string[],
    nonSpace1: number[],
    nonSpace2: number[],
): Array<[number, number]> {
    const idx1 = collectImportantIndexes(nonSpace1);
    const idx2 = collectImportantIndexes(nonSpace2);

    const big1 = idx1.map((i) => cmp1[i]);
    const big2 = idx2.map((i) => cmp2[i]);
    const weights = idx1.map((i) => Math.min(nonSpace1[i], MAX_ANCHOR_WEIGHT));

    const pairs = lcsPairs(big1, big2, weights);
    return pairs.map(([a, b]) => [idx1[a], idx2[b]]);
}

function collectImportantIndexes(nonSpace: number[]): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < nonSpace.length; i++) {
        if (nonSpace[i] > UNIMPORTANT_LINE_CHAR_COUNT) indexes.push(i);
    }
    return indexes;
}

// --- Pass 2: gap correction (port of SmartLineChangeCorrector) ---

function fillGaps(cmp1: string[], cmp2: string[], anchors: Array<[number, number]>): EqualRange[] {
    const ranges: EqualRange[] = [];
    let last1 = 0;
    let last2 = 0;

    for (const [a1, a2] of anchors) {
        matchGap(cmp1, cmp2, last1, a1, last2, a2, ranges);
        ranges.push({ start1: a1, end1: a1 + 1, start2: a2, end2: a2 + 1 });
        last1 = a1 + 1;
        last2 = a2 + 1;
    }
    matchGap(cmp1, cmp2, last1, cmp1.length, last2, cmp2.length, ranges);

    return ranges;
}

function matchGap(
    cmp1: string[],
    cmp2: string[],
    start1: number,
    end1: number,
    start2: number,
    end2: number,
    ranges: EqualRange[],
): void {
    if (start1 >= end1 || start2 >= end2) return;

    // Cheap edge expansion first: grow equal runs inward from both gap edges.
    let prefix = 0;
    while (
        start1 + prefix < end1 &&
        start2 + prefix < end2 &&
        cmp1[start1 + prefix] === cmp2[start2 + prefix]
    ) {
        prefix++;
    }
    let suffix = 0;
    while (
        end1 - 1 - suffix >= start1 + prefix &&
        end2 - 1 - suffix >= start2 + prefix &&
        cmp1[end1 - 1 - suffix] === cmp2[end2 - 1 - suffix]
    ) {
        suffix++;
    }

    if (prefix > 0) {
        ranges.push({ start1, end1: start1 + prefix, start2, end2: start2 + prefix });
    }

    const inner1 = cmp1.slice(start1 + prefix, end1 - suffix);
    const inner2 = cmp2.slice(start2 + prefix, end2 - suffix);
    if (inner1.length > 0 && inner2.length > 0) {
        for (const [a, b] of lcsPairs(inner1, inner2, null)) {
            ranges.push({
                start1: start1 + prefix + a,
                end1: start1 + prefix + a + 1,
                start2: start2 + prefix + b,
                end2: start2 + prefix + b + 1,
            });
        }
    }

    if (suffix > 0) {
        ranges.push({ start1: end1 - suffix, end1, start2: end2 - suffix, end2 });
    }
}

function coalesceRanges(ranges: EqualRange[]): EqualRange[] {
    const result: EqualRange[] = [];
    for (const range of ranges) {
        const last = result[result.length - 1];
        if (last && last.end1 === range.start1 && last.end2 === range.start2) {
            result[result.length - 1] = { ...last, end1: range.end1, end2: range.end2 };
        } else {
            result.push({ ...range });
        }
    }
    return result;
}

// --- LCS core (weighted, with greedy fallback for huge inputs) ---

/**
 * Longest common subsequence returning matched index pairs. When `weights` is
 * provided (aligned to `a`), the match score of a pair is the weight of the
 * `a` line, so higher-information lines win ties against structural noise.
 * Ties in the traceback prefer consuming `b` first, which keeps matches as
 * early as possible on both sides (Myers-like leftmost behavior).
 */
function lcsPairs(a: string[], b: string[], weights: number[] | null): Array<[number, number]> {
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return [];

    if (m * n > MAX_LCS_CELLS) {
        return greedyMonotonicLineMatch(a, b);
    }

    const stride = n + 1;
    const dp = new Int32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
        const weight = weights ? weights[i] : 1;
        for (let j = n - 1; j >= 0; j--) {
            const idx = i * stride + j;
            dp[idx] =
                a[i] === b[j]
                    ? dp[(i + 1) * stride + (j + 1)] + weight
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
        } else if (dp[(i + 1) * stride + j] > dp[i * stride + (j + 1)]) {
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

// --- Pass 3: chunk optimization (port of ChunkOptimizer.LineChunkOptimizer) ---

interface OptimizerContext {
    cmp1: string[];
    cmp2: string[];
    nonSpace1: number[];
    nonSpace2: number[];
}

function optimizeLineChunks(
    ranges: EqualRange[],
    cmp1: string[],
    cmp2: string[],
    nonSpace1: number[],
    nonSpace2: number[],
): EqualRange[] {
    const ctx: OptimizerContext = { cmp1, cmp2, nonSpace1, nonSpace2 };
    const out: EqualRange[] = [];
    for (const range of ranges) {
        out.push({ ...range });
        processLastRanges(out, ctx);
    }
    return out;
}

function processLastRanges(out: EqualRange[], ctx: OptimizerContext): void {
    while (out.length >= 2) {
        const range1 = out[out.length - 2];
        const range2 = out[out.length - 1];

        // Ranges must touch on at least one side for the gap to be a slider.
        if (range1.end1 !== range2.start1 && range1.end2 !== range2.start2) return;

        const count1 = range1.end1 - range1.start1;
        const count2 = range2.end1 - range2.start1;

        const equalForward = expandForward(
            ctx,
            range1.end1,
            range1.end2,
            Math.min(count2, ctx.cmp1.length - range1.end1, ctx.cmp2.length - range1.end2),
        );
        const equalBackward = expandBackward(
            ctx,
            range2.start1,
            range2.start2,
            Math.min(count1, range2.start1, range2.start2),
        );

        if (equalForward === 0 && equalBackward === 0) return;

        // Merge heuristic: [A]B[B] -> [AB]B — the whole second block repeats
        // right after the first, so join them and re-process.
        if (equalForward === count2) {
            out.splice(out.length - 2, 2, {
                start1: range1.start1,
                end1: range1.end1 + count2,
                start2: range1.start2,
                end2: range1.end2 + count2,
            });
            continue;
        }
        // Merge heuristic: [A]A[B] -> A[AB].
        if (equalBackward === count1) {
            out.splice(out.length - 2, 2, {
                start1: range2.start1 - count1,
                end1: range2.end1,
                start2: range2.start2 - count1,
                end2: range2.end2,
            });
            continue;
        }

        const touchSide: 1 | 2 = range1.end1 === range2.start1 ? 1 : 2;
        const shift = getShift(ctx, touchSide, equalForward, equalBackward, range1, range2);
        if (shift !== 0) {
            out[out.length - 2] = {
                start1: range1.start1,
                end1: range1.end1 + shift,
                start2: range1.start2,
                end2: range1.end2 + shift,
            };
            out[out.length - 1] = {
                start1: range2.start1 + shift,
                end1: range2.end1,
                start2: range2.start2 + shift,
                end2: range2.end2,
            };
        }
        return;
    }
}

function expandForward(
    ctx: OptimizerContext,
    start1: number,
    start2: number,
    limit: number,
): number {
    let i = 0;
    while (i < limit && ctx.cmp1[start1 + i] === ctx.cmp2[start2 + i]) i++;
    return i;
}

function expandBackward(ctx: OptimizerContext, end1: number, end2: number, limit: number): number {
    let i = 0;
    while (i < limit && ctx.cmp1[end1 - 1 - i] === ctx.cmp2[end2 - 1 - i]) i++;
    return i;
}

/**
 * Slider placement ladder: try to place the boundary so the change block sits
 * adjacent to an empty line first, then an "unimportant" line. Checks the
 * unchanged (touching) side and the changed side at each threshold.
 */
function getShift(
    ctx: OptimizerContext,
    touchSide: 1 | 2,
    equalForward: number,
    equalBackward: number,
    range1: EqualRange,
    range2: EqualRange,
): number {
    for (const threshold of [0, UNIMPORTANT_LINE_CHAR_COUNT]) {
        let shift = unchangedBoundaryShift(
            ctx,
            touchSide,
            equalForward,
            equalBackward,
            range2,
            threshold,
        );
        if (shift !== null) return shift;
        shift = changedBoundaryShift(
            ctx,
            touchSide,
            equalForward,
            equalBackward,
            range1,
            range2,
            threshold,
        );
        if (shift !== null) return shift;
    }
    return 0;
}

function unchangedBoundaryShift(
    ctx: OptimizerContext,
    touchSide: 1 | 2,
    equalForward: number,
    equalBackward: number,
    range2: EqualRange,
    threshold: number,
): number | null {
    const nonSpace = touchSide === 1 ? ctx.nonSpace1 : ctx.nonSpace2;
    const start = touchSide === 1 ? range2.start1 : range2.start2;
    const forward = findNextUnimportantLine(nonSpace, start, equalForward + 1, threshold);
    const backward = findPrevUnimportantLine(nonSpace, start - 1, equalBackward + 1, threshold);
    return combineShifts(forward, backward);
}

function changedBoundaryShift(
    ctx: OptimizerContext,
    touchSide: 1 | 2,
    equalForward: number,
    equalBackward: number,
    range1: EqualRange,
    range2: EqualRange,
    threshold: number,
): number | null {
    const nonSpace = touchSide === 1 ? ctx.nonSpace2 : ctx.nonSpace1;
    const changeStart = touchSide === 1 ? range1.end2 : range1.end1;
    const changeEnd = touchSide === 1 ? range2.start2 : range2.start1;
    const forward = findNextUnimportantLine(nonSpace, changeStart, equalForward + 1, threshold);
    const backward = findPrevUnimportantLine(nonSpace, changeEnd - 1, equalBackward + 1, threshold);
    return combineShifts(forward, backward);
}

function findNextUnimportantLine(
    nonSpace: number[],
    offset: number,
    count: number,
    threshold: number,
): number {
    for (let i = 0; i < count; i++) {
        const index = offset + i;
        if (index < 0 || index >= nonSpace.length) break;
        if (nonSpace[index] <= threshold) return i;
    }
    return -1;
}

function findPrevUnimportantLine(
    nonSpace: number[],
    offset: number,
    count: number,
    threshold: number,
): number {
    for (let i = 0; i < count; i++) {
        const index = offset - i;
        if (index < 0 || index >= nonSpace.length) break;
        if (nonSpace[index] <= threshold) return i;
    }
    return -1;
}

// Mirrors IntelliJ ChunkOptimizer's shift combination: a 0 shift means the
// boundary already sits on an unimportant line, and when both directions
// offer a viable shift the forward one wins unconditionally.
function combineShifts(forward: number, backward: number): number | null {
    if (forward === -1 && backward === -1) return null;
    if (forward === 0 || backward === 0) return 0;
    return forward !== -1 ? forward : -backward;
}
