import { describe, expect, it } from "vitest";
import {
    buildVerticalLayout,
    type SegmentPaneLines,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import {
    DIFF_PANES,
    revertArrowPane,
    type DiffPane,
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
