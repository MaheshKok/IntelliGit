import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, undo, redo, undoDepth } from "@codemirror/commands";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import {
    buildWorkbenchDocument,
    bulkResolve,
    dismissSide,
    groupingField,
    groupingInit,
    type MergeChoice,
    replaceHunks,
    restoreDraftHunks,
    resultContent,
    workbenchHunks,
    workbenchHistory,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import { parseMergeDraft } from "../../../src/webviews/protocol/mergeWorkbench";

function data(
    base = "head\nbase\ntail\n",
    ours = "head\nours\ntail\n",
    theirs = "head\ntheirs\ntail\n",
) {
    return {
        filePath: "file.ts",
        oursLabel: "ours",
        theirsLabel: "theirs",
        segments: parseConflictVersions(base, ours, theirs),
        ...detectEolMetadata(ours, theirs, base),
    };
}
function harness(input = data()) {
    const initial = buildWorkbenchDocument(input);
    let state = EditorState.create({
        doc: initial.content,
        extensions: [history(), workbenchHunks, workbenchHistory],
    });
    state = state.update({
        effects: replaceHunks.of(initial.hunks),
        annotations: Transaction.addToHistory.of(false),
    }).state;
    const dispatch = (transaction: Transaction) => {
        state = transaction.state;
    };
    return {
        initial,
        get state() {
            return state;
        },
        edit: (spec: Parameters<EditorState["update"]>[0]) => {
            state = state.update(spec).state;
        },
        undo: () =>
            undo({
                get state() {
                    return state;
                },
                dispatch,
            }),
        redo: () =>
            redo({
                get state() {
                    return state;
                },
                dispatch,
            }),
    };
}

describe("merge workbench document", () => {
    it("groupingField starts from the loaded data and throws without init", () => {
        expect(() => EditorState.create({ extensions: [groupingField] })).toThrow(
            "groupingField needs init(data)",
        );
        const input = data();
        const state = EditorState.create({ extensions: [groupingInit(input)] });
        expect(state.field(groupingField)).toEqual({
            ignoreWhitespace: false,
            segments: input.segments,
        });
        expect(state.field(groupingField).segments).toBe(input.segments);
        for (const ignoreWhitespace of [true, false]) {
            const configured = EditorState.create({
                extensions: [groupingInit({ ...input, diffOptions: { ignoreWhitespace } })],
            });
            expect(configured.field(groupingField).ignoreWhitespace).toBe(ignoreWhitespace);
            expect(
                configured
                    .update({ changes: { from: 0, insert: "edit" } })
                    .state.field(groupingField),
            ).toBe(configured.field(groupingField));
        }
    });

    it("bulkResolve of two hunks is one history step", () => {
        const input = data("a\nkeep\nb\n", "ours\nkeep\nleft\n", "theirs\nkeep\nright\n");
        const session = harness(input);
        expect(session.initial.hunks).toHaveLength(2);
        session.edit(
            bulkResolve(
                session.state,
                new Map([
                    [1, "theirs"],
                    [0, "ours"],
                ]),
                input,
            ),
        );
        expect(undoDepth(session.state)).toBe(1);
        expect(session.state.doc.toString()).toBe("ours\nkeep\nright\n");
        expect(session.state.field(workbenchHunks)).toMatchObject([
            { from: 0, to: 5, decision: "ours", resolved: true, edited: false },
            { from: 10, to: 16, decision: "theirs", resolved: true, edited: false },
        ]);
        expect(session.undo()).toBe(true);
        expect(session.state.doc.toString()).toBe(session.initial.content);
        expect(session.state.field(workbenchHunks)).toEqual(session.initial.hunks);
        expect(session.state.field(workbenchHunks).map((hunk) => hunk.resolved)).toEqual([
            false,
            false,
        ]);
        expect(session.redo()).toBe(true);
        expect(session.state.doc.toString()).toBe("ours\nkeep\nright\n");
        expect(session.state.field(workbenchHunks).map((hunk) => hunk.decision)).toEqual([
            "ours",
            "theirs",
        ]);
    });

    it("typing right after bulkResolve starts a separate history step", () => {
        const input = data("a\nkeep\nb\n", "ours\nkeep\nleft\n", "theirs\nkeep\nright\n");
        const session = harness(input);
        session.edit(bulkResolve(session.state, new Map([[0, "ours"]]), input));
        const resolved = session.state.doc.toString();
        expect(resolved.startsWith("ours\n")).toBe(true);
        session.edit({ changes: { from: 4, insert: "!" }, userEvent: "input.type" });
        expect(undoDepth(session.state)).toBe(2);
        expect(session.undo()).toBe(true);
        expect(session.state.doc.toString()).toBe(resolved);
    });

    it("bulkResolve shifts unpicked hunks without changing their side state", () => {
        const input = data("a\nkeep\nb\n", "ours\nkeep\nleft\n", "theirs\nkeep\nright\n");
        const session = harness(input);
        const [first, second] = session.initial.hunks;
        session.edit({
            effects: replaceHunks.of([
                first,
                { ...second, edited: true, dismissed: { ours: false, theirs: true } },
            ]),
        });
        const untouched = session.state.field(workbenchHunks)[1];
        session.edit(bulkResolve(session.state, new Map([[0, "ours"]]), input));
        expect(session.state.doc.toString()).toBe("ours\nkeep\nb\n");
        expect(session.state.field(workbenchHunks)[1]).toEqual({
            ...untouched,
            from: second.from + 3,
            to: second.to + 3,
        });
    });

    it.each<[MergeChoice, string]>([
        ["ours", "ours"],
        ["theirs", "theirs"],
        ["both", "ours\ntheirs"],
        ["both-reversed", "theirs\nours"],
        ["base", "base"],
        ["none", ""],
    ])(
        "bulkResolve %s preserves the missing final newline and resets edited state",
        (choice, expected) => {
            const input = data("base", "ours", "theirs");
            const session = harness(input);
            session.edit({ changes: { from: 1, insert: "manual" } });
            session.edit({
                effects: replaceHunks.of(
                    session.state.field(workbenchHunks).map((hunk) => ({
                        ...hunk,
                        dismissed: { ours: true, theirs: true },
                    })),
                ),
            });
            session.edit(bulkResolve(session.state, new Map([[0, choice]]), input));
            expect(resultContent(session.state.doc, input)).toBe(expected);
            expect(session.state.field(workbenchHunks)[0]).toMatchObject({
                from: 0,
                to: expected.length,
                decision: choice,
                resolved: true,
                edited: false,
                dismissed: { ours: choice !== "none", theirs: choice !== "none" },
            });
        },
    );

    it.each<[MergeChoice, string]>([
        ["ours", "a\nb\n"],
        ["theirs", "a\nc\n"],
        ["both", "a\nb\nc\n"],
    ])("accepting %s at an empty EOF hunk preserves text, range and undo", (choice, expected) => {
        const input = data("a\n", "a\nb\n", "a\nc\n");
        const session = harness(input);
        session.edit(bulkResolve(session.state, new Map([[0, choice]]), input));
        expect(resultContent(session.state.doc, input)).toBe(expected);
        expect(session.state.field(workbenchHunks)[0]).toMatchObject({
            from: 2,
            to: expected.length,
        });
        expect(session.undo()).toBe(true);
        expect(resultContent(session.state.doc, input)).toBe("a\n");
        expect(session.state.field(workbenchHunks)[0]).toMatchObject({
            from: 2,
            to: 2,
            resolved: false,
        });
    });

    it("dismissing one side is undoable and leaves the document unchanged", () => {
        const session = harness(
            data("a\nkeep\nb\n", "ours\nkeep\nleft\n", "theirs\nkeep\nright\n"),
        );
        for (const side of ["ours", "theirs"] as const) {
            const original = session.state.field(workbenchHunks);
            const next = dismissSide(original, 0, side);
            expect(original[0].dismissed).toEqual({ ours: false, theirs: false });
            expect(next[0]).toEqual({
                ...original[0],
                dismissed: { ours: false, theirs: false, [side]: true },
            });
            expect(next[1]).toEqual(original[1]);
            session.edit({
                effects: replaceHunks.of(next),
                userEvent: "input.merge",
                annotations: isolateHistory.of("full"),
            });
            expect(session.state.doc.toString()).toBe(session.initial.content);
            expect(session.state.field(workbenchHunks)[0].dismissed[side]).toBe(true);
            expect(undoDepth(session.state)).toBe(1);
            expect(session.undo()).toBe(true);
            expect(session.state.doc.toString()).toBe(session.initial.content);
            expect(session.state.field(workbenchHunks)).toEqual(original);
        }
    });

    it("starts every hunk undecided, unedited and undismissed", () => {
        for (const input of [data(), data("base\n", "base\n", "theirs\n")]) {
            const { hunks } = buildWorkbenchDocument(input);
            expect(hunks).toHaveLength(1);
            expect(hunks[0]).not.toHaveProperty("decision");
            expect(hunks[0]).toMatchObject({
                edited: false,
                dismissed: { ours: false, theirs: false },
            });
        }
    });

    it("marks a hunk edited when a change touches its range and leaves neighbours untouched", () => {
        const session = harness(
            data("a\nkeep\nb\n", "ours\nkeep\nleft\n", "theirs\nkeep\nright\n"),
        );
        expect(session.initial.hunks).toHaveLength(2);
        const [first, second] = session.initial.hunks;
        session.edit({ changes: { from: first.from + 1, insert: "edit" } });
        expect(session.state.field(workbenchHunks).map((hunk) => hunk.edited)).toEqual([
            true,
            false,
        ]);
        session.edit({ changes: { from: second.from + 5, insert: "next" } });
        expect(session.state.field(workbenchHunks).map((hunk) => hunk.edited)).toEqual([
            true,
            true,
        ]);
        session.undo();
        expect(session.state.field(workbenchHunks).map((hunk) => hunk.edited)).toEqual([
            true,
            false,
        ]);
        session.undo();
        expect(session.state.field(workbenchHunks)).toEqual(session.initial.hunks);
    });

    it("marks an empty hunk edited when text is inserted at its position", () => {
        const session = harness(data("a\n", "a\nb\n", "a\nc\n"));
        session.edit({ changes: { from: 2, insert: "manual\n" } });
        expect(session.state.field(workbenchHunks)[0]).toMatchObject({
            from: 2,
            to: 9,
            edited: true,
            resolved: false,
        });
    });

    it("an empty EOF hunk keeps its [2,2) range and the document text", () => {
        const input = data("a\n", "a\nb\n", "a\nc\n");
        expect(input.hasTrailingNewline).toBe(true);
        const initial = buildWorkbenchDocument(input);
        expect(initial.content).toBe("a\n");
        expect(initial.hunks).toHaveLength(1);
        expect(initial.hunks[0]).toMatchObject({ from: 2, to: 2 });
    });

    it("emptying the document gives an empty result", () => {
        const input = data("a\n", "a\nb\n", "a\nc\n");
        const session = harness(input);
        session.edit({ changes: { from: 0, to: session.state.doc.length, insert: "" } });
        expect(resultContent(session.state.doc, input)).toBe("");
    });

    it("removing the final newline removes it from the result", () => {
        const input = data("a\n", "a\nb\n", "a\nc\n");
        const session = harness(input);
        session.edit({ changes: { from: 1, to: 2, insert: "" } });
        expect(resultContent(session.state.doc, input)).toBe("a");
    });

    it("adding a final newline adds it to the result", () => {
        const input = data("base", "ours", "theirs");
        const session = harness(input);
        session.edit({ changes: { from: session.state.doc.length, insert: "\n" } });
        expect(resultContent(session.state.doc, input)).toBe("base\n");
    });

    it("restores decision and dismissal state from a draft", () => {
        const { hunks, content } = buildWorkbenchDocument(data());
        const entries = hunks.map(({ id, from, to, resolved }) => ({
            id,
            from,
            to,
            resolved,
            decision: "ours",
            edited: true,
            dismissedOurs: true,
            dismissedTheirs: true,
        }));
        expect(restoreDraftHunks(hunks, entries, content.length)?.[0]).toEqual({
            ...hunks[0],
            decision: "ours",
            edited: true,
            dismissed: { ours: true, theirs: true },
        });
        const legacy = hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved }));
        const restored = restoreDraftHunks(hunks, legacy, content.length);
        expect(restored?.[0]).toMatchObject({
            edited: false,
            dismissed: { ours: false, theirs: false },
        });
        expect(Object.hasOwn(restored![0], "decision")).toBe(false);
    });

    it("restores draft ranges with unedited and undismissed defaults", () => {
        const { hunks } = buildWorkbenchDocument(data());
        const draft = hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved }));
        expect(restoreDraftHunks(hunks, draft, 100)?.[0]).toMatchObject({
            edited: false,
            dismissed: { ours: false, theirs: false },
        });
    });

    it("does not absorb edits to the following common text into a preceding change", () => {
        const session = harness();
        const hunk = session.initial.hunks[0];
        session.edit({ changes: { from: hunk.to, insert: "outside\n" } });
        expect(session.state.field(workbenchHunks)[0].to).toBe(hunk.to);
        session.edit({ changes: { from: hunk.from, to: hunk.to, insert: "chosen\n" } });
        expect(session.state.doc.toString()).toBe("head\nchosen\noutside\ntail\n");
    });

    it("seeds conflicts with base and retains automatic non-conflicting changes", () => {
        const result = buildWorkbenchDocument(data());
        expect(result.content).toBe("head\nbase\ntail\n");
        expect(result.hunks[0].resolved).toBe(false);
        const oneSided = buildWorkbenchDocument(data("base\n", "base\n", "theirs\n"));
        expect(oneSided.content).toBe("theirs\n");
        expect(oneSided.hunks[0].resolved).toBe(true);
    });
    it("undoes and redoes decision text and confirmation together", () => {
        const session = harness();
        const hunk = session.initial.hunks[0];
        session.edit({
            changes: { from: hunk.from, to: hunk.to, insert: "chosen\n" },
            effects: replaceHunks.of([{ ...hunk, to: hunk.from + 7, resolved: true }]),
            annotations: isolateHistory.of("full"),
        });
        expect(session.state.doc.toString()).toContain("chosen");
        expect(session.state.field(workbenchHunks)[0].resolved).toBe(true);
        expect(session.undo()).toBe(true);
        expect(session.state.doc.toString()).toBe(session.initial.content);
        expect(session.state.field(workbenchHunks)).toEqual(session.initial.hunks);
        expect(session.redo()).toBe(true);
        expect(session.state.doc.toString()).toContain("chosen");
        expect(session.state.field(workbenchHunks)[0].resolved).toBe(true);
    });
    it("typing maps ranges but does not silently resolve a conflict", () => {
        const session = harness();
        session.edit({ changes: { from: 0, insert: "new\n" } });
        expect(session.state.field(workbenchHunks)[0].from).toBe(session.initial.hunks[0].from + 4);
        expect(session.state.field(workbenchHunks)[0].resolved).toBe(false);
        session.undo();
        expect(session.state.field(workbenchHunks)).toEqual(session.initial.hunks);
    });
    it("records explicit manual confirmation even when the text did not change", () => {
        const session = harness();
        session.edit({
            effects: replaceHunks.of(
                session.initial.hunks.map((hunk) => ({ ...hunk, resolved: true })),
            ),
            annotations: isolateHistory.of("full"),
        });
        expect(session.state.field(workbenchHunks)[0].resolved).toBe(true);
        session.undo();
        expect(session.state.field(workbenchHunks)[0].resolved).toBe(false);
    });
    it("retains CRLF output and missing final newline", () => {
        const input = data("base\r\nlast", "ours\r\nlast", "theirs\r\nlast");
        const initial = buildWorkbenchDocument(input);
        const state = EditorState.create({ doc: initial.content });
        expect(resultContent(state.doc, input)).toBe("base\r\nlast");
    });
    it("rejects malformed, overlapping, and mismatched draft ranges", () => {
        const { hunks } = buildWorkbenchDocument(data());
        expect(restoreDraftHunks(hunks, [], 100)).toBeNull();
        expect(restoreDraftHunks(hunks, [{ ...hunks[0], to: -1 }], 100)).toBeNull();
        expect(restoreDraftHunks(hunks, [{ ...hunks[0], id: -999 }], 100)).toBeNull();
        expect(restoreDraftHunks(hunks, hunks, 100)).toEqual(hunks);
        expect(
            parseMergeDraft({ snapshotId: "a".repeat(64), content: "text", hunks: [] }),
        ).not.toBeNull();
        expect(parseMergeDraft({ snapshotId: "stale", content: "text", hunks: [] })).toBeNull();
    });
});
