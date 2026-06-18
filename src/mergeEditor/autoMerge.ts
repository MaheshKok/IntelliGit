// Token-level three-way auto-merger for conflict hunks. When ours and theirs
// edit disjoint token regions of the same base lines, the two edits compose
// into one merged result the same way IntelliJ's "magic resolve" does. Any
// ambiguity (overlapping edits, same-point insertions, line-count changes,
// deletion versus edit) returns null so the hunk stays a manual conflict.

import { computeTokenLcsPairs, tokenizeWordDiff } from "./wordDiff";

/** One contiguous token-level edit mapping a base range to a modified range. */
interface TokenEditRange {
    baseStart: number;
    baseEnd: number;
    modStart: number;
    modEnd: number;
}

/**
 * Attempts to merge a conflict hunk where both sides changed the same lines.
 *
 * Requirements for success: all three versions have the same line count, and
 * on every line the two sides' token edits never overlap and never insert at
 * the same position. Returns the merged lines, or null when any line cannot
 * be merged safely. Never guesses: a null result means the hunk genuinely
 * needs a human decision.
 */
export function tryAutoMergeLines(
    baseLines: string[],
    oursLines: string[],
    theirsLines: string[],
): string[] | null {
    if (baseLines.length !== oursLines.length || baseLines.length !== theirsLines.length) {
        return null;
    }
    const merged: string[] = [];
    for (let i = 0; i < baseLines.length; i++) {
        const line = tryAutoMergeLine(baseLines[i], oursLines[i], theirsLines[i]);
        if (line === null) return null;
        merged.push(line);
    }
    return merged;
}

/**
 * Merges one line: trivial cases short-circuit (same change, one side kept
 * base); otherwise both sides' token edits are composed when disjoint.
 */
function tryAutoMergeLine(base: string, ours: string, theirs: string): string | null {
    if (ours === theirs) return ours;
    if (ours === base) return theirs;
    if (theirs === base) return ours;
    // A fully deleted line versus an edited line is a real conflict: composing
    // them would silently resurrect or drop code the user meant to decide on.
    if (ours === "" || theirs === "") return null;

    const baseTokens = tokenizeWordDiff(base);
    const oursTokens = tokenizeWordDiff(ours);
    const theirsTokens = tokenizeWordDiff(theirs);
    const oursEdits = tokenEditRanges(baseTokens, oursTokens);
    const theirsEdits = tokenEditRanges(baseTokens, theirsTokens);
    if (editsConflict(oursEdits, theirsEdits)) return null;

    interface TaggedEdit extends TokenEditRange {
        modTokens: string[];
    }
    const tagged: TaggedEdit[] = [
        ...oursEdits.map((edit) => ({
            ...edit,
            modTokens: oursTokens.slice(edit.modStart, edit.modEnd),
        })),
        ...theirsEdits.map((edit) => ({
            ...edit,
            modTokens: theirsTokens.slice(edit.modStart, edit.modEnd),
        })),
    ].sort((a, b) => {
        if (a.baseStart !== b.baseStart) return a.baseStart - b.baseStart;
        // At a shared boundary the pure insertion applies before the
        // replacement that starts there, mirroring "insert before" semantics.
        return a.baseEnd - b.baseEnd;
    });

    const result: string[] = [];
    let cursor = 0;
    for (const edit of tagged) {
        result.push(...baseTokens.slice(cursor, edit.baseStart));
        result.push(...edit.modTokens);
        cursor = Math.max(cursor, edit.baseEnd);
    }
    result.push(...baseTokens.slice(cursor));
    return result.join("");
}

/**
 * Converts the token LCS between base and a modified line into contiguous
 * edit ranges, mirroring the line-level diff construction.
 */
function tokenEditRanges(baseTokens: string[], modTokens: string[]): TokenEditRange[] {
    const lcs = computeTokenLcsPairs(baseTokens, modTokens);
    const edits: TokenEditRange[] = [];
    let bi = 0;
    let mi = 0;
    for (const [lb, lm] of lcs) {
        if (bi < lb || mi < lm) {
            edits.push({ baseStart: bi, baseEnd: lb, modStart: mi, modEnd: lm });
        }
        bi = lb + 1;
        mi = lm + 1;
    }
    if (bi < baseTokens.length || mi < modTokens.length) {
        edits.push({
            baseStart: bi,
            baseEnd: baseTokens.length,
            modStart: mi,
            modEnd: modTokens.length,
        });
    }
    return edits;
}

/**
 * Reports whether any ours edit touches a base region also touched by a
 * theirs edit. Two range edits conflict when their base ranges overlap; two
 * pure insertions conflict when they target the same position, because their
 * relative order would be a guess.
 */
function editsConflict(ours: TokenEditRange[], theirs: TokenEditRange[]): boolean {
    for (const a of ours) {
        for (const b of theirs) {
            const overlap = a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
            const bothInsertSamePoint =
                a.baseStart === a.baseEnd &&
                b.baseStart === b.baseEnd &&
                a.baseStart === b.baseStart;
            if (overlap || bothInsertSamePoint) return true;
        }
    }
    return false;
}
