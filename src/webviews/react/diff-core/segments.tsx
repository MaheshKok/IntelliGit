// Pane-independent segment rendering primitives.
// These shells render code, line numbers, syntax colors, and word-diff masks;
// merge-resolution actions and editable result state remain in merge-editor.

import React, { useMemo } from "react";
import {
    alignCompareLinesForWordDiff,
    bridgeChangedWordRuns,
    buildWordDiffMask,
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
// The rule protects Fast Refresh, which this project does not have: the webviews are
// bundled by esbuild (`scripts/build.js`) with no react-refresh transform anywhere, so a
// mixed module costs nothing here. The three helpers exported alongside the components are
// each read only by them, and a separate module would buy separation without a consumer.
// react-doctor-disable-next-line react-doctor/only-export-components
export function buildChangedCharMasks(
    line: string,
    compareLine: string,
): { changed: boolean[]; whitespace: boolean[] } {
    const tokens = tokenizeWordDiff(line);
    const { changed: changedMask, bridged } = bridgeChangedWordRuns(
        tokens,
        buildWordDiffMask(line, compareLine),
    );
    const changed: boolean[] = [];
    const whitespace: boolean[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const isChanged = changedMask[i];
        // A bridged gap is interior to one changed run, so it takes that run's colour.
        // The neutral whitespace tint is for whitespace that is itself the change.
        const isWhitespace = /^\s+$/.test(token) && !bridged[i];
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
    if (line === compareLine) return <HighlightedLine line={line} />;
    // There is deliberately no similarity floor here. One stood at 0.28 to stop "speckle" -- a
    // mask alternating mark/gap/mark across a row, which reads as noise rather than as a change.
    // Measured against real pairs, the floor selects for the opposite of that. Speckle comes from
    // lines that are highly similar and share their punctuation: `a.b(c).d(e).f(g)` against
    // `z.y(x).w(v).u(t)` scores 0.500 and yields NINE one-character runs, and it sailed over the
    // floor every time. What the floor actually caught was the low-similarity pairs, and those
    // cannot speckle -- few shared tokens means few unchanged islands, so they resolve to a
    // single clean run. `" * "` against `" * ey lets see how it goes"` scores 0.143 and is one
    // 23-character run, and bouncing it painted the one row the reader was hunting for exactly
    // like the untouched rows beside it. `bridgeChangedWordRuns` is what actually suppresses
    // speckle, and it runs below on every line regardless.
    const spans = coloredSpansForLine(line, ctx);
    if (spans.length === 0) return <>{` `}</>;
    const { changed, whitespace } = buildChangedCharMasks(line, compareLine);
    // Not a component call: this returns a keyed array of `<span>`s, holds no state and runs
    // no hooks, so there is nothing for React to remount and nothing for a user to lose.
    // Wrapping it in a component would add one fibre per rendered LINE, on the hottest path
    // the viewer has, to satisfy a naming pattern.
    // react-doctor-disable-next-line react-doctor/no-render-in-render
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
// No Fast Refresh in this build; see the note on `buildChangedCharMasks`.
// react-doctor-disable-next-line react-doctor/only-export-components
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
                                // Positional, and deliberately so. The key was once
                                // `${lineNumber}-${row}-${text}`, which is stable only while the
                                // document is. Insert a line and every row below it renumbers --
                                // correctly -- so every one of those rows drew a new key and React
                                // discarded its node instead of patching the number on it. While
                                // typing, the host echoes about once a second, so that was the
                                // whole page below the caret being torn down and rebuilt at that
                                // rate: the flicker. A row here is its position in this block and
                                // nothing else; the number and the text are what it DISPLAYS, and
                                // both belong in props, where a change repaints one row.
                                // react-doctor-disable-next-line react-doctor/no-array-index-key
                                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                                key={i}
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
// No Fast Refresh in this build; see the note on `buildChangedCharMasks`.
// react-doctor-disable-next-line react-doctor/only-export-components
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
