import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { parseConflictVersions } from "../../../src/mergeEditor/conflictParser";
import {
    buildWorkbenchDocument,
    replaceHunks,
    workbenchHunks,
    type WorkbenchHunk,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import {
    compareLinesFor,
    hunkView,
    isPhantomLine,
    ownedLines,
    resolutionOf,
    rowClasses,
    rowsInRange,
    rowState,
    variantClass,
} from "../../../src/webviews/react/merge-editor/workbenchRows";

function fixture(base = "base", ours = "ours", theirs = "theirs") {
    return buildWorkbenchDocument({
        filePath: "file.ts",
        oursLabel: "ours",
        theirsLabel: "theirs",
        hasTrailingNewline: true,
        eol: "\n",
        segments: parseConflictVersions(base, ours, theirs),
    });
}

describe("workbench rows", () => {
    it.each([
        [{}, "ours", "mrow mrow-conflict mrow-pending"],
        [{ decision: "ours" }, "ours", "mrow mrow-conflict mrow-accepted"],
        [{ decision: "ours" }, "theirs", "mrow mrow-conflict mrow-pending"],
        [{ decision: "ours" }, "result", "mrow mrow-conflict mrow-pending"],
        [
            { decision: "ours", dismissed: { ours: false, theirs: true } },
            "result",
            "mrow mrow-conflict mrow-plain",
        ],
        [{ edited: true }, "result", "mrow mrow-conflict mrow-pending"],
        [
            { edited: true, decision: "ours", resolved: true },
            "result",
            "mrow mrow-conflict mrow-edited",
        ],
        [{ decision: "base" }, "ours", "mrow mrow-conflict mrow-dismissed"],
        [{ decision: "base" }, "result", "mrow mrow-conflict mrow-plain"],
    ] as const)("paints %j in %s", (changes, pane, expected) => {
        const hunk: WorkbenchHunk = { ...fixture().hunks[0], ...changes };
        expect(rowClasses(hunk, pane, "middle", false)).toBe(expected);
    });

    it("leaves the unchanged side without a variant and joins positions in order", () => {
        const hunk = fixture("base", "base", "theirs").hunks[0];
        expect(rowClasses(hunk, "ours", "only", true)).toBe(
            "mrow mrow-pending mrow-first mrow-last mrow-active",
        );
        expect(rowState(hunk, "result")).toBe("variant");
        expect(rowState({ ...hunk, decision: "theirs" }, "result")).toBe("settled");
        expect(rowClasses(hunk, "theirs", "first", false)).toBe(
            "mrow mrow-modification mrow-pending mrow-first",
        );
        expect(rowClasses(hunk, "theirs", "last", false)).toBe(
            "mrow mrow-modification mrow-pending mrow-last",
        );
    });

    it.each(["ours", "theirs"] as const)(
        "keeps main's result conflict fill after confirming %s while the other side can stack",
        (decision) => {
            const hunk: WorkbenchHunk = { ...fixture().hunks[0], decision, resolved: true };
            expect(rowState(hunk, "result")).toBe("pending");
        },
    );

    it("derives render flags and compare lines from main's resolution rules", () => {
        const hunk = fixture().hunks[0];
        expect(resolutionOf({ ...hunk, decision: "base" })).toBe("none");
        expect(hunkView({ ...hunk, decision: "ours" }).oursInResult).toBe(true);
        expect(compareLinesFor({ ...hunk, decision: "ours" }, "ours")).toBeUndefined();
        expect(compareLinesFor({ ...hunk, decision: "theirs" }, "theirs")).toBeUndefined();
        expect(compareLinesFor(hunk, "result")).toBe(hunk.segment.baseLines);
        expect(compareLinesFor(hunk, "ours")).toBe(hunk.segment.baseLines);
        expect(compareLinesFor(hunk, "theirs")).toBe(hunk.segment.baseLines);
        expect(compareLinesFor({ ...hunk, decision: "ours" }, "result")).toBeUndefined();
        expect(compareLinesFor({ ...hunk, edited: true }, "result")).toBe(hunk.segment.baseLines);
    });

    it.each([
        ["base", "ours", "theirs", "mrow-conflict"],
        ["", "ours", "", "mrow-insertion"],
        ["base", "", "base", "mrow-deletion"],
        ["base", "base", "theirs", "mrow-modification"],
    ])("classifies %j / %j / %j", (base, ours, theirs, expected) => {
        expect(variantClass(fixture(base, ours, theirs).hunks[0].segment)).toBe(expected);
    });

    it.each([
        ["a\nb\nc", 0, 4, [1, 2]],
        ["a\nb\nc", 0, 5, [1, 2, 3]],
        ["a\nb\nc", 2, 2, []],
        ["ac", 0, 1, [1]],
        ["ac", 1, 2, []],
        ["a\n", 0, 2, [1]],
        ["a\n", 2, 2, []],
        ["", 0, 0, []],
        ["a", 0, 1, [1]],
    ] as const)("owns line starts in %j [%i,%i)", (text, from, to, expected) => {
        const doc = Text.of(text.split("\n"));
        expect(rowsInRange(doc, from, to)).toBe(expected.length);
        expect(ownedLines(doc, from, to)).toEqual(expected);
    });

    it.each([
        ["a\n", true],
        ["", true],
        ["a", false],
    ] as const)("identifies the phantom in %j", (text, phantom) => {
        const doc = Text.of(text.split("\n"));
        expect(isPhantomLine(doc, doc.line(doc.lines))).toBe(phantom);
    });

    it.each(["a\nb\nc", "ac", "a\n", "", "a"])(
        "partitions every physical row of %j once",
        (text) => {
            const doc = Text.of(text.split("\n"));
            for (let split = 0; split <= doc.length; split++) {
                expect(rowsInRange(doc, 0, split) + rowsInRange(doc, split, doc.length)).toBe(
                    doc.lines - Number(isPhantomLine(doc, doc.line(doc.lines))),
                );
                const lines = [...ownedLines(doc, 0, split), ...ownedLines(doc, split, doc.length)];
                expect(new Set(lines).size).toBe(lines.length);
            }
        },
    );

    it("typing at a conflict's end boundary marks it edited but keeps the conflict fill", () => {
        const initial = fixture("a\nkeep\nb\n", "ours\nkeep\nours2\n", "theirs\nkeep\ntheirs2\n");
        let state = EditorState.create({ doc: initial.content, extensions: [workbenchHunks] });
        state = state.update({ effects: replaceHunks.of(initial.hunks) }).state;
        expect(state.field(workbenchHunks)).toHaveLength(2);
        state = state.update({ changes: { from: initial.hunks[0].to, insert: "x" } }).state;
        const hunks = state.field(workbenchHunks);
        expect(hunks[0].edited).toBe(true);
        // Like PyCharm, hand edits leave an unresolved conflict red until a side is accepted.
        expect(rowState(hunks[0], "result")).toBe("pending");
        expect(rowClasses(hunks[0], "result", "only", false).split(" ")).toContain("mrow-pending");
        expect(hunks[1].edited).toBe(false);
    });
});
