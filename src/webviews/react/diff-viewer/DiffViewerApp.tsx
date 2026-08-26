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
    connectorChannelSpan,
    LINE_HEIGHT_PX,
    ribbonPathD,
    scrollRangePx,
    type DiffVerticalLayout,
    type RibbonSpan,
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
import {
    DIFF_PANES,
    segmentClassName,
    segmentRibbonMarker,
    soleSidedPane,
    type DiffPane,
    type SegmentMarker,
} from "./segmentMarkers";
import { adjacentChangeIndex, buildStripeMarks } from "./changeStripe";
import "./diff-viewer.css";

const LINE_PADDING_PX = 18;

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
function replaceBlockLines(
    sourceText: string,
    startLine: number,
    lineCount: number,
    replacement: readonly string[],
): string {
    const lines = sourceText.split("\n");
    lines.splice(startLine, lineCount, ...replacement);
    return lines.join("\n");
}

/**
 * Same replacement, from edited TEXT rather than from lines.
 *
 * A caller that already holds lines goes to `replaceBlockLines` instead of joining them for
 * this one to split again: that round trip cannot add information and can lose it, since
 * `splitEditedText` splits on `/\r?\n/` and would eat a CR the lines were carrying. The two
 * agree on the empty case -- `splitEditedText("")` is no lines, not one blank one -- so
 * that is not what separates them.
 */
function replaceBlockText(
    sourceText: string,
    startLine: number,
    lineCount: number,
    editedText: string,
): string {
    return replaceBlockLines(sourceText, startLine, lineCount, splitEditedText(editedText));
}

/** Line offset of a segment within one pane's own document text. */
function paneStartLine(
    renderedSegments: readonly RenderedSegment[],
    index: number,
    side: DiffPane,
): number {
    return renderedSegments
        .slice(0, index)
        .reduce((total, previous) => total + previous.segment[side].length, 0);
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
            const startLine = paneStartLine(renderedSegments, item.index, side);
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
                        className={`segment diff-editable-block ${segmentClassName(item.segment, side)}`}
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
    ribbons,
    registerPath,
}: {
    ribbons: readonly { index: number; marker: SegmentMarker | null }[];
    registerPath: (index: number, element: SVGPathElement | null) => void;
}): React.ReactElement {
    return (
        <svg className="diff-ribbon-layer" aria-hidden="true">
            {ribbons.map(({ index, marker }) => (
                <path
                    key={`ribbon-${index}`}
                    ref={(element) => registerPath(index, element)}
                    className={`diff-ribbon ${marker ?? ""}`}
                />
            ))}
        </svg>
    );
}

/** Root class list. The modifier is what widens the surviving pane of a one-sided file. */
function viewerRootClass(singlePane: DiffPane | null): string {
    return singlePane === null
        ? "diff-core diff-viewer"
        : "diff-core diff-viewer diff-viewer-single";
}

/** The pane header labels -- one per pane actually on screen. */
function DiffPaneMetaRow({
    singlePane,
    leftLabel,
    rightLabel,
}: {
    singlePane: DiffPane | null;
    leftLabel: string;
    rightLabel: string;
}): React.ReactElement {
    return (
        <div className="diff-pane-meta-row">
            {singlePane === "right" ? null : <div className="diff-pane-meta">{leftLabel}</div>}
            {singlePane === "left" ? null : <div className="diff-pane-meta">{rightLabel}</div>}
        </div>
    );
}

/**
 * The per-hunk revert arrows, in the connector channel between the panes.
 *
 * Positioned by the scroll driver in viewport pixels rather than by React, for the reason
 * the ribbons are: the two columns are translated independently, so a button's place is a
 * function of the editable pane's own offset and changes every frame of a scroll. Nothing
 * renders when there is no editable pane -- a commit diff has no file to write back to --
 * and nothing renders for a collapsed one-sided file either, where there is no channel to
 * stand in and reverting the whole file is a delete, not an edit.
 */
function DiffHunkActionLayer({
    hunks,
    editablePane,
    onRevert,
    registerButton,
}: {
    hunks: readonly number[];
    editablePane: DiffPane | undefined;
    onRevert: (index: number) => void;
    registerButton: (index: number, element: HTMLButtonElement | null) => void;
}): React.ReactElement | null {
    if (editablePane === undefined || hunks.length === 0) return null;
    return (
        <div className="diff-action-layer">
            {hunks.map((index) => (
                <button
                    key={`revert-${index}`}
                    ref={(element) => registerButton(index, element)}
                    type="button"
                    className="diff-hunk-revert"
                    data-testid={`diff-revert-${index}`}
                    title={t("diff.editable.revertHunk")}
                    aria-label={t("diff.editable.revertHunk")}
                    onClick={() => onRevert(index)}
                >
                    {editablePane === "right" ? "\u00bb" : "\u00ab"}
                </button>
            ))}
        </div>
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
    // ribbons, and `channel` is the empty gutter between the two panes -- the only
    // x range a connector is ever drawn in. Measured on layout/resize so the
    // per-frame draw only recomputes y. The channel starts empty so a draw racing
    // the first measure paints a zero-width band rather than one spanning the
    // whole viewport, which is the defect this replaced.
    const viewportRef = useRef<{ height: number; channel: RibbonSpan }>({
        height: 0,
        channel: connectorChannelSpan(0, 0),
    });
    const ribbonPaths = useMemo(() => new Map<number, SVGPathElement>(), []);
    const actionButtons = useMemo(() => new Map<number, HTMLButtonElement>(), []);
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
                .map((item) => ({
                    index: item.index,
                    marker: segmentRibbonMarker(item.segment),
                })),
        [renderedSegments],
    );

    // Never collapse away the pane bound to the live document. A one-sided file whose
    // surviving side is the read-only one would otherwise unmount the editing surface --
    // the user loses the ability to type into the file the viewer opened for editing,
    // which is a strictly worse trade than an empty column.
    const singlePane = useMemo(() => {
        const sole = soleSidedPane(segments);
        if (sole === null) return null;
        return data?.editablePane === undefined || data.editablePane === sole ? sole : null;
    }, [data?.editablePane, segments]);

    // No arrows on a collapsed one-sided file: there is no channel between panes to stand
    // in, and "revert the whole file" is a delete or a restore, not a block replacement.
    // Whether there is an editable pane at all is NOT re-checked here -- `DiffHunkActionLayer`
    // decides that, because it needs the pane for the arrow's direction anyway. A second copy
    // of the same condition cannot be shown to be doing anything, since removing either one
    // leaves the other answering.
    const actionHunks = useMemo(
        () => (singlePane === null ? ribbonIndices.map((ribbon) => ribbon.index) : []),
        [ribbonIndices, singlePane],
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
        viewportRef.current = { height, channel };
        content.style.setProperty("--diff-viewport-h", `${height}px`);
    }, []);

    // Redraw every ribbon from the same per-pane offsets the columns were just
    // translated by, so a hunk's band always meets its own rows on both sides.
    // Each side's extent comes from that pane's own geometry: a deletion-only
    // hunk followed by an insertion-only one flips which pane is taller, and a
    // shared canonical extent would misdraw one of them.
    // Each arrow stands beside the hunk in the pane it WRITES INTO, not at the canonical
    // position: those differ by exactly the rows the other pane has and this one does not,
    // which is every hunk the button exists for. A hunk the editable pane holds no rows of
    // still gets one, at the collapsed position the reverted lines would be inserted at.
    const drawActions = useCallback(
        (
            currentLayout: DiffVerticalLayout<DiffPane>,
            offsets: Readonly<Record<DiffPane, number>>,
            viewportH: number,
            span: RibbonSpan,
        ) => {
            const pane = data?.editablePane;
            if (pane === undefined) return;
            const centre = (span.x0 + span.x1) / 2;
            for (const [index, button] of actionButtons) {
                if (index >= currentLayout.canonicalTopPx.length) continue;
                const top = currentLayout.paneTopPx[pane][index] - offsets[pane];
                const bottom = top + currentLayout.paneHPx[pane][index];
                if (bottom < 0 || top > viewportH) {
                    button.style.display = "none";
                    continue;
                }
                // Not `""`: that clears the inline property and hands the button back to
                // the stylesheet, which hides it. The ribbons get away with it only because
                // nothing declares a display for them.
                button.style.display = "flex";
                button.style.top = `${top}px`;
                button.style.left = `${centre}px`;
            }
        },
        [actionButtons, data?.editablePane],
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
        const offsets = paneOffsetsForCanonical(
            currentLayout,
            DIFF_PANES,
            content.scrollTop,
            viewportH,
        );
        applyPaneOffsets(DIFF_PANES, (pane) => columnRefs.current[pane], offsets);
        drawRibbons(currentLayout, offsets, viewportH, channel);
        drawActions(currentLayout, offsets, viewportH, channel);
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

    // Reverting is a document edit, deliberately: it goes down the same offset-diff and
    // `editText` path a typed block commit does, so it lands in VS Code's undo stack, is
    // stamped with the version and reseed token the draft machinery already uses to reject
    // a stale write, and needs no second host command to review.
    const handleRevertHunk = useCallback(
        (index: number) => {
            const pane = data?.editablePane;
            const sourceText = data?.editableText;
            const version = data?.documentVersion;
            if (pane === undefined || sourceText === undefined || version === undefined) return;
            const item = renderedSegments[index];
            if (item === undefined) return;
            const nextText = replaceBlockLines(
                sourceText,
                paneStartLine(renderedSegments, index, pane),
                item.segment[pane].length,
                item.segment[pane === "left" ? "right" : "left"],
            );
            if (nextText === sourceText) return;
            handleEdit(sourceText, nextText, version, data?.editableReseedToken ?? 0);
        },
        [data, handleEdit, renderedSegments],
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
            <div
                className={viewerRootClass(singlePane)}
                style={rootStyle}
                data-testid="diff-viewer-root"
            >
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
                <DiffPaneMetaRow
                    singlePane={singlePane}
                    leftLabel={data.leftLabel}
                    rightLabel={data.rightLabel}
                />
                {error ? (
                    <div className="error-message diff-error-banner" role="alert">
                        {t("diff.error.load", { error })}
                    </div>
                ) : null}
                <div className="diff-content-shell">
                    <div ref={contentRef} className="diff-content" onScrollCapture={handleScroll}>
                        <div ref={viewportElementRef} className="diff-viewport">
                            <div className="diff-columns">
                                {singlePane === "right" ? null : (
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
                                )}
                                {singlePane === "left" ? null : (
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
                                )}
                            </div>
                            {/* A ribbon connects two positions. With one pane there is no
                                second position to connect to, so the layer would draw every
                                hunk as a path from a column that is not on screen. */}
                            {singlePane === null ? (
                                <DiffRibbonLayer
                                    ribbons={ribbonIndices}
                                    registerPath={registerRibbonPath}
                                />
                            ) : null}
                            <DiffHunkActionLayer
                                hunks={actionHunks}
                                editablePane={data.editablePane}
                                onRevert={handleRevertHunk}
                                registerButton={registerActionButton}
                            />
                        </div>
                        <div
                            className="diff-vscroll-spacer"
                            style={{ height: scrollRangePx(layout.canonicalTotalPx) }}
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
                        style={{ maxHeight: scrollRangePx(layout.canonicalTotalPx) }}
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
