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
import {
    alignScrollOverlays,
    applyPaneOffsets,
    paneOffsetsForCanonical,
    syncHorizontalScroll as syncHorizontalScrollCore,
    updateSharedScrollbar as updateSharedScrollbarCore,
} from "../diff-core/scrollSync";
import { buildLineNumberValues } from "../diff-core/lineNumbers";
import { CodeBlock, intrinsicSizeStyle, type LineNumberSpec } from "../diff-core/segments";
import {
    IconChevronDown,
    IconChevronUp,
    IconEye,
    IconFilter,
    IconLock,
} from "../merge-editor/icons";
import { splitEditedText } from "../merge-editor/mergeState";
import {
    DIFF_PANES,
    revertArrowPane,
    revertArrowX,
    segmentClassName,
    segmentRibbonMarker,
    soleSidedPane,
    type DiffPane,
    type SegmentMarker,
} from "./segmentMarkers";
import { adjacentChangeIndex, buildStripeMarks } from "./changeStripe";
import {
    baseMaxLineLengthForSegments,
    effectiveMaxLineLength,
    sameEffectiveEditableBlockLayout,
    type EditableBlockLayout,
} from "./editableDraftLayout";
import { EditableSegmentBlock, type EditableSegmentItem } from "./EditableSegmentBlock";
import { reconcileDiffViewerData } from "./reconcileDiffSegments";
import {
    buildRenderedSegments,
    createRenderedSegmentCache,
    type RenderedSegment,
} from "./renderedDiffSegments";
import "./diff-viewer.css";

const LINE_PADDING_PX = 18;
const READ_ONLY_NOTICE_MS = 2500;

/**
 * Where the refusal is spoken when the caret cannot be measured -- a keyboard-only attempt
 * with no selection, or a collapsed range the browser reports as an empty rect at the origin.
 * Just inside the top-left of the panes, so the notice is still visibly ABOUT the diff rather
 * than pinned to a corner of the window.
 */
const READ_ONLY_NOTICE_FALLBACK_POINT = { x: 12, y: 12 } as const;

function isReadOnlyPane(editablePane: DiffPane | undefined, pane: DiffPane): boolean {
    return editablePane !== pane;
}

/** The document a pane is editing, once both halves of it have actually arrived. */
interface PaneEditor {
    readonly text: string;
    readonly version: number;
}

/**
 * The real editing surface this pane puts on screen, or `null` when it renders read-only blocks.
 *
 * Not the same question as `isReadOnlyPane`, which answers from `editablePane` alone: a
 * payload can name an editable side and omit the document behind it, and then the named pane
 * still renders read-only blocks. The caret follows what was actually rendered, because a
 * pane with no editing surface must not swallow keystrokes as if it had one.
 *
 * Returns the document rather than a boolean so the two fields are proven present once, here,
 * instead of at each of the places that then have to hand them to the editor.
 */
function paneEditor(data: DiffViewerData, pane: DiffPane): PaneEditor | null {
    if (data.editablePane !== pane) return null;
    if (data.editableText === undefined || data.documentVersion === undefined) return null;
    return { text: data.editableText, version: data.documentVersion };
}

/** Where the caret sits, so the notice can be spoken next to it rather than in the header. */
interface CaretPoint {
    readonly x: number;
    readonly y: number;
}

function caretPointWithin(host: HTMLElement): CaretPoint | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    // A collapsed range at the very start of a line can measure zero on both axes, which
    // would pin the notice to the viewer's top-left corner rather than to the caret.
    if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) return null;
    return { x: rect.left - hostRect.left, y: rect.top - hostRect.top };
}

function clearReadOnlyNoticeTimer(
    timerRef: React.MutableRefObject<ReturnType<typeof window.setTimeout> | null>,
): void {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
}

/** Renders one read-only side of one aligned diff segment. */
const DiffPaneBlock = React.memo(function DiffPaneBlock({
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
});

interface EditableBlockDraft {
    /** Stable React identity for the continuous active edit session. */
    editSessionKey: string;
    indices: readonly number[];
    text: string;
    selectionStart: number;
    selectionEnd: number;
    sourceText: string;
    startLine: number;
    lineCount: number;
    version: number;
    token: number;
}

/** Longest line in a block, in characters — the block's contribution to the shared extent. */
function longestLine(lines: readonly string[]): number {
    let max = 0;
    for (const line of lines) max = Math.max(max, line.length);
    return max;
}

/** Selects the state layout only when a draft change affects whole-view geometry. */
function nextEditingBlockState(
    previous: EditableBlockLayout | null,
    next: EditableBlockLayout | null,
    baseMaxLineLength: number,
): EditableBlockLayout | null {
    return sameEffectiveEditableBlockLayout(previous, next, baseMaxLineLength) ? previous : next;
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

/** Re-finds a draft's display segments after its own edit changes the diff's segmentation. */
function reanchorDraft(
    draft: EditableBlockDraft,
    renderedSegments: readonly RenderedSegment[],
    side: DiffPane,
    text: string,
    lastPostedText: string,
): EditableBlockDraft {
    const rangeEnd = draft.startLine + draft.lineCount;
    const indices: number[] = [];
    let cursor = 0;
    let runStart = 0;
    let runEnd = 0;

    for (const item of renderedSegments) {
        const nextCursor = cursor + item.segment[side].length;
        if (cursor < rangeEnd && draft.startLine < nextCursor) {
            if (indices.length === 0) runStart = cursor;
            indices.push(item.index);
            runEnd = nextCursor;
        }
        cursor = nextCursor;
    }

    if (indices.length === 0) return draft;
    const nextStartLine = Math.min(draft.startLine, runStart);
    const nextLineCount = Math.max(rangeEnd, runEnd) - nextStartLine;
    const widened = nextStartLine !== draft.startLine || nextLineCount !== draft.lineCount;
    const nextDraft = { ...draft, indices, startLine: nextStartLine, lineCount: nextLineCount };

    if (!widened || draft.text !== lastPostedText) return nextDraft;
    return {
        ...nextDraft,
        text: text
            .split("\n")
            .slice(nextStartLine, nextStartLine + nextLineCount)
            .join("\n"),
    };
}

function editedPaneLines(
    paneLines: Record<DiffPane, number>,
    index: number,
    editingBlock: EditableBlockLayout | null,
): Record<DiffPane, number> {
    if (editingBlock === null || !editingBlock.indices.includes(index)) return paneLines;
    return {
        ...paneLines,
        [editingBlock.side]: editingBlock.indices[0] === index ? editingBlock.rowCount : 0,
    };
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
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const editingIndexRef = useRef<number | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
    const lastPostedTextRef = useRef<string | null>(null);
    const draftRef = useRef<EditableBlockDraft | null>(null);
    const nextEditSessionKeyRef = useRef(0);
    const isComposingRef = useRef(false);
    const reseedDuringCompositionRef = useRef(false);
    const textRef = useRef(text);
    const documentVersionRef = useRef(documentVersion);
    const reseedTokenRef = useRef(reseedToken);
    const renderedSegmentsRef = useRef<readonly RenderedSegment[]>(renderedSegments);
    const lineNumberSide = side === "left" ? "right" : "left";
    const draftLines = useMemo(() => draft?.text.split("\n") ?? [], [draft?.text]);

    textRef.current = text;
    documentVersionRef.current = documentVersion;
    reseedTokenRef.current = reseedToken;
    renderedSegmentsRef.current = renderedSegments;

    const clearDebounceTimer = useCallback(() => {
        if (debounceTimerRef.current === null) return;
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
    }, []);

    const clearDraft = useCallback(() => {
        clearDebounceTimer();
        editingIndexRef.current = null;
        setDraft(null);
        onDraftLayoutChange(null);
    }, [clearDebounceTimer, onDraftLayoutChange]);

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

    useEffect(
        () => () => {
            clearDebounceTimer();
            onDraftLayoutChange(null);
        },
        [clearDebounceTimer, onDraftLayoutChange],
    );

    const editingDraftIndex = draft?.indices[0];
    const editingSelectionStart = draft?.selectionStart;
    const editingSelectionEnd = draft?.selectionEnd;
    useEffect(() => {
        if (
            editingDraftIndex === undefined ||
            editingSelectionStart === undefined ||
            editingSelectionEnd === undefined
        ) {
            return;
        }
        const textarea = textareaRef.current;
        textarea?.setSelectionRange(editingSelectionStart, editingSelectionEnd);

        // A block can be opened while the panes are already scrolled sideways. The overlay is
        // born at scroll 0 and only a scroll event would align it, so align this one directly --
        // otherwise the first caret of the session lands on the wrong column and stays there
        // until something happens to scroll. Directly, and not through `onHorizontalScroll`:
        // that driver coalesces into a frame, and a frame pending on nothing but this would
        // swallow the next real scroll to arrive before it.
        const codeLines = textarea?.parentElement?.querySelector<HTMLElement>(".code-lines");
        if (textarea && codeLines) alignScrollOverlays([textarea], codeLines.scrollLeft);
    }, [editingDraftIndex, editingSelectionEnd, editingSelectionStart]);

    // The debounced post reads the draft as it stands when the timer FIRES, never the one it was
    // armed with. Typing resumes the moment the first post goes out, so the next window is armed
    // while that post's echo is still in flight; a captured draft would still carry the pre-echo
    // version, and the host rejects a delta whose baseVersion has moved -- which reseeds, and the
    // reseed destroys the textarea the user is typing in.
    useEffect(() => {
        draftRef.current = draft;
    });

    const restartDebouncedPost = useCallback(() => {
        clearDebounceTimer();
        debounceTimerRef.current = window.setTimeout(() => {
            debounceTimerRef.current = null;
            const current = draftRef.current;
            if (current === null || isComposingRef.current || current.token !== reseedToken) return;
            const nextText = replaceBlockText(
                current.sourceText,
                current.startLine,
                current.lineCount,
                current.text,
            );
            if (nextText === current.sourceText) return;
            lastPostedTextRef.current = current.text;
            onEdit(current.sourceText, nextText, current.version, current.token);
        }, 1000);
    }, [clearDebounceTimer, onEdit, reseedToken]);

    useEffect(() => {
        if (draft === null || draft.token !== reseedToken || draft.version === documentVersion)
            return;
        const lastPostedText = lastPostedTextRef.current ?? draft.text;
        const nextDraft = reanchorDraft(
            {
                ...draft,
                selectionStart: textareaRef.current?.selectionStart ?? draft.selectionStart,
                selectionEnd: textareaRef.current?.selectionEnd ?? draft.selectionEnd,
                sourceText: textRef.current,
                version: documentVersion,
                // The same splitter the post itself went through. `replaceBlockText` runs
                // `splitEditedText`, which reads empty text as a deleted block -- no lines,
                // not one blank one -- so a plain `split` would claim the emptied block still
                // occupies a line of the echoed document. That line belongs to the NEXT
                // segment: the re-anchor would swallow it, and the reader's replacement text
                // would then overwrite a hunk they never touched.
                lineCount: splitEditedText(lastPostedText).length,
            },
            renderedSegments,
            side,
            text,
            lastPostedText,
        );
        editingIndexRef.current = nextDraft.indices[0];
        setDraft(nextDraft);
        const nextLines = nextDraft.text.split("\n");
        onDraftLayoutChange({
            side,
            indices: nextDraft.indices,
            rowCount: Math.max(nextLines.length, 1),
            maxLineLength: longestLine(nextLines),
        });
    }, [documentVersion, draft, onDraftLayoutChange, renderedSegments, reseedToken, side, text]);

    /** Starts a session from the latest host model without changing its callback identity. */
    const startEditing = useCallback(
        (item: EditableSegmentItem, caretOffset = 0) => {
            const currentRenderedSegments = renderedSegmentsRef.current;
            const currentItem = currentRenderedSegments[item.index] ?? item;
            if (editingIndexRef.current === currentItem.index) return;
            editingIndexRef.current = currentItem.index;
            lastPostedTextRef.current = null;
            const startLine = paneStartLine(currentRenderedSegments, currentItem.index, side);
            const nextDraft = {
                editSessionKey: `edit-session-${nextEditSessionKeyRef.current++}`,
                indices: [currentItem.index],
                text: currentItem.segment[side].join("\n"),
                selectionStart: caretOffset,
                selectionEnd: caretOffset,
                sourceText: textRef.current,
                startLine,
                lineCount: currentItem.segment[side].length,
                version: documentVersionRef.current,
                token: reseedTokenRef.current,
            };
            setDraft(nextDraft);
            onDraftLayoutChange({
                side,
                indices: nextDraft.indices,
                rowCount: Math.max(nextDraft.lineCount, 1),
                maxLineLength: longestLine(currentItem.segment[side]),
            });
        },
        [onDraftLayoutChange, side],
    );

    const commitDraft = useCallback(() => {
        clearDebounceTimer();
        if (draft === null) return;
        if (draft.text === lastPostedTextRef.current) {
            clearDraft();
            return;
        }
        clearDraft();
        if (draft.token !== reseedToken) return;
        const nextText = replaceBlockText(
            draft.sourceText,
            draft.startLine,
            draft.lineCount,
            draft.text,
        );
        if (nextText !== draft.sourceText) {
            lastPostedTextRef.current = draft.text;
            onEdit(draft.sourceText, nextText, draft.version, draft.token);
        }
    }, [clearDebounceTimer, clearDraft, draft, onEdit, reseedToken]);

    return (
        <>
            {renderedSegments.map((item) => {
                const isEditing = draft !== null && draft.indices.includes(item.index);
                const compareLines = item.segment[side === "left" ? "right" : "left"];

                if (isEditing && draft) {
                    if (draft.indices[0] !== item.index) return null;
                    const rowCount = Math.max(draftLines.length, 1);
                    return (
                        <div
                            key={draft.editSessionKey}
                            className={`segment diff-editing-block editing ${segmentClassName(item.segment, side)} line-numbers-${lineNumberSide}`}
                            style={intrinsicSizeStyle(rowCount)}
                        >
                            <CodeBlock
                                lines={draftLines}
                                lineCount={rowCount}
                                lineNumbers={{
                                    primary: buildLineNumberValues(
                                        draft.startLine + 1,
                                        draftLines.length,
                                        rowCount,
                                    ),
                                }}
                                lineNumberSide={lineNumberSide}
                                wordHighlight={highlightWords}
                                compareLines={compareLines}
                            />
                            <textarea
                                ref={textareaRef}
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
                                    if (reseedDuringCompositionRef.current) {
                                        reseedDuringCompositionRef.current = false;
                                        clearDraft();
                                        return;
                                    }
                                    restartDebouncedPost();
                                }}
                                onChange={(event) => {
                                    const nextText = event.target.value;
                                    const nextLines = nextText.split("\n");
                                    const nextDraft = { ...draft, text: nextText };
                                    setDraft(nextDraft);
                                    onDraftLayoutChange({
                                        side,
                                        indices: draft.indices,
                                        // The draft's own lines, never the block it replaces: the
                                        // row count reported here is what the pane's geometry is
                                        // built from, and the render below sizes the block from
                                        // these same lines. Holding the pre-edit height would keep
                                        // the two disagreeing until the echo re-based them.
                                        rowCount: Math.max(nextLines.length, 1),
                                        maxLineLength: longestLine(nextLines),
                                    });
                                    restartDebouncedPost();
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
                        </div>
                    );
                }

                return (
                    <EditableSegmentBlock
                        key={item.renderKey}
                        item={item}
                        side={side}
                        lineNumberSide={lineNumberSide}
                        highlightWords={highlightWords}
                        onStartEditing={startEditing}
                    />
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
    editablePane,
    leftLabel,
    rightLabel,
}: {
    singlePane: DiffPane | null;
    editablePane: DiffPane | undefined;
    leftLabel: string;
    rightLabel: string;
}): React.ReactElement {
    return (
        <div className="diff-pane-meta-row">
            {singlePane === "right" ? null : (
                <div className="diff-pane-meta">
                    {isReadOnlyPane(editablePane, "left") ? (
                        <span
                            className="toolbar-icon diff-pane-lock"
                            title={t("diff.readOnly.pane")}
                            aria-label={t("diff.readOnly.pane")}
                        >
                            <IconLock />
                        </span>
                    ) : null}
                    {leftLabel}
                </div>
            )}
            {singlePane === "left" ? null : (
                <div className="diff-pane-meta">
                    {isReadOnlyPane(editablePane, "right") ? (
                        <span
                            className="toolbar-icon diff-pane-lock"
                            title={t("diff.readOnly.pane")}
                            aria-label={t("diff.readOnly.pane")}
                        >
                            <IconLock />
                        </span>
                    ) : null}
                    {rightLabel}
                </div>
            )}
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

/**
 * The pane a revert can actually be written to, as opposed to the one the host named.
 *
 * `editablePane` is intent; `editableText` and `documentVersion` are what make an edit
 * expressible, and `handleRevertHunk` returns on its first line without all three. The
 * panes already fall back to read-only blocks in that gap, so an arrow drawn on the
 * intent alone is a button that looks live, reads as a broken revert when pressed, and
 * reports nothing. One resolved value, so the arrow and the handler cannot disagree.
 *
 * The two editable-pane mounts keep their own inline form of this check rather than
 * reading it from here: they pass `editableText` and `documentVersion` on as props, so
 * they need the narrowing the inline conditions perform, which a `DiffPane | undefined`
 * cannot carry.
 *
 * Module scope rather than inline in `App`: these three conditions count toward `App`'s
 * cyclomatic complexity, which the lint ceiling already holds at its limit.
 */
function revertablePaneOf(data: DiffViewerData | null): DiffPane | undefined {
    return data?.editableText !== undefined && data.documentVersion !== undefined
        ? data.editablePane
        : undefined;
}

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

/** Hosts a pure, read-only two-pane diff with only view toggles. */
export function App(): React.ReactElement {
    const [data, setData] = useState<DiffViewerData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [readOnlyNotice, setReadOnlyNotice] = useState<CaretPoint | null>(null);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");
    const [highlightWords, setHighlightWords] = useState(true);
    const [editingBlock, setEditingBlock] = useState<EditableBlockLayout | null>(null);
    const latestEditingBlockRef = useRef<EditableBlockLayout | null>(null);
    const baseMaxLineLengthRef = useRef(1);
    const [shikiReady, setShikiReady] = useState(() => isShikiReady());
    const [shikiTheme] = useState(() => detectTheme());
    // The same height `viewportRef` caches, kept in state as well because the scroll
    // spacer and the overview rail are sized from it during render -- a ref alone would
    // leave both stale until some other change happened to re-render.
    const [viewportHeight, setViewportHeight] = useState(0);
    const vscode = useMemo(() => getVsCodeApi<OutboundMessage, unknown>(), []);
    const renderedSegmentCache = useMemo(createRenderedSegmentCache, []);

    const contentRef = useRef<HTMLDivElement | null>(null);
    const viewportElementRef = useRef<HTMLDivElement | null>(null);
    const columnRefs = useRef<Record<DiffPane, HTMLDivElement | null>>({ left: null, right: null });
    /** The positioning context the read-only notice is placed against. */
    const rootRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollInnerRef = useRef<HTMLDivElement | null>(null);
    const lastPaneClientWidthRef = useRef(0);
    const verticalFrameRef = useRef(0);
    const scrollSyncRef = useRef({ raf: 0, left: 0 });
    const readOnlyNoticeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
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
    const handleDraftLayoutChange = useCallback((layout: EditableBlockLayout | null) => {
        latestEditingBlockRef.current = layout;
        setEditingBlock((previous) =>
            nextEditingBlockState(previous, layout, baseMaxLineLengthRef.current),
        );
    }, []);

    const segments = useMemo(() => data?.segments ?? [], [data]);
    const baseMaxLineLength = useMemo(() => baseMaxLineLengthForSegments(segments), [segments]);
    baseMaxLineLengthRef.current = baseMaxLineLength;
    const syntaxHighlightState = useMemo(
        () => ({
            ready: shikiReady,
            lang: data?.languageId || (data?.path ? langForPath(data.path) : null),
            theme: shikiTheme,
        }),
        [data?.languageId, data?.path, shikiReady, shikiTheme],
    );

    const renderedSegments = useMemo(
        () => buildRenderedSegments(segments, renderedSegmentCache),
        [renderedSegmentCache, segments],
    );

    const paneLines = useMemo<SegmentPaneLines<DiffPane>[]>(
        () =>
            renderedSegments.map((item) => ({
                paneLines: editedPaneLines(item.paneLines, item.index, editingBlock),
                conflict: item.segment.type === "changed",
                id: item.segment.type === "changed" ? item.index : undefined,
            })),
        [editingBlock, renderedSegments],
    );
    const layout = useMemo(() => buildVerticalLayout(paneLines, DIFF_PANES), [paneLines]);
    const stripeMarks = useMemo(
        () => buildStripeMarks(segments, layout, viewportHeight),
        [segments, layout, viewportHeight],
    );

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

    /**
     * Moves to the next or previous change, and reports whether there was one to move to.
     *
     * One definition for the toolbar arrows and the Alt+Arrow keys, because "next change"
     * from a given scroll position is a single answer -- two copies would be two answers
     * the moment either one's boundary handling was touched. The boolean is what lets the
     * key handler leave the event alone at the last change instead of swallowing a key it
     * did nothing with.
     */
    const jumpToAdjacentChange = useCallback(
        (direction: 1 | -1): boolean => {
            const content = contentRef.current;
            if (!content) return false;
            const index = adjacentChangeIndex(stripeMarks, layout, content.scrollTop, direction);
            if (index === undefined) return false;
            jumpToSegment(index);
            return true;
        },
        [jumpToSegment, layout, stripeMarks],
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

    /** See `revertablePaneOf`: the host's named pane, narrowed to one an edit can reach. */
    const revertablePane = useMemo(() => revertablePaneOf(data), [data]);

    /** See `paneEditor`: which side, if either, actually has an editing surface to render. */
    const leftEditor = data ? paneEditor(data, "left") : null;
    const rightEditor = data ? paneEditor(data, "right") : null;

    // No arrows on a collapsed one-sided file: there is no channel between panes to stand
    // in, and "revert the whole file" is a delete or a restore, not a block replacement.
    // Whether there is an editable pane at all is NOT re-checked here -- `DiffHunkActionLayer`
    // decides that from `revertablePane`, because it needs the pane for the arrow's direction
    // anyway. A second copy of the same condition cannot be shown to be doing anything, since
    // removing either one leaves the other answering.
    //
    // Nor is an in-flight edit gated here. A revert clicked while a delta is unacknowledged is
    // stamped with the version the webview currently believes, exactly like a keystroke, and the
    // host settles it: a stale `baseVersion` reseeds (`EditableDiffEditorProvider.applyEdit`),
    // and a stale token is dropped and logged. Nothing lands on the wrong text, which is why
    // three same-version reverts are pinned as correct rather than tolerated.
    //
    // Emptying this list until an acknowledgement arrives would be worse in two ways. The token
    // path is the NORMAL case while a reseed is in flight and it produces no echo at all, so the
    // arrows would have nothing to wait for and would stay gone. And an empty list unmounts every
    // button, so each debounced post would flash the whole strip away and back.
    const actionHunks = useMemo(
        () =>
            singlePane === null
                ? ribbonIndices
                      .map((ribbon) => ribbon.index)
                : [],
        [ribbonIndices, singlePane],
    );

    // An open draft is part of the pane's width even though it is not part of the diff. The ref
    // keeps this O(1) on ordinary input and preserves a draft width when a later host echo lowers
    // the base extent.
    const maxLineLength = effectiveMaxLineLength(baseMaxLineLength, latestEditingBlockRef.current);

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

        for (const pane of DIFF_PANES) {
            alignScrollOverlays(
                columnRefs.current[pane]?.querySelectorAll<HTMLElement>(".diff-edit-textarea") ??
                    [],
                left,
            );
        }
    }, []);

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
            const editablePane = data?.editablePane;
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
                button.style.top = `${top + Math.min(paneH, viewportRef.current.lineRowPx) / 2}px`;
                button.style.left = `${leftPx}px`;
                // Set here rather than in the stylesheet because it is half of one placement
                // decision: `left` alone is meaningless without knowing which of the box's
                // edges it names, and splitting the pair across two files is how the two
                // drift apart.
                button.style.transform = transform;
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

    const handleReadOnlyAttempt = useCallback((at: CaretPoint | null) => {
        clearReadOnlyNoticeTimer(readOnlyNoticeTimerRef);
        setReadOnlyNotice(at ?? READ_ONLY_NOTICE_FALLBACK_POINT);
        readOnlyNoticeTimerRef.current = window.setTimeout(() => {
            readOnlyNoticeTimerRef.current = null;
            setReadOnlyNotice(null);
        }, READ_ONLY_NOTICE_MS);
    }, []);

    useEffect(() => {
        return () => clearReadOnlyNoticeTimer(readOnlyNoticeTimerRef);
    }, []);

    /**
     * A caret in the read-only pane, and a refusal when the reader tries to type into it.
     *
     * `contentEditable` is what puts a real caret on a plain div -- clicking places it, the
     * arrow keys move it, and a selection spans lines the way it does in the editable pane.
     * Every actual edit is then refused at `beforeinput`, which the browser raises for
     * typing, paste, cut, delete and drop alike. Enumerating those as keystrokes instead
     * would cover the ones remembered on the day it was written; this covers whatever the
     * browser itself counts as changing the text.
     */
    useEffect(() => {
        if (!data) return;
        const host = rootRef.current;
        const disposers = DIFF_PANES.filter((pane) => !paneEditor(data, pane)).map((pane) => {
            const element = columnRefs.current[pane];
            if (!element) return () => undefined;
            // Refuse on every pane that carries the caret, but only ACCUSE on the ones the
            // lock icon also calls read-only. A payload that names an editable side and
            // omits the document behind it renders immutable blocks on that side too: it
            // must still swallow the keystroke -- there is nowhere to save it -- while
            // staying silent, or the notice would contradict its own pane's missing lock.
            const refuse = (event: Event): void => {
                event.preventDefault();
                if (!isReadOnlyPane(data.editablePane, pane)) return;
                handleReadOnlyAttempt(host ? caretPointWithin(host) : null);
            };
            element.addEventListener("beforeinput", refuse);
            return () => element.removeEventListener("beforeinput", refuse);
        });
        return () => disposers.forEach((dispose) => dispose());
    }, [data, handleReadOnlyAttempt]);

    useEffect(() => {
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setDiffData") {
                setError(event.data.data.loadError ?? null);
                setIgnoreMode(event.data.data.ignoreWhitespace ? "whitespace" : "none");
                setData((previous) => reconcileDiffViewerData(previous, event.data.data));
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
            if (jumpToAdjacentChange(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [jumpToAdjacentChange]);

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

    // Both axes: a long line in the file just closed leaves the next one scrolled sideways
    // just as readily as it leaves it scrolled down, and the horizontal offset lives in a
    // ref shared by both panes rather than on the element this resets.
    const resetViewport = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        content.scrollTop = 0;
        syncHorizontalScroll(0);
        scheduleVerticalFrame();
    }, [scheduleVerticalFrame, syncHorizontalScroll]);

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
        hasDiffData,
        layout,
        measureViewport,
        revertablePane,
        scheduleVerticalFrame,
        updateHorizontalScrollWidth,
    ]);

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
        // Only an arrow needs the strip, so the lane opens on exactly the value the arrow is
        // drawn from -- `revertablePane`, not `data.editablePane`. Reading the host's intent
        // here instead would leave a payload that names an editable side without the document
        // behind it holding two empty lanes open for a button that never renders. A
        // commit-to-commit diff keeps it at zero for the same reason.
        "--diff-viewer-action-gutter": revertablePane ? "var(--diff-revert-arrow-size)" : "0px",
    } as React.CSSProperties;

    return (
        <SyntaxHighlightProvider value={syntaxHighlightState}>
            <div
                ref={rootRef}
                className={viewerRootClass(singlePane)}
                style={rootStyle}
                data-testid="diff-viewer-root"
            >
                {/* No path row. Both entry points already name the file above the webview --
                    the custom editor sits under VS Code's own breadcrumb bar, and the panel
                    opened from a commit's file list carries the full path in its tab title
                    (`DiffViewerPanel.panelTitle`) -- so a row here was a second caption for
                    the same string, one line lower. The header stays for the markers that
                    have nowhere else to go. */}
                <div className="diff-header">
                    {data.newlineDifference ? (
                        <span className="diff-newline-marker" role="status">
                            {t("diff.newlineDifference")}
                        </span>
                    ) : null}
                </div>
                {/* Beside the caret rather than up in the header, because the refusal answers
                    something the reader just did with their hands at that spot -- a status
                    line one band away reads as belonging to the file, not to the keystroke. */}
                {readOnlyNotice ? (
                    <span
                        className="diff-readonly-notice"
                        role="status"
                        style={{ left: `${readOnlyNotice.x}px`, top: `${readOnlyNotice.y}px` }}
                    >
                        {t("diff.readOnly.pane")}
                    </span>
                ) : null}
                <div className="diff-toolbar">
                    <div className="toolbar-left">
                        <div className="toolbar-nav-group">
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                data-testid="diff-prev-change"
                                onClick={() => jumpToAdjacentChange(-1)}
                                title={t("diff.toolbar.prevChange.title")}
                                aria-label={t("diff.toolbar.prevChange.label")}
                                disabled={stripeMarks.length === 0}
                            >
                                <IconChevronUp />
                            </button>
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                data-testid="diff-next-change"
                                onClick={() => jumpToAdjacentChange(1)}
                                title={t("diff.toolbar.nextChange.title")}
                                aria-label={t("diff.toolbar.nextChange.label")}
                                disabled={stripeMarks.length === 0}
                            >
                                <IconChevronDown />
                            </button>
                        </div>
                        <div className="toolbar-separator" />
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
                <DiffPaneMetaRow
                    singlePane={singlePane}
                    editablePane={data.editablePane}
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
                                        contentEditable={!leftEditor}
                                        suppressContentEditableWarning
                                        spellCheck={false}
                                        aria-readonly={!leftEditor}
                                    >
                                        {leftEditor ? (
                                            <EditableDiffPane
                                                side="left"
                                                text={leftEditor.text}
                                                documentVersion={leftEditor.version}
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
                                                    key={`left-${item.renderKey}`}
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
                                        contentEditable={!rightEditor}
                                        suppressContentEditableWarning
                                        spellCheck={false}
                                        aria-readonly={!rightEditor}
                                    >
                                        {rightEditor ? (
                                            <EditableDiffPane
                                                side="right"
                                                text={rightEditor.text}
                                                documentVersion={rightEditor.version}
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
                                                    key={`right-${item.renderKey}`}
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
                                editablePane={revertablePane}
                                onRevert={handleRevertHunk}
                                registerButton={registerActionButton}
                            />
                        </div>
                        <div
                            className="diff-vscroll-spacer"
                            style={{
                                height: scrollRangePx(layout.canonicalTotalPx, viewportHeight),
                            }}
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
                        style={{
                            maxHeight: scrollRangePx(layout.canonicalTotalPx, viewportHeight),
                        }}
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

/**
 * The mounted root, exported so whoever owns the page can take the app back down.
 *
 * `null` when there is no `#root`, which is every import that is not the webview itself.
 * The webview never unmounts -- the editor disposes the whole document instead -- so this
 * exists for callers that mount the module more than once in one page. Integration tests
 * do exactly that, once per case, and without a handle they cannot undo it: an App that is
 * never unmounted keeps the `message` listener its effect registered, so a later
 * `setDiffData` is re-rendered by every instance the file has mounted so far, each one
 * still holding the full fibre tree of a diff nothing can see any more.
 */
export const root = container ? createRoot(container) : null;
root?.render(<App />);
