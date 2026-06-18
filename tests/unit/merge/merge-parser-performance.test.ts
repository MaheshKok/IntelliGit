// Performance regression tests for the three-way conflict parser.
// These guard against quadratic blowups in the diff and segment-building
// pipeline using a large synthetic file, and verify output integrity so a
// fast-but-wrong implementation cannot pass.

import { describe, expect, it } from "vitest";
import {
    parseConflictVersions,
    type ConflictSegment,
    type MergeSegment,
} from "../../../src/mergeEditor/conflictParser";

const TOTAL_LINES = 12_000;
const OURS_EDIT_EVERY = 40;
const THEIRS_EDIT_EVERY = 60;

interface SyntheticVersions {
    base: string;
    ours: string;
    theirs: string;
    oursLines: string[];
    theirsLines: string[];
}

/**
 * Builds a 12k-line file where ours edits every 40th line and theirs edits
 * every 60th line; every 120th line both sides collide into a true conflict.
 */
function buildSyntheticVersions(): SyntheticVersions {
    const baseLines: string[] = [];
    const oursLines: string[] = [];
    const theirsLines: string[] = [];
    for (let i = 0; i < TOTAL_LINES; i++) {
        const line = `const value_${i} = compute(${i});`;
        baseLines.push(line);
        oursLines.push(i % OURS_EDIT_EVERY === 0 ? `${line} // ours-${i}` : line);
        theirsLines.push(i % THEIRS_EDIT_EVERY === 0 ? `${line} // theirs-${i}` : line);
    }
    return {
        base: baseLines.join("\n") + "\n",
        ours: oursLines.join("\n") + "\n",
        theirs: theirsLines.join("\n") + "\n",
        oursLines,
        theirsLines,
    };
}

function reconstructSide(segments: MergeSegment[], side: "ours" | "theirs"): string[] {
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...(side === "ours" ? seg.oursLines : seg.theirsLines));
        }
    }
    return lines;
}

describe("conflict parser performance", () => {
    it("parses a 12k-line file with hundreds of edits quickly and losslessly", () => {
        const versions = buildSyntheticVersions();

        const startedAt = performance.now();
        const segments = parseConflictVersions(versions.base, versions.ours, versions.theirs);
        const elapsedMs = performance.now() - startedAt;

        // Regression guard: the LCS pipeline with the greedy fallback handles
        // this size in well under a second; 3s leaves headroom for slow CI.
        expect(elapsedMs).toBeLessThan(3_000);

        // Integrity: replaying each side from the segments must reproduce the
        // exact input, otherwise the parser dropped or duplicated lines.
        expect(reconstructSide(segments, "ours")).toEqual(versions.oursLines);
        expect(reconstructSide(segments, "theirs")).toEqual(versions.theirsLines);

        // Both sides collide on every 120th line (lcm of 40 and 60), so the
        // parser must emit exactly that many true conflicts.
        const trueConflicts = segments.filter(
            (seg): seg is ConflictSegment => seg.type === "conflict" && seg.changeKind === "conflict",
        );
        expect(trueConflicts).toHaveLength(TOTAL_LINES / 120);

        // One-sided hunks must cover the remaining ours/theirs edits.
        const oursOnly = segments.filter(
            (seg) => seg.type === "conflict" && seg.changeKind === "ours-only",
        );
        const theirsOnly = segments.filter(
            (seg) => seg.type === "conflict" && seg.changeKind === "theirs-only",
        );
        expect(oursOnly).toHaveLength(TOTAL_LINES / 40 - TOTAL_LINES / 120);
        expect(theirsOnly).toHaveLength(TOTAL_LINES / 60 - TOTAL_LINES / 120);
    });

    it("re-parses with ignoreWhitespace without pathological slowdown", () => {
        const versions = buildSyntheticVersions();

        const startedAt = performance.now();
        const segments = parseConflictVersions(versions.base, versions.ours, versions.theirs, {
            ignoreWhitespace: true,
        });
        const elapsedMs = performance.now() - startedAt;

        expect(elapsedMs).toBeLessThan(3_000);
        expect(reconstructSide(segments, "ours")).toEqual(versions.oursLines);
    });
});
