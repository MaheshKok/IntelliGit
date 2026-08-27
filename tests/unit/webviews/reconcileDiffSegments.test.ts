import { describe, expect, it } from "vitest";
import type { DiffSegment, DiffViewerData } from "../../../src/webviews/protocol/diffViewerTypes";
import {
    reconcileDiffSegments,
    reconcileDiffViewerData,
} from "../../../src/webviews/react/diff-viewer/reconcileDiffSegments";

const common = (line: string): DiffSegment => ({ type: "common", left: [line], right: [line] });
const changed = (left: string[], right: string[]): DiffSegment => ({
    type: "changed",
    left,
    right,
});

/** Creates a complete host payload so the reconciliation contract covers every unrelated field. */
function payload(segments: DiffSegment[], overrides: Partial<DiffViewerData> = {}): DiffViewerData {
    return {
        path: "src/example.ts",
        leftLabel: "Before",
        rightLabel: "After",
        segments,
        languageId: "typescript",
        left: { eol: "lf", terminalNewline: true },
        right: { eol: "crlf", terminalNewline: false },
        newlineDifference: true,
        ignoreWhitespace: false,
        loadError: "refresh failed",
        documentId: "document-7",
        editablePane: "right",
        editableText: "const result = 2;",
        documentVersion: 42,
        editableReseedToken: 8,
        ...overrides,
    };
}

describe("reconcileDiffSegments", () => {
    it("returns a new payload and segment array while preserving new host fields", () => {
        const next = payload([common("shared")], { path: "src/new.ts", documentVersion: 43 });

        const reconciled = reconcileDiffViewerData(null, next);

        expect(reconciled).not.toBe(next);
        expect(reconciled.segments).not.toBe(next.segments);
        expect(reconciled.segments[0]).toBe(next.segments[0]);
        expect({ ...reconciled, segments: next.segments }).toEqual(next);
    });

    it("reuses exact prefix and suffix objects while replacing the changed middle segment", () => {
        const prefix = common("prefix");
        const previousMiddle = changed(["before"], ["before"]);
        const suffix = common("suffix");
        const nextMiddle = changed(["before"], ["after"]);

        const reconciled = reconcileDiffSegments(
            [prefix, previousMiddle, suffix],
            [common("prefix"), nextMiddle, common("suffix")],
        );

        expect(reconciled[0]).toBe(prefix);
        expect(reconciled[1].right).toEqual(["after"]);
        expect(reconciled[1]).not.toBe(previousMiddle);
        expect(reconciled[2]).toBe(suffix);
    });

    it("preserves suffix identity across a middle insertion", () => {
        const prefix = common("prefix");
        const suffixOne = common("suffix-one");
        const suffixTwo = common("suffix-two");

        const reconciled = reconcileDiffSegments(
            [prefix, suffixOne, suffixTwo],
            [
                common("prefix"),
                changed([], ["inserted"]),
                common("suffix-one"),
                common("suffix-two"),
            ],
        );

        expect(reconciled[0]).toBe(prefix);
        expect(reconciled[2]).toBe(suffixOne);
        expect(reconciled[3]).toBe(suffixTwo);
    });

    it("preserves suffix identity across a middle deletion", () => {
        const prefix = common("prefix");
        const removed = changed(["removed"], []);
        const suffixOne = common("suffix-one");
        const suffixTwo = common("suffix-two");

        const reconciled = reconcileDiffSegments(
            [prefix, removed, suffixOne, suffixTwo],
            [common("prefix"), common("suffix-one"), common("suffix-two")],
        );

        expect(reconciled[0]).toBe(prefix);
        expect(reconciled[1]).toBe(suffixOne);
        expect(reconciled[2]).toBe(suffixTwo);
    });

    it("does not reuse a segment when its type, left line, or right line differs", () => {
        const typeChanged = common("same-lines");
        const leftChanged = changed(["left-before"], ["right-stable"]);
        const rightChanged = changed(["left-stable"], ["right-before"]);

        const reconciled = reconcileDiffSegments(
            [typeChanged, leftChanged, rightChanged],
            [
                changed(["same-lines"], ["same-lines"]),
                changed(["left-after"], ["right-stable"]),
                changed(["left-stable"], ["right-after"]),
            ],
        );

        expect(reconciled[0]).not.toBe(typeChanged);
        expect(reconciled[1]).not.toBe(leftChanged);
        expect(reconciled[2]).not.toBe(rightChanged);
    });

    it("does not reuse one repeated previous segment object twice", () => {
        const firstRepeat = common("repeat");
        const secondRepeat = common("repeat");
        const nextRepeatedMiddle = common("repeat");

        const reconciled = reconcileDiffSegments(
            [firstRepeat, secondRepeat],
            [common("repeat"), changed([], ["inserted"]), nextRepeatedMiddle, common("repeat")],
        );

        expect(reconciled[0]).toBe(firstRepeat);
        expect(reconciled[2]).toBe(nextRepeatedMiddle);
        expect(reconciled[3]).toBe(secondRepeat);
        expect(new Set(reconciled)).toHaveLength(reconciled.length);
    });
});
