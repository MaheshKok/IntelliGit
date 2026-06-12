// Pure word-level diff algorithms for the merge editor.
// Computes token-level LCS, similarity ratios, and word-diff masks
// used to highlight intra-line changes in conflict hunks.

/**
 * Splits one line into whitespace, word, and punctuation tokens for stable
 * intra-line diffing.
 */
export function tokenizeWordDiff(line: string): string[] {
    if (line === "") return [];
    return line.match(/(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s]+)/g) ?? [line];
}

/** Normalizes whitespace before comparing candidate word-diff lines. */
export function normalizeLineForWordDiff(line: string): string {
    return line.replace(/\s+/g, " ").trim();
}

/** One step of a line-alignment path: pair both cursors, or skip one side. */
export type AlignmentTraceAction = "pair" | "skipA" | "skipB";

/** Gap penalty shared by every line-alignment consumer. */
const LINE_ALIGNMENT_GAP_PENALTY = -0.8;

/**
 * Upper bound on dynamic-programming cells for line alignment. Hunks above
 * this size fall back to cheaper strategies to keep the webview responsive.
 */
export const MAX_LINE_ALIGNMENT_CELLS = 50_000;

/**
 * Computes the full Needleman-Wunsch alignment path between two line arrays
 * using token-similarity pair scores. The returned action list always walks
 * both inputs to exhaustion, so consumers can derive padded row layouts or
 * compare-line mappings from the same path.
 */
export function computeLineAlignmentActions(
    lines: string[],
    compareLines: string[],
): AlignmentTraceAction[] {
    const m = lines.length;
    const n = compareLines.length;
    const gapPenalty = LINE_ALIGNMENT_GAP_PENALTY;
    const pairScoreCache = new Map<string, number>();
    const scorePair = (i: number, j: number): number => {
        const key = `${i}:${j}`;
        const cached = pairScoreCache.get(key);
        if (cached !== undefined) return cached;

        const a = lines[i];
        const b = compareLines[j];
        let score: number;
        if (a === b) {
            score = 4;
        } else {
            const sim = tokenSimilarityRatio(a, b);
            if (normalizeLineForWordDiff(a) === normalizeLineForWordDiff(b)) score = 3.5;
            else if (sim >= 0.78) score = 2.4 + sim;
            else if (sim >= 0.52) score = 1 + sim;
            else if (sim >= 0.34) score = 0.2 + sim * 0.4;
            else score = -1.6;
        }

        pairScoreCache.set(key, score);
        return score;
    };

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
    const trace: AlignmentTraceAction[][] = Array.from({ length: m + 1 }, () =>
        Array<AlignmentTraceAction>(n + 1).fill("pair"),
    );

    for (let i = m - 1; i >= 0; i--) {
        dp[i][n] = dp[i + 1][n] + gapPenalty;
        trace[i][n] = "skipA";
    }
    for (let j = n - 1; j >= 0; j--) {
        dp[m][j] = dp[m][j + 1] + gapPenalty;
        trace[m][j] = "skipB";
    }

    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            const pair = dp[i + 1][j + 1] + scorePair(i, j);
            const skipA = dp[i + 1][j] + gapPenalty;
            const skipB = dp[i][j + 1] + gapPenalty;

            if (pair >= skipA && pair >= skipB) {
                dp[i][j] = pair;
                trace[i][j] = "pair";
            } else if (skipA >= skipB) {
                dp[i][j] = skipA;
                trace[i][j] = "skipA";
            } else {
                dp[i][j] = skipB;
                trace[i][j] = "skipB";
            }
        }
    }

    const actions: AlignmentTraceAction[] = [];
    let walkI = 0;
    let walkJ = 0;
    while (walkI < m || walkJ < n) {
        const action: AlignmentTraceAction =
            walkI < m && walkJ < n ? trace[walkI][walkJ] : walkI < m ? "skipA" : "skipB";
        actions.push(action);
        if (action === "pair") {
            walkI++;
            walkJ++;
        } else if (action === "skipA") {
            walkI++;
        } else {
            walkJ++;
        }
    }
    return actions;
}

/**
 * Finds token pairs shared by two token streams using LCS, with a greedy
 * fallback for very large matrices to avoid blocking the webview.
 */
export function computeTokenLcsPairs(a: string[], b: string[]): Array<[number, number]> {
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return [];

    if (m * n > 40_000) {
        // Greedy fallback to avoid expensive matrices on long lines.
        const pairs: Array<[number, number]> = [];
        let j = 0;
        for (let i = 0; i < m && j < n; i++) {
            while (j < n && b[j] !== a[i]) j++;
            if (j < n) {
                pairs.push([i, j]);
                j++;
            }
        }
        return pairs;
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const pairs: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

/** Computes a symmetric token similarity ratio for deciding word-diff eligibility. */
export function tokenSimilarityRatio(a: string, b: string): number {
    if (a === b) return 1;
    const aNorm = normalizeLineForWordDiff(a);
    const bNorm = normalizeLineForWordDiff(b);
    if (aNorm === bNorm) return 0.98;
    if (!aNorm || !bNorm) return 0;

    const aTokens = tokenizeWordDiff(aNorm);
    const bTokens = tokenizeWordDiff(bNorm);
    if (aTokens.length === 0 && bTokens.length === 0) return 1;
    if (aTokens.length === 0 || bTokens.length === 0) return 0;

    const lcsLen = computeTokenLcsPairs(aTokens, bTokens).length;
    return (2 * lcsLen) / (aTokens.length + bTokens.length);
}

/**
 * Aligns comparison lines to rendered lines so word highlighting compares likely
 * counterparts rather than same-index rows after insertions or deletions.
 */
export function alignCompareLinesForWordDiff(lines: string[], compareLines: string[]): string[] {
    if (lines.length === 0) return [];
    if (compareLines.length === 0) return Array<string>(lines.length).fill("");
    if (lines.length === compareLines.length) {
        return [...compareLines];
    }

    const m = lines.length;
    const n = compareLines.length;

    // Guard against unbounded O(m*n) DP allocation for very large diffs.
    if (m * n > MAX_LINE_ALIGNMENT_CELLS) {
        return lines.map((_, i) => (i < compareLines.length ? compareLines[i] : ""));
    }

    const actions = computeLineAlignmentActions(lines, compareLines);
    const aligned = new Array<string>(m).fill("");
    let i = 0;
    let j = 0;
    for (const action of actions) {
        if (action === "pair") {
            // Only pair lines for word-diff if they are at least moderately similar.
            aligned[i] =
                tokenSimilarityRatio(lines[i], compareLines[j]) >= 0.28 ? compareLines[j] : "";
            i++;
            j++;
        } else if (action === "skipA") {
            aligned[i] = "";
            i++;
        } else {
            j++;
        }
    }

    return aligned;
}

/**
 * Marks tokens that differ from the aligned comparison line; unchanged LCS tokens
 * are left unhighlighted.
 */
export function buildWordDiffMask(line: string, compareLine: string): boolean[] {
    const tokens = tokenizeWordDiff(line);
    const compareTokens = tokenizeWordDiff(compareLine);
    const mask = tokens.map(() => true);

    if (tokens.length === 0) return mask;
    if (line === compareLine) return tokens.map(() => false);

    const lcs = computeTokenLcsPairs(tokens, compareTokens);
    for (const [i] of lcs) {
        mask[i] = false;
    }

    return mask;
}
