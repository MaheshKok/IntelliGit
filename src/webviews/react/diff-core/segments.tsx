// Pane-independent segment rendering primitives.
// These shells render code, line numbers, syntax colors, and word-diff masks;
// merge-resolution actions and editable result state remain in merge-editor.

import React, { useMemo } from "react";
import {
    alignCompareLinesForWordDiff,
    buildWordDiffMask,
    tokenSimilarityRatio,
    tokenizeWordDiff,
} from "../../../diff/wordDiff";
import { highlightLine } from "./shikiHighlighter";
import { useSyntaxHighlightState, type SyntaxHighlightState } from "./syntaxHighlightContext";
import { tokenizeSyntaxLine, type SyntaxTokenKind } from "./syntaxHighlight";
import type { LineNumberValue } from "./lineNumbers";
import { LINE_HEIGHT_PX, type PaneId } from "./mergeScrollLayout";

/** Minimal common-segment shape consumed by the shared code shell. */
interface CommonSegment {
    lines: string[];
}

const TOKEN_CLASS: Record<SyntaxTokenKind, string | undefined> = {
    plain: undefined,
    comment: "tok-comment",
    string: "tok-string",
    keyword: "tok-keyword",
    constant: "tok-constant",
    number: "tok-number",
};

/** A single colored run; Shiki uses inline style and fallback tokens use a class. */
interface ColoredSpan {
    text: string;
    style?: React.CSSProperties;
    className?: string;
}

// Shiki `fontStyle` bitmask bits (see @shikijs/core ThemedToken).
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/** Tokenizes a line with Shiki when ready and otherwise uses the regex fallback. */
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

/** Expands a token-level word-diff mask into per-character masks. */
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

/** Preserves syntax colors while wrapping changed character runs. */
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
            while (runEnd < spanText.length && changed[offset + runEnd] === runChanged) runEnd++;
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
    if (line === compareLine || !compareLine) return <HighlightedLine line={line} />;
    const similarity = tokenSimilarityRatio(line, compareLine);
    if (similarity < 0.28) return <HighlightedLine line={line} />;
    const spans = coloredSpansForLine(line, ctx);
    if (spans.length === 0) return <>{` `}</>;
    const { changed, whitespace } = buildChangedCharMasks(line, compareLine);
    return <>{renderColoredSpansWithWordDiff(spans, changed, whitespace, "wd")}</>;
});

/** Line-number specifications for one code block. */
export interface LineNumberSpec {
    primary: LineNumberValue[];
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
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Value-compares two line-number specifications for memoized block updates. */
export function lineNumberSpecEqual(a: LineNumberSpec, b: LineNumberSpec): boolean {
    if (a === b) return true;
    return lineNumberValuesEqual(a.primary, b.primary);
}

function rowPresenceEqual(a: boolean[] | undefined, b: boolean[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Renders a pane's line-number column while preserving padding-row structure. */
export const LineNumbers = React.memo(
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

/** Props for the memoized pane-generic code block. */
export interface CodeBlockProps {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    lineNumberSide?: "left" | "right";
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
}

function rowKey(lineNumbers: LineNumberSpec, line: string, row: number): string {
    const primary = lineNumbers.primary[row] ?? "gap";
    return `${primary}-${row}-${line}`;
}

/** Renders syntax-colored lines, word-diff overlays, and line numbers. */
export const CodeBlock = React.memo(
    function CodeBlock({
        lines,
        lineCount,
        lineNumbers,
        lineNumberSide = "left",
        className,
        wordHighlight,
        compareLines,
    }: CodeBlockProps) {
        const rowCount = Math.max(lineCount, lines.length);
        const rowIsReal = useMemo(
            () => Array.from({ length: rowCount }, (_, i) => i < lines.length),
            [lines.length, rowCount],
        );
        const padded = useMemo(() => padLines(lines, rowCount), [lines, rowCount]);
        const paddedCompare = useMemo(() => {
            if (!compareLines) return undefined;
            return padLines(alignCompareLinesForWordDiff(lines, compareLines), rowCount);
        }, [compareLines, lines, rowCount]);

        return (
            <div
                className={`code-block line-numbers-${lineNumberSide} ${className ?? ""} ${wordHighlight ? "word-highlight" : ""}`}
            >
                {lineNumberSide === "left" ? (
                    <LineNumbers primary={lineNumbers.primary} rowIsReal={rowIsReal} />
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
                {lineNumberSide === "right" ? (
                    <LineNumbers primary={lineNumbers.primary} rowIsReal={rowIsReal} />
                ) : null}
            </div>
        );
    },
    (prev, next) =>
        prev.lines === next.lines &&
        prev.lineCount === next.lineCount &&
        prev.lineNumberSide === next.lineNumberSide &&
        prev.className === next.className &&
        prev.wordHighlight === next.wordHighlight &&
        prev.compareLines === next.compareLines &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers),
);

/** Size hint that keeps content-visibility geometry equal to rendered rows. */
export function intrinsicSizeStyle(lineCount: number): React.CSSProperties {
    return { containIntrinsicSize: `auto ${lineCount * LINE_HEIGHT_PX}px` };
}

/** Props for one pane's unchanged-segment shell. */
export interface CommonPaneBlockProps<Pane extends PaneId = PaneId> {
    pane: Pane;
    segment: CommonSegment;
    lineCount: number;
    lineNumbers: LineNumberSpec;
    lineNumberSide: "left" | "right";
    highlightWords: boolean;
}

/** Renders one ordered pane's slice of an unchanged segment. */
export const CommonPaneBlock = React.memo(
    function CommonPaneBlock<Pane extends PaneId>({
        pane: _pane,
        segment,
        lineCount,
        lineNumbers,
        lineNumberSide,
        highlightWords,
    }: CommonPaneBlockProps<Pane>) {
        return (
            <div className="segment segment-common" style={intrinsicSizeStyle(lineCount)}>
                <CodeBlock
                    lines={segment.lines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers}
                    lineNumberSide={lineNumberSide}
                    wordHighlight={highlightWords}
                />
            </div>
        );
    },
    (prev, next) =>
        prev.pane === next.pane &&
        prev.segment === next.segment &&
        prev.lineCount === next.lineCount &&
        prev.lineNumberSide === next.lineNumberSide &&
        prev.highlightWords === next.highlightWords &&
        lineNumberSpecEqual(prev.lineNumbers, next.lineNumbers),
);
