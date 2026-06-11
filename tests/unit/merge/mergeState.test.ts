// Tests for merge editor state management in merge-editor/mergeState.ts.

import { describe, it, expect } from "vitest";
import {
    reducer,
    getResultLines,
    getEffectiveResultLines,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
    splitEditedText,
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
    const initial = { data: null, error: null, resolutions: {}, edits: {} };

    it("SET_DATA replaces data and clears resolutions and edits", () => {
        const data = makeData([]);
        const state = reducer(
            { ...initial, resolutions: { 0: "ours" }, edits: { 0: ["custom"] } },
            { type: "SET_DATA", data },
        );
        expect(state.data).toBe(data);
        expect(state.error).toBeNull();
        expect(state.resolutions).toEqual({});
        expect(state.edits).toEqual({});
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

    it("RESOLVE_HUNK discards a manual edit on the same hunk", () => {
        const edited = reducer(initial, { type: "EDIT_HUNK_RESULT", id: 1, lines: ["custom"] });
        const state = reducer(edited, { type: "RESOLVE_HUNK", id: 1, resolution: "theirs" });
        expect(state.resolutions[1]).toBe("theirs");
        expect(state.edits[1]).toBeUndefined();
    });

    it("RESOLVE_HUNK keeps edits on other hunks", () => {
        const edited = reducer(initial, { type: "EDIT_HUNK_RESULT", id: 2, lines: ["keep"] });
        const state = reducer(edited, { type: "RESOLVE_HUNK", id: 1, resolution: "ours" });
        expect(state.edits[2]).toEqual(["keep"]);
    });

    it("EDIT_HUNK_RESULT stores edited lines immutably", () => {
        const state = reducer(initial, { type: "EDIT_HUNK_RESULT", id: 3, lines: ["a", "b"] });
        expect(state.edits[3]).toEqual(["a", "b"]);
        expect(initial.edits).toEqual({});
    });

    it("EDIT_HUNK_RESULT accepts an empty edit as block deletion", () => {
        const state = reducer(initial, { type: "EDIT_HUNK_RESULT", id: 3, lines: [] });
        expect(state.edits[3]).toEqual([]);
    });

    it("CLEAR_HUNK_EDIT removes only the targeted edit", () => {
        let state = reducer(initial, { type: "EDIT_HUNK_RESULT", id: 1, lines: ["x"] });
        state = reducer(state, { type: "EDIT_HUNK_RESULT", id: 2, lines: ["y"] });
        state = reducer(state, { type: "CLEAR_HUNK_EDIT", id: 1 });
        expect(state.edits[1]).toBeUndefined();
        expect(state.edits[2]).toEqual(["y"]);
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

    it("uses manual edits over side resolutions", () => {
        const data = makeData([{ type: "common", lines: ["line1"] }, makeConflict({ id: 0 })]);
        const result = buildResultContent(data, { 0: "ours" }, { 0: ["custom();"] });
        expect(result).toBe("line1\ncustom();\n");
    });

    it("drops a block entirely when the edit is empty", () => {
        const data = makeData([
            { type: "common", lines: ["line1"] },
            makeConflict({ id: 0 }),
            { type: "common", lines: ["line3"] },
        ]);
        const result = buildResultContent(data, {}, { 0: [] });
        expect(result).toBe("line1\nline3\n");
    });

    it("preserves CRLF EOL with edited lines", () => {
        const data = makeData([makeConflict({ id: 0 })]);
        data.eol = "\r\n";
        const result = buildResultContent(data, {}, { 0: ["a", "b"] });
        expect(result).toBe("a\r\nb\r\n");
    });

    it("uses an edit even on auto-resolved one-sided hunks", () => {
        const data = makeData([makeConflict({ id: 0, changeKind: "ours-only" })]);
        const result = buildResultContent(data, {}, { 0: ["override"] });
        expect(result).toBe("override\n");
    });
});

describe("getEffectiveResultLines", () => {
    it("prefers edited lines over any resolution", () => {
        const segment = makeConflict();
        expect(getEffectiveResultLines(segment, "ours", ["edited"])).toEqual(["edited"]);
    });

    it("treats an empty edit as deletion, not absence", () => {
        const segment = makeConflict();
        expect(getEffectiveResultLines(segment, "ours", [])).toEqual([]);
    });

    it("falls back to resolution lines without an edit", () => {
        const segment = makeConflict();
        expect(getEffectiveResultLines(segment, "theirs", undefined)).toEqual(["theirs"]);
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

    it("treats a manual edit as a resolution", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 })];
        expect(allResolved(segments, {}, { 0: ["fixed"] })).toBe(true);
    });

    it("treats an empty manual edit as a resolution", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 })];
        expect(allResolved(segments, {}, { 0: [] })).toBe(true);
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
        const segments: MergeSegment[] = [makeConflict({ id: 0 }), makeConflict({ id: 1 })];
        expect(resolvedTrueConflictCount(segments, { 0: "ours" })).toBe(1);
    });

    it("counts manually edited true conflicts as resolved", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 }), makeConflict({ id: 1 })];
        expect(resolvedTrueConflictCount(segments, {}, { 1: ["edit"] })).toBe(1);
    });

    it("does not double-count a hunk that is both resolved and edited", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 })];
        expect(resolvedTrueConflictCount(segments, { 0: "ours" }, { 0: ["edit"] })).toBe(1);
    });
});

describe("splitEditedText", () => {
    it("treats empty text as block deletion", () => {
        expect(splitEditedText("")).toEqual([]);
    });

    it("splits LF and CRLF text into lines", () => {
        expect(splitEditedText("a\nb")).toEqual(["a", "b"]);
        expect(splitEditedText("a\r\nb")).toEqual(["a", "b"]);
    });

    it("keeps a trailing empty line when text ends with a newline", () => {
        expect(splitEditedText("a\n")).toEqual(["a", ""]);
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
