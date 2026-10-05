import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import fixture from "../../visual/fixtures/merge-editor/conflicted.json";
import type {
    MergeEditorData,
    ConflictSegment,
} from "../../../src/webviews/react/merge-editor/types";
import { buildWorkbenchDocument } from "../../../src/webviews/react/merge-editor/workbenchModel";
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
