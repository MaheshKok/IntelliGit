import {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MutableRefObject,
} from "react";
import type { EditorView } from "@codemirror/view";
import {
    buildVerticalLayout,
    scrollRangePx,
    LINE_HEIGHT_PX,
    type DiffVerticalLayout,
} from "../diff-core/mergeScrollLayout";
import { applyPaneOffsets, paneOffsetsForCanonical } from "../diff-core/scrollSync";
import {
    MERGE_PANES,
    type MergePaneId,
    type ConnectorRenderSpec,
    measureRibbonSpans,
    drawRibbons,
    requirePxVar,
} from "./mergeRibbons";
import { groupingField, type WorkbenchHunk } from "./workbenchModel";
import {
    layoutSegments,
    overviewMarkers,
    canonicalForPaneY,
    horizontalInnerWidth,
    workbenchConnectors,
} from "./workbenchLayout";
import type { ConnectorSpec, OverviewMarker } from "./segments";
import type { WorkbenchScrollHandler } from "./codeEditor";

function scrollVertical(
    content: HTMLElement,
    layout: DiffVerticalLayout<MergePaneId>,
    pane: MergePaneId,
    paneY: number,
    viewportH: number,
) {
    if (viewportH === 0) return;
    const canonicalY = canonicalForPaneY(layout, pane, paneY);
    let top = content.scrollTop;
    if (canonicalY < top + LINE_HEIGHT_PX) top = canonicalY - LINE_HEIGHT_PX;
    else if (canonicalY > top + viewportH - 2 * LINE_HEIGHT_PX)
        top = canonicalY - viewportH + 2 * LINE_HEIGHT_PX;
    content.scrollTop = Math.max(
        0,
        Math.min(top, Math.max(0, scrollRangePx(layout.canonicalTotalPx, viewportH) - viewportH)),
    );
}

function horizontalPosition(view: EditorView, head: number, left: number): number | null {
    const contentLeft = view.contentDOM.getBoundingClientRect().left;
    // scrollHandler runs in CodeMirror's update phase, where coordsAtPos throws.
    // Its public DOM position API lets us measure the same caret synchronously.
    const position = view.domAtPos(head, -1);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const coords = range.getClientRects()[0];
    const node = position.node;
    const line = (
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    )?.closest<HTMLElement>(".cm-line");
    if (!coords && !line) throw new Error("merge-workbench: caret line is missing");
    const x =
        (coords?.left ??
            line!.getBoundingClientRect().left + parseFloat(getComputedStyle(line!).paddingLeft)) -
        contentLeft +
        view.contentDOM.scrollLeft;
    const visibleW = view.contentDOM.clientWidth;
    if (x < left + LINE_HEIGHT_PX) return x - LINE_HEIGHT_PX;
    if (x > left + visibleW - LINE_HEIGHT_PX) return x - visibleW + LINE_HEIGHT_PX;
    return left;
}

function resetScroll(element: HTMLElement | null) {
    if (!element) return;
    if (element.scrollTop) element.scrollTop = 0;
    if (element.scrollLeft) element.scrollLeft = 0;
}

function gutterWidthOf(col: HTMLElement, withActions: boolean): number {
    const width = [...col.querySelectorAll<HTMLElement>(".cm-gutters")].reduce(
        (total, gutter) => total + gutter.offsetWidth,
        0,
    );
    if (width > 0) return width;
    const lineNumber = col.querySelector(".cm-lineNumbers .cm-gutterElement");
    const minWidth = lineNumber ? getComputedStyle(lineNumber).minWidth : "";
    const lineNumberWidth = Number.parseFloat(minWidth);
    if (!minWidth.endsWith("px") || !Number.isFinite(lineNumberWidth) || lineNumberWidth <= 0)
        throw new Error("merge-editor: CSS variable --merge-line-number-gutter is missing or 0");
    return lineNumberWidth + (withActions ? requirePxVar(col, "--merge-action-gutter") : 0);
}

function sameRibbonSpans(
    previous: ReturnType<typeof measureRibbonSpans>,
    next: NonNullable<ReturnType<typeof measureRibbonSpans>>,
): boolean {
    return (["left", "right"] as const).every((side) =>
        (["band", "contour"] as const).every((kind) =>
            (["x0", "curveX0", "curveX1", "x1"] as const).every(
                (key) => previous?.[side][kind][key] === next[side][kind][key],
            ),
        ),
    );
}

/** Drives the workbench's single vertical scroller and translated editor columns. */
export function useWorkbenchLayout(
    editors: MutableRefObject<Array<{ view: EditorView }>>,
    hunks: readonly WorkbenchHunk[],
) {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const horizontalRef = useRef<HTMLDivElement | null>(null);
    const horizontalInnerRef = useRef<HTMLDivElement | null>(null);
    const columnRefs = useRef<Record<MergePaneId, HTMLDivElement | null>>({
        left: null,
        middle: null,
        right: null,
    });
    const [geometry, setGeometry] = useState(() => ({
        layout: buildVerticalLayout([], MERGE_PANES),
        markers: [] as OverviewMarker[],
        connectorSpecs: [] as ConnectorSpec[],
    }));
    const layoutRef = useRef(geometry.layout);
    const connectorsRef = useRef<ConnectorRenderSpec[]>([]);
    const spansRef = useRef<ReturnType<typeof measureRibbonSpans>>(null);
    const ribbonMeasureKey = useRef({});
    const paths = useMemo(() => new Map<string, SVGPathElement>(), []);
    const registerPath = useCallback(
        (key: string, el: SVGPathElement | null) => {
            if (el) paths.set(key, el);
            else paths.delete(key);
        },
        [paths],
    );
    const frameRef = useRef(0);
    const horizontalRoom = useRef(new WeakMap<HTMLElement, number>());
    const requestedHorizontal = useRef<number | null>(null);
    const viewportHRef = useRef(0);
    const [viewportH, setViewportH] = useState(0);

    const syncHorizontal = useCallback(
        (left: number) => {
            const bar = horizontalRef.current;
            if (!bar) throw new Error("merge-workbench: horizontal bar is missing");
            bar.scrollLeft = left;
            editors.current.slice(0, 3).forEach(({ view }) => {
                view.contentDOM.scrollLeft = bar.scrollLeft;
            });
        },
        [editors],
    );

    const drawFrameNow = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        const offsets = paneOffsetsForCanonical(layoutRef.current, MERGE_PANES, content.scrollTop);
        applyPaneOffsets(MERGE_PANES, (pane) => columnRefs.current[pane], offsets);
        const panes = editors.current.slice(0, 3);
        const bar = horizontalRef.current;
        const inner = horizontalInnerRef.current;
        if (!bar || !inner) throw new Error("merge-workbench: horizontal bar is missing");
        panes[0]?.view.requestMeasure({
            key: horizontalInnerRef,
            read: () => {
                // Remove our previous room before measuring natural overflow, so edits can shrink it.
                const natural = panes.map(({ view }) => ({
                    clientWidth: view.contentDOM.clientWidth,
                    scrollWidth:
                        view.contentDOM.scrollWidth -
                        (horizontalRoom.current.get(view.contentDOM) ?? 0),
                }));
                const width = horizontalInnerWidth(bar.clientWidth, natural);
                const overflow = width - bar.clientWidth;
                return {
                    width,
                    rooms: natural.map(
                        (pane) => overflow - Math.max(0, pane.scrollWidth - pane.clientWidth),
                    ),
                };
            },
            write: ({ width, rooms }) => {
                panes.forEach(({ view }, index) => {
                    const room = rooms[index];
                    if (horizontalRoom.current.get(view.contentDOM) !== room) {
                        horizontalRoom.current.set(view.contentDOM, room);
                        view.contentDOM.style.setProperty("--merge-horizontal-room", `${room}px`);
                    }
                });
                inner.style.width = `${width}px`;
                syncHorizontal(requestedHorizontal.current ?? bar.scrollLeft);
                requestedHorizontal.current = null;
            },
        });
        panes[0]?.view.requestMeasure({
            key: ribbonMeasureKey,
            read: () =>
                viewportRef.current && viewportRef.current.clientWidth > 0
                    ? measureRibbonSpans(columnRefs.current, gutterWidthOf)
                    : null,
            write: (spans) => {
                if (spans && !sameRibbonSpans(spansRef.current, spans)) {
                    spansRef.current = spans;
                    drawRibbons(
                        layoutRef.current,
                        offsets,
                        viewportHRef.current,
                        spans,
                        connectorsRef.current,
                        paths,
                    );
                }
            },
        });
        panes.slice(1).forEach(({ view }) => view.requestMeasure());
        if (spansRef.current) {
            drawRibbons(
                layoutRef.current,
                offsets,
                viewportHRef.current,
                spansRef.current,
                connectorsRef.current,
                paths,
            );
        }
        resetScroll(viewportRef.current);
        MERGE_PANES.forEach((pane) => resetScroll(columnRefs.current[pane]));
    }, [editors, syncHorizontal, paths]);

    const handleScrollRequest = useCallback<WorkbenchScrollHandler>(
        (pane, view, range, _scrollOptions) => {
            try {
                const content = contentRef.current;
                const bar = horizontalRef.current;
                if (!content || !bar) throw new Error("merge-workbench: scrollers are missing");
                const paneId = { ours: "left", result: "middle", theirs: "right" } as const;
                scrollVertical(
                    content,
                    layoutRef.current,
                    paneId[pane],
                    view.lineBlockAt(range.head).top,
                    viewportHRef.current,
                );
                const left = horizontalPosition(view, range.head, bar.scrollLeft);
                if (left !== null) {
                    requestedHorizontal.current = left;
                    syncHorizontal(left);
                }
                drawFrameNow();
            } catch (error) {
                // CodeMirror falls back to native scrolling if a handler throws.
                console.error("merge-workbench: scroll request failed", error);
            }
            return true;
        },
        [drawFrameNow, syncHorizontal],
    );

    const onHorizontalScroll = useCallback(() => {
        requestedHorizontal.current = null;
        const bar = horizontalRef.current;
        if (!bar) throw new Error("merge-workbench: horizontal bar is missing");
        syncHorizontal(bar.scrollLeft);
        drawFrameNow();
    }, [syncHorizontal, drawFrameNow]);

    const scheduleFrame = useCallback(() => {
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0;
            drawFrameNow();
        });
    }, [drawFrameNow]);

    const measureViewport = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        const height = content.clientHeight;
        viewportHRef.current = height;
        setViewportH(height);
        content.style.setProperty("--merge-viewport-h", `${height}px`);
    }, []);

    useLayoutEffect(() => {
        for (const pane of MERGE_PANES) {
            columnRefs.current[pane] = viewportRef.current!.querySelector(`.col-${pane}`);
        }
        const state = editors.current[1]?.view.state;
        // Editors mount in useWorkbenchEditors' effect and publish the initial hunks afterwards.
        if (!state) return;
        const field = state.field(groupingField);
        const info = layoutSegments(field.segments, hunks, state.doc);
        const layout = buildVerticalLayout(info.paneLines, MERGE_PANES);
        const connectors = workbenchConnectors(hunks, field.segments);
        layoutRef.current = layout;
        connectorsRef.current = connectors;
        setGeometry({
            layout,
            markers: overviewMarkers(hunks, info, null),
            connectorSpecs: connectors.map(({ id, left, right }) => ({
                id,
                leftColorClass: left?.colorClass,
                rightColorClass: right?.colorClass,
            })),
        });
        measureViewport();
        scheduleFrame();
    }, [editors, hunks, measureViewport, scheduleFrame]);

    const mountedEditors = editors.current;
    useLayoutEffect(() => {
        measureViewport();
        const content = contentRef.current;
        if (!content || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            measureViewport();
            scheduleFrame();
        });
        observer.observe(content);
        mountedEditors.slice(0, 3).forEach(({ view }) => observer.observe(view.contentDOM));
        return () => observer.disconnect();
    }, [mountedEditors, measureViewport, scheduleFrame]);

    useLayoutEffect(() => () => cancelAnimationFrame(frameRef.current), []);

    const jumpTo = useCallback(
        (index: number) => {
            const content = contentRef.current;
            const hunk = hunks[index];
            if (!content || !hunk) return;
            const layout = layoutRef.current;
            const extent = layout.hunkCanonical.get(hunk.id);
            if (!extent) throw new Error("merge-editor: jump hunk is missing from the layout");
            const height = viewportHRef.current;
            const maxScroll = Math.max(0, scrollRangePx(layout.canonicalTotalPx, height) - height);
            const top = Math.max(
                0,
                Math.min(extent.top + extent.height / 2 - height / 2, maxScroll),
            );
            if (typeof content.scrollTo === "function")
                content.scrollTo({ top, behavior: "smooth" });
            else content.scrollTop = top;
            drawFrameNow();
        },
        [hunks, drawFrameNow],
    );

    return {
        ...geometry,
        viewportH,
        contentRef,
        viewportRef,
        horizontalRef,
        horizontalInnerRef,
        handleScrollRequest,
        onHorizontalScroll,
        onScroll: scheduleFrame,
        jumpTo,
        drawFrameNow,
        registerPath,
    };
}
