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
import {
    CodeBlock,
    intrinsicSizeStyle,
    LineNumbers,
    type LineNumberSpec,
} from "../diff-core/segments";
import { IconChevronDown, IconEye, IconFilter } from "../merge-editor/icons";
import { splitEditedText } from "../merge-editor/mergeState";
import { DIFF_PANES, segmentClassName, type DiffPane } from "./segmentMarkers";
import { adjacentChangeIndex, buildStripeMarks } from "./changeStripe";
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

interface EditableBlockDraft {
    index: number;
    text: string;
    sourceText: string;
    startLine: number;
    lineCount: number;
    version: number;
    token: number;
}

interface EditableBlockLayout {
    side: DiffPane;
    index: number;
    rowCount: number;
}

/** Replaces one line-addressed display block in the LF-normalized document text. */
function replaceBlockText(
    sourceText: string,
    startLine: number,
    lineCount: number,
    editedText: string,
): string {
    const lines = sourceText.split("\n");
    const editedLines = splitEditedText(editedText);
    lines.splice(startLine, lineCount, ...editedLines);
    return lines.join("\n");
}

/** Renders editable display blocks while keeping document writes delegated to the host. */
function EditableDiffPane({
    side,
    text,
    documentVersion,
    reseedToken,
    renderedSegments,
    highlightWords,
    onEdit,
    onDraftLayoutChange,
    onHorizontalScroll,
}: {
    side: DiffPane;
    text: string;
    documentVersion: number;
    reseedToken: number;
    renderedSegments: readonly RenderedSegment[];
    highlightWords: boolean;
    onEdit: (
        currentText: string,
        nextText: string,
        baseVersion: number,
        baseReseedToken: number,
    ) => void;
    onDraftLayoutChange: (layout: EditableBlockLayout | null) => void;
    onHorizontalScroll: (left: number, source: HTMLElement) => void;
}): React.ReactElement {
    const [draft, setDraft] = useState<EditableBlockDraft | null>(null);
    const isComposingRef = useRef(false);
    const reseedDuringCompositionRef = useRef(false);
    const lineNumberSide = side === "left" ? "right" : "left";

    const clearDraft = useCallback(() => {
        setDraft(null);
        onDraftLayoutChange(null);
    }, [onDraftLayoutChange]);

    // A reseed denotes an external document change. The active block was measured against the
    // old document and must not remain available for a second edit against stale text. During an
    // IME composition, keep its buffer alive until compositionend, but never commit the stale draft.
    useEffect(() => {
        if (isComposingRef.current) {
            reseedDuringCompositionRef.current = true;
            return;
        }
        clearDraft();
    }, [clearDraft, reseedToken]);

    useEffect(() => () => onDraftLayoutChange(null), [onDraftLayoutChange]);

    const startEditing = useCallback(
        (item: RenderedSegment) => {
            const startLine = renderedSegments
                .slice(0, item.index)
                .reduce((total, previous) => total + previous.segment[side].length, 0);
            const nextDraft = {
                index: item.index,
                text: item.segment[side].join("\n"),
                sourceText: text,
                startLine,
                lineCount: item.segment[side].length,
                version: documentVersion,
                token: reseedToken,
            };
            setDraft(nextDraft);
            onDraftLayoutChange({
                side,
                index: item.index,
                rowCount: Math.max(nextDraft.lineCount, 1),
            });
        },
        [documentVersion, onDraftLayoutChange, renderedSegments, reseedToken, side, text],
    );

    const commitDraft = useCallback(() => {
        if (draft === null) return;
        clearDraft();
        if (draft.token !== reseedToken) return;
        const nextText = replaceBlockText(
            draft.sourceText,
            draft.startLine,
            draft.lineCount,
            draft.text,
        );
        if (nextText !== draft.sourceText) {
            onEdit(draft.sourceText, nextText, draft.version, draft.token);
        }
    }, [clearDraft, draft, onEdit, reseedToken]);

    return (
        <>
            {renderedSegments.map((item) => {
                const lines = item.segment[side];
                const compareLines = item.segment[side === "left" ? "right" : "left"];
                const isEditing = draft?.index === item.index;
                const lineCount = item.paneLines[side];

                if (isEditing && draft) {
                    const rowCount = Math.max(draft.text.split("\n").length, lineCount, 1);
                    return (
                        <div
                            key={`editable-${side}-${item.index}`}
                            className={`code-block line-numbers-${lineNumberSide} diff-editing-block editing`}
                            style={intrinsicSizeStyle(rowCount)}
                        >
                            {lineNumberSide === "left" ? (
                                <LineNumbers primary={item.lineNumbers[side].primary} />
                            ) : null}
                            <textarea
                                className="diff-edit-textarea"
                                data-testid={`diff-pane-${side}-editable`}
                                aria-label={t("diff.editable.editingAria")}
                                value={draft.text}
                                rows={rowCount}
                                // Deliberate: edit mode opens from a user action and should focus the draft textarea.
                                // react-doctor-disable-next-line react-doctor/no-autofocus
                                autoFocus
                                spellCheck={false}
                                onCompositionStart={() => {
                                    isComposingRef.current = true;
                                }}
                                onCompositionEnd={() => {
                                    isComposingRef.current = false;
                                    if (!reseedDuringCompositionRef.current) return;
                                    reseedDuringCompositionRef.current = false;
                                    clearDraft();
                                }}
                                onChange={(event) => {
                                    const nextText = event.target.value;
                                    setDraft({ ...draft, text: nextText });
                                    onDraftLayoutChange({
                                        side,
                                        index: draft.index,
                                        rowCount: Math.max(
                                            nextText.split("\n").length,
                                            draft.lineCount,
                                            1,
                                        ),
                                    });
                                }}
                                onBlur={commitDraft}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        clearDraft();
                                    }
                                }}
                                onClick={(event) => event.stopPropagation()}
                                onScroll={(event) =>
                                    onHorizontalScroll(
                                        event.currentTarget.scrollLeft,
                                        event.currentTarget,
                                    )
                                }
                            />
                            {lineNumberSide === "right" ? (
                                <LineNumbers primary={item.lineNumbers[side].primary} />
                            ) : null}
                        </div>
                    );
                }

                const style = intrinsicSizeStyle(lineCount);
                return (
                    <div
                        key={`editable-${side}-${item.index}`}
                        className="segment diff-editable-block"
                        style={style}
                        onDoubleClick={() => startEditing(item)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== "F2") return;
                            event.preventDefault();
                            startEditing(item);
                        }}
                        role="group"
                        tabIndex={0}
                        title={t("diff.editable.blockHint")}
                        aria-label={t("diff.editable.blockHint")}
                    >
                        <CodeBlock
                            lines={lines}
                            lineCount={lineCount}
                            lineNumbers={item.lineNumbers[side]}
                            lineNumberSide={lineNumberSide}
                            wordHighlight={highlightWords}
                            compareLines={compareLines}
                        />
                    </div>
                );
            })}
        </>
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
    const [editingBlock, setEditingBlock] = useState<EditableBlockLayout | null>(null);
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
    const handleDraftLayoutChange = useCallback((layout: EditableBlockLayout | null) => {
        setEditingBlock(layout);
    }, []);

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

    const paneLines = useMemo<SegmentPaneLines<DiffPane>[]>(
        () =>
            renderedSegments.map((item) => ({
                paneLines:
                    editingBlock?.index === item.index
                        ? { ...item.paneLines, [editingBlock.side]: editingBlock.rowCount }
                        : item.paneLines,
                conflict: item.segment.type === "changed",
                id: item.segment.type === "changed" ? item.index : undefined,
            })),
        [editingBlock, renderedSegments],
    );
    const layout = useMemo(() => buildVerticalLayout(paneLines, DIFF_PANES), [paneLines]);
    const stripeMarks = useMemo(() => buildStripeMarks(segments, layout), [segments, layout]);

    // The scroll range is `canonicalTotalPx` and the stripe is measured against the same
    // number, so a mark's segment top is already the scrollTop that puts it at the fold.
    const jumpToSegment = useCallback(
        (index: number) => {
            const content = contentRef.current;
            if (!content) return;
            content.scrollTop = layout.canonicalTopPx[index] ?? 0;
        },
        [layout],
    );
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
            (pane) =>
                columnRefs.current[pane]?.querySelectorAll<HTMLElement>(
                    ".code-lines, .diff-edit-textarea",
                ) ?? [],
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

    // The stripe marks are aria-hidden and take no tab stops -- one per change would be
    // hundreds on a real diff -- so click-to-jump is a pointer affordance only. Without a
    // key for the same move, reaching the next change from the keyboard means scrolling
    // and looking for it, which is the gap this closes.
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            // A composing IME owns the arrow keys for its candidate list, and inside a text
            // field this chord is already taken -- macOS walks the caret by paragraph on
            // Option+Up/Down, which an open edit block needs. The diff claims it outside a
            // field only, so nothing a reader can type into loses a key it already had.
            if (event.isComposing) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                (target.isContentEditable || target.closest("input, textarea") !== null)
            ) {
                return;
            }
            const content = contentRef.current;
            if (!content) return;
            const index = adjacentChangeIndex(
                stripeMarks,
                layout,
                content.scrollTop,
                event.key === "ArrowDown" ? 1 : -1,
            );
            if (index === undefined) return;
            event.preventDefault();
            jumpToSegment(index);
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [jumpToSegment, layout, stripeMarks]);

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
                                            text={data.editableText}
                                            documentVersion={data.documentVersion}
                                            reseedToken={data.editableReseedToken ?? 0}
                                            renderedSegments={renderedSegments}
                                            highlightWords={highlightWords}
                                            onEdit={handleEdit}
                                            onDraftLayoutChange={handleDraftLayoutChange}
                                            onHorizontalScroll={syncHorizontalScroll}
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
                                            text={data.editableText}
                                            documentVersion={data.documentVersion}
                                            reseedToken={data.editableReseedToken ?? 0}
                                            renderedSegments={renderedSegments}
                                            highlightWords={highlightWords}
                                            onEdit={handleEdit}
                                            onDraftLayoutChange={handleDraftLayoutChange}
                                            onHorizontalScroll={syncHorizontalScroll}
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
                        className="diff-change-stripe"
                        data-testid="diff-change-stripe"
                        aria-hidden="true"
                        // Clamped to the scroll range the marks are fractions of. A file
                        // shorter than the viewport has no scrollbar to mirror and ends
                        // partway down the pane, so a stripe spanning the full height
                        // would spread its marks past where the content stops -- pointing
                        // confidently at blank space. Taller than the viewport, this
                        // exceeds the box and the stripe is the full track, as it should
                        // be. Same number as the spacer, because it is the same range.
                        style={{ maxHeight: layout.canonicalTotalPx }}
                    >
                        {stripeMarks.map((mark) => (
                            <div
                                key={mark.index}
                                className={`diff-change-mark diff-change-${mark.tone}`}
                                style={{
                                    top: `${mark.topPct}%`,
                                    height: `${mark.heightPct}%`,
                                }}
                                onClick={() => {
                                    jumpToSegment(mark.index);
                                }}
                            />
                        ))}
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
