// Merge editor segment rendering components.
// CommonSection renders unchanged code lines across all three panes.
// ConflictSection renders conflict hunks with per-hunk resolution controls
// and an editable result block for manual fix-ups.
// OverviewRail provides a minimap of conflict locations for quick navigation.

import React, { useCallback, useMemo, useState } from "react";
import type { CommonSegment, ConflictSegment, HunkResolution } from "./types";
import {
    IconArrowRight,
    IconArrowLeft,
    IconClose,
    IconSplitBoth,
    IconWarning,
    IconCheck,
    IconDot,
} from "./icons";
import {
    tokenSimilarityRatio,
    buildWordDiffMask,
    tokenizeWordDiff,
    alignCompareLinesForWordDiff,
} from "./wordDiff";
import { getEffectiveResultLines, splitEditedText } from "./mergeState";
import { t } from "../shared/i18n";

// --- Syntax highlighting ---

const TOKEN_REGEX =
    /("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`)|\b(import|from|const|let|var|class|interface|type|function|return|if|else|for|while|switch|case|break|continue|new|export|default|private|public|protected|readonly|static|async|await)\b|\b(true|false|null|undefined)\b|\b\d+(\.\d+)?\b/g;

function renderSyntaxHighlightedNodes(line: string, keyPrefix: string): React.ReactNode[] {
    if (!line) return [<React.Fragment key={`${keyPrefix}-nbsp`}>{`\u00A0`}</React.Fragment>];
    if (line.trimStart().startsWith("//")) {
        return [
            <span key={`${keyPrefix}-comment`} className="tok-comment">
                {line}
            </span>,
        ];
    }

    const nodes: React.ReactNode[] = [];
    let last = 0;
    let idx = 0;

    for (const match of line.matchAll(TOKEN_REGEX)) {
        const start = match.index ?? 0;
        if (start > last) {
            nodes.push(<span key={`${keyPrefix}-txt-${idx++}`}>{line.slice(last, start)}</span>);
        }
        const token = match[0];
        let className: string;
        if (match[1]) className = "tok-string";
        else if (match[5]) className = "tok-keyword";
        else if (match[6]) className = "tok-constant";
        else className = "tok-number";
        nodes.push(
            <span key={`${keyPrefix}-tok-${idx++}`} className={className}>
                {token}
            </span>,
        );
        last = start + token.length;
    }
    if (last < line.length) {
        nodes.push(<span key={`${keyPrefix}-txt-${idx}`}>{line.slice(last)}</span>);
    }
    return nodes;
}

const HighlightedLine = React.memo(function HighlightedLine({
    line,
}: {
    line: string;
}): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    return <>{renderSyntaxHighlightedNodes(line, "line")}</>;
});

const WordDiffLine = React.memo(function WordDiffLine({
    line,
    compareLine,
}: {
    line: string;
    compareLine: string;
}): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    if (line === compareLine) return <HighlightedLine line={line} />;
    if (!compareLine) return <HighlightedLine line={line} />;

    const similarity = tokenSimilarityRatio(line, compareLine);
    if (similarity < 0.28) {
        return <HighlightedLine line={line} />;
    }

    const tokens = tokenizeWordDiff(line);
    if (tokens.length === 0) return <>{`\u00A0`}</>;

    const changedMask = buildWordDiffMask(line, compareLine);
    const nodes: React.ReactNode[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const changed = changedMask[i];
        const syntaxNodes = renderSyntaxHighlightedNodes(token, `wd-${i}`);
        if (!changed) {
            nodes.push(<React.Fragment key={`same-${i}`}>{syntaxNodes}</React.Fragment>);
            continue;
        }

        const isWhitespace = /^\s+$/.test(token);
        nodes.push(
            <span
                key={`chg-${i}`}
                className={`word-diff-change ${isWhitespace ? "word-diff-whitespace" : ""}`}
            >
                {syntaxNodes}
            </span>,
        );
    }

    return <>{nodes}</>;
});

// --- Line numbers ---

/** Line-number value for a rendered row; `null` reserves padding rows. */
export type LineNumberValue = number | null;

interface LineNumberSpec {
    primary: LineNumberValue[];
    secondary?: LineNumberValue[];
}

/**
 * Builds displayed line numbers for a pane, using null placeholders when a
 * shorter side needs visual padding to align with the hunk's row count.
 */
export function buildLineNumberValues(
    startAt: number,
    actualCount: number,
    rowCount: number,
): LineNumberValue[] {
    const values: LineNumberValue[] = [];
    for (let i = 0; i < rowCount; i++) {
        values.push(i < actualCount ? startAt + i : null);
    }
    return values;
}

function padLines(lines: string[], count: number): string[] {
    const padded = [...lines];
    while (padded.length < count) padded.push("");
    return padded;
}

function lineNumberValuesEqual(a: LineNumberValue[], b: LineNumberValue[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function lineNumberSpecEqual(a: LineNumberSpec, b: LineNumberSpec): boolean {
    if (a === b) return true;
    if (!lineNumberValuesEqual(a.primary, b.primary)) return false;
    if (a.secondary === b.secondary) return true;
    if (!a.secondary || !b.secondary) return false;
    return lineNumberValuesEqual(a.secondary, b.secondary);
}

/**
 * Value-compares the three pane line-number specs so memoized segments skip
 * re-rendering when an unrelated hunk resolution rebuilds equal number arrays.
 */
function paneLineNumbersEqual(a: SegmentPaneLineNumbers, b: SegmentPaneLineNumbers): boolean {
    return (
        lineNumberSpecEqual(a.left, b.left) &&
        lineNumberSpecEqual(a.middle, b.middle) &&
        lineNumberSpecEqual(a.right, b.right)
    );
}

const LineNumbers = React.memo(
    function LineNumbers({ primary, secondary }: LineNumberSpec) {
        const rowCount = Math.max(primary.length, secondary?.length ?? 0);
        const hasSecondary = Boolean(secondary);

        return (
            <div className={`line-numbers ${hasSecondary ? "has-secondary" : ""}`}>
                {Array.from({ length: rowCount }, (_, i) => (
                    <div key={i} className="line-number-row">
                        {hasSecondary ? (
                            <div className="line-number line-number-secondary">
                                {secondary?.[i] ?? ""}
                            </div>
                        ) : null}
                        <div className="line-number line-number-primary">{primary[i] ?? ""}</div>
                    </div>
                ))}
            </div>
        );
    },
    (prev, next) => lineNumberSpecEqual(prev, next),
);

// --- Code block ---

interface CodeBlockProps {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
}

const CodeBlock = React.memo(
    function CodeBlock({
        lines,
        lineCount,
        lineNumbers,
        className,
        wordHighlight,
        compareLines,
    }: CodeBlockProps) {
        const padded = useMemo(() => padLines(lines, lineCount), [lines, lineCount]);
        const paddedCompare = useMemo(() => {
            if (!compareLines) return undefined;
            const alignedCompare = alignCompareLinesForWordDiff(lines, compareLines);
            return padLines(alignedCompare, lineCount);
        }, [compareLines, lineCount, lines]);

        return (
            <div
                className={`code-block ${className ?? ""} ${wordHighlight ? "word-highlight" : ""}`}
            >
                <LineNumbers primary={lineNumbers.primary} secondary={lineNumbers.secondary} />
                <div className="code-lines">
                    {padded.map((line, i) => (
                        <div key={i} className="code-line">
                            {wordHighlight && paddedCompare ? (
                                <WordDiffLine line={line} compareLine={paddedCompare[i]} />
                            ) : (
                                <HighlightedLine line={line} />
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    },
    (prev, next) =>
        prev.lines === next.lines &&
        prev.lineCount === next.lineCount &&
        prev.className === next.className &&
        prev.wordHighlight === next.wordHighlight &&
        prev.compareLines === next.compareLines &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers),
);

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
            <LineNumbers primary={lineNumbers.primary} secondary={lineNumbers.secondary} />
            <textarea
                className="result-edit-textarea"
                aria-label={t("merge.result.editingAria")}
                value={draft}
                rows={rowCount}
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

// --- Hunk helpers ---

/** Line-number specifications for the left, result, and right merge panes. */
export interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
}

function getHunkStatus(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    isEdited: boolean,
): {
    label: string;
    tone: "warn" | "ok" | "muted";
} {
    if (isEdited) return { label: t("merge.status.edited"), tone: "ok" };
    if (segment.changeKind === "ours-only") {
        return resolution === "none"
            ? { label: t("merge.status.droppedLeftOnly"), tone: "muted" }
            : { label: t("merge.status.leftOnly"), tone: "muted" };
    }
    if (segment.changeKind === "theirs-only") {
        return resolution === "none"
            ? { label: t("merge.status.droppedRightOnly"), tone: "muted" }
            : { label: t("merge.status.rightOnly"), tone: "muted" };
    }

    if (resolution === undefined) return { label: t("merge.status.unresolvedLabel"), tone: "warn" };
    if (resolution === "ours") return { label: t("merge.status.useLeft"), tone: "ok" };
    if (resolution === "theirs") return { label: t("merge.status.useRight"), tone: "ok" };
    if (resolution === "both") return { label: t("merge.status.useBoth"), tone: "ok" };
    return { label: t("merge.status.removeBlock"), tone: "muted" };
}

function getHunkKindLabel(segment: ConflictSegment): string {
    if (segment.changeKind === "ours-only") return t("merge.kind.leftOnly");
    if (segment.changeKind === "theirs-only") return t("merge.kind.rightOnly");
    return t("merge.kind.conflict");
}

// --- Section components ---

/** Editor row height in pixels, matched to the .code-line CSS line-height. */
const LINE_HEIGHT_PX = 20;
/** Estimated hunk-header plus margin overhead used for offscreen size hints. */
const CONFLICT_CHROME_PX = 30;

/**
 * Size hint that lets `content-visibility: auto` skip layout of offscreen
 * segments while keeping the scrollbar geometry stable for large files.
 */
function intrinsicSizeStyle(lineCount: number, chromePx = 0): React.CSSProperties {
    return { containIntrinsicSize: `auto ${lineCount * LINE_HEIGHT_PX + chromePx}px` };
}

interface CommonSectionProps {
    segment: CommonSegment;
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    highlightWords: boolean;
}

/**
 * Renders unchanged lines across all three panes while preserving aligned line
 * numbers and optional word highlighting. Memoized with value-compared line
 * numbers so resolving one hunk does not re-render every other segment.
 */
export const CommonSection = React.memo(
    function CommonSection({
        segment,
        lineCount,
        lineNumbers,
        highlightWords,
    }: CommonSectionProps) {
        return (
            <div className="segment segment-common" style={intrinsicSizeStyle(lineCount)}>
                <div className="column column-left">
                    <CodeBlock
                        lines={segment.lines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.left}
                        wordHighlight={highlightWords}
                    />
                </div>
                <div className="column column-middle result-column">
                    <CodeBlock
                        lines={segment.lines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.middle}
                        wordHighlight={highlightWords}
                    />
                </div>
                <div className="column column-right">
                    <CodeBlock
                        lines={segment.lines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.right}
                        wordHighlight={highlightWords}
                    />
                </div>
            </div>
        );
    },
    (prev, next) =>
        prev.segment === next.segment &&
        prev.lineCount === next.lineCount &&
        prev.highlightWords === next.highlightWords &&
        paneLineNumbersEqual(prev.lineNumbers, next.lineNumbers),
);

/**
 * Props that connect one conflict hunk to result-line computation, keyboard
 * navigation, active-state styling, hunk-resolution callbacks, and manual
 * result editing. `editedLines` overrides the side-resolution result when set.
 */
export interface ConflictSectionProps {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    editedLines: string[] | undefined;
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    onResolve: (id: number, resolution: HunkResolution) => void;
    onEditResult: (id: number, lines: string[]) => void;
    onSelect: (id: number) => void;
    onSectionRef: (id: number, el: HTMLDivElement | null) => void;
    isActive: boolean;
    showDetails: boolean;
    highlightWords: boolean;
    conflictOrdinal: number;
    trueConflictOrdinal?: number;
}

/**
 * Renders one merge-editor hunk with ours/result/theirs columns, resolution
 * controls, status badges, and per-pane word-diff highlighting. Memoized with
 * value-compared line numbers so resolving or editing one hunk re-renders only
 * the affected segments in large files.
 */
export const ConflictSection = React.memo(function ConflictSection({
    segment,
    resolution,
    editedLines,
    lineCount,
    lineNumbers,
    onResolve,
    onEditResult,
    onSelect,
    onSectionRef,
    isActive,
    showDetails,
    highlightWords,
    conflictOrdinal,
    trueConflictOrdinal,
}: ConflictSectionProps) {
    const resultLines = getEffectiveResultLines(segment, resolution, editedLines);
    const isEdited = editedLines !== undefined;
    const status = getHunkStatus(segment, resolution, isEdited);

    const isOurs = !isEdited && resolution === "ours";
    const isTheirs = !isEdited && resolution === "theirs";
    const isBoth = !isEdited && resolution === "both";
    const isNone = !isEdited && resolution === "none";
    const isResolved = segment.changeKind !== "conflict" || resolution !== undefined || isEdited;
    const kindLabel = getHunkKindLabel(segment);
    const setSectionRef = useCallback(
        (el: HTMLDivElement | null) => onSectionRef(segment.id, el),
        [onSectionRef, segment.id],
    );
    const resultCompareLines =
        resolution === "ours"
            ? segment.theirsLines
            : resolution === "theirs"
              ? segment.oursLines
              : segment.baseLines;

    return (
        <div
            ref={setSectionRef}
            style={intrinsicSizeStyle(lineCount, CONFLICT_CHROME_PX)}
            className={[
                "segment",
                "segment-conflict",
                `change-${segment.changeKind}`,
                isResolved ? "resolved" : "unresolved",
                isActive ? "active" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            data-conflict-id={segment.id}
            onClick={() => onSelect(segment.id)}
        >
            <div className="hunk-header">
                <div className="hunk-header-left">
                    <span className={`hunk-badge hunk-kind-${segment.changeKind}`}>
                        {trueConflictOrdinal !== undefined
                            ? `#${trueConflictOrdinal}`
                            : `#${conflictOrdinal}`}
                    </span>
                    <span className="hunk-kind-label">{kindLabel}</span>
                    {showDetails ? (
                        <span className="hunk-detail-lines">
                            {t("merge.hunk.detail", {
                                left: segment.oursLines.length,
                                right: segment.theirsLines.length,
                                result: resultLines.length,
                            })}
                        </span>
                    ) : null}
                </div>
                <div className="hunk-header-center" onClick={(e) => e.stopPropagation()}>
                    <button
                        className={`hunk-choice ${isOurs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "ours")}
                        title={t("merge.hunk.useLeft")}
                    >
                        <IconArrowRight />
                        {t("merge.hunk.left")}
                    </button>
                    {segment.changeKind === "conflict" ? (
                        <button
                            className={`hunk-choice ${isBoth ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "both")}
                            title={t("merge.hunk.useBoth")}
                        >
                            <IconSplitBoth />
                            {t("merge.hunk.both")}
                        </button>
                    ) : null}
                    <button
                        className={`hunk-choice ${isTheirs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "theirs")}
                        title={t("merge.hunk.useRight")}
                    >
                        <IconArrowLeft />
                        {t("merge.hunk.right")}
                    </button>
                    <button
                        className={`hunk-choice danger ${isNone ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "none")}
                        title={t("merge.hunk.dropTitle")}
                    >
                        <IconClose />
                        {t("merge.hunk.drop")}
                    </button>
                </div>
                <div className={`hunk-status tone-${status.tone}`}>
                    <span className="toolbar-icon status-icon">
                        {status.tone === "warn" ? (
                            <IconWarning />
                        ) : status.tone === "ok" ? (
                            <IconCheck />
                        ) : (
                            <IconDot />
                        )}
                    </span>
                    {status.label}
                </div>
            </div>

            <div className="hunk-columns">
                <div className={`column column-left conflict-column ${isOurs ? "accepted" : ""}`}>
                    <CodeBlock
                        lines={segment.oursLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.left}
                        className="conflict-ours"
                        wordHighlight={highlightWords}
                        compareLines={segment.theirsLines}
                    />
                    <div className="conflict-actions-left" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "theirs")}
                            title={t("merge.hunk.ignoreLeft")}
                            aria-label={t("merge.hunk.ignoreLeft")}
                        >
                            <IconClose />
                        </button>
                        <button
                            className={`action-btn accept-btn ${isOurs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "ours")}
                            title={t("merge.hunk.acceptLeft")}
                            aria-label={t("merge.hunk.acceptLeft")}
                            aria-current={isOurs ? "true" : undefined}
                        >
                            <IconArrowRight />
                        </button>
                    </div>
                </div>

                <div className="column column-middle conflict-column result-column">
                    <EditableResultBlock
                        lines={resultLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.middle}
                        className={`conflict-result ${isResolved ? "resolved" : "unresolved"} ${isEdited ? "edited" : ""}`}
                        wordHighlight={highlightWords}
                        compareLines={resultCompareLines}
                        onCommit={(lines) => onEditResult(segment.id, lines)}
                    />
                </div>

                <div
                    className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}
                >
                    <div className="conflict-actions-right" onClick={(e) => e.stopPropagation()}>
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "theirs")}
                            title={t("merge.hunk.acceptRight")}
                            aria-label={t("merge.hunk.acceptRight")}
                            aria-current={isTheirs ? "true" : undefined}
                        >
                            <IconArrowLeft />
                        </button>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title={t("merge.hunk.ignoreRight")}
                            aria-label={t("merge.hunk.ignoreRight")}
                        >
                            <IconClose />
                        </button>
                    </div>
                    <CodeBlock
                        lines={segment.theirsLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.right}
                        className="conflict-theirs"
                        wordHighlight={highlightWords}
                        compareLines={segment.oursLines}
                    />
                </div>
            </div>
        </div>
    );
}, conflictSectionPropsEqual);

/**
 * Value-compares conflict-section props so a resolution or edit on one hunk
 * only re-renders segments whose computed line numbers actually shifted.
 */
function conflictSectionPropsEqual(
    prev: ConflictSectionProps,
    next: ConflictSectionProps,
): boolean {
    return (
        prev.segment === next.segment &&
        prev.resolution === next.resolution &&
        prev.editedLines === next.editedLines &&
        prev.lineCount === next.lineCount &&
        prev.onResolve === next.onResolve &&
        prev.onEditResult === next.onEditResult &&
        prev.onSelect === next.onSelect &&
        prev.onSectionRef === next.onSectionRef &&
        prev.isActive === next.isActive &&
        prev.showDetails === next.showDetails &&
        prev.highlightWords === next.highlightWords &&
        prev.conflictOrdinal === next.conflictOrdinal &&
        prev.trueConflictOrdinal === next.trueConflictOrdinal &&
        paneLineNumbersEqual(prev.lineNumbers, next.lineNumbers)
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
