import { describe, it, expect } from "vitest";
import { parseConflictVersions } from "../../../src/mergeEditor/conflictParser";

describe("merge conflict parser", () => {
    it("handles insertion-only changes without hanging", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "a\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({
            type: "conflict",
            changeKind: "ours-only",
            oursLines: ["x"],
            theirsLines: [],
            baseLines: [],
        });
        expect(segments[1]).toEqual({
            type: "common",
            lines: ["a", "b"],
        });
    });

    it("treats identical insertions as common content", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "x\na\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toEqual([
            {
                type: "common",
                lines: ["x", "a", "b"],
            },
        ]);
    });

    it("creates a conflict when both sides insert different lines", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "y\na\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            oursLines: ["x"],
            theirsLines: ["y"],
            baseLines: [],
        });
        expect(segments[1]).toEqual({
            type: "common",
            lines: ["a", "b"],
        });
    });

    it("classifies theirs-only change as theirs-only", () => {
        const base = "a\nb";
        const ours = "a\nb";
        const theirs = "a\nz\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "theirs-only",
        });
    });

    it("classifies both-sides-different as a true conflict", () => {
        const base = "a\nb\nc";
        const ours = "a\nX\nc";
        const theirs = "a\nY\nc";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            oursLines: ["X"],
            theirsLines: ["Y"],
            baseLines: ["b"],
        });
    });

    it("can ignore whitespace-only line differences", () => {
        const base = "function x() {\n  return 1;\n}";
        const ours = "function x() {\n    return 1;\n}";
        const theirs = "function x() {\n\treturn 1;\n}";

        const strictSegments = parseConflictVersions(base, ours, theirs);
        const ignoreWhitespaceSegments = parseConflictVersions(base, ours, theirs, {
            ignoreWhitespace: true,
        });

        expect(strictSegments.some((seg) => seg.type === "conflict")).toBe(true);
        expect(ignoreWhitespaceSegments).toHaveLength(1);
        expect(ignoreWhitespaceSegments[0]).toMatchObject({ type: "common" });
        if (ignoreWhitespaceSegments[0].type !== "common") {
            throw new Error("Expected a common segment");
        }
        expect(ignoreWhitespaceSegments[0].lines.map((line) => line.replace(/\s+/g, " ").trim())).toEqual(
            ["function x() {", "return 1;", "}"],
        );
    });

    it("does not create a synthetic empty line for trailing newlines", () => {
        const text = "a\nb\n";
        const segments = parseConflictVersions(text, text, text);

        expect(segments).toEqual([
            {
                type: "common",
                lines: ["a", "b"],
            },
        ]);
    });

    it("coalesces overlapping cross-side edits so later edits are not skipped", () => {
        const base = "a\nb\nc\nd\ne";
        const ours = "a\nB\nC\nD\ne";
        const theirs = "a\nb\nX\nd\ne";

        const segments = parseConflictVersions(base, ours, theirs);
        const conflict = segments.find((segment) => segment.type === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            baseLines: ["b", "c", "d"],
            oursLines: ["B", "C", "D"],
            theirsLines: ["b", "X", "d"],
        });
    });
});
