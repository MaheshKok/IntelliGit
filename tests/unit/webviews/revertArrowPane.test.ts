import { describe, expect, it } from "vitest";
import {
    buildVerticalLayout,
    connectorChannelSpan,
    type SegmentPaneLines,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import {
    DIFF_PANES,
    revertArrowPane,
    revertArrowX,
    type DiffPane,
    type RevertArrowX,
} from "../../../src/webviews/react/diff-viewer/segmentMarkers";

/**
 * Where a hunk's revert arrow sits vertically.
 *
 * `drawActions` positions each button in viewport pixels from `layout.paneTopPx[pane]`, so the
 * only thing that decides its row is which pane it reads. That choice is invisible to jsdom --
 * the integration suite loads no stylesheet and measures no boxes -- and invisible to the pixel
 * gate, whose diff-viewer fixtures are all commit diffs with no editable pane at all. So the
 * arithmetic is asserted here against the same layout the app builds, rather than left to a
 * screenshot that cannot currently reach it.
 */
describe("revert arrow placement", () => {
    it("aligns the arrow to the pane the change came from, not the one it writes into", () => {
        expect(revertArrowPane("right")).toBe("left");
        expect(revertArrowPane("left")).toBe("right");
    });

    it("never points the arrow at the pane it writes into", () => {
        // Stated as a property rather than as two more literals: the arrow's direction glyph is
        // already derived from `editablePane`, so an implementation that returned it unchanged
        // would leave a `»` sitting on the very rows it is about to overwrite.
        for (const pane of DIFF_PANES) {
            expect(revertArrowPane(pane), `arrow for an editable ${pane} pane`).not.toBe(pane);
        }
    });

    it("puts a deletion's arrow on the deleted rows instead of the seam that replaced them", () => {
        // Right pane editable -- a working-tree diff, the common case. Two hunks whose panes
        // disagree about height, which is what makes the two candidate placements separable:
        // with only one hunk both panes start at 0 and any choice looks correct.
        const segments: SegmentPaneLines<DiffPane>[] = [
            // Insertion: nothing on the left, two added lines on the right.
            { paneLines: { left: 0, right: 2 }, conflict: true, id: 0 },
            // Deletion: three lines gone from the working tree, nothing on the right.
            { paneLines: { left: 3, right: 0 }, conflict: true, id: 1 },
        ];
        const layout = buildVerticalLayout(segments, DIFF_PANES);
        const pane = revertArrowPane("right");

        // The whole point of the change, in one pair of numbers: the deleted rows begin at 0 in
        // the left pane and the seam they left behind sits at 40 in the right one.
        expect(layout.paneTopPx.left[1], "the deleted rows").toBe(0);
        expect(layout.paneTopPx.right[1], "the seam they left behind").toBe(40);
        expect(layout.paneTopPx[pane][1], "the arrow follows the deleted rows").toBe(0);

        // And it stands beside a block with height, not on a collapsed point. `drawActions`
        // derives the button's visibility window from this height, so a zero here would also
        // make the arrow's on-screen test degenerate.
        expect(layout.paneHPx[pane][1], "the arrow spans the rows it copies").toBe(60);
        expect(layout.paneHPx.right[1], "which the editable side does not have").toBe(0);
    });
});

/**
 * Where the same arrow sits horizontally: in its pane's action strip -- the lane between that
 * pane's code and its line numbers -- which is PyCharm's placement and the merge editor's.
 *
 * `revertArrowX` returns a `leftPx` and a `transform`, and neither half means anything alone:
 * `leftPx` names the number column's outer edge and the transform names which of the box's own
 * edges lands on it. Both are therefore read back here as the box's resulting edges rather than
 * compared as raw strings, so a pair that is individually plausible but jointly wrong cannot
 * pass -- and the two panes anchor from OPPOSITE edges, so a copy-pasted half is exactly the
 * mistake available to make.
 */
describe("revert arrow horizontal placement", () => {
    // A 28px channel -- `--diff-connector-gutter` -- between two panes, in the action layer's
    // own coordinates: x0 is the left pane's outer edge, x1 the right pane's. Nothing under
    // test reads it; it is here so the assertions can say the arrow is NOT in it.
    const channel = connectorChannelSpan(600, 628);
    /** Each pane's whole number column: 33px of numbers plus a 20px action strip. */
    const COLUMN = 53;
    /** `.diff-hunk-revert`'s width in diff-viewer.css. The stylesheet is the source; this is a
     *  reader of it, which is why the production code offsets by transform and never by 20. */
    const BOX = 20;

    /**
     * What `measureViewport` reads off each rendered column: the edge of that pane's numbers
     * that faces its own code. The left pane numbers on its right, so its code stops `COLUMN`
     * before the channel; the right pane numbers on its left, so its code starts `COLUMN`
     * after it. These are also the two code edges the arrow must butt against.
     */
    const stripAnchor: Record<DiffPane, number> = {
        left: channel.x0 - COLUMN,
        right: channel.x1 + COLUMN,
    };

    /** The box's own edges once a browser has applied the returned `left` and `transform`. */
    const boxEdges = ({ leftPx, transform }: RevertArrowX) => {
        const shift: Record<string, number | undefined> = {
            "translateX(0)": 0,
            "translateX(-100%)": -BOX,
        };
        const dx = shift[transform];
        // A transform this test cannot resolve is a placement it cannot judge, so it fails here
        // rather than silently treating the unknown case as zero.
        expect(dx, `unhandled transform ${transform}`).toBeDefined();
        return { left: leftPx + dx!, right: leftPx + dx! + BOX };
    };

    const arrow = (pane: DiffPane) => boxEdges(revertArrowX(pane, stripAnchor[pane]));

    it("stands the arrow in the strip between its pane's code and that pane's numbers", () => {
        // Written as both edges of each box rather than as one, because a single correct edge
        // is what a swapped transform still produces.
        expect(arrow("left"), "left pane arrow").toEqual({ left: 547, right: 567 });
        expect(arrow("right"), "right pane arrow").toEqual({ left: 661, right: 681 });
    });

    it("butts the arrow against the code on either pane", () => {
        // The property the two literals above are instances of, and the reason each pane pads
        // its numbers away from its own code side: the arrow annotates a line, so it stands
        // against the lines, not against the far edge of the numbers. The edge that does the
        // touching is mirrored -- the left pane's code stops before its strip, the right
        // pane's starts after its own -- which is exactly what the two transforms encode.
        expect(arrow("left").left, "the left pane's code ends here").toBe(stripAnchor.left);
        expect(arrow("right").right, "the right pane's code starts here").toBe(stripAnchor.right);
    });

    it("keeps the whole box inside its own pane's number column", () => {
        // The half a swapped transform breaks. The anchor is the same number either way and
        // still reads as "on this pane", but the wrong edge of the box lands on it and the
        // glyph hangs out over the code instead of standing beside it.
        const column: Record<DiffPane, [number, number]> = {
            left: [channel.x0 - COLUMN, channel.x0],
            right: [channel.x1, channel.x1 + COLUMN],
        };
        for (const pane of DIFF_PANES) {
            const { left, right } = arrow(pane);
            expect(left, `${pane} arrow's left edge`).toBeGreaterThanOrEqual(column[pane][0]);
            expect(right, `${pane} arrow's right edge`).toBeLessThanOrEqual(column[pane][1]);
        }
    });

    it("never puts the arrow back in the connector channel", () => {
        // Both behaviours this replaced, named so that restoring either cannot pass quietly: a
        // 20px box centred in the 28px channel, and one flush against a pane's outer edge. Any
        // overlap with the channel at all is the old placement, so the whole span is barred.
        for (const pane of DIFF_PANES) {
            const { left, right } = arrow(pane);
            const overlapsChannel = left < channel.x1 && right > channel.x0;
            expect(overlapsChannel, `${pane} arrow overlaps the connector channel`).toBe(false);
        }
    });
});
