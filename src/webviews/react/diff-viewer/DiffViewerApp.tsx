// Entry point for the read-only two-pane diff viewer.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
    DiffSegment,
    DiffViewerData,
    InboundMessage,
    OutboundMessage,
} from "../../protocol/diffViewerTypes";
import { getVsCodeApi } from "../shared/vscodeApi";
import { t } from "../shared/i18n";
import { detectTheme, initShiki, isShikiReady, langForPath } from "../diff-core/shikiHighlighter";
import { SyntaxHighlightProvider } from "../diff-core/syntaxHighlightContext";
import {
    buildVerticalLayout,
    LINE_HEIGHT_PX,
    ribbonPathD,
    type DiffVerticalLayout,
    type SegmentPaneLines,
} from "../diff-core/mergeScrollLayout";
import { buildLineNumberValues } from "../diff-core/lineNumbers";
import {
    applyPaneOffsets,
    paneOffsetsForCanonical,
    syncHorizontalScroll as syncHorizontalScrollCore,
    updateSharedScrollbar as updateSharedScrollbarCore,
} from "../diff-core/scrollSync";
import { CodeBlock, intrinsicSizeStyle, type LineNumberSpec } from "../diff-core/segments";
import { IconChevronDown, IconEye, IconFilter } from "../merge-editor/icons";
import { DIFF_PANES, segmentClassName, type DiffPane } from "./segmentMarkers";
import "./diff-viewer.css";

const LINE_PADDING_PX = 18;
// Fractions of the viewport width where a ribbon stops running flat and bends.
// The two panes meet at the halfway point, so the S-bend straddles it in a
// narrow strip and the band reads as flat under each pane's rows.
const RIBBON_CURVE_START = 0.48;
const RIBBON_CURVE_END = 0.52;

interface RenderedSegment {
    segment: DiffSegment;
    index: number;
    paneLines: Record<DiffPane, number>;
    lineNumbers: Record<DiffPane, LineNumberSpec>;
    canonicalLineCount: number;
}

/** Renders one read-only side of one aligned diff segment. */
function DiffPaneBlock({
    segment,
    side,
    lineCount,
    lineNumbers,
    highlightWords,
}: {
    segment: DiffSegment;
    side: DiffPane;
    lineCount: number;
    lineNumbers: LineNumberSpec;
    highlightWords: boolean;
}): React.ReactElement {
    const lines = segment[side];
    const compareLines = segment[side === "left" ? "right" : "left"];

    return (
        <div
            className={`segment ${segmentClassName(segment, side)}`}
            style={intrinsicSizeStyle(lineCount)}
        >
            <CodeBlock
                lines={lines}
                lineCount={lineCount}
                lineNumbers={lineNumbers}
                lineNumberSide={side === "left" ? "right" : "left"}
                wordHighlight={highlightWords}
                compareLines={compareLines}
            />
        </div>
    );
}

/** Renders the live document as an input while keeping all edit authority in the host. */
function EditableDiffPane({
    side,
    label,
    text,
    documentVersion,
    reseedToken,
    canonicalTotalPx,
    onEdit,
}: {
    side: DiffPane;
    label: string;
    text: string;
    documentVersion: number;
    reseedToken: number;
    canonicalTotalPx: number;
    onEdit: (
        currentText: string,
        nextText: string,
        baseVersion: number,
        baseReseedToken: number,
    ) => void;
}): React.ReactElement {
    // The token rides with the draft rather than being read live at keystroke time, so the
    // delta reports the reseed the measured text actually came from. Reading the current prop
    // would stamp a delta measured against the old draft with a token the pane has not
    // adopted yet, which is exactly the staleness the host uses it to detect.
    const [draft, setDraft] = useState({ text, version: documentVersion, token: reseedToken });
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const carryCaret = useRef<{ start: number; end: number } | null>(null);
    const hostText = useRef({ text, version: documentVersion, token: reseedToken });

    // Mirrors the host's latest payload for the reseed effect below to read WITHOUT
    // depending on it. Written in an effect rather than during render because a render
    // React discards still runs its body, and the discarded values would be what a later
    // reseed restored. Declared first, so it has already run when the reseed effect fires
    // in the same commit.
    useEffect(() => {
        hostText.current = { text, version: documentVersion, token: reseedToken };
    });

    // Reseed only when the host says the text moved for a reason we did not cause. The
    // host echoes one payload per delta it applies, so reseeding on every payload would
    // roll the pane back to whichever edit has finished round-tripping and drop the
    // keystrokes typed since — the version numbers alone cannot tell the two apart.
    useEffect(() => {
        const node = textareaRef.current;
        if (node) carryCaret.current = { start: node.selectionStart, end: node.selectionEnd };
        setDraft(hostText.current);
    }, [reseedToken]);

    // Rewriting a controlled textarea's value collapses the selection to the end, so an
    // external write would drop the caret at EOF and land the next keystroke there.
    useEffect(() => {
        const node = textareaRef.current;
        const caret = carryCaret.current;
        if (!node || !caret) return;
        carryCaret.current = null;
        const end = node.value.length;
        node.setSelectionRange(Math.min(caret.start, end), Math.min(caret.end, end));
    }, [draft]);

    // A textarea renders one line box per "\n"-separated element, including the empty one that
    // follows a terminal newline — which `splitText` deliberately emits no row for, since it
    // treats that newline as metadata. Sizing from the segment model alone therefore leaves the
    // pane exactly one line short of its own value for nearly every real file. Measured from
    // `draft` rather than the `text` prop so the height tracks the edit in flight instead of the
    // host's last echo, which also covers a draft that has outgrown the last computed segments.
    const contentPx = draft.text.split("\n").length * LINE_HEIGHT_PX;

    return (
        <textarea
            ref={textareaRef}
            // The pane carries the canonical extent itself rather than inheriting a height from
            // the grid row. This pane REPLACES the segment stack, and a textarea has no `rows`
            // here and never grows with its value, so the row is sized by whatever the opposite
            // pane renders — which for an added file is one one-sided segment, no rows, and no
            // height at all. Canonical is the right number in every case, not just that one: it
            // is the per-segment max of the two sides, so it is never below the opposite pane's
            // own extent, and it is the same number the scroll spacer declares.
            // `height`, not `min-height`: an empty file has no segments at all, so canonical is
            // 0, and the CSS floors the pane at one viewport so it never collapses to a
            // textarea's two-row default.
            style={{ height: Math.max(canonicalTotalPx, contentPx) }}
            className="diff-edit-textarea"
            data-testid={`diff-pane-${side}-editable`}
            aria-label={label}
            spellCheck={false}
            value={draft.text}
            onChange={(event) => {
                const nextText = event.currentTarget.value;
                // This render is showing a draft the host has already replaced: the reseed
                // payload has been committed (it is in `reseedToken`) but the passive effect
                // that adopts it into the draft has not produced a commit yet. React reads
                // `onChange` from the latest COMMITTED render, so a keystroke landing in that
                // window is handled by this stale closure. Sending its delta is pointless — the
                // host drops anything stamped with a superseded token — and the `setDraft`
                // below is actively harmful: it would land after the adopting `setDraft` and
                // last-write-wins would pin the draft on the dead token. `reseedToken` never
                // changes again, so the effect would never re-fire and every later keystroke
                // would be dropped in silence. Drop this one instead; the reseed is what the
                // pane is about to show anyway.
                if (draft.token !== reseedToken) return;
                onEdit(draft.text, nextText, draft.version, draft.token);
                setDraft({ text: nextText, version: draft.version + 1, token: draft.token });
            }}
        />
    );
}

/**
 * Renders one connector ribbon per changed segment. Paths carry no geometry
 * here — the scroll driver sets each path's `d` in its rAF, in viewport pixels,
 * so the ribbons track the two independently translated columns without a React
 * re-render. A `viewBox` would reintroduce the squish this replaced: scaling the
 * canonical (taller-side) span onto the viewport shrinks every extent by the
 * same factor, which is only correct while one pane stays the taller one.
 */
function DiffRibbonLayer({
    indices,
    registerPath,
}: {
    indices: readonly number[];
    registerPath: (index: number, element: SVGPathElement | null) => void;
}): React.ReactElement {
    return (
        <svg className="diff-ribbon-layer" aria-hidden="true">
            {indices.map((index) => (
                <path
                    key={`ribbon-${index}`}
                    ref={(element) => registerPath(index, element)}
                    className="diff-ribbon"
                />
            ))}
        </svg>
    );
}

/** Hosts a pure, read-only two-pane diff with only view toggles. */
export function App(): React.ReactElement {
    const [data, setData] = useState<DiffViewerData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");
    const [highlightWords, setHighlightWords] = useState(true);
    const [shikiReady, setShikiReady] = useState(() => isShikiReady());
    const [shikiTheme] = useState(() => detectTheme());
    const vscode = useMemo(() => getVsCodeApi<OutboundMessage, unknown>(), []);

    const contentRef = useRef<HTMLDivElement | null>(null);
    const viewportElementRef = useRef<HTMLDivElement | null>(null);
    const columnRefs = useRef<Record<DiffPane, HTMLDivElement | null>>({ left: null, right: null });
    const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollInnerRef = useRef<HTMLDivElement | null>(null);
    const lastPaneClientWidthRef = useRef(0);
    const verticalFrameRef = useRef(0);
    const scrollSyncRef = useRef({ raf: 0, left: 0 });
    const layoutRef = useRef<DiffVerticalLayout<DiffPane> | null>(null);
    // Viewport box in px: the height clamps pane offsets and culls offscreen
    // ribbons, the width supplies the ribbon layer's user-unit span. Measured on
    // layout/resize so the per-frame draw only recomputes y.
    const viewportRef = useRef({ height: 0, width: 0 });
    const ribbonPaths = useMemo(() => new Map<number, SVGPathElement>(), []);

    const segments = useMemo(() => data?.segments ?? [], [data]);
    const syntaxHighlightState = useMemo(
        () => ({
            ready: shikiReady,
            lang: data?.languageId || (data?.path ? langForPath(data.path) : null),
            theme: shikiTheme,
        }),
        [data?.languageId, data?.path, shikiReady, shikiTheme],
    );

    const renderedSegments = useMemo<RenderedSegment[]>(() => {
        let leftCursor = 1;
        let rightCursor = 1;
        return segments.map((segment, index) => {
            const leftCount = segment.left.length;
            const rightCount = segment.right.length;
            const item = {
                segment,
                index,
                paneLines: { left: leftCount, right: rightCount },
                lineNumbers: {
                    left: { primary: buildLineNumberValues(leftCursor, leftCount, leftCount) },
                    right: { primary: buildLineNumberValues(rightCursor, rightCount, rightCount) },
                },
                canonicalLineCount: Math.max(leftCount, rightCount, 1),
            } satisfies RenderedSegment;
            leftCursor += leftCount;
            rightCursor += rightCount;
            return item;
        });
    }, [segments]);

    const paneLines = useMemo<SegmentPaneLines<DiffPane>[]>(() => {
        const rows = renderedSegments.map((item) => ({
            paneLines: item.paneLines,
            conflict: item.segment.type === "changed",
            id: item.segment.type === "changed" ? item.index : undefined,
        }));
        const pane = data?.editablePane;
        const text = data?.editableText;
        if (!pane || text === undefined || rows.length === 0) return rows;

        // The editable pane is a `<textarea>`, and it does not render the segment model — it
        // renders its own value, one line box per "\n"-separated element. `splitText` emits no
        // row for a terminal newline, so for nearly every real file the textarea is one box
        // taller than the segments say. Sizing only the pane to that (which it does) would put
        // the extra box outside every reachable scroll position: `paneTotalPx` and the spacer
        // are both built from these counts, `clampOffset` stops the column at
        // `paneTotalPx - viewport`, and `.diff-viewport` clips whatever is past it. So the
        // deficit belongs here, where the scroll range, the spacer, and the ribbon offsets are
        // all derived from one number.
        //
        // Derived as a difference rather than special-cased as "+1 for a terminal newline":
        // the two counters can disagree for more than one reason, and the pane must never be
        // the shorter of the two whatever the reason is. `editableText` is LF-normalized
        // host-side, so this counts the same units the textarea lays out.
        const boxes = text.split("\n").length;
        const counted = rows.reduce((sum, row) => sum + row.paneLines[pane], 0);
        const deficit = Math.max(0, boxes - counted);
        if (deficit === 0) return rows;

        const last = rows[rows.length - 1];
        rows[rows.length - 1] = {
            ...last,
            paneLines: { ...last.paneLines, [pane]: last.paneLines[pane] + deficit },
        };
        return rows;
    }, [renderedSegments, data?.editablePane, data?.editableText]);
    const layout = useMemo(() => buildVerticalLayout(paneLines, DIFF_PANES), [paneLines]);
    layoutRef.current = layout;
    const ribbonIndices = useMemo(
        () =>
            renderedSegments
                .filter((item) => item.segment.type === "changed")
                .map((item) => item.index),
        [renderedSegments],
    );

    const maxLineLength = useMemo(() => {
        let max = 1;
        for (const segment of segments) {
            for (const line of segment.left) max = Math.max(max, line.length);
            for (const line of segment.right) max = Math.max(max, line.length);
        }
        return max;
    }, [segments]);

    const syncHorizontalScroll = useCallback((left: number, source?: HTMLElement | null) => {
        syncHorizontalScrollCore(
            DIFF_PANES,
            (pane) => columnRefs.current[pane]?.querySelectorAll<HTMLElement>(".code-lines") ?? [],
            horizontalScrollRef.current,
            scrollSyncRef.current,
            left,
            source,
        );
    }, []);

    // Cache the viewport box and expose its height as a CSS var so the sticky
    // viewport's negative margin cancels exactly its own height, leaving the
    // scroll range at canonicalTotalPx.
    const measureViewport = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        const height = content.clientHeight;
        const width = viewportElementRef.current?.clientWidth ?? 0;
        viewportRef.current = { height, width };
        content.style.setProperty("--diff-viewport-h", `${height}px`);
    }, []);

    // Redraw every ribbon from the same per-pane offsets the columns were just
    // translated by, so a hunk's band always meets its own rows on both sides.
    // Each side's extent comes from that pane's own geometry: a deletion-only
    // hunk followed by an insertion-only one flips which pane is taller, and a
    // shared canonical extent would misdraw one of them.
    const drawRibbons = useCallback(
        (
            currentLayout: DiffVerticalLayout<DiffPane>,
            offsets: Readonly<Record<DiffPane, number>>,
            viewportH: number,
            viewportW: number,
        ) => {
            const span = {
                x0: 0,
                curveX0: viewportW * RIBBON_CURVE_START,
                curveX1: viewportW * RIBBON_CURVE_END,
                x1: viewportW,
            };
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
        const { height: viewportH, width: viewportW } = viewportRef.current;
        const offsets = paneOffsetsForCanonical(
            currentLayout,
            DIFF_PANES,
            content.scrollTop,
            viewportH,
        );
        applyPaneOffsets(DIFF_PANES, (pane) => columnRefs.current[pane], offsets);
        drawRibbons(currentLayout, offsets, viewportH, viewportW);
    }, [drawRibbons]);

    const registerRibbonPath = useCallback(
        (index: number, element: SVGPathElement | null) => {
            if (element) ribbonPaths.set(index, element);
            else ribbonPaths.delete(index);
        },
        [ribbonPaths],
    );

    const scheduleVerticalFrame = useCallback(() => {
        if (verticalFrameRef.current) return;
        verticalFrameRef.current = requestAnimationFrame(() => {
            verticalFrameRef.current = 0;
            drawVerticalFrame();
        });
    }, [drawVerticalFrame]);

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
    }, [maxLineLength, syncHorizontalScroll]);

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
        [scheduleVerticalFrame, syncHorizontalScroll],
    );

    const handleHorizontalScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            syncHorizontalScroll(event.currentTarget.scrollLeft, event.currentTarget);
        },
        [syncHorizontalScroll],
    );

    const handleIgnoreMode = useCallback(() => {
        const mode = ignoreMode === "none" ? "whitespace" : "none";
        setIgnoreMode(mode);
        vscode.postMessage({ type: "setIgnoreMode", mode });
    }, [ignoreMode, vscode]);

    const handleEdit = useCallback(
        (currentText: string, nextText: string, baseVersion: number, baseReseedToken: number) => {
            if (!data?.editablePane) return;
            let startOffset = 0;
            while (
                startOffset < currentText.length &&
                startOffset < nextText.length &&
                currentText[startOffset] === nextText[startOffset]
            ) {
                startOffset++;
            }
            let currentEnd = currentText.length;
            let nextEnd = nextText.length;
            while (
                currentEnd > startOffset &&
                nextEnd > startOffset &&
                currentText[currentEnd - 1] === nextText[nextEnd - 1]
            ) {
                currentEnd--;
                nextEnd--;
            }
            // Both scans compare UTF-16 code units, so either can stop between the halves of
            // a surrogate pair -- two emoji in the same 1024-point block share a high
            // surrogate. That emits a lone surrogate over a range bisecting a character.
            // Step each boundary back onto a code-point edge.
            const lead = currentText.charCodeAt(startOffset - 1);
            if (startOffset > 0 && lead >= 0xd800 && lead <= 0xdbff) startOffset--;
            const tail = currentText.charCodeAt(currentEnd);
            if (tail >= 0xdc00 && tail <= 0xdfff) {
                currentEnd++;
                nextEnd++;
            }
            vscode.postMessage({
                type: "editText",
                delta: {
                    baseVersion,
                    baseReseedToken,
                    startOffset,
                    endOffset: currentEnd,
                    text: nextText.slice(startOffset, nextEnd),
                },
            });
        },
        [data?.editablePane, vscode],
    );

    useEffect(() => {
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setDiffData") {
                setError(event.data.data.loadError ?? null);
                setIgnoreMode(event.data.data.ignoreWhitespace ? "whitespace" : "none");
                setData(event.data.data);
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, [vscode]);

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

    // Runs before paint so `--diff-viewport-h` (which sizes the sticky viewport
    // and its margin-bottom cancel) is committed on the first frame — otherwise
    // the scrollbar would flash one viewport too long before a post-paint
    // measure.
    useLayoutEffect(() => {
        measureViewport();
        scheduleVerticalFrame();
    }, [layout, measureViewport, scheduleVerticalFrame]);

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
        return () => observer.disconnect();
    }, [hasDiffData, measureViewport, scheduleVerticalFrame, updateHorizontalScrollWidth]);

    useEffect(() => {
        const scrollSyncState = scrollSyncRef.current;
        return () => {
            if (verticalFrameRef.current) cancelAnimationFrame(verticalFrameRef.current);
            if (scrollSyncState.raf) cancelAnimationFrame(scrollSyncState.raf);
        };
    }, []);

    // Only a failure with nothing already on screen takes the whole surface. The host
    // reports a refresh failure while deliberately retaining the snapshot it already
    // posted, so the diff still rendered is valid and remains the best available answer.
    // Replacing it would discard that, and once a pane is document-backed it would also
    // unmount the user's editing surface mid-edit, for as long as the error stands — with
    // nothing guaranteeing a later refresh arrives to clear it.
    if (error && !data) {
        return (
            <div className="diff-core diff-viewer diff-loading">
                <div className="error-message">{t("diff.error.load", { error })}</div>
            </div>
        );
    }

    if (!data) {
        return <div className="diff-core diff-viewer diff-loading">{t("diff.loading")}</div>;
    }

    const totalLines = Math.max(layout.canonicalTotalPx / LINE_HEIGHT_PX, 1);
    const gutterDigits = Math.max(String(Math.ceil(totalLines)).length, 2);
    const rootStyle = {
        "--diff-line-number-gutter": `max(33px, calc(${gutterDigits}ch + 12px))`,
        "--diff-line-min-width": `calc(${maxLineLength}ch + ${LINE_PADDING_PX}px)`,
        "--diff-viewer-action-gutter": "0px",
    } as React.CSSProperties;

    return (
        <SyntaxHighlightProvider value={syntaxHighlightState}>
            <div className="diff-core diff-viewer" style={rootStyle} data-testid="diff-viewer-root">
                <div className="diff-toolbar">
                    <div className="toolbar-left">
                        <button
                            type="button"
                            className="toolbar-btn subtle dropdown"
                            onClick={handleIgnoreMode}
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
                            onClick={() => setHighlightWords((value) => !value)}
                            aria-pressed={highlightWords}
                        >
                            <span className="toolbar-icon">
                                <IconEye />
                            </span>
                            {t("merge.toolbar.highlightWords")}
                        </button>
                    </div>
                </div>
                <div className="diff-header">
                    <span className="file-path">{data.path}</span>
                    {data.newlineDifference ? (
                        <span className="diff-newline-marker" role="status">
                            {t("diff.newlineDifference")}
                        </span>
                    ) : null}
                </div>
                <div className="diff-pane-meta-row">
                    <div className="diff-pane-meta">{data.leftLabel}</div>
                    <div className="diff-pane-meta">{data.rightLabel}</div>
                </div>
                {error ? (
                    <div className="error-message diff-error-banner" role="alert">
                        {t("diff.error.load", { error })}
                    </div>
                ) : null}
                <div className="diff-content-shell">
                    <div ref={contentRef} className="diff-content" onScrollCapture={handleScroll}>
                        <div ref={viewportElementRef} className="diff-viewport">
                            <div className="diff-columns">
                                <div
                                    ref={(element) => {
                                        columnRefs.current.left = element;
                                    }}
                                    className="diff-pane diff-pane-left"
                                    data-testid="diff-pane-left"
                                >
                                    {data.editablePane === "left" &&
                                    data.editableText !== undefined &&
                                    data.documentVersion !== undefined ? (
                                        <EditableDiffPane
                                            side="left"
                                            label={data.leftLabel}
                                            text={data.editableText}
                                            documentVersion={data.documentVersion}
                                            reseedToken={data.editableReseedToken ?? 0}
                                            canonicalTotalPx={layout.canonicalTotalPx}
                                            onEdit={handleEdit}
                                        />
                                    ) : (
                                        renderedSegments.map((item) => (
                                            <DiffPaneBlock
                                                key={`left-${item.index}`}
                                                segment={item.segment}
                                                side="left"
                                                lineCount={item.paneLines.left}
                                                lineNumbers={item.lineNumbers.left}
                                                highlightWords={highlightWords}
                                            />
                                        ))
                                    )}
                                </div>
                                <div
                                    ref={(element) => {
                                        columnRefs.current.right = element;
                                    }}
                                    className="diff-pane diff-pane-right"
                                    data-testid="diff-pane-right"
                                >
                                    {data.editablePane === "right" &&
                                    data.editableText !== undefined &&
                                    data.documentVersion !== undefined ? (
                                        <EditableDiffPane
                                            side="right"
                                            label={data.rightLabel}
                                            text={data.editableText}
                                            documentVersion={data.documentVersion}
                                            reseedToken={data.editableReseedToken ?? 0}
                                            canonicalTotalPx={layout.canonicalTotalPx}
                                            onEdit={handleEdit}
                                        />
                                    ) : (
                                        renderedSegments.map((item) => (
                                            <DiffPaneBlock
                                                key={`right-${item.index}`}
                                                segment={item.segment}
                                                side="right"
                                                lineCount={item.paneLines.right}
                                                lineNumbers={item.lineNumbers.right}
                                                highlightWords={highlightWords}
                                            />
                                        ))
                                    )}
                                </div>
                            </div>
                            <DiffRibbonLayer
                                indices={ribbonIndices}
                                registerPath={registerRibbonPath}
                            />
                        </div>
                        <div
                            className="diff-vscroll-spacer"
                            style={{ height: layout.canonicalTotalPx }}
                            aria-hidden="true"
                        />
                    </div>
                    <div
                        ref={horizontalScrollRef}
                        className="diff-horizontal-scroll"
                        aria-hidden="true"
                        onScroll={handleHorizontalScroll}
                    >
                        <div
                            ref={horizontalScrollInnerRef}
                            className="diff-horizontal-scroll-inner"
                        />
                    </div>
                </div>
            </div>
        </SyntaxHighlightProvider>
    );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
