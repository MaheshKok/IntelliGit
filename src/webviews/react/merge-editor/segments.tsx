// Merge-only conflict rendering components.
// Generic code-line rendering, syntax highlighting, line numbers, and common
// segment shells live in diff-core; resolution controls stay in this module.

import React, { useCallback, useState } from "react";
import type { ConflictSegment, HunkResolution, HunkSideDismissal } from "./types";
import { getEffectiveResultLines, splitEditedText } from "./mergeState";
import { t } from "../shared/i18n";
import {
    CodeBlock,
    intrinsicSizeStyle,
    lineNumberSpecEqual,
    LineNumbers,
    type LineNumberSpec,
} from "../diff-core/segments";

/** Line-number specifications for the merge editor's three protocol panes. */
export interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
}

// --- Editable result block ---

/**
 * Result-pane block that supports IntelliJ-style manual editing.
 *
 * Display mode renders the highlighted result; double-click switches to a
 * textarea seeded with the current result text. Blur commits the draft through
 * `onCommit` (no-op when the text is unchanged), and Escape cancels without
 * committing. Committed edits mark the hunk resolved upstream.
 */
function EditableResultBlock({
    lines,
    lineCount,
    lineNumbers,
    className,
    wordHighlight,
    compareLines,
    onCommit,
}: {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
    onCommit: (lines: string[]) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const isEditing = draft !== null;

    const startEditing = useCallback(() => {
        setDraft(lines.join("\n"));
    }, [lines]);

    const commitDraft = useCallback(() => {
        if (draft === null) return;
        setDraft(null);
        const edited = splitEditedText(draft);
        const unchanged = edited.length === lines.length && edited.every((l, i) => l === lines[i]);
        if (!unchanged) onCommit(edited);
    }, [draft, lines, onCommit]);

    const cancelDraft = useCallback(() => {
        setDraft(null);
    }, []);

    if (!isEditing) {
        return (
            <div
                className="result-editable"
                onDoubleClick={startEditing}
                title={t("merge.result.editHint")}
            >
                <CodeBlock
                    lines={lines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    className={className}
                    wordHighlight={wordHighlight}
                    compareLines={compareLines}
                />
            </div>
        );
    }

    const rowCount = Math.max(draft.split("\n").length, lineCount, 1);
    return (
        <div className={`code-block ${className ?? ""} editing`}>
            <LineNumbers primary={lineNumbers.primary} />
            <textarea
                className="result-edit-textarea"
                aria-label={t("merge.result.editingAria")}
                value={draft}
                rows={rowCount}
                // Deliberate: edit mode opens from a user action and should focus the draft textarea.
                // react-doctor-disable-next-line react-doctor/no-autofocus
                autoFocus
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelDraft();
                    }
                }}
                onClick={(event) => event.stopPropagation()}
            />
        </div>
    );
}

/** Props shared by all merge conflict pane blocks. */
export interface ConflictPaneBaseProps {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    editedLines: string[] | undefined;
    dismissed: HunkSideDismissal | undefined;
    lineCount: number;
    lineNumbers: LineNumberSpec;
    onSelect: (id: number) => void;
    isActive: boolean;
    highlightWords: boolean;
}

/** Callbacks the ours/theirs blocks use to accept or discard their side. */
interface ConflictSideCallbacks {
    onResolve: (id: number, resolution: HunkResolution) => void;
    onDismiss: (id: number, side: "ours" | "theirs") => void;
}

/** Derived render flags for one conflict hunk: which sides are in the result,
 * which controls to show, and how the result/side panes compare against base. */
interface ConflictView {
    isEdited: boolean;
    isOurs: boolean;
    isTheirs: boolean;
    oursInResult: boolean;
    theirsInResult: boolean;
    oursDismissed: boolean;
    theirsDismissed: boolean;
    isAutoMerged: boolean;
    isResolved: boolean;
    resultIsUnresolved: boolean;
    /** One-sided hunk explicitly settled by the user: its result rows drop the variant fill. */
    resultSettled: boolean;
    showLeftActions: boolean;
    showRightActions: boolean;
    leftAppend: boolean;
    rightAppend: boolean;
    resultCompareLines: string[] | undefined;
    sideVariant: string;
}

/**
 * Determines the lines the result pane diffs against: nothing once a side is
 * accepted, otherwise the opposite side (single accept) or base (unresolved).
 */
function resultCompareBaseline(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    oursInResult: boolean,
    theirsInResult: boolean,
): string[] | undefined {
    if (oursInResult || theirsInResult) return undefined;
    if (resolution === "ours") return segment.theirsLines;
    if (resolution === "theirs") return segment.oursLines;
    return segment.baseLines;
}

/**
 * PyCharm-style color class for a one-sided hunk: pure insertions green,
 * deletions gray, modifications blue. True conflicts carry no variant class.
 */
function sideVariantClass(segment: ConflictSegment): string {
    if (segment.changeKind === "conflict") return "";
    if (segment.baseLines.length === 0) return "variant-insertion";
    const changedSideLines =
        segment.changeKind === "ours-only" ? segment.oursLines : segment.theirsLines;
    if (changedSideLines.length === 0) return "variant-deletion";
    return "variant-modification";
}

type ConflictResolutionState = Pick<
    ConflictView,
    "isOurs" | "isTheirs" | "oursInResult" | "theirsInResult" | "oursDismissed" | "theirsDismissed"
>;

/** Derives accepted and dismissed side state independently of segment-specific rendering metadata. */
function deriveResolutionState(
    resolution: HunkResolution | undefined,
    isEdited: boolean,
    dismissed: HunkSideDismissal | undefined,
): ConflictResolutionState {
    const isOurs = !isEdited && resolution === "ours";
    const isTheirs = !isEdited && resolution === "theirs";
    // Both orders stack the two sides; the order only differs in getResultLines.
    const isBoth = !isEdited && (resolution === "both" || resolution === "both-reversed");
    const oursInResult = isOurs || isBoth;
    const theirsInResult = isTheirs || isBoth;
    // A side is "dismissed" when the user discarded it (X) without accepting the
    // opposite side. Resolving to "none" discards BOTH sides (the reducer clears
    // per-side dismissals then), so it must read as dismissed too — otherwise the
    // settled blocks would keep their suggestion bands and controls. Acceptance
    // overrides dismissal, so a side in the result is never treated as
    // dismissed. A manual edit supersedes both.
    const bothDiscarded = !isEdited && resolution === "none";
    const oursDismissed = !isEdited && !oursInResult && (dismissed?.ours === true || bothDiscarded);
    const theirsDismissed =
        !isEdited && !theirsInResult && (dismissed?.theirs === true || bothDiscarded);

    return {
        isOurs,
        isTheirs,
        oursInResult,
        theirsInResult,
        oursDismissed,
        theirsDismissed,
    };
}

/**
 * Computes the render flags for a conflict hunk from its resolution, manual
 * edits, and per-side dismissals. Pure helper so ConflictSection stays a thin
 * view over these derived values.
 */
function deriveConflictView(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    editedLines: string[] | undefined,
    dismissed: HunkSideDismissal | undefined,
): ConflictView {
    const isEdited = editedLines !== undefined;
    const { isOurs, isTheirs, oursInResult, theirsInResult, oursDismissed, theirsDismissed } =
        deriveResolutionState(resolution, isEdited, dismissed);
    const isAutoMerged =
        segment.autoResolvedLines !== undefined && resolution === undefined && !isEdited;
    const isResolved =
        segment.changeKind !== "conflict" ||
        segment.autoResolvedLines !== undefined ||
        resolution !== undefined ||
        isEdited;
    const resultIsUnresolved =
        segment.changeKind === "conflict" &&
        !isEdited &&
        ((isOurs && !theirsDismissed) || (isTheirs && !oursDismissed));
    // A one-sided hunk is auto-included in the result the moment it loads
    // (isResolved is unconditionally true for changeKind !== "conflict"), but
    // it only counts as the user's DECISION once a resolution is actually set
    // — an explicit accept/discard, not the initial auto-include. Only then
    // does PyCharm drop the variant wash and show the result as plain merged
    // text under its dotted contour.
    const resultSettled =
        segment.changeKind !== "conflict" && resolution !== undefined && !isEdited;
    return {
        isEdited,
        isOurs,
        isTheirs,
        oursInResult,
        theirsInResult,
        oursDismissed,
        theirsDismissed,
        isAutoMerged,
        isResolved,
        resultIsUnresolved,
        resultSettled,
        // A side's controls show only while that side is still pending: not yet
        // in the result and not discarded. Accepting one side leaves the other
        // side's accept button available to append (stack) below it; discarding
        // the other side hides its controls. Once both are stacked, all controls
        // hide. A manual edit puts neither side "in result", so both reappear.
        showLeftActions: !oursInResult && !oursDismissed,
        showRightActions: !theirsInResult && !theirsDismissed,
        // When one side is already in the result, the opposite accept button
        // appends the second side below it instead of replacing the result.
        leftAppend: theirsInResult,
        rightAppend: oursInResult,
        resultCompareLines: resultCompareBaseline(
            segment,
            resolution,
            oursInResult,
            theirsInResult,
        ),
        sideVariant: sideVariantClass(segment),
    };
}

/** Left-column controls for a pending "ours" side: discard and accept-or-append. */
function LeftHunkActions({
    segmentId,
    leftAppend,
    isOurs,
    theirsDismissed,
    onResolve,
    onDismiss,
}: {
    segmentId: number;
    leftAppend: boolean;
    isOurs: boolean;
    theirsDismissed: boolean;
    onResolve: (id: number, resolution: HunkResolution) => void;
    onDismiss: (id: number, side: "ours" | "theirs") => void;
}) {
    return (
        <div className="conflict-actions-left" onClick={(e) => e.stopPropagation()}>
            <button
                type="button"
                className="action-btn discard-btn"
                onClick={() =>
                    theirsDismissed ? onResolve(segmentId, "none") : onDismiss(segmentId, "ours")
                }
                title={t("merge.hunk.ignoreLeft")}
                aria-label={t("merge.hunk.ignoreLeft")}
            >
                <span className="hunk-action-glyph" aria-hidden="true">
                    ×
                </span>
            </button>
            <button
                type="button"
                className={`action-btn accept-btn ${leftAppend ? "append-btn" : ""} ${isOurs ? "active" : ""}`}
                onClick={() => onResolve(segmentId, leftAppend ? "both-reversed" : "ours")}
                title={t(leftAppend ? "merge.hunk.appendLeft" : "merge.hunk.acceptLeft")}
                aria-label={t(leftAppend ? "merge.hunk.appendLeft" : "merge.hunk.acceptLeft")}
                aria-current={isOurs ? "true" : undefined}
            >
                <span className="hunk-action-glyph" aria-hidden="true">
                    {leftAppend ? "≫+" : "≫"}
                </span>
            </button>
        </div>
    );
}

/** Right-column controls for a pending "theirs" side: accept-or-append and discard. */
function RightHunkActions({
    segmentId,
    rightAppend,
    isTheirs,
    oursDismissed,
    onResolve,
    onDismiss,
}: {
    segmentId: number;
    rightAppend: boolean;
    isTheirs: boolean;
    oursDismissed: boolean;
    onResolve: (id: number, resolution: HunkResolution) => void;
    onDismiss: (id: number, side: "ours" | "theirs") => void;
}) {
    return (
        <div className="conflict-actions-right" onClick={(e) => e.stopPropagation()}>
            <button
                type="button"
                className={`action-btn accept-btn ${rightAppend ? "append-btn" : ""} ${isTheirs ? "active" : ""}`}
                onClick={() => onResolve(segmentId, rightAppend ? "both" : "theirs")}
                title={t(rightAppend ? "merge.hunk.appendRight" : "merge.hunk.acceptRight")}
                aria-label={t(rightAppend ? "merge.hunk.appendRight" : "merge.hunk.acceptRight")}
                aria-current={isTheirs ? "true" : undefined}
            >
                <span className="hunk-action-glyph" aria-hidden="true">
                    {rightAppend ? "≪+" : "≪"}
                </span>
            </button>
            <button
                type="button"
                className="action-btn discard-btn"
                onClick={() =>
                    oursDismissed ? onResolve(segmentId, "none") : onDismiss(segmentId, "theirs")
                }
                title={t("merge.hunk.ignoreRight")}
                aria-label={t("merge.hunk.ignoreRight")}
            >
                <span className="hunk-action-glyph" aria-hidden="true">
                    ×
                </span>
            </button>
        </div>
    );
}

/**
 * Outer per-pane wrapper class list for a conflict block. The change-/variant-
 * classes must be an ancestor of the pane's code block for the band-color CSS to
 * apply, so every pane block replicates them.
 */
function conflictWrapperClass(
    segment: ConflictSegment,
    view: ConflictView,
    isActive: boolean,
): string {
    return [
        "segment",
        "segment-conflict",
        `change-${segment.changeKind}`,
        view.sideVariant,
        view.isResolved ? "resolved" : "unresolved",
        view.isAutoMerged ? "auto-merged" : "",
        isActive ? "active" : "",
    ]
        .filter(Boolean)
        .join(" ");
}

/** Value-compares the shared conflict-pane props used by the ours/theirs blocks. */
function sideConflictEqual(
    prev: ConflictPaneBaseProps & ConflictSideCallbacks,
    next: ConflictPaneBaseProps & ConflictSideCallbacks,
): boolean {
    return (
        prev.segment === next.segment &&
        prev.resolution === next.resolution &&
        prev.editedLines === next.editedLines &&
        prev.dismissed === next.dismissed &&
        prev.lineCount === next.lineCount &&
        prev.isActive === next.isActive &&
        prev.highlightWords === next.highlightWords &&
        prev.onResolve === next.onResolve &&
        prev.onDismiss === next.onDismiss &&
        prev.onSelect === next.onSelect &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers)
    );
}

/** Props for the middle (result) conflict block: manual edit callback + ordinals. */
export interface ResultConflictBlockProps extends ConflictPaneBaseProps {
    onEditResult: (id: number, lines: string[]) => void;
    conflictOrdinal: number;
    trueConflictOrdinal?: number;
}

/** Value-compares the result-pane props (edit callback + ordinals). */
function resultConflictEqual(
    prev: ResultConflictBlockProps,
    next: ResultConflictBlockProps,
): boolean {
    return (
        prev.segment === next.segment &&
        prev.resolution === next.resolution &&
        prev.editedLines === next.editedLines &&
        prev.dismissed === next.dismissed &&
        prev.lineCount === next.lineCount &&
        prev.isActive === next.isActive &&
        prev.highlightWords === next.highlightWords &&
        prev.onEditResult === next.onEditResult &&
        prev.onSelect === next.onSelect &&
        prev.conflictOrdinal === next.conflictOrdinal &&
        prev.trueConflictOrdinal === next.trueConflictOrdinal &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers)
    );
}

/**
 * Left (ours) pane block: the ours lines plus this side's accept/discard
 * controls. Selecting anywhere in the block activates the hunk. Memoized so a
 * resolution or edit elsewhere re-renders only the affected block.
 */
export const OursConflictBlock = React.memo(function OursConflictBlock({
    segment,
    resolution,
    editedLines,
    dismissed,
    lineCount,
    lineNumbers,
    onResolve,
    onDismiss,
    onSelect,
    isActive,
    highlightWords,
}: ConflictPaneBaseProps & ConflictSideCallbacks) {
    const view = deriveConflictView(segment, resolution, editedLines, dismissed);
    const handleSelect = useCallback(() => onSelect(segment.id), [onSelect, segment.id]);
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect(segment.id);
        },
        [onSelect, segment.id],
    );
    return (
        <div
            className={conflictWrapperClass(segment, view, isActive)}
            style={intrinsicSizeStyle(lineCount)}
            // Native button is invalid here because the block contains hunk action buttons.
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            role="button"
            tabIndex={0}
            data-conflict-id={segment.id}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
        >
            <div
                className={`column column-left conflict-column ${view.oursInResult ? "accepted" : ""} ${view.oursDismissed ? "dismissed" : ""}`}
            >
                <CodeBlock
                    lines={segment.oursLines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    lineNumberSide="right"
                    className={`conflict-ours ${view.oursInResult ? "accepted-pane" : ""}`}
                    wordHighlight={highlightWords}
                    compareLines={view.oursInResult ? undefined : segment.baseLines}
                />
                {view.showLeftActions ? (
                    <LeftHunkActions
                        segmentId={segment.id}
                        leftAppend={view.leftAppend}
                        isOurs={view.isOurs}
                        theirsDismissed={view.theirsDismissed}
                        onResolve={onResolve}
                        onDismiss={onDismiss}
                    />
                ) : null}
            </div>
        </div>
    );
}, sideConflictEqual);

/**
 * Middle (result) pane block: the editable merged result. Carries the hunk's
 * keyboard/aria affordances (the result is the primary target for a hunk).
 */
export const ResultConflictBlock = React.memo(function ResultConflictBlock({
    segment,
    resolution,
    editedLines,
    dismissed,
    lineCount,
    lineNumbers,
    onEditResult,
    onSelect,
    isActive,
    highlightWords,
    conflictOrdinal,
    trueConflictOrdinal,
}: ResultConflictBlockProps) {
    const view = deriveConflictView(segment, resolution, editedLines, dismissed);
    const resultLines = getEffectiveResultLines(segment, resolution, editedLines);
    const handleSelect = useCallback(() => onSelect(segment.id), [onSelect, segment.id]);
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect(segment.id);
        },
        [onSelect, segment.id],
    );
    return (
        <div
            className={conflictWrapperClass(segment, view, isActive)}
            style={intrinsicSizeStyle(lineCount)}
            // Native button is invalid here because the block contains an edit textarea.
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            role="button"
            tabIndex={0}
            aria-label={t("merge.hunk.groupAria", {
                ordinal: trueConflictOrdinal ?? conflictOrdinal,
            })}
            data-conflict-id={segment.id}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
        >
            <div className="column column-middle conflict-column result-column">
                <EditableResultBlock
                    lines={resultLines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    className={`conflict-result ${
                        view.resultIsUnresolved || !view.isResolved ? "unresolved" : "resolved"
                    } ${view.isEdited ? "edited" : ""} ${view.resultSettled ? "settled" : ""}`}
                    wordHighlight={highlightWords}
                    compareLines={view.resultCompareLines}
                    onCommit={(lines) => onEditResult(segment.id, lines)}
                />
            </div>
        </div>
    );
}, resultConflictEqual);

/**
 * Right (theirs) pane block: this side's accept/discard controls plus the
 * theirs lines.
 */
export const TheirsConflictBlock = React.memo(function TheirsConflictBlock({
    segment,
    resolution,
    editedLines,
    dismissed,
    lineCount,
    lineNumbers,
    onResolve,
    onDismiss,
    onSelect,
    isActive,
    highlightWords,
}: ConflictPaneBaseProps & ConflictSideCallbacks) {
    const view = deriveConflictView(segment, resolution, editedLines, dismissed);
    const handleSelect = useCallback(() => onSelect(segment.id), [onSelect, segment.id]);
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect(segment.id);
        },
        [onSelect, segment.id],
    );
    return (
        <div
            className={conflictWrapperClass(segment, view, isActive)}
            style={intrinsicSizeStyle(lineCount)}
            // Native button is invalid here because the block contains hunk action buttons.
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            role="button"
            tabIndex={0}
            data-conflict-id={segment.id}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
        >
            <div
                className={`column column-right conflict-column ${view.theirsInResult ? "accepted" : ""} ${view.theirsDismissed ? "dismissed" : ""}`}
            >
                {view.showRightActions ? (
                    <RightHunkActions
                        segmentId={segment.id}
                        rightAppend={view.rightAppend}
                        isTheirs={view.isTheirs}
                        oursDismissed={view.oursDismissed}
                        onResolve={onResolve}
                        onDismiss={onDismiss}
                    />
                ) : null}
                <CodeBlock
                    lines={segment.theirsLines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    className={`conflict-theirs ${view.theirsInResult ? "accepted-pane" : ""}`}
                    wordHighlight={highlightWords}
                    compareLines={view.theirsInResult ? undefined : segment.baseLines}
                />
            </div>
        </div>
    );
}, sideConflictEqual);

// --- Connector ribbons ---

/** One hunk's connector metadata; geometry is set imperatively per scroll frame. */
export interface ConnectorSpec {
    id: number;
    leftColorClass?: string;
    rightColorClass?: string;
}

/** Color class for a hunk's connector ribbon, matching its block band. */
// react-doctor-disable-next-line react-doctor/only-export-components
export function connectorClass(segment: ConflictSegment): string {
    return sideVariantClass(segment) || "change-conflict";
}

/**
 * SVG overlay drawing a colored ribbon per conflict hunk across the gutters
 * between panes. Paths carry no geometry here — the scroll driver sets each
 * path's `d` in its rAF so the ribbons track the translated columns without a
 * React re-render.
 */
export function ConnectorLayer({
    specs,
    registerPath,
}: {
    specs: ConnectorSpec[];
    registerPath: (key: string, el: SVGPathElement | null) => void;
}): React.ReactElement {
    return (
        <svg className="merge-connectors" aria-hidden="true">
            {specs.map((spec) => (
                <React.Fragment key={spec.id}>
                    {spec.leftColorClass ? (
                        <path
                            ref={(el) => registerPath(`${spec.id}-left`, el)}
                            className={`merge-connector ${spec.leftColorClass}`}
                        />
                    ) : null}
                    {spec.rightColorClass ? (
                        <path
                            ref={(el) => registerPath(`${spec.id}-right`, el)}
                            className={`merge-connector ${spec.rightColorClass}`}
                        />
                    ) : null}
                </React.Fragment>
            ))}
        </svg>
    );
}

// --- Overview rail ---

/**
 * Percentage-based minimap marker describing where a hunk appears in the full
 * rendered merge document and whether it is resolved.
 */
export interface OverviewMarker {
    id: number;
    ordinal: number;
    topPct: number;
    heightPct: number;
    changeKind: ConflictSegment["changeKind"];
    resolved: boolean;
}

/**
 * Renders the merge-editor overview rail and maps marker clicks back to hunk IDs
 * without changing hunk resolution state.
 */
export function OverviewRail({
    markers,
    activeConflictId,
    onJump,
}: {
    markers: OverviewMarker[];
    activeConflictId: number | null;
    onJump: (id: number) => void;
}) {
    return (
        <div className="overview-rail" aria-label={t("merge.overview.label")}>
            <div className="overview-track">
                {markers.map((marker) => (
                    <button
                        type="button"
                        key={marker.id}
                        className={[
                            "overview-marker",
                            `marker-${marker.changeKind}`,
                            marker.resolved ? "resolved" : "unresolved",
                            activeConflictId === marker.id ? "active" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        style={{
                            top: `${marker.topPct}%`,
                            height: `${marker.heightPct}%`,
                        }}
                        title={t("merge.overview.jumpToHunk", { ordinal: marker.ordinal })}
                        aria-label={t("merge.overview.jumpToHunk", { ordinal: marker.ordinal })}
                        aria-current={activeConflictId === marker.id ? "true" : undefined}
                        onClick={() => onJump(marker.id)}
                    />
                ))}
            </div>
        </div>
    );
}
