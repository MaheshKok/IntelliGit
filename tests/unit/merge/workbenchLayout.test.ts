import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { parseConflictVersions } from "../../../src/mergeEditor/conflictParser";
import fixture from "../../visual/fixtures/merge-editor/conflicted.json";
import type {
    MergeEditorData,
    ConflictSegment,
} from "../../../src/webviews/react/merge-editor/types";
import {
    buildWorkbenchDocument,
    groupingField,
    groupingInit,
    regroupSpec,
    workbenchHunks,
    workbenchHistory,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import {
    MERGE_PANES,
    type MergePaneId,
} from "../../../src/webviews/react/merge-editor/mergeRibbons";
import {
    buildVerticalLayout,
    paneOffsetForCanonical,
    LINE_HEIGHT_PX,
    type SegmentPaneLines,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import {
    layoutSegments,
    canonicalForPaneY,
    overviewMarkers,
    workbenchCounts,
    horizontalInnerWidth,
    workbenchConnectors,
} from "../../../src/webviews/react/merge-editor/workbenchLayout";

const data = fixture.messages[0].message.data as MergeEditorData;
function model(segments = data.segments) {
    const initial = buildWorkbenchDocument({ ...data, segments });
    const doc = EditorState.create({ doc: initial.content }).doc;
    return { ...initial, doc, info: layoutSegments(segments, initial.hunks, doc) };
}
function conflict(overrides: Partial<ConflictSegment> = {}): ConflictSegment {
    return {
        type: "conflict",
        id: 7,
        changeKind: "conflict",
        oursLines: ["ours"],
        baseLines: ["base one", "base two"],
        theirsLines: ["theirs one", "theirs two", "theirs three"],
        ...overrides,
    };
}

describe("workbench layout", () => {
    it("geometry after regroup, undo and redo matches a fresh load in each mode", () => {
        const versions = { base: "a\nb\n", ours: "a\n  b\n", theirs: "a\nb\nc\n" };
        const input = {
            ...data,
            hasTrailingNewline: true,
            workbench: {
                ...versions,
                snapshotId: "snapshot",
                draftKey: "draft",
                operation: "merge",
            },
        };
        const fresh = (ignoreWhitespace: boolean) => {
            const loaded = {
                ...input,
                diffOptions: { ignoreWhitespace },
                segments: parseConflictVersions(versions.base, versions.ours, versions.theirs, {
                    ignoreWhitespace,
                }),
            };
            const built = buildWorkbenchDocument(loaded);
            return EditorState.create({
                doc: built.content,
                extensions: [
                    history(),
                    workbenchHunks.init(() => built.hunks),
                    workbenchHistory,
                    groupingInit(loaded),
                ],
            });
        };
        const geometry = (state: EditorState) => {
            const segments = state.field(groupingField).segments;
            const hunks = state.field(workbenchHunks);
            const layout = layoutSegments(segments, hunks, state.doc);
            return {
                paneLines: layout.paneLines,
                connectors: workbenchConnectors(hunks, segments).length,
                markers: overviewMarkers(hunks, layout, null).length,
            };
        };
        let state = fresh(false);
        const none = geometry(state);
        const whitespace = geometry(fresh(true));
        expect(none).not.toEqual(whitespace);
        state = state.update(
            regroupSpec(state, { ...input, segments: state.field(groupingField).segments }, true, {
                history: true,
            }),
        ).state;
        expect(geometry(state)).toEqual(whitespace);
        const target = {
            get state() {
                return state;
            },
            dispatch(transaction: Transaction) {
                state = transaction.state;
            },
        };
        expect(undo(target)).toBe(true);
        expect(geometry(state)).toEqual(none);
        expect(redo(target)).toBe(true);
        expect(geometry(state)).toEqual(whitespace);
    });
    it("ribbon specs retain edited hunks and exclude untouched auto-merges", () => {
        const segments = [
            { type: "common" as const, lines: ["head"] },
            conflict({ id: 10, oursLines: ["ours one", "ours two"] }),
            conflict({ id: 11, oursLines: ["edited one", "edited two"] }),
            { type: "common" as const, lines: ["between"] },
            conflict({
                id: 12,
                changeKind: "ours-only",
                oursLines: ["auto one", "auto two"],
                autoResolvedLines: ["auto one", "auto two"],
            }),
            conflict({
                id: 13,
                changeKind: "ours-only",
                oursLines: ["decided one", "decided two"],
                autoResolvedLines: ["decided one", "decided two"],
            }),
        ];
        const { hunks, doc } = model(segments);
        hunks[1] = { ...hunks[1], edited: true };
        hunks[3] = { ...hunks[3], decision: "ours", resolved: true };
        const specs = workbenchConnectors(hunks, segments);
        expect(specs.map(({ id, index }) => ({ id, index }))).toEqual([
            { id: 10, index: 1 },
            { id: 11, index: 2 },
            { id: 13, index: 5 },
        ]);
        const { paneLines } = layoutSegments(segments, hunks, doc);
        for (const spec of specs) {
            expect(paneLines[spec.index]).toMatchObject({ conflict: true, id: spec.id });
        }
        expect(specs[0].left?.resolved).toBe(false);
        expect(specs[0].right?.resolved).toBe(false);
        expect(specs[1].left?.resolved).toBe(false);
        expect(specs[1].right?.resolved).toBe(false);
        expect(specs[2].left?.resolved).toBe(true);
        expect(specs[2].left?.colorClass.split(" ")).toContain("connector-resolved");
        expect(specs[2].right).toBeUndefined();
    });
    it.each([undefined, "ours", "theirs", "both", "both-reversed", "none", "base"] as const)(
        "edited ribbons span the current result instead of the previous %s decision",
        (decision) => {
            const { hunks } = model([conflict()]);
            const edited = {
                ...hunks[0],
                edited: true,
                decision,
                dismissed: { ours: true, theirs: true },
            };
            const [spec] = workbenchConnectors([edited], [edited.segment]);
            expect(spec, "manual editing must retain the hunk's divider bands").toBeDefined();
            for (const side of [spec.left, spec.right]) {
                expect(side?.resolved).toBe(false);
                expect(side?.midSlice).toBeUndefined();
            }
        },
    );
    it("an edited automatic merge retains its contributing ribbon", () => {
        const { hunks } = model([
            conflict({ changeKind: "ours-only", autoResolvedLines: ["ours"] }),
        ]);
        const edited = { ...hunks[0], edited: true };
        const [spec] = workbenchConnectors([edited], [edited.segment]);
        expect(spec, "manual editing must retain the automatic hunk's divider band").toBeDefined();
        expect(spec.left?.resolved).toBe(false);
        expect(spec.right).toBeUndefined();
    });
    it("rejects a ribbon hunk missing from the current segments", () => {
        const { hunks } = model([conflict()]);
        expect(() => workbenchConnectors(hunks, [{ ...hunks[0].segment }])).toThrow(
            "merge-editor: ribbon hunk is missing from the current segments",
        );
    });
    it("matches main's hand-counted committed fixture", () => {
        const expected: SegmentPaneLines<MergePaneId>[] = [
            { paneLines: { left: 1, middle: 1, right: 1 }, conflict: false },
            { paneLines: { left: 1, middle: 1, right: 1 }, conflict: true, id: 0 },
            { paneLines: { left: 2, middle: 2, right: 2 }, conflict: false },
            { paneLines: { left: 0, middle: 1, right: 1 }, conflict: true, id: 1 },
        ];
        expect(model().info.paneLines).toEqual(expected);
        expect(model().info.startLine).toEqual([1, 2, 3, 5]);
    });
    it("keeps an empty-result hunk at zero rows but one rail line", () => {
        const { info } = model([conflict({ oursLines: [], baseLines: [], theirsLines: [] })]);
        expect(info.paneLines[0].paneLines.middle).toBe(0);
        expect(info.canonicalLineCount).toEqual([1]);
    });
    it("excludes the final newline phantom from the last common stretch and row total", () => {
        const { info, doc } = model([...data.segments, { type: "common", lines: ["tail"] }]);
        expect(info.paneLines.at(-1)?.paneLines.middle).toBe(1);
        expect(info.paneLines.reduce((sum, item) => sum + item.paneLines.middle, 0)).toBe(
            doc.lines - 1,
        );
    });
    it("maps unequal 1/2/3 rows to 20/40/60 pixels using main's geometry", () => {
        const { info } = model([conflict()]);
        const layout = buildVerticalLayout(info.paneLines, MERGE_PANES);
        expect(info.canonicalLineCount).toEqual([3]);
        expect(MERGE_PANES.map((pane) => layout.paneHPx[pane][0])).toEqual([20, 40, 60]);
        expect(layout.canonicalTotalPx).toBe(3 * LINE_HEIGHT_PX);
    });
    it("round trips within one pixel inside non-zero segments", () => {
        const { info } = model([
            { type: "common", lines: ["head"] },
            conflict(),
            { type: "common", lines: ["tail"] },
        ]);
        const layout = buildVerticalLayout(info.paneLines, MERGE_PANES);
        expect(layout.canonicalTopPx).toHaveLength(3);
        for (const pane of MERGE_PANES) {
            layout.canonicalTopPx.forEach((top, index) => {
                if (layout.paneHPx[pane][index] === 0) return;
                for (const fraction of [0.1, 0.5, 0.9]) {
                    const canonical = top + layout.canonicalHPx[index] * fraction;
                    const y = paneOffsetForCanonical(layout, pane, canonical);
                    expect(Math.abs(canonicalForPaneY(layout, pane, y) - canonical)).toBeLessThan(
                        1,
                    );
                }
            });
        }
    });
    it("chooses the first zero-height segment at a shared boundary", () => {
        const paneLines = [2, 0, 0, 3].map((middle) => ({
            paneLines: { left: 3, middle, right: 3 },
            conflict: false,
        }));
        const layout = buildVerticalLayout(paneLines, MERGE_PANES);
        expect(layout.paneHPx.middle).toEqual([40, 0, 0, 60]);
        expect(canonicalForPaneY(layout, "middle", 40)).toBe(layout.canonicalTopPx[1]);
        expect(canonicalForPaneY(layout, "middle", 41)).toBeGreaterThan(layout.canonicalTopPx[3]);
        expect(canonicalForPaneY(layout, "middle", 41)).toBeLessThan(layout.canonicalTotalPx);
    });
    it("clamps positions outside the pane to the canonical endpoints", () => {
        const layout = buildVerticalLayout(model([conflict()]).info.paneLines, MERGE_PANES);
        expect(canonicalForPaneY(layout, "middle", -5)).toBe(0);
        expect(canonicalForPaneY(layout, "middle", 45)).toBe(60);
    });
    it("places a two-row hunk at row four at 30 percent with 20 percent height", () => {
        const { hunks, info } = model([
            { type: "common", lines: ["a", "b", "c"] },
            conflict({ oursLines: ["a", "b"], theirsLines: ["c", "d"] }),
            { type: "common", lines: ["d", "e", "f", "g", "h"] },
        ]);
        expect(overviewMarkers(hunks, info, 0)).toEqual([
            {
                id: 7,
                ordinal: 1,
                topPct: 30,
                heightPct: 20,
                changeKind: "conflict",
                resolved: false,
            },
        ]);
    });
    it("leaves edited but unconfirmed conflicts unresolved on the rail", () => {
        const { hunks, info } = model();
        const markers = overviewMarkers(
            hunks.map((hunk) => ({ ...hunk, edited: true })),
            info,
            0,
        );
        expect(markers.map(({ resolved }) => resolved)).toEqual([false, true]);
        expect(markers.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    });
    it("counts true conflicts and undecided automatic changes", () => {
        const { hunks } = model([
            conflict(),
            conflict({ id: 8 }),
            conflict({ id: 9, changeKind: "ours-only" }),
        ]);
        expect(workbenchCounts(hunks)).toEqual({
            total: 2,
            resolved: 0,
            unresolved: 2,
            autoResolvedCount: 1,
            nextUnresolvedIndex: 0,
        });
        const partial = hunks.map((hunk, index) =>
            index === 0 ? { ...hunk, resolved: true } : hunk,
        );
        expect(workbenchCounts(partial)).toEqual({
            total: 2,
            resolved: 1,
            unresolved: 1,
            autoResolvedCount: 1,
            nextUnresolvedIndex: 1,
        });
        expect(
            workbenchCounts(
                hunks.map((hunk) => ({ ...hunk, resolved: true, decision: "ours" as const })),
            ),
        ).toEqual({
            total: 2,
            resolved: 2,
            unresolved: 0,
            autoResolvedCount: 0,
            nextUnresolvedIndex: -1,
        });
        expect(workbenchCounts([])).toEqual({
            total: 0,
            resolved: 0,
            unresolved: 0,
            autoResolvedCount: 0,
            nextUnresolvedIndex: -1,
        });
    });
    it("sizes the shared horizontal track from the largest editor overflow", () => {
        expect(
            horizontalInnerWidth(500, [
                { scrollWidth: 900, clientWidth: 500 },
                { scrollWidth: 500, clientWidth: 500 },
            ]),
        ).toBe(900);
        expect(horizontalInnerWidth(500, [])).toBe(500);
    });
});
