// Everything `App` derives from one diff payload before it renders anything: the segments, the
// vertical layout built from them, the change stripe measured against it, and the handful of
// questions the render asks about editability.
//
// Split out of `App`, which was 777 lines even after the overlay painter left. This half is pure
// -- it reads the payload and two measured numbers and returns values -- so pulling it out is what
// leaves the component holding only the parts that talk to something.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffViewerData } from "../../protocol/diffViewerTypes";
import { detectTheme, initShiki, isShikiReady, langForPath } from "../diff-core/shikiHighlighter";
import {
    buildVerticalLayout,
    type DiffVerticalLayout,
    type SegmentPaneLines,
} from "../diff-core/mergeScrollLayout";
import { DIFF_PANES, segmentRibbonMarker, soleSidedPane, type DiffPane } from "./segmentMarkers";
import { adjacentChangeIndex, buildStripeMarks, type StripeMark } from "./changeStripe";
import type { SyntaxHighlightState } from "../diff-core/syntaxHighlightContext";
import {
    baseMaxLineLengthForSegments,
    effectiveMaxLineLength,
    type EditableBlockLayout,
} from "./editableDraftLayout";
import { editableRunRows, editedPaneLines, nextEditingBlockState } from "./editableDraftSession";
import {
    buildRenderedSegments,
    createRenderedSegmentCache,
    type RenderedSegment,
} from "./renderedDiffSegments";

/** The document a pane is editing, once both halves of it have actually arrived. */
export interface PaneEditor {
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
export function paneEditor(data: DiffViewerData, pane: DiffPane): PaneEditor | null {
    if (data.editablePane !== pane) return null;
    if (data.editableText === undefined || data.documentVersion === undefined) return null;
    return { text: data.editableText, version: data.documentVersion };
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
 * Everything `App` destructures out of one payload.
 *
 * Named rather than left to inference so the hook's surface is a declaration: fourteen members
 * inferred from a return literal are fourteen members nothing states, and a change to any of
 * them reads as an ordinary edit rather than as a change to what the component is handed.
 */
export interface DiffViewerModel {
    readonly renderedSegments: RenderedSegment[];
    readonly syntaxHighlightState: SyntaxHighlightState;
    readonly layout: DiffVerticalLayout<DiffPane>;
    readonly stripeMarks: StripeMark[];
    readonly jumpToSegment: (index: number) => void;
    /** Returns false when there was no change to move to, so the key handler can pass it on. */
    readonly jumpToAdjacentChange: (direction: 1 | -1) => boolean;
    readonly ribbonIndices: Array<{
        index: number;
        marker: ReturnType<typeof segmentRibbonMarker>;
    }>;
    readonly singlePane: DiffPane | null;
    readonly revertablePane: DiffPane | undefined;
    readonly leftEditor: PaneEditor | null;
    readonly rightEditor: PaneEditor | null;
    readonly actionHunks: number[];
    readonly maxLineLength: number;
    readonly handleDraftLayoutChange: (layout: EditableBlockLayout | null) => void;
}

/**
 * Derives one payload's whole render model.
 *
 * `contentRef` and `layoutRef` belong to `useDiffOverlayPainter` and are threaded through rather
 * than duplicated: the jumps write a scrollTop into the same box the painter measures, and the
 * painter's per-frame draw reads the layout this hook builds. Two copies of either would be two
 * answers to one question.
 */
export function useDiffViewerModel(
    data: DiffViewerData | null,
    contentRef: React.MutableRefObject<HTMLDivElement | null>,
    layoutRef: React.MutableRefObject<DiffVerticalLayout<DiffPane> | null>,
    viewportHeight: number,
): DiffViewerModel {
    const [editingBlock, setEditingBlock] = useState<EditableBlockLayout | null>(null);
    const latestEditingBlockRef = useRef<EditableBlockLayout | null>(null);
    const baseMaxLineLengthRef = useRef(1);
    const [shikiReady, setShikiReady] = useState(() => isShikiReady());
    const [shikiTheme] = useState(() => detectTheme());

    const renderedSegmentCache = useMemo(() => createRenderedSegmentCache(), []);

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

    const paneLines = useMemo<SegmentPaneLines<DiffPane>[]>(() => {
        const runRows =
            editingBlock === null
                ? new Map<number, number>()
                : editableRunRows(editingBlock, renderedSegments);
        return renderedSegments.map((item) => ({
            paneLines: editedPaneLines(item.paneLines, item.index, editingBlock, runRows),
            conflict: item.segment.type === "changed",
            id: item.segment.type === "changed" ? item.index : undefined,
        }));
    }, [editingBlock, renderedSegments]);
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
        [contentRef, layout],
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
        [contentRef, jumpToSegment, layout, stripeMarks],
    );
    layoutRef.current = layout;
    const ribbonIndices = useMemo(() => {
        const ribbons: Array<{ index: number; marker: ReturnType<typeof segmentRibbonMarker> }> =
            [];
        for (const item of renderedSegments) {
            if (item.segment.type !== "changed") continue;
            ribbons.push({ index: item.index, marker: segmentRibbonMarker(item.segment) });
        }
        return ribbons;
    }, [renderedSegments]);

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
        () => (singlePane === null ? ribbonIndices.map((ribbon) => ribbon.index) : []),
        [ribbonIndices, singlePane],
    );

    // An open draft is part of the pane's width even though it is not part of the diff. The ref
    // keeps this O(1) on ordinary input and preserves a draft width when a later host echo lowers
    // the base extent.
    const maxLineLength = effectiveMaxLineLength(baseMaxLineLength, latestEditingBlockRef.current);

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

    return {
        renderedSegments,
        syntaxHighlightState,
        layout,
        stripeMarks,
        jumpToSegment,
        jumpToAdjacentChange,
        ribbonIndices,
        singlePane,
        revertablePane,
        leftEditor,
        rightEditor,
        actionHunks,
        maxLineLength,
        handleDraftLayoutChange,
    };
}
