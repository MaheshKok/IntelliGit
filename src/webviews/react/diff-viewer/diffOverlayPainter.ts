// The overlay drawn on top of the two diff panes: the ribbons connecting each hunk across the
// gutter, and the revert arrow standing beside it.
//
// Split out of `App`, which was 1006 lines. This is the half of it that talks to the DOM directly
// -- it measures boxes, writes inline styles and drives its own animation frame -- and none of
// that is reachable from a test that renders the component, so keeping it inline only made the
// component longer without making the drawing more visible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    connectorChannelSpan,
    ribbonPathD,
    type DiffVerticalLayout,
    type RibbonSpan,
} from "../diff-core/mergeScrollLayout";
import { applyPaneOffsets, paneOffsetsForCanonical } from "../diff-core/scrollSync";
import { DIFF_PANES, revertArrowPane, revertArrowX, type DiffPane } from "./segmentMarkers";

/** The overlay's own DOM handles and draw commands, for the component that hosts it. */
export interface DiffOverlayPainter {
    readonly contentRef: React.MutableRefObject<HTMLDivElement | null>;
    readonly viewportElementRef: React.MutableRefObject<HTMLDivElement | null>;
    readonly columnRefs: React.MutableRefObject<Record<DiffPane, HTMLDivElement | null>>;
    readonly layoutRef: React.MutableRefObject<DiffVerticalLayout<DiffPane> | null>;
    /** The measured viewport height, in state because the scroll spacer is sized from it. */
    readonly viewportHeight: number;
    readonly measureViewport: () => void;
    readonly scheduleVerticalFrame: () => void;
    readonly registerRibbonPath: (index: number, element: SVGPathElement | null) => void;
    readonly registerActionButton: (index: number, element: HTMLButtonElement | null) => void;
}

/**
 * Owns the overlay's geometry and its per-frame draw.
 *
 * `editablePane` rather than the whole diff payload: the arrow is the only thing here that cares
 * which side is writable, and passing the payload would let anything in this file start depending
 * on the document.
 */
export function useDiffOverlayPainter(editablePane: DiffPane | undefined): DiffOverlayPainter {
    // The same height `viewportRef` caches, kept in state as well because the scroll
    // spacer and the overview rail are sized from it during render -- a ref alone would
    // leave both stale until some other change happened to re-render.
    const [viewportHeight, setViewportHeight] = useState(0);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const viewportElementRef = useRef<HTMLDivElement | null>(null);
    const columnRefs = useRef<Record<DiffPane, HTMLDivElement | null>>({ left: null, right: null });
    const verticalFrameRef = useRef(0);
    const layoutRef = useRef<DiffVerticalLayout<DiffPane> | null>(null);
    // Viewport box in px: the height clamps pane offsets and culls offscreen
    // ribbons, and `channel` is the empty gutter between the two panes -- the only
    // x range a connector is ever drawn in. Measured on layout/resize so the
    // per-frame draw only recomputes y. The channel starts empty so a draw racing
    // the first measure paints a zero-width band rather than one spanning the
    // whole viewport, which is the defect this replaced.
    // `stripAnchorPx` is the edge of each pane's number column that touches that pane's code:
    // where its action strip begins, and so where the revert arrow stands. Measured off the
    // rendered column rather than computed from `--diff-line-number-gutter`, which is a
    // `max(33px, calc(Nch + 12px))` token a custom property hands back unresolved.
    // `lineRowPx` is one rendered line-number row's height, which is the other half of where the
    // arrow stands: it centres on the hunk's FIRST row, not on the hunk's top edge. Measured for
    // the same reason as the anchor -- the 20px lives in diff-core.css, and a copy of it here is
    // a number that silently drifts the day the code metrics change. Zero until the first
    // measure, which degrades to the old top-alignment rather than to a wild offset.
    const viewportRef = useRef<{
        height: number;
        channel: RibbonSpan;
        stripAnchorPx: Record<DiffPane, number>;
        lineRowPx: number;
    }>({
        height: 0,
        channel: connectorChannelSpan(0, 0),
        stripAnchorPx: { left: 0, right: 0 },
        lineRowPx: 0,
    });
    const ribbonPaths = useMemo(() => new Map<number, SVGPathElement>(), []);
    const actionButtons = useMemo(() => new Map<number, HTMLButtonElement>(), []);

    // Cache the viewport box and expose its height as a CSS var so the sticky
    // viewport's negative margin cancels exactly its own height, leaving the scroll
    // range at whatever the spacer says -- `scrollRangePx`, and nothing else.
    //
    // The connector channel is measured here too, from the panes' own boxes rather than
    // recomputed from the column template: --diff-connector-gutter is a CSS decision,
    // and arithmetic that re-derives it here would keep returning a stale answer if the
    // grid changed, which is the failure mode that put the ribbons across the code in
    // the first place. Reading two rects per resize, not per frame, keeps it off the
    // scroll path.
    const measureViewport = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        const height = content.clientHeight;
        const viewport = viewportElementRef.current;
        const width = viewport?.clientWidth ?? 0;
        const left = columnRefs.current.left?.getBoundingClientRect();
        const right = columnRefs.current.right?.getBoundingClientRect();
        const origin = viewport?.getBoundingClientRect().left ?? 0;
        // Before the panes have laid out there is no channel to measure. A zero-width
        // span at the midpoint draws nothing rather than falling back to the full
        // width, so a ribbon can never appear over the code even for one frame.
        const channel = connectorChannelSpan(
            left ? left.right - origin : width / 2,
            right ? right.left - origin : width / 2,
        );
        // The arrow's own anchor, read off the number column rather than derived from the
        // channel: `channel` is measured from the PANE's box, and the pane's 1px right border
        // sits outside the column, so `x0 - columnWidth` lands one pixel past the strip. That
        // is invisible on a screenshot and exactly the kind of drift that survives a review.
        //
        // `content-visibility: auto` can leave a skipped block unmeasured (the merge editor's
        // `gutterWidth` guards the same case), so a zero-width rect keeps the previous anchor:
        // the arrow stays where it already was for that frame instead of slamming to the
        // viewport edge and back.
        const previous = viewportRef.current.stripAnchorPx;
        const stripAnchor = (pane: DiffPane): number => {
            const column = columnRefs.current[pane]
                ?.querySelector<HTMLElement>(".line-numbers")
                ?.getBoundingClientRect();
            if (!column || column.width === 0) return previous[pane];
            // Each pane's strip is the edge of its column that touches its own code: the left
            // pane numbers on its right, so the code stops at the column's left edge; the
            // right pane numbers on its left, so the code starts at the column's right edge.
            return (pane === "left" ? column.left : column.right) - origin;
        };
        const stripAnchorPx = { left: stripAnchor("left"), right: stripAnchor("right") };
        // Any rendered row will do -- every pane shares one set of code metrics, and the row box
        // carries no vertical padding, so its height IS the line box. Same guard as the anchor:
        // a skipped or not-yet-mounted column keeps the previous reading instead of collapsing
        // every arrow onto its hunk's top edge for a frame.
        const rowHeight = content
            .querySelector<HTMLElement>(".line-number-row")
            ?.getBoundingClientRect().height;
        const lineRowPx =
            rowHeight === undefined || rowHeight === 0 ? viewportRef.current.lineRowPx : rowHeight;
        viewportRef.current = { height, channel, stripAnchorPx, lineRowPx };
        setViewportHeight(height);
        content.style.setProperty("--diff-viewport-h", `${height}px`);
    }, []);

    // Redraw every ribbon from the same per-pane offsets the columns were just
    // translated by, so a hunk's band always meets its own rows on both sides.
    // Each side's extent comes from that pane's own geometry: a deletion-only
    // hunk followed by an insertion-only one flips which pane is taller, and a
    // shared canonical extent would misdraw one of them.
    // Each arrow stands beside the hunk in the pane the change CAME FROM, not at the canonical
    // position and not beside the pane it writes into: those three differ by exactly the rows
    // one pane has and the other does not, which is every hunk the button exists for. See
    // `revertArrowPane` for which hunk kind that leaves standing on a collapsed seam.
    const drawActions = useCallback(
        (
            currentLayout: DiffVerticalLayout<DiffPane>,
            offsets: Readonly<Record<DiffPane, number>>,
            viewportH: number,
        ) => {
            if (editablePane === undefined) return;
            const pane = revertArrowPane(editablePane);
            // Takes no `RibbonSpan`, unlike `drawRibbons`. The arrow does not live in the
            // channel between the panes: it stands inside one pane's own action strip, so its
            // anchor is that pane's measured column edge and nothing about the gap.
            const { leftPx, transform } = revertArrowX(
                pane,
                viewportRef.current.stripAnchorPx[pane],
            );
            for (const [index, button] of actionButtons) {
                if (index >= currentLayout.canonicalTopPx.length) continue;
                const top = currentLayout.paneTopPx[pane][index] - offsets[pane];
                const paneH = currentLayout.paneHPx[pane][index];
                const bottom = top + paneH;
                if (bottom < 0 || top > viewportH) {
                    button.style.display = "none";
                    continue;
                }
                // Not `""`: that clears the inline property and hands the button back to
                // the stylesheet, which hides it. The ribbons get away with it only because
                // nothing declares a display for them.
                button.style.display = "flex";
                // PyCharm's placement: the box centres on the hunk's FIRST line-number row, not
                // on the hunk's top edge. Top-aligning a 30px box to a 20px row hangs it 10px
                // into the row below, so the arrow reads as annotating the wrong number and the
                // hunk's boundary cuts across the middle of the glyph; centred, that boundary
                // grazes the top of the icon instead.
                //
                // `top` names the row's centre and `.diff-hunk-revert`'s `translate` centres the
                // box on it -- the same split as the horizontal half, where `left` names the
                // edge and the transform names which of the box's own edges meets it. Nothing
                // here has to agree with the 30px in diff-viewer.css.
                //
                // The clamp is not defensive. A hunk whose rows exist only in the EDITABLE pane
                // collapses to a zero-height seam in the pane the arrow stands in, and there is
                // no row to centre on; clamping to that pane's own height centres the arrow on
                // the seam, which is where the hunk actually is.
                // These four writes are consecutive with no DOM READ between them, which is
                // the condition that actually forces a synchronous reflow. Nothing here
                // measures; `top`, `leftPx`, `paneH` and `transform` were all computed above,
                // and `viewportRef.current` is a plain object. The browser coalesces a run of
                // pure writes until the next read or paint, so cssText would batch nothing
                // that is not already batched -- and it would clobber any property this
                // function does not set, which is how the ribbons lose their display value.
                // react-doctor-disable-next-line react-doctor/js-batch-dom-css
                button.style.top = `${top + Math.min(paneH, viewportRef.current.lineRowPx) / 2}px`;
                // react-doctor-disable-next-line react-doctor/js-batch-dom-css
                button.style.left = `${leftPx}px`;
                // Set here rather than in the stylesheet because it is half of one placement
                // decision: `left` alone is meaningless without knowing which of the box's
                // edges it names, and splitting the pair across two files is how the two
                // drift apart.
                // react-doctor-disable-next-line react-doctor/js-batch-dom-css
                button.style.transform = transform;
            }
        },
        [actionButtons, editablePane],
    );

    const drawRibbons = useCallback(
        (
            currentLayout: DiffVerticalLayout<DiffPane>,
            offsets: Readonly<Record<DiffPane, number>>,
            viewportH: number,
            span: RibbonSpan,
        ) => {
            for (const [index, path] of ribbonPaths) {
                if (index >= currentLayout.canonicalTopPx.length) continue;
                const leftTop = currentLayout.paneTopPx.left[index] - offsets.left;
                const leftBottom = leftTop + currentLayout.paneHPx.left[index];
                const rightTop = currentLayout.paneTopPx.right[index] - offsets.right;
                const rightBottom = rightTop + currentLayout.paneHPx.right[index];
                if (
                    Math.max(leftBottom, rightBottom) < 0 ||
                    Math.min(leftTop, rightTop) > viewportH
                ) {
                    path.style.display = "none";
                    continue;
                }
                path.style.display = "";
                path.setAttribute(
                    "d",
                    ribbonPathD(span, leftTop, leftBottom, rightTop, rightBottom),
                );
            }
        },
        [ribbonPaths],
    );

    const drawVerticalFrame = useCallback(() => {
        const content = contentRef.current;
        const currentLayout = layoutRef.current;
        if (!content || !currentLayout) return;
        const { height: viewportH, channel } = viewportRef.current;
        const offsets = paneOffsetsForCanonical(currentLayout, DIFF_PANES, content.scrollTop);
        applyPaneOffsets(DIFF_PANES, (pane) => columnRefs.current[pane], offsets);
        drawRibbons(currentLayout, offsets, viewportH, channel);
        drawActions(currentLayout, offsets, viewportH);
    }, [drawActions, drawRibbons]);

    const registerRibbonPath = useCallback(
        (index: number, element: SVGPathElement | null) => {
            if (element) ribbonPaths.set(index, element);
            else ribbonPaths.delete(index);
        },
        [ribbonPaths],
    );

    const registerActionButton = useCallback(
        (index: number, element: HTMLButtonElement | null) => {
            if (element) actionButtons.set(index, element);
            else actionButtons.delete(index);
        },
        [actionButtons],
    );

    const scheduleVerticalFrame = useCallback(() => {
        if (verticalFrameRef.current) return;
        verticalFrameRef.current = requestAnimationFrame(() => {
            verticalFrameRef.current = 0;
            drawVerticalFrame();
        });
    }, [drawVerticalFrame]);

    // Cancel whatever frame is still pending when the pane goes away. Read inside the cleanup
    // rather than captured: this is unmount-only, and the handle to cancel is whichever frame is
    // pending AT unmount. At mount there is no frame at all, so a captured value would be zero
    // and would cancel nothing -- the exact leak this exists to prevent.
    useEffect(
        () => () => {
            if (verticalFrameRef.current) cancelAnimationFrame(verticalFrameRef.current);
        },
        [],
    );

    return {
        contentRef,
        viewportElementRef,
        columnRefs,
        layoutRef,
        viewportHeight,
        measureViewport,
        scheduleVerticalFrame,
        registerRibbonPath,
        registerActionButton,
    };
}
