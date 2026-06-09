// Tests for merge editor state management in merge-editor/mergeState.ts.

import { describe, it, expect } from "vitest";
import {
    reducer,
    getResultLines,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
} from "../../../src/webviews/react/merge-editor/mergeState";
import type {
    MergeEditorData,
    ConflictSegment,
    MergeSegment,
} from "../../../src/webviews/react/merge-editor/types";

function makeConflict(overrides: Partial<ConflictSegment> = {}): ConflictSegment {
    return {
        type: "conflict",
        id: 0,
        baseLines: ["base"],
        oursLines: ["ours"],
        theirsLines: ["theirs"],
        changeKind: "conflict",
        ...overrides,
    };
}

function makeData(segments: MergeSegment[]): MergeEditorData {
    return {
        filePath: "test.ts",
        oursLabel: "HEAD",
        theirsLabel: "feature",
        segments,
        eol: "\n",
        hasTrailingNewline: true,
    };
}

describe("reducer", () => {
    const initial = { data: null, error: null, resolutions: {} };

    it("SET_DATA replaces data and clears resolutions", () => {
        const data = makeData([]);
        const state = reducer(
            { ...initial, resolutions: { 0: "ours" } },
            { type: "SET_DATA", data },
        );
        expect(state.data).toBe(data);
        expect(state.error).toBeNull();
        expect(state.resolutions).toEqual({});
    });

    it("SET_ERROR sets error message", () => {
        const state = reducer(initial, { type: "SET_ERROR", message: "fail" });
        expect(state.error).toBe("fail");
    });

    it("RESOLVE_HUNK adds resolution immutably", () => {
        const state = reducer(initial, { type: "RESOLVE_HUNK", id: 1, resolution: "ours" });
        expect(state.resolutions[1]).toBe("ours");
        expect(initial.resolutions).toEqual({});
    });
});

describe("getResultLines", () => {
    const segment = makeConflict();

    it("returns oursLines for 'ours' resolution", () => {
        expect(getResultLines(segment, "ours")).toEqual(["ours"]);
    });

    it("returns theirsLines for 'theirs' resolution", () => {
        expect(getResultLines(segment, "theirs")).toEqual(["theirs"]);
    });

    it("returns both for 'both' resolution", () => {
        expect(getResultLines(segment, "both")).toEqual(["ours", "theirs"]);
    });

    it("returns empty for 'none' resolution", () => {
        expect(getResultLines(segment, "none")).toEqual([]);
    });

    it("returns baseLines for unresolved conflict", () => {
        expect(getResultLines(segment, undefined)).toEqual(["base"]);
    });

    it("auto-resolves ours-only to oursLines", () => {
        const seg = makeConflict({ changeKind: "ours-only" });
        expect(getResultLines(seg, undefined)).toEqual(["ours"]);
    });

    it("auto-resolves theirs-only to theirsLines", () => {
        const seg = makeConflict({ changeKind: "theirs-only" });
        expect(getResultLines(seg, undefined)).toEqual(["theirs"]);
    });
});

describe("buildResultContent", () => {
    it("joins common and resolved conflict lines", () => {
        const data = makeData([
            { type: "common", lines: ["line1"] },
            makeConflict({ id: 0 }),
            { type: "common", lines: ["line3"] },
        ]);
        const result = buildResultContent(data, { 0: "ours" });
        expect(result).toBe("line1\nours\nline3\n");
    });

    it("omits trailing newline when hasTrailingNewline is false", () => {
        const data = makeData([{ type: "common", lines: ["only"] }]);
        data.hasTrailingNewline = false;
        expect(buildResultContent(data, {})).toBe("only");
    });

    it("preserves a single blank line when trailing newline is present", () => {
        const data = makeData([{ type: "common", lines: [""] }]);
        expect(buildResultContent(data, {})).toBe("\n");
    });
});

describe("allResolved", () => {
    it("returns true when all true conflicts are resolved", () => {
        const segments: MergeSegment[] = [
            makeConflict({ id: 0 }),
            makeConflict({ id: 1, changeKind: "ours-only" }),
        ];
        expect(allResolved(segments, { 0: "ours" })).toBe(true);
    });

    it("returns false when a true conflict is unresolved", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 })];
        expect(allResolved(segments, {})).toBe(false);
    });

    it("returns true for common segments only", () => {
        const segments: MergeSegment[] = [{ type: "common", lines: ["a"] }];
        expect(allResolved(segments, {})).toBe(true);
    });
});

describe("trueConflictCount", () => {
    it("counts only true conflicts", () => {
        const segments: MergeSegment[] = [
            makeConflict({ id: 0 }),
            makeConflict({ id: 1, changeKind: "ours-only" }),
            makeConflict({ id: 2 }),
        ];
        expect(trueConflictCount(segments)).toBe(2);
    });
});

describe("resolvedTrueConflictCount", () => {
    it("counts resolved true conflicts", () => {
        const segments: MergeSegment[] = [
            makeConflict({ id: 0 }),
            makeConflict({ id: 1 }),
        ];
        expect(resolvedTrueConflictCount(segments, { 0: "ours" })).toBe(1);
    });
});

describe("paneChangeCount", () => {
    it("counts ours-side changes (excludes theirs-only)", () => {
        const segments: MergeSegment[] = [
            makeConflict({ changeKind: "conflict" }),
            makeConflict({ changeKind: "ours-only" }),
            makeConflict({ changeKind: "theirs-only" }),
        ];
        expect(paneChangeCount(segments, "ours")).toBe(2);
    });

    it("counts theirs-side changes (excludes ours-only)", () => {
        const segments: MergeSegment[] = [
            makeConflict({ changeKind: "conflict" }),
            makeConflict({ changeKind: "ours-only" }),
            makeConflict({ changeKind: "theirs-only" }),
        ];
        expect(paneChangeCount(segments, "theirs")).toBe(2);
    });
});
