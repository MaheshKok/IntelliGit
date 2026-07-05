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
        expect(
            ignoreWhitespaceSegments[0].lines.map((line) => line.replace(/\s+/g, " ").trim()),
        ).toEqual(["function x() {", "return 1;", "}"]);
    });

    it("auto-resolves whitespace-differing identical changes while preserving both sides' bytes", () => {
        // Both sides replace the same base line with the same code but
        // different indentation. With ignoreWhitespace the hunk must not
        // demand a decision, yet neither side's exact bytes may be lost.
        const base = "keep();\nold();\ntail();";
        const ours = "keep();\n  fresh();\ntail();";
        const theirs = "keep();\n\tfresh();\ntail();";

        const segments = parseConflictVersions(base, ours, theirs, { ignoreWhitespace: true });
        const conflict = segments.find((seg) => seg.type === "conflict");
        expect(conflict).toMatchObject({
            changeKind: "conflict",
            oursLines: ["  fresh();"],
            theirsLines: ["\tfresh();"],
            baseLines: ["old();"],
            autoResolvedLines: ["  fresh();"],
        });
    });

    it("trims byte-identical conflict edges into common segments when ignoring whitespace", () => {
        const base = "start();\nmiddle();\nfinish();";
        const ours = "start();\nours_core();\nshared_tail();\nfinish();";
        const theirs = "start();\ntheirs_core();\nshared_tail();\nfinish();";

        const segments = parseConflictVersions(base, ours, theirs, { ignoreWhitespace: true });
        const conflict = segments.find((seg) => seg.type === "conflict");
        expect(conflict).toMatchObject({
            changeKind: "conflict",
            oursLines: ["ours_core();"],
            theirsLines: ["theirs_core();"],
            baseLines: ["middle();"],
        });
        const commonLines = segments.flatMap((seg) => (seg.type === "common" ? seg.lines : []));
        expect(commonLines).toContain("shared_tail();");
    });

    it("keeps whitespace-differing shared edges inside the conflict so resolving theirs keeps its bytes", () => {
        const base = "start();\nmiddle();\nfinish();";
        const ours = "start();\nours_core();\n  shared_tail();\nfinish();";
        const theirs = "start();\ntheirs_core();\n\tshared_tail();\nfinish();";

        const segments = parseConflictVersions(base, ours, theirs, { ignoreWhitespace: true });
        const conflict = segments.find((seg) => seg.type === "conflict");
        expect(conflict).toMatchObject({
            changeKind: "conflict",
            oursLines: ["ours_core();", "  shared_tail();"],
            theirsLines: ["theirs_core();", "\tshared_tail();"],
        });
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

describe("auto-resolved lines", () => {
    it("auto-resolves non-overlapping word edits within the same line", () => {
        const base = "const count = step;";
        const ours = "const total = step;";
        const theirs = "const count = stride;";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(1);
        const conflict = segments[0];
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            baseLines: [base],
            oursLines: [ours],
            theirsLines: [theirs],
        });
        expect(conflict).toHaveProperty("autoResolvedLines", ["const total = stride;"]);
    });

    it("leaves a true conflict when both sides edit the same token", () => {
        const base = "const count = step;";
        const ours = "const COUNT = step;";
        const theirs = "const countTotal = step;";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(1);
        const conflict = segments[0];
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
        });
        expect(conflict).not.toHaveProperty("autoResolvedLines");
    });

    it("does not auto-resolve when the hunk line counts differ between versions", () => {
        const base = "value = compute(alpha, beta)";
        const ours = "value = compute(\n    alpha, beta\n)";
        const theirs = "value = compute(alpha, gamma)";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict" && s.changeKind === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).not.toHaveProperty("autoResolvedLines");
    });

    it("auto-resolves each line independently in a multi-line hunk", () => {
        const base = "first left right\nsecond left right";
        const ours = "first LEFT right\nsecond LEFT right";
        const theirs = "first left RIGHT\nsecond left RIGHT";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(1);
        const conflict = segments[0];
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            baseLines: ["first left right", "second left right"],
        });
        expect(conflict).toHaveProperty("autoResolvedLines", [
            "first LEFT RIGHT",
            "second LEFT RIGHT",
        ]);
    });

    it("does not auto-resolve when any single line in the hunk cannot be merged", () => {
        const base = "first left right\nsecond left right";
        const ours = "first LEFT right\nsecond CHANGED right";
        const theirs = "first left RIGHT\nsecond ALTERED right";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict" && s.changeKind === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).not.toHaveProperty("autoResolvedLines");
    });
});
