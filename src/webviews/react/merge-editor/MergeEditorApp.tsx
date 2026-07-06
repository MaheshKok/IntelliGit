// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
    ConflictSegment,
    HunkResolution,
    InboundMessage,
    MergeSegment,
    OutboundMessage,
} from "./types";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import { t } from "../shared/i18n";
import {
    IconArrowRight,
    IconArrowLeft,
    IconChevronUp,
    IconChevronDown,
    IconSpark,
    IconEye,
    IconFilter,
    IconLock,
    IconWarning,
} from "./icons";
import {
    reducer,
    getEffectiveResultLines,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
    isTrueConflict,
} from "./mergeState";
import {
    CommonPaneBlock,
    OursConflictBlock,
    ResultConflictBlock,
    TheirsConflictBlock,
    ConnectorLayer,
    connectorClass,
    OverviewRail,
    type SegmentPaneLineNumbers,
    type ConnectorSpec,
    type OverviewMarker,
} from "./segments";
import {
    buildVerticalLayout,
    paneOffsetForCanonical,
    type MergeVerticalLayout,
    type MergePane,
    type SegmentPaneLines,
} from "./mergeScrollLayout";
import { buildLineNumberValues } from "./lineNumbers";
import { initShiki, isShikiReady, langForPath, detectTheme } from "./shikiHighlighter";
import { SyntaxHighlightProvider } from "./syntaxHighlightContext";
import "./merge-editor.css";

const EMPTY_SEGMENTS: MergeSegment[] = [];

/** Horizontal padding of a `.code-line` (0 9px), added to the content width. */
const LINE_PADDING_PX = 18;

const MERGE_PANES: readonly MergePane[] = ["left", "middle", "right"];

/**
 * Sets one connector ribbon's path to a filled quadrilateral spanning a gutter:
 * from side A (rows aTop..aBot at x0) to side B (rows bTop..bBot at x1), with
 * cubic-bezier top and bottom edges. Hides the path when the hunk is fully
 * outside the viewport so offscreen ribbons cost nothing.
 */
function setRibbonPath(
    path: SVGPathElement | undefined,
    x0: number,
    x1: number,
    aTop: number,
    aBot: number,
    bTop: number,
    bBot: number,
    viewportH: number,
): void {
    if (!path) return;
    const top = Math.min(aTop, bTop);
    const bottom = Math.max(aBot, bBot);
    if (bottom < 0 || top > viewportH) {
        path.style.display = "none";
        return;
    }
    path.style.display = "";
    const xc = (x0 + x1) / 2;
    path.setAttribute(
        "d",
        `M ${x0},${aTop} C ${xc},${aTop} ${xc},${bTop} ${x1},${bTop} ` +
            `L ${x1},${bBot} C ${xc},${bBot} ${xc},${aBot} ${x0},${aBot} Z`,
    );
}

// --- VS Code API ---

/** Acquires the typed VS Code API for the interactive three-way merge editor. */
function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

// --- App ---

/**
 * Hosts the three-way merge editor, translating conflict data into synchronized
 * pane rows, local hunk resolutions, overview markers, keyboard navigation, and
 * extension apply/ignore-mode commands.
 */
// Webview entrypoint owns merge-editor state orchestration and root render side effects.
// react-doctor-disable-next-line react-doctor/only-export-components, react-doctor/no-giant-component
function App() {
    const [state, dispatch] = useReducer(reducer, {
        data: null,
        error: null,
        resolutions: {},
        edits: {},
        dismissals: {},
    });
    const [showDetails, setShowDetails] = useState(false);
    const [highlightWords, setHighlightWords] = useState(true);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");
    const [activeConflictId, setActiveConflictId] = useState<number | null>(null);
    const [shikiReady, setShikiReady] = useState(isShikiReady());
    // ponytail: theme sampled once at mount. VS Code reloads the webview on a
    // live theme switch, so re-reading the body class on every render buys
    // nothing — reopen the merge editor to pick up a changed theme.
    const [shikiTheme] = useState(detectTheme());
    const segments = state.data?.segments ?? EMPTY_SEGMENTS;
    const filePath = state.data?.filePath;
    const syntaxHighlightState = useMemo(
        () => ({
            ready: shikiReady,
            lang: filePath ? langForPath(filePath) : null,
            theme: shikiTheme,
        }),
        [shikiReady, filePath, shikiTheme],
    );

    const mergeContentRef = useRef<HTMLDivElement | null>(null);
    const columnRefs = useRef<Record<MergePane, HTMLDivElement | null>>({
        left: null,
        middle: null,
        right: null,
    });
    const connectorPathsRef = useRef<Map<string, SVGPathElement>>(new Map());
    // Gutter x-ranges (viewport-relative) the connector ribbons span; measured
    // on layout/resize so the per-frame draw only recomputes y.
    const gutterXRef = useRef<{ leftX0: number; leftX1: number; rightX0: number; rightX1: number }>(
        { leftX0: 0, leftX1: 0, rightX0: 0, rightX1: 0 },
    );
    const viewportHRef = useRef(0);
    const layoutRef = useRef<MergeVerticalLayout | null>(null);
    // Conflict hunks the ribbons link, kept in a ref so the rAF draw reads the
    // current set without being re-created each render.
    const connectorsRef = useRef<{ id: number; index: number }[]>([]);
    const vFrameRef = useRef(0);
    const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollInnerRef = useRef<HTMLDivElement | null>(null);
    const updateHorizontalScrollWidthRef = useRef<() => void>(() => undefined);
    const lastPaneClientWidthRef = useRef(0);

    const scrollSyncRef = useRef<{ raf: number; left: number }>({ raf: 0, left: 0 });
    const syncHorizontalScroll = useCallback((left: number, source?: HTMLElement | null) => {
        const sync = scrollSyncRef.current;
        sync.left = left;
        if (sync.raf) return;
        sync.raf = requestAnimationFrame(() => {
            sync.raf = 0;
            const targetLeft = sync.left;
            const panes =
                mergeContentRef.current?.querySelectorAll<HTMLElement>(".code-lines") ?? [];
            for (const pane of panes) {
                if (pane === source) continue;
                const max = Math.max(0, pane.scrollWidth - pane.clientWidth);
                const paneLeft = Math.min(targetLeft, max);
                if (Math.abs(pane.scrollLeft - paneLeft) >= 1) pane.scrollLeft = paneLeft;
            }
            const bar = horizontalScrollRef.current;
            if (bar && bar !== source && Math.abs(bar.scrollLeft - targetLeft) >= 1) {
                bar.scrollLeft = targetLeft;
            }
        });
    }, []);

    // Cache the viewport height (clamps pane offsets, culls ribbons) and expose
    // it as a CSS var so the sticky viewport's negative margin cancels its own
    // height, leaving the scroll range at exactly canonicalTotalPx.
    const measureViewport = useCallback(() => {
        const content = mergeContentRef.current;
        if (!content) return;
        const h = content.clientHeight;
        viewportHRef.current = h;
        content.style.setProperty("--merge-viewport-h", `${h}px`);
    }, []);

    // Gutter x-ranges are viewport-relative and change only on layout/resize, so
    // measure them once here and let the per-frame draw recompute only y.
    const measureGutters = useCallback(() => {
        const { left, middle, right } = columnRefs.current;
        if (!left || !middle || !right) return;
        gutterXRef.current = {
            leftX0: left.offsetLeft + left.offsetWidth,
            leftX1: middle.offsetLeft,
            rightX0: middle.offsetLeft + middle.offsetWidth,
            rightX1: right.offsetLeft,
        };
    }, []);

    const drawConnectors = useCallback((offsets: Record<MergePane, number>, viewportH: number) => {
        const layout = layoutRef.current;
        if (!layout) return;
        const paths = connectorPathsRef.current;
        const { leftX0, leftX1, rightX0, rightX1 } = gutterXRef.current;
        for (const { id, index } of connectorsRef.current) {
            const oursTop = layout.paneTopPx.left[index] - offsets.left;
            const oursBot = oursTop + layout.paneHPx.left[index];
            const midTop = layout.paneTopPx.middle[index] - offsets.middle;
            const midBot = midTop + layout.paneHPx.middle[index];
            const theirsTop = layout.paneTopPx.right[index] - offsets.right;
            const theirsBot = theirsTop + layout.paneHPx.right[index];
            setRibbonPath(
                paths.get(`${id}-left`),
                leftX0,
                leftX1,
                oursTop,
                oursBot,
                midTop,
                midBot,
                viewportH,
            );
            setRibbonPath(
                paths.get(`${id}-right`),
                rightX0,
                rightX1,
                midTop,
                midBot,
                theirsTop,
                theirsBot,
                viewportH,
            );
        }
    }, []);

    // One frame of the vertical layout: translate each column to its proportional
    // offset for the shared canonical scrollTop, then redraw the ribbons from the
    // same offsets so columns and connectors never disagree.
    const drawMergeFrame = useCallback(() => {
        const layout = layoutRef.current;
        const content = mergeContentRef.current;
        if (!layout || !content) return;
        const viewportH = viewportHRef.current;
        const scroll = content.scrollTop;
        const offsets = {
            left: paneOffsetForCanonical(layout, "left", scroll, viewportH),
            middle: paneOffsetForCanonical(layout, "middle", scroll, viewportH),
            right: paneOffsetForCanonical(layout, "right", scroll, viewportH),
        } as Record<MergePane, number>;
        for (const pane of MERGE_PANES) {
            const col = columnRefs.current[pane];
            if (col) col.style.transform = `translateY(${-offsets[pane]}px)`;
        }
        drawConnectors(offsets, viewportH);
    }, [drawConnectors]);

    const scheduleMergeFrame = useCallback(() => {
        if (vFrameRef.current) return;
        vFrameRef.current = requestAnimationFrame(() => {
            vFrameRef.current = 0;
            drawMergeFrame();
        });
    }, [drawMergeFrame]);

    const registerConnectorPath = useCallback((key: string, el: SVGPathElement | null) => {
        if (el) connectorPathsRef.current.set(key, el);
        else connectorPathsRef.current.delete(key);
    }, []);

    const handlePaneScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            if (target.classList.contains("code-lines")) {
                const left = target.scrollLeft;
                const sharedLeft = scrollSyncRef.current.left;
                if (Math.abs(left - sharedLeft) < 1) return;
                const max = target.scrollWidth - target.clientWidth;
                if (left > max - 1 && sharedLeft > max - 1) return;
                syncHorizontalScroll(left, target);
                return;
            }
            // Vertical scroll of the single native scroller drives the columns.
            if (target === mergeContentRef.current) {
                scheduleMergeFrame();
            }
            if (scrollSyncRef.current.left > 0) {
                syncHorizontalScroll(scrollSyncRef.current.left, target);
            }
        },
        [scheduleMergeFrame, syncHorizontalScroll],
    );
    const handleHorizontalScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            syncHorizontalScroll(event.currentTarget.scrollLeft, event.currentTarget);
        },
        [syncHorizontalScroll],
    );
    // Widest line across every pane, derived from the data rather than the DOM.
    // The monospace editor font makes 1ch == one glyph, so this length sizes the
    // synthetic scrollbar without measuring each pane — and it counts lines in
    // offscreen segments whose content-visibility-collapsed scrollWidth would
    // otherwise read short.
    const maxLineLength = useMemo(() => {
        let max = 1;
        for (const segment of segments) {
            if (segment.type === "common") {
                for (const line of segment.lines) max = Math.max(max, line.length);
            } else {
                for (const line of segment.oursLines) max = Math.max(max, line.length);
                for (const line of segment.theirsLines) max = Math.max(max, line.length);
                for (const line of segment.baseLines) max = Math.max(max, line.length);
                // Auto-merged lines splice both sides together, so a merged line
                // can be longer than any single side.
                for (const line of segment.autoResolvedLines ?? []) {
                    max = Math.max(max, line.length);
                }
            }
        }
        for (const lines of Object.values(state.edits)) {
            for (const line of lines) max = Math.max(max, line.length);
        }
        return max;
    }, [segments, state.edits]);
    const updateHorizontalScrollWidth = useCallback(() => {
        const bar = horizontalScrollRef.current;
        const inner = horizontalScrollInnerRef.current;
        const content = mergeContentRef.current;
        if (!bar || !inner || !content) return;
        // The narrowest pane overflows first, so it sets the shared scroll extent.
        // Each column is one flow with a stable width, so the first non-collapsed
        // `.code-lines` in each `.merge-col` gives that pane's clientWidth without
        // walking every block.
        let minClientWidth = Infinity;
        for (const col of content.querySelectorAll<HTMLElement>(".merge-col")) {
            for (const pane of col.querySelectorAll<HTMLElement>(".code-lines")) {
                // A skipped (content-visibility) block reports 0; ignore those
                // and fall back to the last real width below.
                if (pane.clientWidth > 0) {
                    minClientWidth = Math.min(minClientWidth, pane.clientWidth);
                    break;
                }
            }
        }
        // ponytail: reuse the last real width when the first segment is offscreen
        // and layout-skipped. It only drifts if the window is resized while
        // scrolled past segment 0, and self-corrects on the next render tick.
        if (minClientWidth === Infinity) {
            minClientWidth = lastPaneClientWidthRef.current;
        } else {
            lastPaneClientWidthRef.current = minClientWidth;
        }
        // 100% == bar width; the ch term is the content width (monospace) and the
        // px terms add the line padding and subtract the visible pane, leaving
        // exactly the overflow the bar must cover.
        inner.style.width = `calc(100% + ${maxLineLength}ch + ${LINE_PADDING_PX}px - ${minClientWidth}px)`;
        const maxScroll = Math.max(0, inner.offsetWidth - bar.clientWidth);
        bar.hidden = maxScroll < 1;
        if (scrollSyncRef.current.left > maxScroll) {
            syncHorizontalScroll(maxScroll);
        }
    }, [maxLineLength, syncHorizontalScroll]);
    useEffect(() => {
        updateHorizontalScrollWidthRef.current = updateHorizontalScrollWidth;
    }, [updateHorizontalScrollWidth]);
    const renderedSegments = useMemo(() => {
        let canonicalLineCursor = 1;
        let oursCursor = 1;
        let baseCursor = 1;
        let theirsCursor = 1;
        let resultCursor = 1;
        let conflictOrdinal = 0;
        let trueConflictOrdinal = 0;

        return segments.map((segment, index) => {
            let paneLines: { left: number; middle: number; right: number };
            // Canonical height is the tallest pane; segment boundaries align
            // across panes in this space while shorter panes flow naturally.
            let canonicalLineCount: number;
            let lineNumbers: SegmentPaneLineNumbers;
            let startLine: number;
            let renderKey: string;

            if (segment.type === "common") {
                const commonLen = segment.lines.length;
                paneLines = { left: commonLen, middle: commonLen, right: commonLen };
                canonicalLineCount = Math.max(commonLen, 1);
                startLine = canonicalLineCursor;
                // Each pane numbers exactly its own lines — no null padding,
                // because panes no longer stretch to a shared row count.
                lineNumbers = {
                    left: { primary: buildLineNumberValues(oursCursor, commonLen, commonLen) },
                    middle: { primary: buildLineNumberValues(resultCursor, commonLen, commonLen) },
                    right: { primary: buildLineNumberValues(theirsCursor, commonLen, commonLen) },
                };
                renderKey = `common-${oursCursor}-${baseCursor}-${theirsCursor}-${commonLen}-${segment.lines[0] ?? ""}`;
                oursCursor += commonLen;
                baseCursor += commonLen;
                theirsCursor += commonLen;
                resultCursor += commonLen;
            } else {
                const resultLines = getEffectiveResultLines(
                    segment,
                    state.resolutions[segment.id],
                    state.edits[segment.id],
                );
                const oursLen = segment.oursLines.length;
                const theirsLen = segment.theirsLines.length;
                const baseLen = segment.baseLines.length;
                const resultLen = resultLines.length;
                paneLines = { left: oursLen, middle: resultLen, right: theirsLen };
                canonicalLineCount = Math.max(oursLen, theirsLen, resultLen, 1);
                startLine = canonicalLineCursor;
                lineNumbers = {
                    left: { primary: buildLineNumberValues(oursCursor, oursLen, oursLen) },
                    middle: { primary: buildLineNumberValues(resultCursor, resultLen, resultLen) },
                    right: { primary: buildLineNumberValues(theirsCursor, theirsLen, theirsLen) },
                };
                renderKey = `conflict-${segment.id}`;
                oursCursor += oursLen;
                baseCursor += baseLen;
                theirsCursor += theirsLen;
                resultCursor += resultLen;
            }

            canonicalLineCursor += canonicalLineCount;

            let computedConflictOrdinal: number | undefined;
            let computedTrueConflictOrdinal: number | undefined;
            if (segment.type === "conflict") {
                conflictOrdinal += 1;
                computedConflictOrdinal = conflictOrdinal;
                if (isTrueConflict(segment)) {
                    trueConflictOrdinal += 1;
                    computedTrueConflictOrdinal = trueConflictOrdinal;
                }
            }

            return {
                segment,
                index,
                renderKey,
                startLine,
                canonicalLineCount,
                paneLines,
                lineNumbers,
                conflictOrdinal: computedConflictOrdinal,
                trueConflictOrdinal: computedTrueConflictOrdinal,
            };
        });
    }, [segments, state.resolutions, state.edits]);

    // Vertical geometry for the single-scrollbar / translated-column layout.
    const layout = useMemo<MergeVerticalLayout>(() => {
        const paneLines: SegmentPaneLines[] = renderedSegments.map((item) => ({
            left: item.paneLines.left,
            middle: item.paneLines.middle,
            right: item.paneLines.right,
            conflict: item.segment.type === "conflict",
            id: item.segment.type === "conflict" ? item.segment.id : undefined,
        }));
        return buildVerticalLayout(paneLines);
    }, [renderedSegments]);

    // Conflict hunks the connector ribbons link across panes. `index` is the
    // segment index into the layout tables; `colorClass` matches the block band.
    const connectors = useMemo(
        () =>
            renderedSegments
                .filter(
                    (
                        item,
                    ): item is (typeof renderedSegments)[number] & { segment: ConflictSegment } =>
                        item.segment.type === "conflict" &&
                        isTrueConflict(item.segment) &&
                        state.resolutions[item.segment.id] === undefined &&
                        state.edits[item.segment.id] === undefined,
                )
                .map((item) => ({
                    id: item.segment.id,
                    index: item.index,
                    colorClass: connectorClass(item.segment),
                })),
        [renderedSegments, state.resolutions, state.edits],
    );
    const connectorSpecs: ConnectorSpec[] = useMemo(
        () => connectors.map(({ id, colorClass }) => ({ id, colorClass })),
        [connectors],
    );

    // Keep the driver's refs current and repaint columns + ribbons whenever the
    // layout or connector set changes (resolve/edit/segment change) so heights
    // and ribbon positions stay in sync with the DOM. Runs before paint so the
    // `--merge-viewport-h` var (which sizes the sticky viewport and its
    // margin-bottom cancel) is committed on the first frame — otherwise the
    // scrollbar would flash one viewport too long before a post-paint measure.
    useLayoutEffect(() => {
        layoutRef.current = layout;
        connectorsRef.current = connectors;
        measureViewport();
        measureGutters();
        scheduleMergeFrame();
    }, [layout, connectors, measureViewport, measureGutters, scheduleMergeFrame]);

    // Track viewport height (pane-offset clamp + ribbon culling) and gutter
    // x-ranges across resizes. jsdom lacks ResizeObserver, so guard it.
    useEffect(() => {
        measureViewport();
        if (typeof ResizeObserver === "undefined") return;
        const content = mergeContentRef.current;
        if (!content) return;
        const observer = new ResizeObserver(() => {
            measureViewport();
            measureGutters();
            scheduleMergeFrame();
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [measureViewport, measureGutters, scheduleMergeFrame]);

    useEffect(() => {
        return () => {
            if (vFrameRef.current) cancelAnimationFrame(vFrameRef.current);
        };
    }, []);

    useEffect(() => {
        const raf = requestAnimationFrame(updateHorizontalScrollWidth);
        return () => cancelAnimationFrame(raf);
    }, [renderedSegments, updateHorizontalScrollWidth]);

    useEffect(() => {
        const handleResize = () => updateHorizontalScrollWidthRef.current();
        window.addEventListener("resize", handleResize);
        const sync = scrollSyncRef.current;
        return () => {
            window.removeEventListener("resize", handleResize);
            if (sync.raf) cancelAnimationFrame(sync.raf);
        };
    }, []);

    const conflictSegments = useMemo(
        () => segments.filter((seg): seg is ConflictSegment => seg.type === "conflict"),
        [segments],
    );
    const trueConflicts = useMemo(
        () => conflictSegments.filter(isTrueConflict),
        [conflictSegments],
    );
    const trueConflictIds = useMemo(() => trueConflicts.map((seg) => seg.id), [trueConflicts]);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setConflictData") {
                setIgnoreMode(
                    event.data.data.diffOptions?.ignoreWhitespace ? "whitespace" : "none",
                );
                dispatch({ type: "SET_DATA", data: event.data.data });
            } else if (event.data.type === "loadError") {
                dispatch({ type: "SET_ERROR", message: event.data.message });
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    // Lazily initialize the Shiki highlighter off the critical render path so the
    // first paint isn't blocked by grammar/theme compilation; flip ready so
    // consumers switch from the fallback tokenizer to grammar-accurate colors.
    useEffect(() => {
        if (shikiReady) return;
        const runInit = (): void => {
            if (initShiki()) setShikiReady(true);
        };
        if (typeof window.requestIdleCallback === "function") {
            const handle = window.requestIdleCallback(runInit);
            return () => window.cancelIdleCallback(handle);
        }
        const timer = window.setTimeout(runInit, 0);
        return () => window.clearTimeout(timer);
    }, [shikiReady]);

    useEffect(() => {
        setActiveConflictId((prev) => {
            if (trueConflictIds.length === 0) return null;
            if (prev !== null && trueConflictIds.includes(prev)) return prev;
            const firstUnresolved = trueConflicts.find(
                (seg) =>
                    state.resolutions[seg.id] === undefined && state.edits[seg.id] === undefined,
            );
            return firstUnresolved?.id ?? trueConflictIds[0];
        });
    }, [trueConflictIds, trueConflicts, state.resolutions, state.edits]);

    const handleResolve = useCallback((id: number, resolution: HunkResolution) => {
        setActiveConflictId(id);
        dispatch({ type: "RESOLVE_HUNK", id, resolution });
    }, []);

    const handleEditResult = useCallback((id: number, lines: string[]) => {
        setActiveConflictId(id);
        dispatch({ type: "EDIT_HUNK_RESULT", id, lines });
    }, []);

    const handleDismissSide = useCallback((id: number, side: "ours" | "theirs") => {
        setActiveConflictId(id);
        dispatch({ type: "DISMISS_SIDE", id, side });
    }, []);

    const handleApply = useCallback(() => {
        if (!state.data) return;
        const content = buildResultContent(state.data, state.resolutions, state.edits);
        getVsCodeApi().postMessage({ type: "applyResolution", content });
    }, [state.data, state.resolutions, state.edits]);

    const handleAcceptAllYours = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            }
        }
    }, [state.data]);

    const handleAcceptAllTheirs = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleApplyNonConflicting = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict" && seg.changeKind === "ours-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            } else if (seg.type === "conflict" && seg.changeKind === "theirs-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleBulkAcceptYours = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptYours" });
    }, []);

    const handleBulkAcceptTheirs = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptTheirs" });
    }, []);

    const handleOpenConflictSession = useCallback(() => {
        getVsCodeApi().postMessage({ type: "openConflictSession" });
    }, []);

    const handleAbortMerge = useCallback(() => {
        getVsCodeApi().postMessage({ type: "abortMerge" });
    }, []);

    const handleRetry = useCallback(() => {
        dispatch({ type: "SET_ERROR", message: "" });
        getVsCodeApi().postMessage({ type: "ready" });
    }, []);

    const handleClose = useCallback(() => {
        getVsCodeApi().postMessage({ type: "close" });
    }, []);

    const handleToggleIgnoreMode = useCallback(() => {
        const nextMode: "none" | "whitespace" = ignoreMode === "none" ? "whitespace" : "none";
        setIgnoreMode(nextMode);
        getVsCodeApi().postMessage({ type: "setIgnoreMode", mode: nextMode });
    }, [ignoreMode]);

    const jumpToConflict = useCallback(
        (id: number) => {
            setActiveConflictId(id);
            const content = mergeContentRef.current;
            const layout = layoutRef.current;
            if (!content || !layout) return;
            const extent = layout.hunkCanonical.get(id);
            if (!extent) return;
            // Center the hunk's canonical extent in the viewport, clamped to range.
            const maxScroll = Math.max(0, layout.canonicalTotalPx - viewportHRef.current);
            const top = Math.max(
                0,
                Math.min(extent.top + extent.height / 2 - viewportHRef.current / 2, maxScroll),
            );
            if (typeof content.scrollTo === "function") {
                content.scrollTo({ top, behavior: "smooth" });
            } else {
                content.scrollTop = top;
            }
            scheduleMergeFrame();
        },
        [scheduleMergeFrame],
    );

    const moveActiveConflict = useCallback(
        (direction: -1 | 1) => {
            if (trueConflictIds.length === 0) return;
            const currentIndex =
                activeConflictId === null ? -1 : trueConflictIds.indexOf(activeConflictId);
            const fallbackIndex = direction > 0 ? -1 : 0;
            const baseIndex = currentIndex === -1 ? fallbackIndex : currentIndex;
            const nextIndex =
                (((baseIndex + direction) % trueConflictIds.length) + trueConflictIds.length) %
                trueConflictIds.length;
            jumpToConflict(trueConflictIds[nextIndex]);
        },
        [activeConflictId, jumpToConflict, trueConflictIds],
    );

    const resolveActiveFromKeyboard = useCallback(
        (resolution: HunkResolution) => {
            if (!state.data) return;
            const targetId =
                activeConflictId !== null
                    ? activeConflictId
                    : trueConflicts.find(
                          (seg) =>
                              state.resolutions[seg.id] === undefined &&
                              state.edits[seg.id] === undefined,
                      )?.id;
            if (targetId === undefined) return;
            const segment = state.data.segments.find(
                (seg): seg is ConflictSegment => seg.type === "conflict" && seg.id === targetId,
            );
            if (!segment) return;
            // Stacking both sides (in either order) only makes sense when both
            // sides changed the same region.
            if (
                (resolution === "both" || resolution === "both-reversed") &&
                segment.changeKind !== "conflict"
            )
                return;
            handleResolve(targetId, resolution);
            // IntelliJ-style: move on to the next unresolved conflict after applying.
            const targetIndex = trueConflicts.findIndex((seg) => seg.id === targetId);
            const ordered = [
                ...trueConflicts.slice(targetIndex + 1),
                ...trueConflicts.slice(0, Math.max(targetIndex, 0)),
            ];
            const next = ordered.find(
                (seg) =>
                    seg.id !== targetId &&
                    state.resolutions[seg.id] === undefined &&
                    state.edits[seg.id] === undefined,
            );
            if (next) jumpToConflict(next.id);
        },
        [
            activeConflictId,
            handleResolve,
            jumpToConflict,
            state.data,
            state.edits,
            state.resolutions,
            trueConflicts,
        ],
    );

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            const normalizedKey = event.key.toLowerCase();
            const hasCommandModifier = event.ctrlKey || event.metaKey;
            const plainKey = !hasCommandModifier && !event.altKey;

            if ((normalizedKey === "p" && plainKey) || (event.shiftKey && event.key === "F7")) {
                event.preventDefault();
                moveActiveConflict(-1);
            } else if ((normalizedKey === "n" && plainKey) || event.key === "F7") {
                event.preventDefault();
                moveActiveConflict(1);
            } else if (hasCommandModifier && event.key === "ArrowLeft") {
                event.preventDefault();
                resolveActiveFromKeyboard("ours");
            } else if (hasCommandModifier && event.key === "ArrowRight") {
                event.preventDefault();
                resolveActiveFromKeyboard("theirs");
            } else if (normalizedKey === "b" && plainKey) {
                event.preventDefault();
                resolveActiveFromKeyboard("both");
            } else if (normalizedKey === "x" && plainKey) {
                event.preventDefault();
                resolveActiveFromKeyboard("none");
            } else if (hasCommandModifier && event.key === "Enter") {
                if (!state.data) return;
                if (!allResolved(state.data.segments, state.resolutions, state.edits)) return;
                event.preventDefault();
                handleApply();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        handleApply,
        moveActiveConflict,
        resolveActiveFromKeyboard,
        state.data,
        state.resolutions,
        state.edits,
    ]);

    if (state.error) {
        return (
            <div className="loading">
                <div className="error-message">{t("merge.error.load", { error: state.error })}</div>
                <button type="button" className="retry-btn" onClick={handleRetry}>
                    {t("merge.error.retry")}
                </button>
            </div>
        );
    }

    if (!state.data) {
        return <div className="loading">{t("merge.loading")}</div>;
    }

    const total = trueConflictCount(segments);
    const resolved = resolvedTrueConflictCount(segments, state.resolutions, state.edits);
    const unresolved = total - resolved;
    const canApply = allResolved(segments, state.resolutions, state.edits);
    const changeCount = conflictSegments.length;
    // One-sided hunks auto-resolve to the changed side, so they never block Apply.
    const autoResolvedCount = changeCount - total;
    const oursChanges = paneChangeCount(segments, "ours");
    const theirsChanges = paneChangeCount(segments, "theirs");
    const currentConflictIndex =
        activeConflictId !== null ? trueConflictIds.indexOf(activeConflictId) + 1 : 0;

    const totalVisualLines = Math.max(
        renderedSegments.reduce((sum, item) => sum + item.canonicalLineCount, 0),
        1,
    );
    const overviewMarkers: OverviewMarker[] = renderedSegments
        .filter(
            (item): item is (typeof renderedSegments)[number] & { segment: ConflictSegment } => {
                return item.segment.type === "conflict";
            },
        )
        .map((item) => ({
            id: item.segment.id,
            ordinal: item.conflictOrdinal ?? 0,
            topPct: ((item.startLine - 1) / totalVisualLines) * 100,
            heightPct: Math.min(
                Math.max((item.canonicalLineCount / totalVisualLines) * 100, 1),
                30,
            ),
            changeKind: item.segment.changeKind,
            resolved:
                !isTrueConflict(item.segment) ||
                state.resolutions[item.segment.id] !== undefined ||
                state.edits[item.segment.id] !== undefined,
        }));

    const unresolvedTrueConflictIds = trueConflicts
        .filter(
            (seg) => state.resolutions[seg.id] === undefined && state.edits[seg.id] === undefined,
        )
        .map((seg) => seg.id);
    const nextUnresolvedId = (() => {
        if (unresolvedTrueConflictIds.length === 0) return null;
        if (activeConflictId === null) return unresolvedTrueConflictIds[0];
        const activeIdx = unresolvedTrueConflictIds.indexOf(activeConflictId);
        const nextIdx = activeIdx + 1;
        return nextIdx < unresolvedTrueConflictIds.length
            ? unresolvedTrueConflictIds[nextIdx]
            : unresolvedTrueConflictIds[0];
    })();

    // Widen the line-number gutter with the largest line number so editor-size
    // digits never clip, floored at the base width for small files. When the
    // host supplied editor.fontSize, use it as the code size, overriding the
    // unreliable --vscode-editor-font-size webview variable.
    const gutterDigits = Math.max(String(totalVisualLines).length, 2);
    const rootStyle = {
        "--merge-line-number-gutter": `max(37px, calc(${gutterDigits}ch + 14px))`,
        // Shared minimum content width for every pane so all code-lines panes
        // scroll in lockstep (see .code-lines in merge-editor.css). Monospace
        // editor font makes 1ch == one glyph, matching the synthetic scrollbar.
        "--merge-line-min-width": `calc(${maxLineLength}ch + ${LINE_PADDING_PX}px)`,
        ...(state.data.editorFontSize
            ? { "--merge-code-font-size": `${state.data.editorFontSize}px` }
            : {}),
    } as React.CSSProperties;

    return (
        <SyntaxHighlightProvider value={syntaxHighlightState}>
            <div
                style={rootStyle}
                className={[
                    "merge-editor",
                    highlightWords ? "words-highlighted" : "",
                    showDetails ? "details-expanded" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                <div className="merge-toolbar">
                    <div className="toolbar-left">
                        <button
                            type="button"
                            className="toolbar-btn subtle"
                            onClick={handleApplyNonConflicting}
                            disabled={autoResolvedCount === 0}
                        >
                            <span className="toolbar-icon">
                                <IconSpark />
                            </span>
                            {t("merge.toolbar.applyNonConflicting")}
                        </button>
                        <div className="toolbar-nav-group">
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                onClick={() => moveActiveConflict(-1)}
                                title={t("merge.toolbar.prevConflict.title")}
                                aria-label={t("merge.toolbar.prevConflict.label")}
                                disabled={total === 0}
                            >
                                <IconChevronUp />
                            </button>
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                onClick={() => moveActiveConflict(1)}
                                title={t("merge.toolbar.nextConflict.title")}
                                aria-label={t("merge.toolbar.nextConflict.label")}
                                disabled={total === 0}
                            >
                                <IconChevronDown />
                            </button>
                        </div>
                        <div className="toolbar-separator" />
                        <button
                            type="button"
                            className="toolbar-btn subtle dropdown"
                            onClick={handleToggleIgnoreMode}
                            title={t("merge.toolbar.ignoreMode.title")}
                        >
                            <span className="toolbar-icon">
                                <IconFilter />
                            </span>
                            {ignoreMode === "none"
                                ? t("merge.toolbar.ignoreMode.none")
                                : t("merge.toolbar.ignoreMode.whitespace")}
                            <span className="toolbar-icon dropdown-icon">
                                <IconChevronDown />
                            </span>
                        </button>
                        <button
                            type="button"
                            className={`toolbar-btn subtle ${highlightWords ? "active" : ""}`}
                            onClick={() => setHighlightWords((v) => !v)}
                            aria-pressed={highlightWords}
                        >
                            <span className="toolbar-icon">
                                <IconEye />
                            </span>
                            {t("merge.toolbar.highlightWords")}
                        </button>
                        <button
                            type="button"
                            className={`toolbar-btn subtle ${showDetails ? "active" : ""}`}
                            onClick={() => setShowDetails((v) => !v)}
                            aria-pressed={showDetails}
                        >
                            {t("merge.toolbar.showDetails")}
                        </button>
                    </div>

                    <div className="toolbar-center">
                        <span className="toolbar-status-pill">
                            <span className="toolbar-icon">
                                <IconWarning />
                            </span>
                            {t("merge.status.unresolved", { count: unresolved })}
                        </span>
                        <span className="toolbar-status-pill muted">
                            {t("merge.status.resolved", { resolved, total })}
                        </span>
                        <span className="toolbar-status-pill muted">
                            {t("merge.count.changes", { count: changeCount })}
                        </span>
                        {currentConflictIndex > 0 ? (
                            <button
                                type="button"
                                className="toolbar-inline-link"
                                onClick={() => {
                                    if (nextUnresolvedId !== null) jumpToConflict(nextUnresolvedId);
                                }}
                                disabled={nextUnresolvedId === null}
                                title={t("merge.toolbar.jumpUnresolved.title")}
                            >
                                {t("merge.status.hunk", { current: currentConflictIndex, total })}
                            </button>
                        ) : null}
                    </div>

                    <div className="toolbar-right">
                        <button
                            type="button"
                            className="toolbar-btn"
                            onClick={handleAcceptAllYours}
                            title={t("merge.toolbar.acceptAllYours.title")}
                        >
                            <span className="toolbar-icon">
                                <IconArrowRight />
                            </span>
                            {t("merge.toolbar.acceptAllYours.label")}
                        </button>
                        <button
                            type="button"
                            className="toolbar-btn"
                            onClick={handleAcceptAllTheirs}
                            title={t("merge.toolbar.acceptAllTheirs.title")}
                        >
                            <span className="toolbar-icon">
                                <IconArrowLeft />
                            </span>
                            {t("merge.toolbar.acceptAllTheirs.label")}
                        </button>
                    </div>
                </div>

                <div className="merge-header">
                    <div className="merge-title">
                        <span className="file-path">{state.data.filePath}</span>
                        <span className="conflict-counter">
                            {t("merge.header.conflictsResolved", { resolved, total })}
                        </span>
                    </div>
                    <div className="merge-stats">
                        <span className="merge-stat-pill">
                            {t("merge.count.changes", { count: changeCount })}
                        </span>
                        {autoResolvedCount > 0 ? (
                            <span className="merge-stat-pill ok">
                                {t("merge.header.autoResolved", { count: autoResolvedCount })}
                            </span>
                        ) : null}
                        <span className={`merge-stat-pill ${unresolved > 0 ? "warn" : "ok"}`}>
                            {t("merge.count.conflicts", { count: unresolved })}
                        </span>
                    </div>
                </div>

                <div className="pane-meta-row">
                    <div className="pane-meta">
                        <span className="pane-meta-label">
                            <span className="toolbar-icon pane-lock">
                                <IconLock />
                            </span>
                            {t("merge.pane.changesFrom", { label: state.data.oursLabel })}
                        </span>
                        <span className="pane-meta-right-group">
                            <span className="pane-meta-counts">
                                {t("merge.count.changes", { count: oursChanges })},{" "}
                                {t("merge.count.conflicts", { count: total })}
                            </span>
                            <button
                                type="button"
                                className="show-details"
                                onClick={() => setShowDetails((v) => !v)}
                            >
                                {showDetails
                                    ? t("merge.toolbar.hideDetails")
                                    : t("merge.toolbar.showDetails")}
                            </button>
                        </span>
                    </div>
                    <div className="pane-meta pane-meta-center">
                        <span>{t("merge.pane.result", { path: state.data.filePath })}</span>
                    </div>
                    <div className="pane-meta pane-meta-right">
                        <span className="pane-meta-label">
                            <span className="toolbar-icon pane-lock">
                                <IconLock />
                            </span>
                            {t("merge.pane.changesFrom", { label: state.data.theirsLabel })}
                        </span>
                        <span className="pane-meta-right-group">
                            <span className="pane-meta-counts">
                                {t("merge.count.changes", { count: theirsChanges })},{" "}
                                {t("merge.count.conflicts", { count: total })}
                            </span>
                            <button
                                type="button"
                                className="show-details"
                                onClick={() => setShowDetails((v) => !v)}
                            >
                                {showDetails
                                    ? t("merge.toolbar.hideDetails")
                                    : t("merge.toolbar.showDetails")}
                            </button>
                        </span>
                    </div>
                </div>

                <div className="merge-content-shell">
                    <div
                        ref={mergeContentRef}
                        className="merge-content"
                        onScrollCapture={handlePaneScroll}
                    >
                        <div className="merge-viewport">
                            <div
                                ref={(el) => {
                                    columnRefs.current.left = el;
                                }}
                                className="merge-col col-left"
                            >
                                {renderedSegments.map((item) =>
                                    item.segment.type === "common" ? (
                                        <CommonPaneBlock
                                            key={item.renderKey}
                                            pane="left"
                                            segment={item.segment}
                                            lineCount={item.paneLines.left}
                                            lineNumbers={item.lineNumbers.left}
                                            highlightWords={highlightWords}
                                        />
                                    ) : (
                                        <OursConflictBlock
                                            key={item.renderKey}
                                            segment={item.segment}
                                            resolution={state.resolutions[item.segment.id]}
                                            editedLines={state.edits[item.segment.id]}
                                            dismissed={state.dismissals[item.segment.id]}
                                            lineCount={item.paneLines.left}
                                            lineNumbers={item.lineNumbers.left}
                                            onResolve={handleResolve}
                                            onDismiss={handleDismissSide}
                                            onSelect={setActiveConflictId}
                                            isActive={activeConflictId === item.segment.id}
                                            highlightWords={highlightWords}
                                        />
                                    ),
                                )}
                            </div>
                            <div className="merge-gutter merge-gutter-left" aria-hidden="true" />
                            <div
                                ref={(el) => {
                                    columnRefs.current.middle = el;
                                }}
                                className="merge-col col-middle"
                            >
                                {renderedSegments.map((item) =>
                                    item.segment.type === "common" ? (
                                        <CommonPaneBlock
                                            key={item.renderKey}
                                            pane="middle"
                                            segment={item.segment}
                                            lineCount={item.paneLines.middle}
                                            lineNumbers={item.lineNumbers.middle}
                                            highlightWords={highlightWords}
                                        />
                                    ) : (
                                        <ResultConflictBlock
                                            key={item.renderKey}
                                            segment={item.segment}
                                            resolution={state.resolutions[item.segment.id]}
                                            editedLines={state.edits[item.segment.id]}
                                            dismissed={state.dismissals[item.segment.id]}
                                            lineCount={item.paneLines.middle}
                                            lineNumbers={item.lineNumbers.middle}
                                            onEditResult={handleEditResult}
                                            onSelect={setActiveConflictId}
                                            isActive={activeConflictId === item.segment.id}
                                            highlightWords={highlightWords}
                                            conflictOrdinal={
                                                item.conflictOrdinal ?? item.segment.id + 1
                                            }
                                            trueConflictOrdinal={item.trueConflictOrdinal}
                                        />
                                    ),
                                )}
                            </div>
                            <div className="merge-gutter merge-gutter-right" aria-hidden="true" />
                            <div
                                ref={(el) => {
                                    columnRefs.current.right = el;
                                }}
                                className="merge-col col-right"
                            >
                                {renderedSegments.map((item) =>
                                    item.segment.type === "common" ? (
                                        <CommonPaneBlock
                                            key={item.renderKey}
                                            pane="right"
                                            segment={item.segment}
                                            lineCount={item.paneLines.right}
                                            lineNumbers={item.lineNumbers.right}
                                            highlightWords={highlightWords}
                                        />
                                    ) : (
                                        <TheirsConflictBlock
                                            key={item.renderKey}
                                            segment={item.segment}
                                            resolution={state.resolutions[item.segment.id]}
                                            editedLines={state.edits[item.segment.id]}
                                            dismissed={state.dismissals[item.segment.id]}
                                            lineCount={item.paneLines.right}
                                            lineNumbers={item.lineNumbers.right}
                                            onResolve={handleResolve}
                                            onDismiss={handleDismissSide}
                                            onSelect={setActiveConflictId}
                                            isActive={activeConflictId === item.segment.id}
                                            highlightWords={highlightWords}
                                        />
                                    ),
                                )}
                            </div>
                            <ConnectorLayer
                                specs={connectorSpecs}
                                registerPath={registerConnectorPath}
                            />
                        </div>
                        <div
                            className="merge-vscroll-spacer"
                            style={{ height: layout.canonicalTotalPx }}
                            aria-hidden="true"
                        />
                    </div>
                    <div
                        ref={horizontalScrollRef}
                        className="merge-horizontal-scroll"
                        aria-hidden="true"
                        onScroll={handleHorizontalScroll}
                    >
                        <div
                            ref={horizontalScrollInnerRef}
                            className="merge-horizontal-scroll-inner"
                        />
                    </div>
                    <OverviewRail
                        markers={overviewMarkers}
                        activeConflictId={activeConflictId}
                        onJump={jumpToConflict}
                    />
                </div>

                <div className="merge-footer">
                    <div className="footer-left">
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleBulkAcceptYours}
                        >
                            {t("merge.footer.useFileOurs")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleBulkAcceptTheirs}
                        >
                            {t("merge.footer.useFileTheirs")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleOpenConflictSession}
                        >
                            {t("mergeSession.title")}
                        </button>
                        <span className="footer-hint">{t("merge.footer.hint")}</span>
                    </div>
                    <div className="footer-right">
                        <button
                            type="button"
                            className="footer-btn danger"
                            onClick={handleAbortMerge}
                        >
                            {t("merge.action.abortMerge")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary"
                            onClick={handleClose}
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            className={`footer-btn primary ${canApply ? "" : "disabled"}`}
                            onClick={handleApply}
                            disabled={!canApply}
                        >
                            {t("merge.footer.apply", { resolved, total })}
                        </button>
                    </div>
                </div>
            </div>
        </SyntaxHighlightProvider>
    );
}

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
