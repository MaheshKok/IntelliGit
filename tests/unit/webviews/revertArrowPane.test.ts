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
 * Where the same arrow sits horizontally.
 *
 * `revertArrowX` returns a `left` and a `transform`, and neither half means anything alone --
 * `left` names a channel edge and the transform names which of the box's own edges lands on it.
 * Both are therefore read back here as the box's resulting edges rather than compared as raw
 * strings, so a pair that is individually plausible but jointly wrong cannot pass.
 */
describe("revert arrow horizontal placement", () => {
    // A 28px channel -- `--diff-connector-gutter` -- between two panes, in the action layer's
    // own coordinates: x0 is the left pane's inner edge, x1 the right pane's.
    const channel = connectorChannelSpan(600, 628);
    /** `.diff-hunk-revert`'s width in diff-viewer.css. The stylesheet is the source; this is a
     *  reader of it, which is why the production code offsets by transform and never by 20. */
    const BOX = 20;

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

    it("butts the arrow against the pane it stands beside", () => {
        expect(boxEdges(revertArrowX(channel, "left")).left, "flush with the left pane").toBe(600);
        expect(boxEdges(revertArrowX(channel, "right")).right, "flush with the right pane").toBe(
            628,
        );
    });

    it("keeps the whole box inside the channel from either side", () => {
        // The half a swapped transform breaks. `x0` paired with `translateX(-100%)` still reads
        // as "anchored to the left pane" and still returns a plausible number, but it hangs the
        // glyph back over the line numbers it was supposed to sit beside.
        for (const pane of DIFF_PANES) {
            const { left, right } = boxEdges(revertArrowX(channel, pane));
            expect(left, `${pane} arrow's left edge`).toBeGreaterThanOrEqual(channel.x0);
            expect(right, `${pane} arrow's right edge`).toBeLessThanOrEqual(channel.x1);
        }
    });

    it("never floats the arrow at the channel's midpoint again", () => {
        // The behaviour this replaced, named so that restoring it cannot pass quietly: a 20px box
        // centred in a 28px channel begins at 604, and neither side may land there.
        const centred = (channel.x0 + channel.x1) / 2 - BOX / 2;
        for (const pane of DIFF_PANES) {
            expect(boxEdges(revertArrowX(channel, pane)).left, `${pane} arrow`).not.toBe(centred);
        }
    });
});
