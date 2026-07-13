// Merge editor segment rendering components.
// Each pane (ours/result/theirs) renders in its own column, so a segment is
// split into per-pane blocks: CommonPaneBlock for unchanged code and the
// Ours/Result/Theirs ConflictBlock trio for a hunk (with resolution controls and
// an editable result). ConnectorLayer draws the ribbons linking a hunk across
// panes; OverviewRail provides a minimap of conflict locations for navigation.

import React, { useCallback, useMemo, useState } from "react";
import type { CommonSegment, ConflictSegment, HunkResolution, HunkSideDismissal } from "./types";
import {
    tokenSimilarityRatio,
    buildWordDiffMask,
    tokenizeWordDiff,
    alignCompareLinesForWordDiff,
} from "../../../mergeEditor/wordDiff";
import { getEffectiveResultLines, splitEditedText } from "./mergeState";
import { tokenizeSyntaxLine, type SyntaxTokenKind } from "./syntaxHighlight";
import { highlightLine } from "./shikiHighlighter";
import { useSyntaxHighlightState, type SyntaxHighlightState } from "./syntaxHighlightContext";
import type { LineNumberValue } from "./lineNumbers";
import { LINE_HEIGHT_PX, type MergePane } from "./mergeScrollLayout";
import { t } from "../shared/i18n";

// --- Syntax highlighting ---

const TOKEN_CLASS: Record<SyntaxTokenKind, string | undefined> = {
    plain: undefined,
    comment: "tok-comment",
    string: "tok-string",
    keyword: "tok-keyword",
    constant: "tok-constant",
    number: "tok-number",
};

/** A single colored run of text: Shiki tokens carry an inline style, fallback tokens carry a className. */
interface ColoredSpan {
    text: string;
    style?: React.CSSProperties;
    className?: string;
}

// Shiki `fontStyle` bitmask bits (see @shikijs/core ThemedToken).
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/**
 * Tokenizes a line into colored spans. Uses Shiki's grammar-accurate tokens
 * when the highlighter is ready and the file's language is registered;
 * otherwise falls back to the hand-rolled five-category tokenizer.
 */
function coloredSpansForLine(line: string, ctx: SyntaxHighlightState): ColoredSpan[] {
    if (ctx.ready && ctx.lang) {
        const shikiTokens = highlightLine(line, ctx.lang, ctx.theme);
        if (shikiTokens) {
            return shikiTokens.map((tok) => {
                const style: React.CSSProperties = {};
                if (tok.color) style.color = tok.color;
                if (tok.fontStyle) {
                    if (tok.fontStyle & FONT_STYLE_ITALIC) style.fontStyle = "italic";
                    if (tok.fontStyle & FONT_STYLE_BOLD) style.fontWeight = "bold";
                    if (tok.fontStyle & FONT_STYLE_UNDERLINE) style.textDecoration = "underline";
                }
                return { text: tok.text, style: Object.keys(style).length ? style : undefined };
            });
        }
    }
    return tokenizeSyntaxLine(line).map((token) => ({
        text: token.text,
        className: TOKEN_CLASS[token.kind],
    }));
}

function renderColoredSpans(spans: ColoredSpan[], keyPrefix: string): React.ReactNode[] {
    let offset = 0;
    return spans.map((span) => {
        const key = `${keyPrefix}-${offset}-${span.text}`;
        offset += span.text.length;
        return (
            <span key={key} className={span.className} style={span.style}>
                {span.text}
            </span>
        );
    });
}

const HighlightedLine = React.memo(function HighlightedLine({
    line,
}: {
    line: string;
}): React.ReactElement {
    const ctx = useSyntaxHighlightState();
    if (!line) return <>{` `}</>;
    // Pure syntax-token helper, not a component invocation.
    // react-doctor-disable-next-line react-doctor/no-render-in-render
    return <>{renderColoredSpans(coloredSpansForLine(line, ctx), "line")}</>;
});

/**
 * Expands a token-level word-diff mask into per-character changed/whitespace
 * masks aligned to `line`. This lets the change overlay be intersected with
 * Shiki's full-line colored spans without re-tokenizing fragments (which
 * would lose surrounding grammar context, e.g. a string opened before the
 * changed run).
 */
function buildChangedCharMasks(
    line: string,
    compareLine: string,
): { changed: boolean[]; whitespace: boolean[] } {
    const tokens = tokenizeWordDiff(line);
    const changedMask = buildWordDiffMask(line, compareLine);
    const changed: boolean[] = [];
    const whitespace: boolean[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const isChanged = changedMask[i];
        const isWhitespace = /^\s+$/.test(token);
        for (let c = 0; c < token.length; c++) {
            changed.push(isChanged);
            whitespace.push(isWhitespace);
        }
    }
    return { changed, whitespace };
}

/**
 * Renders colored spans with a word-diff overlay: each colored span is split
 * at change-boundary offsets so the underlying grammar coloring is preserved
 * beneath the `.word-diff-change` background instead of being replaced by it.
 */
function renderColoredSpansWithWordDiff(
    spans: ColoredSpan[],
    changed: boolean[],
    whitespace: boolean[],
    keyPrefix: string,
): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let offset = 0;
    for (const span of spans) {
        const spanText = span.text;
        let runStart = 0;
        while (runStart < spanText.length) {
            const runChanged = changed[offset + runStart];
            let runEnd = runStart + 1;
            while (runEnd < spanText.length && changed[offset + runEnd] === runChanged) {
                runEnd++;
            }
            const runText = spanText.slice(runStart, runEnd);
            const key = `${keyPrefix}-${offset + runStart}`;
            const coloredNode = (
                <span key={key} className={span.className} style={span.style}>
                    {runText}
                </span>
            );
            if (runChanged) {
                const runIsWhitespace = whitespace[offset + runStart];
                nodes.push(
                    <span
                        key={`chg-${key}`}
                        className={`word-diff-change ${runIsWhitespace ? "word-diff-whitespace" : ""}`}
                    >
                        {coloredNode}
                    </span>,
                );
            } else {
                nodes.push(coloredNode);
            }
            runStart = runEnd;
        }
        offset += spanText.length;
    }
    return nodes;
}

const WordDiffLine = React.memo(function WordDiffLine({
    line,
    compareLine,
}: {
    line: string;
    compareLine: string;
}): React.ReactElement {
    const ctx = useSyntaxHighlightState();
    if (!line) return <>{` `}</>;
    if (line === compareLine) return <HighlightedLine line={line} />;
    if (!compareLine) return <HighlightedLine line={line} />;

    const similarity = tokenSimilarityRatio(line, compareLine);
    if (similarity < 0.28) {
        return <HighlightedLine line={line} />;
    }

    const spans = coloredSpansForLine(line, ctx);
    if (spans.length === 0) return <>{` `}</>;

    const { changed, whitespace } = buildChangedCharMasks(line, compareLine);

    const wordDiffNodes = renderColoredSpansWithWordDiff(spans, changed, whitespace, "wd");
    return <>{wordDiffNodes}</>;
});

// --- Line numbers ---

/** Line-number values to render alongside a code block (optional secondary column). */
export interface LineNumberSpec {
    primary: LineNumberValue[];
    secondary?: LineNumberValue[];
}

interface LineNumbersProps extends LineNumberSpec {
    rowIsReal?: boolean[];
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

function rowPresenceEqual(a: boolean[] | undefined, b: boolean[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const LineNumbers = React.memo(
    function LineNumbers({ primary, rowIsReal }: LineNumbersProps) {
        return (
            <div className="line-numbers">
                {Array.from({ length: primary.length }, (_, i) => {
                    const isReal = rowIsReal?.[i] ?? true;
                    return (
                        <div
                            key={i}
                            className={`line-number-row ${
                                isReal ? "real-line-row" : "padding-line-row"
                            }`}
                        >
                            <div className="line-number line-number-primary">
                                {primary[i] ?? ""}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    },
    (prev, next) =>
        lineNumberSpecEqual(prev, next) && rowPresenceEqual(prev.rowIsReal, next.rowIsReal),
);

// --- Code block ---

interface CodeBlockProps {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    showLineNumbers?: boolean;
    lineNumberSide?: "left" | "right";
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
}

function rowKey(lineNumbers: LineNumberSpec, line: string, row: number): string {
    const primary = lineNumbers.primary[row] ?? "gap";
    const secondary = lineNumbers.secondary?.[row] ?? "gap";
    return `${primary}-${secondary}-${row}-${line}`;
}

const CodeBlock = React.memo(
    function CodeBlock({
        lines,
        lineCount,
        lineNumbers,
        showLineNumbers = true,
        lineNumberSide = "left",
        className,
        wordHighlight,
        compareLines,
    }: CodeBlockProps) {
        // Padding rows align panes to the tallest side; only source-backed rows
        // should receive diff coloring.
        const rowCount = Math.max(lineCount, lines.length);
        const rowIsReal = useMemo(
            () => Array.from({ length: rowCount }, (_, i) => i < lines.length),
            [lines.length, rowCount],
        );
        const padded = useMemo(() => padLines(lines, rowCount), [lines, rowCount]);
        const paddedCompare = useMemo(() => {
            if (!compareLines) return undefined;
            const alignedCompare = alignCompareLinesForWordDiff(lines, compareLines);
            return padLines(alignedCompare, rowCount);
        }, [compareLines, lines, rowCount]);

        return (
            <div
                className={`code-block ${showLineNumbers ? `line-numbers-${lineNumberSide}` : "no-line-numbers"} ${className ?? ""} ${wordHighlight ? "word-highlight" : ""}`}
            >
                {showLineNumbers && lineNumberSide === "left" ? (
                    <LineNumbers
                        primary={lineNumbers.primary}
                        secondary={lineNumbers.secondary}
                        rowIsReal={rowIsReal}
                    />
                ) : null}
                <div className="code-lines">
                    {padded.map((line, i) => {
                        const isReal = rowIsReal[i] ?? false;
                        return (
                            <div
                                key={rowKey(lineNumbers, line, i)}
                                className={`code-line ${
                                    isReal ? "real-code-line" : "padding-code-line"
                                }`}
                            >
                                <span className="code-line-content">
                                    {wordHighlight && paddedCompare ? (
                                        <WordDiffLine line={line} compareLine={paddedCompare[i]} />
                                    ) : (
                                        <HighlightedLine line={line} />
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
                {showLineNumbers && lineNumberSide === "right" ? (
                    <LineNumbers
                        primary={lineNumbers.primary}
                        secondary={lineNumbers.secondary}
                        rowIsReal={rowIsReal}
                    />
                ) : null}
            </div>
        );
    },
    (prev, next) =>
        prev.lines === next.lines &&
        prev.lineCount === next.lineCount &&
        prev.showLineNumbers === next.showLineNumbers &&
        prev.lineNumberSide === next.lineNumberSide &&
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

// --- Hunk helpers ---

/** Line-number specifications for the left, result, and right merge panes. */
export interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
}

// --- Section components ---

/**
 * Size hint that lets `content-visibility: auto` skip layout of offscreen
 * segments while keeping the scrollbar geometry stable for large files. Every
 * block — common or conflict — is exactly `lineCount * LINE_HEIGHT_PX` tall
 * (conflict rules are drawn with a zero-height inset shadow), so this matches
 * both the rendered content box and the scroll geometry.
 */
function intrinsicSizeStyle(lineCount: number): React.CSSProperties {
    return { containIntrinsicSize: `auto ${lineCount * LINE_HEIGHT_PX}px` };
}

interface CommonPaneBlockProps {
    pane: MergePane;
    segment: CommonSegment;
    lineCount: number;
    lineNumbers: LineNumberSpec;
    highlightWords: boolean;
}

/**
 * Renders one pane's slice of an unchanged segment. The three panes hold
 * identical common lines but flow in separate columns (PyCharm-style), so each
 * is its own block; the scroll driver keeps them vertically aligned. Memoized
 * with value-compared line numbers so resolving one hunk does not re-render
 * every other segment.
 */
export const CommonPaneBlock = React.memo(
    function CommonPaneBlock({
        pane,
        segment,
        lineCount,
        lineNumbers,
        highlightWords,
    }: CommonPaneBlockProps) {
        return (
            <div className="segment segment-common" style={intrinsicSizeStyle(lineCount)}>
                <CodeBlock
                    lines={segment.lines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    lineNumberSide={pane === "left" ? "right" : "left"}
                    wordHighlight={highlightWords}
                />
            </div>
        );
    },
    (prev, next) =>
        prev.pane === next.pane &&
        prev.segment === next.segment &&
        prev.lineCount === next.lineCount &&
        prev.highlightWords === next.highlightWords &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers),
);

/**
 * Props shared by all three conflict-pane blocks: result-line computation
 * inputs, selection, active-state styling, and word highlighting. `editedLines`
 * overrides the side-resolution result when set. Side blocks add resolution
 * callbacks; the result block adds the edit callback and ordinals.
 */
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
