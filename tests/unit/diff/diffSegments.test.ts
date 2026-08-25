import { describe, expect, it } from "vitest";
import { computeDiffSegments } from "../../../src/diff/diffSegments";
import { MAX_LCS_CELLS } from "../../../src/mergeEditor/lineDiff";

function flattenSide(
    segments: ReturnType<typeof computeDiffSegments>["segments"],
    side: "left" | "right",
): string[] {
    return segments.flatMap((segment) => segment[side]);
}

describe("computeDiffSegments", () => {
    it("models a plain modification", () => {
        const result = computeDiffSegments("before\na\nafter", "before\nb\nafter");

        expect(result.segments).toEqual([
            { type: "common", left: ["before"], right: ["before"] },
            { type: "changed", left: ["a"], right: ["b"] },
            { type: "common", left: ["after"], right: ["after"] },
        ]);
    });

    it("records a lone carriage return as its own EOL style, not as a line feed", () => {
        // Two byte-different files whose only difference is the newline representation.
        // Folding CR into "lf" made both sides report the same EOL, cleared the
        // newline-difference marker, and rendered them as identical text.
        const result = computeDiffSegments("a\rb\r", "a\nb\n");

        expect(result.left.eol).toBe("cr");
        expect(result.right.eol).toBe("lf");
        expect(result.newlineDifference).toBe(true);
    });

    it("still reports a CRLF side and an LF side as differing only in newlines", () => {
        const result = computeDiffSegments("a\r\nb\r\n", "a\nb\n");

        expect(result.left.eol).toBe("crlf");
        expect(result.right.eol).toBe("lf");
        expect(result.newlineDifference).toBe(true);
    });

    it("reports a mixed-EOL side as mixed rather than picking one style", () => {
        const result = computeDiffSegments("a\rb\n", "a\nb\n");

        expect(result.left.eol).toBe("mixed");
        expect(result.right.eol).toBe("lf");
    });

    it("models a pure insertion with an empty left side", () => {
        const result = computeDiffSegments("a\nc", "a\nb\nc");

        expect(result.segments).toContainEqual({ type: "changed", left: [], right: ["b"] });
    });

    it("models a pure deletion with an empty right side", () => {
        const result = computeDiffSegments("a\nb\nc", "a\nc");

        expect(result.segments).toContainEqual({ type: "changed", left: ["b"], right: [] });
    });

    it("marks a terminal-newline-only difference without changing line content", () => {
        expect(computeDiffSegments("a", "a\n").newlineDifference).toBe(true);
        expect(computeDiffSegments("a\n", "a\n").newlineDifference).toBe(false);
    });

    it("reports CRLF and LF metadata separately", () => {
        const result = computeDiffSegments("a\r\nb\r\n", "a\nb\n");

        expect(result.left).toEqual({ eol: "crlf", terminalNewline: true });
        expect(result.right).toEqual({ eol: "lf", terminalNewline: true });
        expect(result.newlineDifference).toBe(true);
    });

    it("changes line alignment when whitespace is ignored", () => {
        const left = "head\n  target  \ntail";
        const right = "head\ntarget\ntail";
        const exact = computeDiffSegments(left, right);
        const ignored = computeDiffSegments(left, right, { ignoreWhitespace: true });

        expect(exact.segments.some((segment) => segment.type === "changed")).toBe(true);
        expect(ignored.segments).toEqual([
            {
                type: "common",
                left: ["head", "  target  ", "tail"],
                right: ["head", "target", "tail"],
            },
        ]);
    });

    it("reconstructs both sides through the greedy fallback for huge inputs", () => {
        // Keep the input above the DP guard so this regression covers the greedy fallback.
        const lineCount = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 1;
        const leftLines = Array.from({ length: lineCount }, (_, index) => `left-${index}`);
        const rightLines = Array.from({ length: lineCount }, (_, index) => `right-${index}`);
        const result = computeDiffSegments(leftLines.join("\n"), rightLines.join("\n"));

        expect(flattenSide(result.segments, "left")).toEqual(leftLines);
        expect(flattenSide(result.segments, "right")).toEqual(rightLines);
    });
});
