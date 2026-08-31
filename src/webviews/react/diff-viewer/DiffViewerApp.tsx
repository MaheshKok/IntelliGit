// Entry point for the read-only two-pane diff viewer.

import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DiffSegment } from "../../protocol/diffViewerTypes";
import { t } from "../shared/i18n";
import { SyntaxHighlightProvider } from "../diff-core/syntaxHighlightContext";
import { LINE_HEIGHT_PX, scrollRangePx } from "../diff-core/mergeScrollLayout";
import { buildLineNumberValues } from "../diff-core/lineNumbers";
import { CodeBlock, intrinsicSizeStyle, type LineNumberSpec } from "../diff-core/segments";
import {
    IconChevronDown,
    IconChevronUp,
    IconEye,
    IconFilter,
    IconLock,
} from "../merge-editor/icons";
import { segmentClassName, type DiffPane, type SegmentMarker } from "./segmentMarkers";
import type { EditableBlockLayout } from "./editableDraftLayout";
import type { RenderedSegment } from "./renderedDiffSegments";
import { EditableSegmentBlock } from "./EditableSegmentBlock";
import { useDiffOverlayPainter } from "./diffOverlayPainter";
import { useDiffViewerHost, useRevertHunk } from "./diffViewerHost";
import { isReadOnlyPane, useDiffKeyboardNav, useReadOnlyNotice } from "./diffViewerInput";
import { LINE_PADDING_PX, useDiffViewerScroll } from "./diffViewerScroll";
import { useDiffViewerModel, type PaneEditor } from "./diffViewerModel";
import { editableRunBlocks, useEditableDraft } from "./editableDraftSession";
import "./diff-viewer.css";

/** Renders one read-only side of one aligned diff segment. */
const DiffPaneBlock = React.memo(function DiffPaneBlock({
    segment,
    side,
    compareLines,
    lineCount,
    lineNumbers,
    highlightWords,
}: {
    segment: DiffSegment;
    side: DiffPane;
    compareLines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    highlightWords: boolean;
}): React.ReactElement {
    const lines = segment[side];

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
    const lineNumberSide = side === "left" ? "right" : "left";
    const {
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
    } = useEditableDraft({
        side,
        text,
        documentVersion,
        reseedToken,
        renderedSegments,
        onEdit,
        onDraftLayoutChange,
    });

    return (
        <>
            {renderedSegments.map((item) => {
                const isEditing = activeRun !== null && activeRun.indices.includes(item.index);

                if (isEditing && draft && activeRun) {
                    if (activeRun.firstIndex !== item.index) return null;
                    // A draft that spans several host segments is drawn as those segments. One
                    // representative class stretched over the whole run washes every untouched
                    // line in it -- which, for the first click into a file with no local edits
                    // yet, is the entire file.
                    const splitRun = activeRun.indices.length > 1;
                    const runBlocks = splitRun
                        ? editableRunBlocks(activeRun, side, renderedSegments)
                        : [];
                    return (
                        <div
                            key={draft.editSessionKey}
                            className={`segment diff-editing-block editing ${splitRun ? "" : (activeSegmentClassName ?? segmentClassName(item.segment, side))} line-numbers-${lineNumberSide}`}
                            style={intrinsicSizeStyle(activeRun.rowCount)}
                        >
                            {splitRun ? (
                                // The edit-session wrapper owns this list's lifetime. Host segment
                                // identities are allowed to churn on every echo, so position is the
                                // stable identity here; inactive segments keep their host keys.
                                runBlocks.map((runBlock, runBlockIndex) => (
                                    <div
                                        // react-doctor-disable-next-line react-doctor/no-array-index-key
                                        key={runBlockIndex}
                                        className={`diff-editable-block diff-editing-static ${runBlock.className}`}
                                    >
                                        <CodeBlock
                                            lines={runBlock.lines}
                                            lineCount={runBlock.lines.length}
                                            lineNumbers={{
                                                primary: buildLineNumberValues(
                                                    runBlock.startLine,
                                                    runBlock.lines.length,
                                                    runBlock.lines.length,
                                                ),
                                            }}
                                            lineNumberSide={lineNumberSide}
                                            wordHighlight={highlightWords}
                                            compareLines={runBlock.compareLines}
                                        />
                                    </div>
                                ))
                            ) : (
                                <>
                                    {activeRun.prefixLines.length > 0 ? (
                                        <div
                                            key="static-prefix"
                                            className="diff-editable-block diff-editing-static"
                                        >
                                            <CodeBlock
                                                lines={activeRun.prefixLines}
                                                lineCount={activeRun.prefixLines.length}
                                                lineNumbers={{
                                                    primary: buildLineNumberValues(
                                                        activeRun.runStartLine + 1,
                                                        activeRun.prefixLines.length,
                                                        activeRun.prefixLines.length,
                                                    ),
                                                }}
                                                lineNumberSide={lineNumberSide}
                                                wordHighlight={highlightWords}
                                                compareLines={activeRun.prefixCompareLines}
                                            />
                                        </div>
                                    ) : null}
                                    <div key="draft" className="diff-editing-draft">
                                        <CodeBlock
                                            lines={activeRun.draftLines}
                                            lineCount={activeRun.draftLines.length}
                                            lineNumbers={{
                                                primary: buildLineNumberValues(
                                                    draft.startLine + 1,
                                                    activeRun.draftLines.length,
                                                    activeRun.draftLines.length,
                                                ),
                                            }}
                                            lineNumberSide={lineNumberSide}
                                            wordHighlight={highlightWords}
                                            compareLines={activeRun.draftCompareLines}
                                        />
                                    </div>
                                    {activeRun.suffixLines.length > 0 ? (
                                        <div
                                            key="static-suffix"
                                            className="diff-editable-block diff-editing-static"
                                        >
                                            <CodeBlock
                                                lines={activeRun.suffixLines}
                                                lineCount={activeRun.suffixLines.length}
                                                lineNumbers={{
                                                    primary: buildLineNumberValues(
                                                        draft.startLine +
                                                            activeRun.draftLines.length +
                                                            1,
                                                        activeRun.suffixLines.length,
                                                        activeRun.suffixLines.length,
                                                    ),
                                                }}
                                                lineNumberSide={lineNumberSide}
                                                wordHighlight={highlightWords}
                                                compareLines={activeRun.suffixCompareLines}
                                            />
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <textarea
                                key="textarea"
                                ref={focusTextarea}
                                className="diff-edit-textarea"
                                data-testid={`diff-pane-${side}-editable`}
                                aria-label={t("diff.editable.editingAria")}
                                value={draft.text}
                                rows={activeRun.draftLines.length}
                                style={{
                                    top: activeRun.prefixLines.length * LINE_HEIGHT_PX,
                                    bottom: activeRun.suffixLines.length * LINE_HEIGHT_PX,
                                }}
                                spellCheck={false}
                                onCompositionStart={handleCompositionStart}
                                onCompositionEnd={handleCompositionEnd}
                                onChange={(event) => {
                                    handleDraftTextChange(
                                        event.target.value,
                                        event.target.selectionStart,
                                    );
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
            {hunks.map((ribbonIndex) => (
                <button
                    key={`revert-${ribbonIndex}`}
                    ref={(element) => registerButton(ribbonIndex, element)}
                    type="button"
                    className="diff-hunk-revert"
                    data-testid={`diff-revert-${ribbonIndex}`}
                    title={t("diff.editable.revertHunk")}
                    aria-label={t("diff.editable.revertHunk")}
                    onClick={() => onRevert(ribbonIndex)}
                >
                    {editablePane === "right" ? "\u00bb" : "\u00ab"}
                </button>
            ))}
        </div>
    );
}

/**
 * One side of the diff: the editing surface when this pane owns the document, read-only blocks
 * otherwise.
 *
 * Both sides render this. They were two copies of the same 39 lines differing only in the word
 * `left`/`right`, down to the `key` prefix and the test id -- which is the shape where one side
 * quietly stops matching the other.
 */
function DiffPaneColumn({
    side,
    editor,
    reseedToken,
    renderedSegments,
    highlightWords,
    columnRefs,
    onEdit,
    onDraftLayoutChange,
    onHorizontalScroll,
}: {
    side: DiffPane;
    editor: PaneEditor | null;
    reseedToken: number;
    renderedSegments: readonly RenderedSegment[];
    highlightWords: boolean;
    columnRefs: React.MutableRefObject<Record<DiffPane, HTMLDivElement | null>>;
    onEdit: (
        currentText: string,
        nextText: string,
        baseVersion: number,
        baseReseedToken: number,
    ) => void;
    onDraftLayoutChange: (layout: EditableBlockLayout | null) => void;
    onHorizontalScroll: (left: number, source?: HTMLElement | null) => void;
}): React.ReactElement {
    return (
        <div
            ref={(element) => {
                columnRefs.current[side] = element;
            }}
            className={`diff-pane diff-pane-${side}`}
            data-testid={`diff-pane-${side}`}
            contentEditable={!editor}
            suppressContentEditableWarning
            spellCheck={false}
            aria-readonly={!editor}
        >
            {editor ? (
                <EditableDiffPane
                    side={side}
                    text={editor.text}
                    documentVersion={editor.version}
                    reseedToken={reseedToken}
                    renderedSegments={renderedSegments}
                    highlightWords={highlightWords}
                    onEdit={onEdit}
                    onDraftLayoutChange={onDraftLayoutChange}
                    onHorizontalScroll={onHorizontalScroll}
                />
            ) : (
                renderedSegments.map((item) => (
                    <DiffPaneBlock
                        key={`${side}-${item.renderKey}`}
                        segment={item.segment}
                        side={side}
                        compareLines={item.alignedCompareLines[side]}
                        lineCount={item.paneLines[side]}
                        lineNumbers={item.lineNumbers[side]}
                        highlightWords={highlightWords}
                    />
                ))
            )}
        </div>
    );
}

/** Change-to-change navigation, the whitespace mode, and the word-highlight toggle. */
function DiffViewerToolbar({
    hasChanges,
    ignoreMode,
    highlightWords,
    onJump,
    onIgnoreMode,
    onToggleHighlightWords,
}: {
    hasChanges: boolean;
    ignoreMode: "none" | "whitespace";
    highlightWords: boolean;
    onJump: (direction: 1 | -1) => void;
    onIgnoreMode: () => void;
    onToggleHighlightWords: () => void;
}): React.ReactElement {
    return (
        <div className="diff-toolbar">
            <div className="toolbar-left">
                <div className="toolbar-nav-group">
                    <button
                        type="button"
                        className="toolbar-icon-btn"
                        data-testid="diff-prev-change"
                        onClick={() => onJump(-1)}
                        title={t("diff.toolbar.prevChange.title")}
                        aria-label={t("diff.toolbar.prevChange.label")}
                        disabled={!hasChanges}
                    >
                        <IconChevronUp />
                    </button>
                    <button
                        type="button"
                        className="toolbar-icon-btn"
                        data-testid="diff-next-change"
                        onClick={() => onJump(1)}
                        title={t("diff.toolbar.nextChange.title")}
                        aria-label={t("diff.toolbar.nextChange.label")}
                        disabled={!hasChanges}
                    >
                        <IconChevronDown />
                    </button>
                </div>
                <div className="toolbar-separator" />
                <button
                    type="button"
                    className="toolbar-btn subtle dropdown"
                    onClick={onIgnoreMode}
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
                    onClick={onToggleHighlightWords}
                    aria-pressed={highlightWords}
                >
                    <span className="toolbar-icon">
                        <IconEye />
                    </span>
                    {t("merge.toolbar.highlightWords")}
                </button>
            </div>
        </div>
    );
}

/** Hosts a pure, read-only two-pane diff with only view toggles. */
export function App(): React.ReactElement {
    const { data, error, ignoreMode, handleIgnoreMode, handleEdit } = useDiffViewerHost();
    const [highlightWords, setHighlightWords] = useState(true);
    const {
        contentRef,
        viewportElementRef,
        columnRefs,
        layoutRef,
        viewportHeight,
        measureViewport,
        scheduleVerticalFrame,
        registerRibbonPath,
        registerActionButton,
    } = useDiffOverlayPainter(data?.editablePane);
    const {
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
    } = useDiffViewerModel(data, contentRef, layoutRef, viewportHeight);
    /** The positioning context the read-only notice is placed against. */
    const rootRef = useRef<HTMLDivElement | null>(null);

    const {
        horizontalScrollRef,
        horizontalScrollInnerRef,
        syncHorizontalScroll,
        handleScroll,
        handleHorizontalScroll,
    } = useDiffViewerScroll({
        data,
        layout,
        maxLineLength,
        revertablePane,
        contentRef,
        columnRefs,
        measureViewport,
        scheduleVerticalFrame,
    });

    const handleRevertHunk = useRevertHunk(data, renderedSegments, handleEdit);

    const readOnlyNotice = useReadOnlyNotice(data, rootRef, columnRefs);

    useDiffKeyboardNav(jumpToAdjacentChange);

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
                        <output className="diff-newline-marker">
                            {t("diff.newlineDifference")}
                        </output>
                    ) : null}
                </div>
                {/* Beside the caret rather than up in the header, because the refusal answers
                    something the reader just did with their hands at that spot -- a status
                    line one band away reads as belonging to the file, not to the keystroke. */}
                {readOnlyNotice ? (
                    <output
                        className="diff-readonly-notice"
                        style={{ left: `${readOnlyNotice.x}px`, top: `${readOnlyNotice.y}px` }}
                    >
                        {t("diff.readOnly.pane")}
                    </output>
                ) : null}
                <DiffViewerToolbar
                    hasChanges={stripeMarks.length > 0}
                    ignoreMode={ignoreMode}
                    highlightWords={highlightWords}
                    onJump={jumpToAdjacentChange}
                    onIgnoreMode={handleIgnoreMode}
                    onToggleHighlightWords={() => setHighlightWords((value) => !value)}
                />
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
                                    <DiffPaneColumn
                                        side="left"
                                        editor={leftEditor}
                                        reseedToken={data.editableReseedToken ?? 0}
                                        renderedSegments={renderedSegments}
                                        highlightWords={highlightWords}
                                        columnRefs={columnRefs}
                                        onEdit={handleEdit}
                                        onDraftLayoutChange={handleDraftLayoutChange}
                                        onHorizontalScroll={syncHorizontalScroll}
                                    />
                                )}
                                {singlePane === "left" ? null : (
                                    <DiffPaneColumn
                                        side="right"
                                        editor={rightEditor}
                                        reseedToken={data.editableReseedToken ?? 0}
                                        renderedSegments={renderedSegments}
                                        highlightWords={highlightWords}
                                        columnRefs={columnRefs}
                                        onEdit={handleEdit}
                                        onDraftLayoutChange={handleDraftLayoutChange}
                                        onHorizontalScroll={syncHorizontalScroll}
                                    />
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
                            // A redundant pointer shortcut, not a control: the stripe above is
                            // `aria-hidden`, and jumping between changes is already keyboard-
                            // reachable app-wide through Alt+Arrow and the toolbar arrows, which
                            // share `jumpToAdjacentChange` with this handler. Promoting each mark
                            // to a button would instead bolt one tab stop per changed segment onto
                            // a scrollbar minimap -- more keyboard work to cross, for a path the
                            // keyboard already has.
                            // react-doctor-disable-next-line react-doctor/click-events-have-key-events
                            // react-doctor-disable-next-line react-doctor/no-static-element-interactions
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
// This is the entry module, so the handle cannot live anywhere else, and there is no Fast
// Refresh in this build to protect (esbuild, no react-refresh transform).
// react-doctor-disable-next-line react-doctor/only-export-components
export const root = container ? createRoot(container) : null;
root?.render(<App />);
