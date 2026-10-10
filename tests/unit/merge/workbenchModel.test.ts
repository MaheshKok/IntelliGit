import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, undo, redo } from "@codemirror/commands";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import {
    buildWorkbenchDocument,
    replaceHunks,
    restoreDraftHunks,
    resultContent,
    workbenchHunks,
    workbenchHistory,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import { parseMergeDraft } from "../../../src/webviews/protocol/mergeWorkbench";
import { mappedMergePosition } from "../../../src/webviews/react/merge-editor/useMergeScrollSync";

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
function harness() {
    const initial = buildWorkbenchDocument(data());
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
    it("maps scrolling by matching conflict boundaries", () => {
        const { hunks } = buildWorkbenchDocument(data());
        const lengths = [15, 15, 17];
        expect(mappedMergePosition(hunks[0].from, 1, 2, hunks, lengths)).toBe(hunks[0].theirsFrom);
        expect(mappedMergePosition(hunks[0].to, 1, 2, hunks, lengths)).toBe(hunks[0].theirsTo);
    });
});
