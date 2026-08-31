// One editing session inside a diff pane: its draft, the debounced post to the host, and the
// re-anchoring that keeps the draft pointed at the right lines after the host echoes back.
//
// Split out of `EditableDiffPane`, which was 486 lines and could not be read in one sitting. The
// component is the render; this is the session it renders. The two were only ever tangled because
// the session is held in refs, and refs are invisible in a listing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alignScrollOverlays } from "../diff-core/scrollSync";
import { splitEditedText } from "../merge-editor/mergeState";
import { segmentClassName, type DiffPane } from "./segmentMarkers";
import { sameEffectiveEditableBlockLayout, type EditableBlockLayout } from "./editableDraftLayout";
import type { EditableSegmentItem } from "./EditableSegmentBlock";
import type { RenderedSegment } from "./renderedDiffSegments";

/** One in-flight edit session: the text being typed, and where it sits in the host document. */
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
    /** Stable zero-based host line used to remap pending growth after an echo resegments the run. */
    pendingGrowthAnchorLine: number | null;
    /** Frozen host segment that owns the current unposted positive row surplus. */
    pendingGrowthTargetIndex: number | null;
    version: number;
    token: number;
}

/**
 * The host-backed rows that share an active draft's rendered run.
 *
 * A fresh diff can coalesce an exact draft with neighboring host rows. The run keeps those rows
 * in one outer segment for layout, while prefix and suffix stay outside the native textarea.
 */
export interface EditableDraftRun {
    readonly firstIndex: number;
    readonly indices: readonly number[];
    readonly runStartLine: number;
    readonly prefixLines: string[];
    readonly draftLines: string[];
    readonly suffixLines: string[];
    readonly prefixCompareLines: string[];
    readonly draftCompareLines: string[];
    readonly suffixCompareLines: string[];
    readonly rowCount: number;
    readonly maxLineLength: number;
    /** Frozen host segment that owns the current unposted positive row surplus. */
    readonly pendingGrowthTargetIndex: number | null;
    /** The rendered host segments the run covers, in document order. */
    readonly items: readonly RenderedSegment[];
    /** Every row the run puts on screen, in order: host prefix, then the draft, then host suffix. */
    readonly displayLines: string[];
    /** The opposite pane's line for each display row, for word-level marking. */
    readonly displayCompareLines: string[];
}

/** Longest line in a block, in characters — the block's contribution to the shared extent. */
function longestLine(lines: readonly string[]): number {
    let max = 0;
    for (const line of lines) max = Math.max(max, line.length);
    return max;
}

/** Selects the state layout only when a draft change affects whole-view geometry. */
export function nextEditingBlockState(
    previous: EditableBlockLayout | null,
    next: EditableBlockLayout | null,
    baseMaxLineLength: number,
): EditableBlockLayout | null {
    return sameEffectiveEditableBlockLayout(previous, next, baseMaxLineLength) ? previous : next;
}

/** Replaces one line-addressed display block in the LF-normalized document text. */
export function replaceBlockLines(
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
export function paneStartLine(
    renderedSegments: readonly RenderedSegment[],
    index: number,
    side: DiffPane,
): number {
    return renderedSegments
        .slice(0, index)
        .reduce((total, previous) => total + previous.segment[side].length, 0);
}

/**
 * Finds an echoed draft in its next host document, preferring the closest repeated occurrence.
 *
 * The same line sequence can appear several times in a file, so the previous draft coordinate is
 * the tie-breaker. A missing sequence leaves the caller to retain its bounded old coordinate.
 */
function nearestPostedLineSequence(
    lines: readonly string[],
    postedLines: readonly string[],
    previousStartLine: number,
): number | null {
    let nearest: number | null = null;
    for (let start = 0; start + postedLines.length <= lines.length; start++) {
        let matches = true;
        for (let offset = 0; offset < postedLines.length; offset++) {
            if (lines[start + offset] !== postedLines[offset]) {
                matches = false;
                break;
            }
        }
        if (
            matches &&
            (nearest === null ||
                Math.abs(start - previousStartLine) < Math.abs(nearest - previousStartLine))
        ) {
            nearest = start;
        }
    }
    return nearest;
}

/**
 * Records rendered segments that contain an exact draft range without expanding that range.
 *
 * Empty drafts select a zero-line boundary hunk when one exists; otherwise they anchor to the
 * following row (or the previous final row) so an insertion control still has one outer segment.
 */
function segmentIndicesForDraftRange(
    renderedSegments: readonly RenderedSegment[],
    side: DiffPane,
    startLine: number,
    lineCount: number,
): number[] {
    const rangeEnd = startLine + lineCount;
    const indices: number[] = [];
    let cursor = 0;
    let followingIndex: number | undefined;
    let previousIndex: number | undefined;

    for (const item of renderedSegments) {
        const segmentLineCount = item.segment[side].length;
        const nextCursor = cursor + segmentLineCount;
        if (lineCount === 0) {
            if (segmentLineCount === 0 && cursor === startLine) {
                indices.push(item.index);
            } else if (
                segmentLineCount > 0 &&
                cursor === startLine &&
                followingIndex === undefined
            ) {
                followingIndex = item.index;
            }
            if (segmentLineCount > 0 && nextCursor === startLine) previousIndex = item.index;
        } else if (segmentLineCount === 0) {
            if (cursor >= startLine && cursor <= rangeEnd) indices.push(item.index);
        } else if (cursor < rangeEnd && startLine < nextCursor) {
            indices.push(item.index);
        }
        cursor = nextCursor;
    }

    if (lineCount > 0 || indices.length > 0) return indices;
    if (followingIndex !== undefined) return [followingIndex];
    return previousIndex === undefined ? [] : [previousIndex];
}

/**
 * Splits a coalesced active run into immutable host rows and the exact editable draft rows.
 *
 * The outer run still carries the combined geometry, while the native control is positioned only
 * over `draftLines`; host prefix/suffix lines retain their syntax-painted CodeBlock rendering.
 */
function editableDraftRun(
    draft: EditableBlockDraft,
    renderedSegments: readonly RenderedSegment[],
    side: DiffPane,
): EditableDraftRun {
    const activeIndices = new Set(draft.indices);
    const items = renderedSegments.filter(({ index }) => activeIndices.has(index));
    const firstIndex = draft.indices[0] ?? 0;
    const runStartLine =
        items.length === 0
            ? draft.startLine
            : paneStartLine(renderedSegments, items[0].index, side);
    const runLines = items.flatMap((item) => item.segment[side]);
    const alignedRunCompareLines = items.flatMap((item) => item.alignedCompareLines[side]);
    const prefixEnd = Math.min(Math.max(draft.startLine - runStartLine, 0), runLines.length);
    const suffixStart = Math.min(Math.max(prefixEnd + draft.lineCount, prefixEnd), runLines.length);
    const prefixLines = runLines.slice(0, prefixEnd);
    const draftLines = draft.text.split("\n");
    const suffixLines = runLines.slice(suffixStart);
    const displayLines = [...prefixLines, ...draftLines, ...suffixLines];
    // The compare lines the host aligned to the rows the draft replaces. A draft that has grown
    // has rows past the end of that slice, and they have nothing to be compared against yet.
    const replacedCompareLines = alignedRunCompareLines.slice(prefixEnd, suffixStart);

    return {
        items,
        displayLines,
        displayCompareLines: [
            ...alignedRunCompareLines.slice(0, prefixEnd),
            ...draftLines.map((_line, offset) => replacedCompareLines[offset] ?? ""),
            ...alignedRunCompareLines.slice(suffixStart),
        ],
        firstIndex,
        indices: draft.indices,
        runStartLine,
        prefixLines,
        draftLines,
        suffixLines,
        prefixCompareLines: alignedRunCompareLines.slice(0, prefixEnd),
        draftCompareLines: alignedRunCompareLines.slice(prefixEnd, suffixStart),
        suffixCompareLines: alignedRunCompareLines.slice(suffixStart),
        rowCount: displayLines.length,
        maxLineLength: longestLine(displayLines),
        pendingGrowthTargetIndex: draft.pendingGrowthTargetIndex,
    };
}

/** Counts draft rows that the active host run has not echoed yet. */
function pendingGrowthRows(run: EditableDraftRun, side: DiffPane): number {
    let hostRows = 0;
    for (const item of run.items) hostRows += item.paneLines[side];
    return Math.max(run.rowCount - hostRows, 0);
}

/** One active host segment and its zero-based row span inside the editable run. */
interface PendingGrowthRowTarget {
    readonly index: number;
    readonly startRow: number;
    readonly rowCount: number;
}

/**
 * Resolves one run-relative host row to an active segment.
 *
 * A zero-row segment at an exact boundary is the explicit insertion target; otherwise the
 * containing non-empty segment owns the row. Returning the first active item is the bounded
 * fallback when the coordinate sits outside the echoed host run.
 */
function pendingGrowthTargetAtRunRow(
    run: EditableDraftRun,
    side: DiffPane,
    runRow: number,
): PendingGrowthRowTarget | null {
    let cursor = 0;
    let first: PendingGrowthRowTarget | null = null;
    let containing: PendingGrowthRowTarget | null = null;

    for (const item of run.items) {
        const rowCount = item.paneLines[side];
        const target = { index: item.index, startRow: cursor, rowCount };
        first ??= target;
        if (rowCount === 0 && cursor === runRow) return target;
        if (rowCount > 0 && cursor <= runRow && runRow < cursor + rowCount) {
            containing ??= target;
        }
        cursor += rowCount;
    }

    return containing ?? first;
}

/**
 * Freezes the first positive growth at a stable document row inside its resolved host segment.
 *
 * The pre-growth coordinate selects the segment. Clamping the live caret row into that segment
 * preserves the insertion boundary when the original host exposed only one broad common segment,
 * while an already echoed insertion anchors to its own existing row.
 */
function pendingGrowthAnchorAtCaret(
    run: EditableDraftRun,
    side: DiffPane,
    draftText: string,
    caretOffset: number,
    surplusRows: number,
): number {
    let draftRow = 0;
    const boundedCaret = Math.min(Math.max(caretOffset, 0), draftText.length);
    for (let offset = 0; offset < boundedCaret; offset++) {
        if (draftText.charCodeAt(offset) === 10) draftRow++;
    }
    const caretRunRow = run.prefixLines.length + draftRow;
    const target = pendingGrowthTargetAtRunRow(run, side, Math.max(caretRunRow - surplusRows, 0));
    if (target === null) return run.runStartLine + Math.max(caretRunRow - surplusRows, 0);
    const anchorRunRow =
        target.rowCount === 0
            ? target.startRow
            : Math.min(
                  Math.max(caretRunRow, target.startRow),
                  target.startRow + target.rowCount - 1,
              );
    return run.runStartLine + anchorRunRow;
}

/** Remaps a frozen document-row anchor to the current host segmentation of the active run. */
function pendingGrowthTargetAtAnchor(
    run: EditableDraftRun,
    side: DiffPane,
    anchorLine: number,
): number | null {
    return (
        pendingGrowthTargetAtRunRow(run, side, anchorLine - run.runStartLine)?.index ??
        run.indices[0] ??
        null
    );
}

/** Re-finds an exact draft range after its own edit changes the host diff segmentation. */
function reanchorDraft(
    draft: EditableBlockDraft,
    renderedSegments: readonly RenderedSegment[],
    side: DiffPane,
    text: string,
    lastPostedText: string,
): EditableBlockDraft {
    const textLines = splitEditedText(text);
    const postedLines = splitEditedText(lastPostedText);
    const fallbackStart = Math.min(
        Math.max(draft.startLine, 0),
        Math.max(textLines.length - postedLines.length, 0),
    );
    const nextStartLine =
        postedLines.length === 0
            ? Math.min(Math.max(draft.startLine, 0), textLines.length)
            : (nearestPostedLineSequence(textLines, postedLines, draft.startLine) ?? fallbackStart);
    const nextLineCount = postedLines.length;
    const indices = segmentIndicesForDraftRange(
        renderedSegments,
        side,
        nextStartLine,
        nextLineCount,
    );

    return { ...draft, indices, startLine: nextStartLine, lineCount: nextLineCount };
}

/** The whole-view geometry one active run contributes, in the shape the app keeps in state. */
function draftLayoutOf(run: EditableDraftRun, side: DiffPane): EditableBlockLayout {
    return {
        side,
        indices: run.indices,
        rowCount: run.rowCount,
        pendingGrowthTargetIndex: run.pendingGrowthTargetIndex,
        maxLineLength: run.maxLineLength,
    };
}

/**
 * Spreads an open draft's rows back across the host segments its run covers.
 *
 * Every segment keeps its own host rows for as long as the draft has rows to pay for them, so the
 * canonical table stays the one the host's segmentation produced -- and the READ-ONLY pane, which
 * maps its own offset through that table, keeps standing beside the lines it is meant to. Only
 * the difference the draft has not posted yet has to land somewhere. It stays on the host segment
 * resolved from the caret when that positive surplus first appeared.
 */
export function editableRunRows(
    editingBlock: EditableBlockLayout,
    renderedSegments: readonly RenderedSegment[],
): Map<number, number> {
    const rows = new Map<number, number>();
    let remaining = editingBlock.rowCount;
    for (const index of editingBlock.indices) {
        const own = Math.min(
            renderedSegments[index]?.paneLines[editingBlock.side] ?? 0,
            Math.max(remaining, 0),
        );
        rows.set(index, own);
        remaining -= own;
    }
    const first = editingBlock.indices[0];
    const target =
        editingBlock.pendingGrowthTargetIndex !== null &&
        editingBlock.indices.includes(editingBlock.pendingGrowthTargetIndex)
            ? editingBlock.pendingGrowthTargetIndex
            : first;
    if (remaining > 0 && target !== undefined) {
        rows.set(target, (rows.get(target) ?? 0) + remaining);
    }
    return rows;
}

/** One host segment's share of an open draft's rows, ready to render. */
export interface EditableRunBlock {
    readonly className: string;
    readonly lines: string[];
    readonly compareLines: string[];
    /** One-based source line of this block's first row, on the edited pane. */
    readonly startLine: number;
}

/**
 * Cuts an open draft's rows back along the host's own segment boundaries.
 *
 * The rows are the draft's, because the reader owns them for the whole debounce window and must
 * keep seeing what they typed. The paint and the row counts are the host's, through the same
 * distribution the whole-view layout measures with -- so a line the host still calls common is
 * never washed as changed merely because an open draft happens to sit over it, and paint cannot
 * drift from geometry.
 */
export function editableRunBlocks(
    run: EditableDraftRun,
    side: DiffPane,
    renderedSegments: readonly RenderedSegment[],
): EditableRunBlock[] {
    const rows = editableRunRows(draftLayoutOf(run, side), renderedSegments);
    const blocks: EditableRunBlock[] = [];
    let offset = 0;
    for (const item of run.items) {
        const count = rows.get(item.index) ?? 0;
        blocks.push({
            className: segmentClassName(item.segment, side),
            lines: run.displayLines.slice(offset, offset + count),
            compareLines: run.displayCompareLines.slice(offset, offset + count),
            startLine: run.runStartLine + offset + 1,
        });
        offset += count;
    }
    return blocks;
}

/** Substitutes the edited pane's row count for one segment the open draft has taken over. */
export function editedPaneLines(
    paneLines: Record<DiffPane, number>,
    index: number,
    editingBlock: EditableBlockLayout | null,
    runRows: Map<number, number>,
): Record<DiffPane, number> {
    if (editingBlock === null || !editingBlock.indices.includes(index)) return paneLines;
    return { ...paneLines, [editingBlock.side]: runRows.get(index) ?? 0 };
}

/** What the pane needs from its editing session in order to render it. */
export interface EditableDraftSession {
    readonly draft: EditableBlockDraft | null;
    readonly activeRun: EditableDraftRun | null;
    readonly activeSegmentClassName: string | null;
    readonly focusTextarea: (textarea: HTMLTextAreaElement | null) => void;
    readonly startEditing: (item: EditableSegmentItem, caretOffset?: number) => void;
    readonly clearDraft: () => void;
    readonly commitDraft: () => void;
    readonly handleCompositionStart: () => void;
    readonly handleCompositionEnd: () => void;
    readonly handleDraftTextChange: (nextText: string, selectionStart: number) => void;
}

/**
 * Runs one pane's editing session.
 *
 * The composition and text-change handlers are here rather than inline in the JSX because both
 * read refs this hook owns -- `isComposingRef` in particular decides whether a keystroke may be
 * posted at all. Leaving them in the markup would mean handing those refs back out, which is the
 * seam that made the component look unsplittable in the first place.
 */
export function useEditableDraft({
    side,
    text,
    documentVersion,
    reseedToken,
    renderedSegments,
    onEdit,
    onDraftLayoutChange,
}: {
    side: DiffPane;
    text: string;
    documentVersion: number;
    reseedToken: number;
    renderedSegments: readonly RenderedSegment[];
    onEdit: (
        currentText: string,
        nextText: string,
        baseVersion: number,
        baseReseedToken: number,
    ) => void;
    onDraftLayoutChange: (layout: EditableBlockLayout | null) => void;
}): EditableDraftSession {
    const [draft, setDraft] = useState<EditableBlockDraft | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const seededSelectionSessionKeyRef = useRef<string | null>(null);
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
    /** Captures each mounted draft editor and restores focus without moving the diff viewport. */
    const focusTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
        textareaRef.current = textarea;
        textarea?.focus({ preventScroll: true });
    }, []);
    const activeRun = useMemo(
        () => (draft === null ? null : editableDraftRun(draft, renderedSegments, side)),
        [draft, renderedSegments, side],
    );

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
        // Not derived state, and not a handler in disguise: `reseedToken` changes because the
        // HOST replaced the document, which arrives as a postMessage, not as a user gesture
        // in this tree. There is no event handler to move this into. The parent is told
        // because the draft occupies pane width it owns, and only this effect knows the draft
        // just went away.
        // react-doctor-disable-next-line react-doctor/no-derived-state
        // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
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
    const editingSessionKey = draft?.editSessionKey;
    const editingSelectionStart = draft?.selectionStart;
    const editingSelectionEnd = draft?.selectionEnd;
    useEffect(() => {
        if (
            editingDraftIndex === undefined ||
            editingSessionKey === undefined ||
            editingSelectionStart === undefined ||
            editingSelectionEnd === undefined
        ) {
            return;
        }
        const textarea = textareaRef.current;
        if (textarea === null) return;
        if (seededSelectionSessionKeyRef.current !== editingSessionKey) {
            seededSelectionSessionKeyRef.current = editingSessionKey;
            textarea.setSelectionRange(editingSelectionStart, editingSelectionEnd);
        }

        // A block can be opened while the panes are already scrolled sideways. The overlay is
        // born at scroll 0 and only a scroll event would align it, so align this one directly --
        // otherwise the first caret of the session lands on the wrong column and stays there
        // until something happens to scroll. Directly, and not through `onHorizontalScroll`:
        // that driver coalesces into a frame, and a frame pending on nothing but this would
        // swallow the next real scroll to arrive before it.
        // Any row block in the run will do: every `.code-lines` in the view is held at one shared
        // horizontal position, and a settled run is drawn as its host segments with no single
        // draft block to name.
        const codeLines = textarea.parentElement?.querySelector<HTMLElement>(".code-lines");
        if (codeLines) alignScrollOverlays([textarea], codeLines.scrollLeft);
    }, [editingDraftIndex, editingSelectionEnd, editingSelectionStart, editingSessionKey]);

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
        }, 500);
    }, [clearDebounceTimer, onEdit, reseedToken]);

    useEffect(() => {
        if (draft === null || draft.token !== reseedToken || draft.version === documentVersion)
            return;
        const lastPostedText = lastPostedTextRef.current ?? draft.text;
        const reanchoredDraft = reanchorDraft(
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
        const reanchoredRun = editableDraftRun(reanchoredDraft, renderedSegments, side);
        const stillGrowing = pendingGrowthRows(reanchoredRun, side) > 0;
        const pendingGrowthAnchorLine = stillGrowing
            ? reanchoredDraft.pendingGrowthAnchorLine
            : null;
        const nextDraft = {
            ...reanchoredDraft,
            pendingGrowthAnchorLine,
            pendingGrowthTargetIndex:
                pendingGrowthAnchorLine === null
                    ? null
                    : pendingGrowthTargetAtAnchor(reanchoredRun, side, pendingGrowthAnchorLine),
        };
        editingIndexRef.current = nextDraft.indices[0];
        // The re-anchor cannot be computed during render: it needs the PREVIOUS draft and the
        // newly arrived host segments together, and it is what decides the draft's identity
        // going forward. Deriving it would mean recomputing an edit session from text that
        // has already moved under it.
        // react-doctor-disable-next-line react-doctor/no-derived-state
        setDraft(nextDraft);
        const nextRun = editableDraftRun(nextDraft, renderedSegments, side);
        // The parent sizes its columns from the draft's measured run, which only exists once
        // the draft has been re-anchored against the echo above. Lifting the draft into the
        // parent would put an edit session's per-keystroke state one level up from the pane
        // that owns it; a Provider would do the same with more indirection.
        // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
        // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent
        // react-doctor-disable-next-line react-doctor/no-prop-callback-in-effect
        onDraftLayoutChange(draftLayoutOf(nextRun, side));
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
                pendingGrowthAnchorLine: null,
                pendingGrowthTargetIndex: null,
                version: documentVersionRef.current,
                token: reseedTokenRef.current,
            };
            setDraft(nextDraft);
            const nextRun = editableDraftRun(nextDraft, currentRenderedSegments, side);
            onDraftLayoutChange(draftLayoutOf(nextRun, side));
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

    const draftIndices = draft?.indices;
    const activeSegmentClassName = useMemo(() => {
        if (draftIndices === undefined) return null;
        const activeIndices = new Set(draftIndices);
        // A host echo can split one active range into common and changed segments. Prefer the
        // changed representative, while keeping this scan off the ordinary keystroke path.
        const representative =
            renderedSegments.find(
                ({ index, segment }) => activeIndices.has(index) && segment.type === "changed",
            ) ?? renderedSegments.find(({ index }) => activeIndices.has(index));
        return representative === undefined ? null : segmentClassName(representative.segment, side);
    }, [draftIndices, renderedSegments, side]);

    const handleCompositionStart = useCallback(() => {
        isComposingRef.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
        isComposingRef.current = false;
        if (reseedDuringCompositionRef.current) {
            reseedDuringCompositionRef.current = false;
            clearDraft();
            return;
        }
        restartDebouncedPost();
    }, [clearDraft, restartDebouncedPost]);

    const handleDraftTextChange = useCallback(
        (nextText: string, selectionStart: number) => {
            if (draft === null) return;
            const textDraft = { ...draft, text: nextText };
            const textRun = editableDraftRun(textDraft, renderedSegments, side);
            const surplusRows = pendingGrowthRows(textRun, side);
            const pendingGrowthAnchorLine =
                surplusRows === 0
                    ? null
                    : (draft.pendingGrowthAnchorLine ??
                      pendingGrowthAnchorAtCaret(
                          textRun,
                          side,
                          nextText,
                          selectionStart,
                          surplusRows,
                      ));
            const pendingGrowthTargetIndex =
                pendingGrowthAnchorLine === null
                    ? null
                    : pendingGrowthTargetAtAnchor(textRun, side, pendingGrowthAnchorLine);
            const nextDraft = {
                ...textDraft,
                pendingGrowthAnchorLine,
                pendingGrowthTargetIndex,
            };
            setDraft(nextDraft);
            onDraftLayoutChange(draftLayoutOf({ ...textRun, pendingGrowthTargetIndex }, side));
            restartDebouncedPost();
        },
        [draft, onDraftLayoutChange, renderedSegments, restartDebouncedPost, side],
    );

    return {
        draft,
        activeRun,
        activeSegmentClassName,
        focusTextarea,
        startEditing,
        clearDraft,
        commitDraft,
        handleCompositionStart,
        handleCompositionEnd,
        handleDraftTextChange,
    };
}
