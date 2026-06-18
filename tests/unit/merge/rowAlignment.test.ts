// Spec-derived tests for the intra-hunk row aligner. The contract: given the
// ours/theirs line arrays of one conflict hunk, produce equal-length row arrays
// where similar lines share a row index and gaps are explicit null spacers,
// without ever reordering or losing source lines.

import { describe, expect, it } from "vitest";
import { alignConflictRows } from "../../../src/webviews/react/merge-editor/rowAlignment";

/** Collects the non-spacer texts of one aligned side, in row order. */
function texts(rows: Array<string | null>): string[] {
    return rows.filter((row): row is string => row !== null);
}

describe("alignConflictRows", () => {
    it("returns empty alignment for two empty sides", () => {
        const aligned = alignConflictRows([], []);
        expect(aligned.rowCount).toBe(0);
        expect(aligned.ours).toEqual([]);
        expect(aligned.theirs).toEqual([]);
    });

    it("fills one side with spacers when the other side is empty", () => {
        const aligned = alignConflictRows(["a();", "b();"], []);
        expect(aligned.rowCount).toBe(2);
        expect(aligned.ours).toEqual(["a();", "b();"]);
        expect(aligned.theirs).toEqual([null, null]);

        const mirrored = alignConflictRows([], ["x();"]);
        expect(mirrored.rowCount).toBe(1);
        expect(mirrored.ours).toEqual([null]);
        expect(mirrored.theirs).toEqual(["x();"]);
    });

    it("pairs identical lines on the same row without spacers", () => {
        const aligned = alignConflictRows(["same();", "more();"], ["same();", "more();"]);
        expect(aligned.rowCount).toBe(2);
        expect(aligned.ours).toEqual(["same();", "more();"]);
        expect(aligned.theirs).toEqual(["same();", "more();"]);
    });

    it("inserts spacers so a shared line aligns when each side adds around it", () => {
        // ours adds A before X; theirs adds B after X. IntelliJ renders:
        //   ours:   A    X    ·
        //   theirs: ·    X    B
        const aligned = alignConflictRows(["added_a();", "shared();"], ["shared();", "added_b();"]);
        expect(aligned.rowCount).toBe(3);
        expect(aligned.ours).toEqual(["added_a();", "shared();", null]);
        expect(aligned.theirs).toEqual([null, "shared();", "added_b();"]);
    });

    it("pairs modified-but-similar lines on the same row", () => {
        const aligned = alignConflictRows(
            ["const parsed = yaml.parse(raw);"],
            ["const parsed = toml.parse(raw);"],
        );
        expect(aligned.rowCount).toBe(1);
        expect(aligned.ours).toEqual(["const parsed = yaml.parse(raw);"]);
        expect(aligned.theirs).toEqual(["const parsed = toml.parse(raw);"]);
    });

    it("keeps a short rewrite row-paired with the start of a long rewrite", () => {
        const ours = ["this.config = this.mergeConfig(this.config, parsed);"];
        const theirs = [
            "// Deep merge with validation",
            "const merged = { ...this.config, ...parsed };",
            "this.config = merged;",
        ];
        const aligned = alignConflictRows(ours, theirs);
        expect(aligned.rowCount).toBe(3);
        expect(texts(aligned.ours)).toEqual(ours);
        expect(texts(aligned.theirs)).toEqual(theirs);
        // The single ours line must occupy exactly one row; the other two rows
        // are spacers on the ours side.
        expect(aligned.ours.filter((row) => row === null)).toHaveLength(2);
    });

    it("never reorders or rewrites source lines on either side", () => {
        const ours = ["b();", "a();", "z();", "q();"];
        const theirs = ["a();", "z();", "k();"];
        const aligned = alignConflictRows(ours, theirs);
        expect(texts(aligned.ours)).toEqual(ours);
        expect(texts(aligned.theirs)).toEqual(theirs);
        expect(aligned.ours).toHaveLength(aligned.rowCount);
        expect(aligned.theirs).toHaveLength(aligned.rowCount);
    });

    it("exposes source line indexes that skip spacer rows", () => {
        const aligned = alignConflictRows(["added_a();", "shared();"], ["shared();", "added_b();"]);
        expect(aligned.oursLineIndex).toEqual([0, 1, null]);
        expect(aligned.theirsLineIndex).toEqual([null, 0, 1]);
    });

    it("never pairs a row with two spacers", () => {
        const aligned = alignConflictRows(
            ["left_only_1();", "left_only_2();"],
            ["right_only();"],
        );
        for (let i = 0; i < aligned.rowCount; i++) {
            expect(aligned.ours[i] === null && aligned.theirs[i] === null).toBe(false);
        }
    });

    it("falls back to top-aligned rows for very large hunks", () => {
        const ours = Array.from({ length: 600 }, (_, i) => `ours_${i}();`);
        const theirs = Array.from({ length: 400 }, (_, i) => `theirs_${i}();`);
        const aligned = alignConflictRows(ours, theirs);
        expect(aligned.rowCount).toBe(600);
        expect(texts(aligned.ours)).toEqual(ours);
        expect(texts(aligned.theirs)).toEqual(theirs);
        // Top-aligned fallback: theirs content first, spacers after.
        expect(aligned.theirs[0]).toBe("theirs_0();");
        expect(aligned.theirs[599]).toBeNull();
    });
});
