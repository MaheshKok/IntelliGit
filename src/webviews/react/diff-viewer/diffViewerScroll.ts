// Keeping the diff scrolled: the shared horizontal offset both panes read, the scrollbar that
// drives it, and the measure/reset cycle that runs whenever the layout or the document changes.
//
// Split out of `App`. The panel is a singleton, so this is also where a second file opening into
// the first one's scroll position is prevented -- see `documentIdentityOf` for what counts as a
// different document, which is the whole of that mechanism.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { DiffViewerData } from "../../protocol/diffViewerTypes";
import type { DiffVerticalLayout } from "../diff-core/mergeScrollLayout";
import {
    alignScrollOverlays,
    syncHorizontalScroll as syncHorizontalScrollCore,
    updateSharedScrollbar as updateSharedScrollbarCore,
} from "../diff-core/scrollSync";
import { DIFF_PANES, type DiffPane } from "./segmentMarkers";

/** Padding inside a line's box, added to its `ch` width to get the width it needs. */
export const LINE_PADDING_PX = 18;

/**
 * Which document is on screen, as opposed to which payload delivered it.
 *
 * The viewer panel is a singleton, so opening a second file from the changed-files list
 * reuses the live webview: nothing remounts, and the scroll box keeps the offset the
 * previous file was left at. The second file then opens partway into itself, or past its
 * own end, which is the view that reads as one file's diff bleeding into another's.
 *
 * Both labels count, not only the path -- one file against two different revisions is two
 * different diffs, which is what the file-history entry point opens. What must NOT count is
 * anything that changes while one document stays on screen: the segments, the
 * ignore-whitespace mode and the load error all re-post constantly, and keying on those
 * would throw the reader back to line 1 on every whitespace toggle.
 *
 * `documentId` leads because the labels are not always enough to tell two diffs apart: a
 * shelf entry is captioned `Shelved` whatever it holds, so two shelved versions of one file
 * agree on all three of the other fields. Hosts that can be more specific put that here, and
 * a host that cannot is no worse off than before.
 *
 * `JSON.stringify` rather than joining on a separator, because every separator a path
 * or a label is allowed to contain lets two different documents spell one key -- and
 * "Working tree" already contains a space. Quoting the fields removes the question
 * instead of answering it once per separator.
 */
function documentIdentityOf(data: DiffViewerData | null): string | null {
    return data === null
        ? null
        : JSON.stringify([data.documentId ?? null, data.path, data.leftLabel, data.rightLabel]);
}

/** The scroll surfaces the render attaches to, and the handlers it routes scroll events through. */
export interface DiffViewerScroll {
    readonly horizontalScrollRef: React.MutableRefObject<HTMLDivElement | null>;
    readonly horizontalScrollInnerRef: React.MutableRefObject<HTMLDivElement | null>;
    readonly syncHorizontalScroll: (left: number, source?: HTMLElement | null) => void;
    readonly handleScroll: (event: React.UIEvent<HTMLDivElement>) => void;
    readonly handleHorizontalScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * Wires both scroll axes to the geometry `useDiffOverlayPainter` measures.
 *
 * Takes the painter's refs and draw commands rather than measuring anything itself: the box this
 * scrolls IS the box the overlay is drawn over, so a second measurement of it would be a second
 * answer that drifts from the first exactly when the layout moves.
 */
export function useDiffViewerScroll({
    data,
    layout,
    maxLineLength,
    revertablePane,
    contentRef,
    columnRefs,
    measureViewport,
    scheduleVerticalFrame,
}: {
    data: DiffViewerData | null;
    layout: DiffVerticalLayout<DiffPane>;
    maxLineLength: number;
    revertablePane: DiffPane | undefined;
    contentRef: React.MutableRefObject<HTMLDivElement | null>;
    columnRefs: React.MutableRefObject<Record<DiffPane, HTMLDivElement | null>>;
    measureViewport: () => void;
    scheduleVerticalFrame: () => void;
}): DiffViewerScroll {
    const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollInnerRef = useRef<HTMLDivElement | null>(null);
    const lastPaneClientWidthRef = useRef(0);
    const scrollSyncRef = useRef({ raf: 0, left: 0 });

    const syncHorizontalScroll = useCallback(
        (left: number, source?: HTMLElement | null) => {
            syncHorizontalScrollCore(
                DIFF_PANES,
                (pane) =>
                    columnRefs.current[pane]?.querySelectorAll<HTMLElement>(
                        ".code-lines, .diff-edit-textarea",
                    ) ?? [],
                horizontalScrollRef.current,
                scrollSyncRef.current,
                left,
                source,
            );

            for (const pane of DIFF_PANES) {
                alignScrollOverlays(
                    columnRefs.current[pane]?.querySelectorAll<HTMLElement>(
                        ".diff-edit-textarea",
                    ) ?? [],
                    left,
                );
            }
        },
        [columnRefs],
    );

    const updateHorizontalScrollWidth = useCallback(() => {
        updateSharedScrollbarCore(
            DIFF_PANES,
            (pane) => columnRefs.current[pane],
            horizontalScrollRef.current,
            horizontalScrollInnerRef.current,
            maxLineLength,
            LINE_PADDING_PX,
            lastPaneClientWidthRef,
            scrollSyncRef.current.left,
            syncHorizontalScroll,
        );
    }, [columnRefs, maxLineLength, syncHorizontalScroll]);

    const handleScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            if (target.classList.contains("code-lines")) {
                syncHorizontalScroll(target.scrollLeft, target);
            } else if (target === contentRef.current) {
                scheduleVerticalFrame();
            }
        },
        [contentRef, scheduleVerticalFrame, syncHorizontalScroll],
    );

    const handleHorizontalScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            syncHorizontalScroll(event.currentTarget.scrollLeft, event.currentTarget);
        },
        [syncHorizontalScroll],
    );

    // Both axes: a long line in the file just closed leaves the next one scrolled sideways
    // just as readily as it leaves it scrolled down, and the horizontal offset lives in a
    // ref shared by both panes rather than on the element this resets.
    const resetViewport = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        content.scrollTop = 0;
        syncHorizontalScroll(0);
        scheduleVerticalFrame();
    }, [contentRef, scheduleVerticalFrame, syncHorizontalScroll]);

    // Keyed on the document rather than on `data`, which is what makes this a reset per file
    // instead of a reset per payload: the key is the whole mechanism, so the identity string
    // is where the behaviour lives and this effect is only the write.
    const documentKey = documentIdentityOf(data);
    useLayoutEffect(() => {
        resetViewport();
    }, [documentKey, resetViewport]);

    // Runs before paint so `--diff-viewport-h` (which sizes the sticky viewport
    // and its margin-bottom cancel) is committed on the first frame — otherwise
    // the scrollbar would flash one viewport too long before a post-paint
    // measure.
    // `revertablePane` is a dependency because it opens and closes the action strip, which
    // changes every number column's width without changing `layout` at all. The panel is a
    // singleton: a second file arriving with the same shape but a different editability keeps
    // one `layout` identity, so measuring on `layout` alone never re-read the columns for the
    // new payload at all. This pass still cannot see the strip it just opened -- see the
    // observer below, which is what finally places the arrow -- but it is what re-reads the
    // rest of the viewport geometry when only editability moved.
    useLayoutEffect(() => {
        measureViewport();
        scheduleVerticalFrame();
    }, [layout, measureViewport, revertablePane, scheduleVerticalFrame]);

    useEffect(() => {
        const raf = requestAnimationFrame(updateHorizontalScrollWidth);
        return () => cancelAnimationFrame(raf);
    }, [layout, updateHorizontalScrollWidth]);

    // Keyed on hasDiffData because the scroller only mounts with data: the
    // mount-time run finds no element, so it must re-attach once the loading
    // branch is replaced or resizes would leave the viewport geometry stale.
    const hasDiffData = data !== null;
    useEffect(() => {
        measureViewport();
        const content = contentRef.current;
        if (!content || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            measureViewport();
            scheduleVerticalFrame();
            updateHorizontalScrollWidth();
        });
        observer.observe(content);
        // Each pane's number column is observed too, and that is what actually places the arrow.
        // The strip's width is NOT readable on the commit that opens it: the root already
        // computes `--diff-viewer-action-gutter: 20px` while the code block below it still
        // reports `grid-template-columns: 541px 33px`, and a `getBoundingClientRect` on the
        // column returns that stale 33 rather than flushing it -- the segments carry
        // `content-visibility: auto`, so the pane that did NOT change its DOM keeps last frame's
        // geometry. Measuring again on the next frame was not enough either; the observer is,
        // because it fires off the resize itself, whenever the browser gets round to it.
        // `content` cannot stand in for this: opening the strip moves a boundary inside it and
        // leaves its own box exactly the same size.
        for (const pane of DIFF_PANES) {
            const column = columnRefs.current[pane]?.querySelector(".line-numbers");
            if (column) observer.observe(column);
        }
        return () => observer.disconnect();
    }, [
        columnRefs,
        contentRef,
        hasDiffData,
        layout,
        measureViewport,
        revertablePane,
        scheduleVerticalFrame,
        updateHorizontalScrollWidth,
    ]);

    // `scrollSyncRef` is captured because a ref's identity must be pinned for the cleanup to
    // reach the same object; its `.raf` field is still read live. The vertical frame is cancelled
    // by `useDiffOverlayPainter`, which owns it.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
    useEffect(() => {
        const scrollSyncState = scrollSyncRef.current;
        return () => {
            if (scrollSyncState.raf) cancelAnimationFrame(scrollSyncState.raf);
        };
    }, []);

    return {
        horizontalScrollRef,
        horizontalScrollInnerRef,
        syncHorizontalScroll,
        handleScroll,
        handleHorizontalScroll,
    };
}
