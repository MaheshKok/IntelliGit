// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
    MergeEditorData,
    MergeSegment,
    CommonSegment,
    ConflictSegment,
    HunkResolution,
    InboundMessage,
    OutboundMessage,
} from "./types";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import "./merge-editor.css";

// --- VS Code API ---

function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

// --- State ---

interface State {
    data: MergeEditorData | null;
    error: string | null;
    resolutions: Record<number, HunkResolution>;
}

type Action =
    | { type: "SET_DATA"; data: MergeEditorData }
    | { type: "SET_ERROR"; message: string }
    | { type: "RESOLVE_HUNK"; id: number; resolution: HunkResolution };

const TOKEN_REGEX =
    /("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`)|\b(import|from|const|let|var|class|interface|type|function|return|if|else|for|while|switch|case|break|continue|new|export|default|private|public|protected|readonly|static|async|await)\b|\b(true|false|null|undefined)\b|\b\d+(\.\d+)?\b/g;

function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "SET_DATA":
            return { ...state, data: action.data, error: null, resolutions: {} };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "RESOLVE_HUNK":
            return {
                ...state,
                resolutions: { ...state.resolutions, [action.id]: action.resolution },
            };
        default:
            return state;
    }
}

// --- Helpers ---

function getResultLines(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
): string[] {
    switch (resolution) {
        case "ours":
            return segment.oursLines;
        case "theirs":
            return segment.theirsLines;
        case "both":
            return [...segment.oursLines, ...segment.theirsLines];
        case "none":
            return [];
        default:
            // Non-conflicting changes auto-resolve to the changed side
            if (segment.changeKind === "ours-only") return segment.oursLines;
            if (segment.changeKind === "theirs-only") return segment.theirsLines;
            return segment.baseLines;
    }
}

function buildResultContent(
    data: MergeEditorData,
    resolutions: Record<number, HunkResolution>,
): string {
    const { segments } = data;
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...getResultLines(seg, resolutions[seg.id]));
        }
    }
    const eol = data.eol ?? "\n";
    const joined = lines.join(eol);
    return data.hasTrailingNewline ? joined + eol : joined;
}

function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): boolean {
    return segments.every(
        (seg) =>
            seg.type === "common" ||
            seg.changeKind !== "conflict" ||
            resolutions[seg.id] !== undefined,
    );
}

function trueConflictCount(segments: MergeSegment[]): number {
    return segments.filter((seg) => seg.type === "conflict" && seg.changeKind === "conflict")
        .length;
}

function resolvedTrueConflictCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): number {
    return segments.filter(
        (seg) =>
            seg.type === "conflict" &&
            seg.changeKind === "conflict" &&
            resolutions[seg.id] !== undefined,
    ).length;
}

function padLines(lines: string[], count: number): string[] {
    const padded = [...lines];
    while (padded.length < count) padded.push("");
    return padded;
}

type LineNumberValue = number | null;

interface LineNumberSpec {
    primary: LineNumberValue[];
    secondary?: LineNumberValue[];
}

function buildLineNumberValues(
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

// --- Components ---

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
}

function IconArrowRight(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M5 3l5 5-5 5-.7-.7L8.6 8 4.3 3.7z" />
        </svg>
    );
}

function IconArrowLeft(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M11 3l.7.7L7.4 8l4.3 4.3-.7.7-5-5z" />
        </svg>
    );
}

function IconChevronUp(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M3.7 10.8L8 6.5l4.3 4.3.7-.7L8 5.1 3 10.1z" />
        </svg>
    );
}

function IconChevronDown(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M3.7 5.2L3 5.9l5 5 5-5-.7-.7L8 9.5z" />
        </svg>
    );
}

function IconClose(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M4.7 4L8 7.3 11.3 4l.7.7L8.7 8l3.3 3.3-.7.7L8 8.7 4.7 12l-.7-.7L7.3 8 4 4.7z"
            />
        </svg>
    );
}

function IconSpark(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 1l1.6 3.4L13 6l-3.4 1.6L8 11 6.4 7.6 3 6l3.4-1.6zM3 10l.8 1.7L5.5 13l-1.7.8L3 15l-.8-1.2L.5 13l1.7-.8zM12.5 10l.9 1.8L15 12.5l-1.6.7L12.5 15l-.8-1.8-1.7-.7 1.7-.7z"
            />
        </svg>
    );
}

function IconEye(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 3c3.4 0 6 3 6.7 4-.7 1-3.3 4-6.7 4S2 8 1.3 7C2 6 4.6 3 8 3zm0 1C5.5 4 3.4 6 2.5 7c.9 1 3 3 5.5 3s4.6-2 5.5-3c-.9-1-3-3-5.5-3zm0 1.5A1.5 1.5 0 1 1 8 8.5 1.5 1.5 0 0 1 8 5.5z"
            />
        </svg>
    );
}

function IconFilter(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M2 3h12L9.5 8v4.2l-3 1V8z" />
        </svg>
    );
}

function IconLock(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M11 6V5a3 3 0 00-6 0v1H4v8h8V6h-1zm-4-1a2 2 0 114 0v1H7V5zm3 8H6V7h4v6z"
            />
        </svg>
    );
}

function IconWarning(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 1.6l6.5 11.3H1.5L8 1.6zm0 2L3.2 12h9.6L8 3.6zm-.7 2.1h1.4v3.7H7.3V5.7zm0 4.8h1.4v1.4H7.3v-1.4z"
            />
        </svg>
    );
}

function IconCheck(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M6.3 11.2L2.8 7.7l1-1 2.5 2.5 5.9-5.9 1 1z" />
        </svg>
    );
}

function IconSplitBoth(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M1.5 8l4-4 .9.9L4 7.4h8L9.6 4.9l.9-.9 4 4-4 4-.9-.9 2.4-2.5H4l2.4 2.5-.9.9z"
            />
        </svg>
    );
}

function IconDot(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="8" height="8" aria-hidden="true">
            <circle cx="8" cy="8" r="4" fill="currentColor" />
        </svg>
    );
}

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

function HighlightedLine({ line }: { line: string }): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    return <>{renderSyntaxHighlightedNodes(line, "line")}</>;
}

function tokenizeWordDiff(line: string): string[] {
    if (line === "") return [];
    return line.match(/(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s]+)/g) ?? [line];
}

function normalizeLineForWordDiff(line: string): string {
    return line.replace(/\s+/g, " ").trim();
}

function computeTokenLcsPairs(a: string[], b: string[]): Array<[number, number]> {
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return [];

    if (m * n > 40_000) {
        // Greedy fallback to avoid expensive matrices on long lines.
        const pairs: Array<[number, number]> = [];
        let j = 0;
        for (let i = 0; i < m && j < n; i++) {
            while (j < n && b[j] !== a[i]) j++;
            if (j < n) {
                pairs.push([i, j]);
                j++;
            }
        }
        return pairs;
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const pairs: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

function tokenSimilarityRatio(a: string, b: string): number {
    if (a === b) return 1;
    const aNorm = normalizeLineForWordDiff(a);
    const bNorm = normalizeLineForWordDiff(b);
    if (aNorm === bNorm) return 0.98;
    if (!aNorm && !bNorm) return 1;
    if (!aNorm || !bNorm) return 0;

    const aTokens = tokenizeWordDiff(aNorm);
    const bTokens = tokenizeWordDiff(bNorm);
    if (aTokens.length === 0 && bTokens.length === 0) return 1;
    if (aTokens.length === 0 || bTokens.length === 0) return 0;

    const lcsLen = computeTokenLcsPairs(aTokens, bTokens).length;
    return (2 * lcsLen) / (aTokens.length + bTokens.length);
}

function alignCompareLinesForWordDiff(lines: string[], compareLines: string[]): string[] {
    if (lines.length === 0) return [];
    if (compareLines.length === 0) return new Array(lines.length).fill("");
    if (lines.length === compareLines.length) {
        return [...compareLines];
    }

    const m = lines.length;
    const n = compareLines.length;
    const gapPenalty = -0.8;
    const pairScoreCache = new Map<string, number>();
    const scorePair = (i: number, j: number): number => {
        const key = `${i}:${j}`;
        const cached = pairScoreCache.get(key);
        if (cached !== undefined) return cached;

        const a = lines[i];
        const b = compareLines[j];
        let score: number;
        if (a === b) {
            score = 4;
        } else {
            const sim = tokenSimilarityRatio(a, b);
            if (normalizeLineForWordDiff(a) === normalizeLineForWordDiff(b)) score = 3.5;
            else if (sim >= 0.78) score = 2.4 + sim;
            else if (sim >= 0.52) score = 1 + sim;
            else if (sim >= 0.34) score = 0.2 + sim * 0.4;
            else score = -1.6;
        }

        pairScoreCache.set(key, score);
        return score;
    };

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    const trace: ("pair" | "skipA" | "skipB")[][] = Array.from({ length: m + 1 }, () =>
        new Array(n + 1).fill("pair"),
    );

    for (let i = m - 1; i >= 0; i--) {
        dp[i][n] = dp[i + 1][n] + gapPenalty;
        trace[i][n] = "skipA";
    }
    for (let j = n - 1; j >= 0; j--) {
        dp[m][j] = dp[m][j + 1] + gapPenalty;
        trace[m][j] = "skipB";
    }

    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            const pair = dp[i + 1][j + 1] + scorePair(i, j);
            const skipA = dp[i + 1][j] + gapPenalty;
            const skipB = dp[i][j + 1] + gapPenalty;

            if (pair >= skipA && pair >= skipB) {
                dp[i][j] = pair;
                trace[i][j] = "pair";
            } else if (skipA >= skipB) {
                dp[i][j] = skipA;
                trace[i][j] = "skipA";
            } else {
                dp[i][j] = skipB;
                trace[i][j] = "skipB";
            }
        }
    }

    const aligned = new Array<string>(m).fill("");
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        const action = trace[i][j];
        if (action === "pair") {
            // Only pair lines for word-diff if they are at least moderately similar.
            aligned[i] =
                tokenSimilarityRatio(lines[i], compareLines[j]) >= 0.28 ? compareLines[j] : "";
            i++;
            j++;
        } else if (action === "skipA") {
            aligned[i] = "";
            i++;
        } else {
            j++;
        }
    }
    while (i < m) {
        aligned[i] = "";
        i++;
    }

    return aligned;
}

function buildWordDiffMask(line: string, compareLine: string): boolean[] {
    const tokens = tokenizeWordDiff(line);
    const compareTokens = tokenizeWordDiff(compareLine);
    const mask = tokens.map(() => true);

    if (tokens.length === 0) return mask;
    if (line === compareLine) return tokens.map(() => false);

    const lcs = computeTokenLcsPairs(tokens, compareTokens);
    for (const [i] of lcs) {
        mask[i] = false;
    }

    return mask;
}

function WordDiffLine({
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
        // PyCharm-style behavior is conservative: for low similarity, keep line-level diff
        // instead of noisy token highlights.
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
}

function CodeBlock({
    lines,
    lineCount,
    lineNumbers,
    className,
    wordHighlight,
    compareLines,
}: {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
}) {
    const padded = useMemo(() => padLines(lines, lineCount), [lines, lineCount]);
    const paddedCompare = useMemo(() => {
        if (!compareLines) return undefined;
        const alignedCompare = alignCompareLinesForWordDiff(lines, compareLines);
        return padLines(alignedCompare, lineCount);
    }, [compareLines, lineCount, lines]);

    return (
        <div className={`code-block ${className ?? ""} ${wordHighlight ? "word-highlight" : ""}`}>
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
}

function getHunkStatus(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
): {
    label: string;
    tone: "warn" | "ok" | "muted";
} {
    if (segment.changeKind === "ours-only") {
        return resolution === "none"
            ? { label: "Dropped left-only change", tone: "muted" }
            : { label: "Left-only change", tone: "muted" };
    }
    if (segment.changeKind === "theirs-only") {
        return resolution === "none"
            ? { label: "Dropped right-only change", tone: "muted" }
            : { label: "Right-only change", tone: "muted" };
    }

    if (resolution === undefined) return { label: "Unresolved", tone: "warn" };
    if (resolution === "ours") return { label: "Use left", tone: "ok" };
    if (resolution === "theirs") return { label: "Use right", tone: "ok" };
    if (resolution === "both") return { label: "Use both", tone: "ok" };
    return { label: "Remove block", tone: "muted" };
}

function getHunkKindLabel(segment: ConflictSegment): string {
    if (segment.changeKind === "ours-only") return "Left only";
    if (segment.changeKind === "theirs-only") return "Right only";
    return "Conflict";
}

function paneChangeCount(segments: MergeSegment[], side: "ours" | "theirs"): number {
    return segments.filter((seg) => {
        if (seg.type !== "conflict") return false;
        if (side === "ours") return seg.changeKind !== "theirs-only";
        return seg.changeKind !== "ours-only";
    }).length;
}

interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
}

function CommonSection({
    segment,
    lineCount,
    lineNumbers,
    highlightWords,
}: {
    segment: CommonSegment;
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    highlightWords: boolean;
}) {
    return (
        <div className="segment segment-common">
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
}

interface ConflictSectionProps {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    onResolve: (id: number, resolution: HunkResolution) => void;
    onSelect: (id: number) => void;
    setSectionRef: (el: HTMLDivElement | null) => void;
    isActive: boolean;
    showDetails: boolean;
    highlightWords: boolean;
    conflictOrdinal: number;
    trueConflictOrdinal?: number;
}

function ConflictSection({
    segment,
    resolution,
    lineCount,
    lineNumbers,
    onResolve,
    onSelect,
    setSectionRef,
    isActive,
    showDetails,
    highlightWords,
    conflictOrdinal,
    trueConflictOrdinal,
}: ConflictSectionProps) {
    const resultLines = getResultLines(segment, resolution);
    const status = getHunkStatus(segment, resolution);

    const isOurs = resolution === "ours";
    const isTheirs = resolution === "theirs";
    const isBoth = resolution === "both";
    const isNone = resolution === "none";
    const isResolved = segment.changeKind !== "conflict" || resolution !== undefined;
    const kindLabel = getHunkKindLabel(segment);
    const resultCompareLines =
        resolution === "ours"
            ? segment.theirsLines
            : resolution === "theirs"
              ? segment.oursLines
              : segment.baseLines;

    return (
        <div
            ref={setSectionRef}
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
                        {trueConflictOrdinal ? `#${trueConflictOrdinal}` : `#${conflictOrdinal}`}
                    </span>
                    <span className="hunk-kind-label">{kindLabel}</span>
                    {showDetails ? (
                        <span className="hunk-detail-lines">
                            L:{segment.oursLines.length} R:{segment.theirsLines.length} Result:
                            {resultLines.length}
                        </span>
                    ) : null}
                </div>
                <div className="hunk-header-center" onClick={(e) => e.stopPropagation()}>
                    <button
                        className={`hunk-choice ${isOurs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "ours")}
                        title="Use left block"
                    >
                        <IconArrowRight />
                        Left
                    </button>
                    {segment.changeKind === "conflict" ? (
                        <button
                            className={`hunk-choice ${isBoth ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "both")}
                            title="Use both blocks"
                        >
                            <IconSplitBoth />
                            Both
                        </button>
                    ) : null}
                    <button
                        className={`hunk-choice ${isTheirs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "theirs")}
                        title="Use right block"
                    >
                        <IconArrowLeft />
                        Right
                    </button>
                    <button
                        className={`hunk-choice danger ${isNone ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "none")}
                        title="Remove this block from result"
                    >
                        <IconClose />
                        Drop
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
                            title="Ignore left block"
                        >
                            <IconClose />
                        </button>
                        <button
                            className={`action-btn accept-btn ${isOurs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Accept left block"
                        >
                            <IconArrowRight />
                        </button>
                    </div>
                </div>

                <div className="column column-middle conflict-column result-column">
                    <CodeBlock
                        lines={resultLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.middle}
                        className={`conflict-result ${isResolved ? "resolved" : "unresolved"}`}
                        wordHighlight={highlightWords}
                        compareLines={resultCompareLines}
                    />
                </div>

                <div
                    className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}
                >
                    <div className="conflict-actions-right" onClick={(e) => e.stopPropagation()}>
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "theirs")}
                            title="Accept right block"
                        >
                            <IconArrowLeft />
                        </button>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Ignore right block"
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
}

interface OverviewMarker {
    id: number;
    topPct: number;
    heightPct: number;
    changeKind: ConflictSegment["changeKind"];
    resolved: boolean;
}

function OverviewRail({
    markers,
    activeConflictId,
    onJump,
}: {
    markers: OverviewMarker[];
    activeConflictId: number | null;
    onJump: (id: number) => void;
}) {
    return (
        <div className="overview-rail" aria-label="Conflict overview">
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
                        title={`Jump to hunk #${marker.id + 1}`}
                        onClick={() => onJump(marker.id)}
                    />
                ))}
            </div>
        </div>
    );
}

function App() {
    const [state, dispatch] = useReducer(reducer, { data: null, error: null, resolutions: {} });
    const [showDetails, setShowDetails] = useState(false);
    const [highlightWords, setHighlightWords] = useState(true);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");
    const [activeConflictId, setActiveConflictId] = useState<number | null>(null);
    const segments = state.data?.segments ?? [];

    const conflictSectionRefs = useRef<Record<number, HTMLDivElement | null>>({});

    const renderedSegments = useMemo(() => {
        let visualLineCursor = 1;
        let oursCursor = 1;
        let baseCursor = 1;
        let theirsCursor = 1;
        let resultCursor = 1;
        let conflictOrdinal = 0;
        let trueConflictOrdinal = 0;

        return segments.map((segment, index) => {
            let lineCount: number;
            let lineNumbers: SegmentPaneLineNumbers;
            let startLine: number;

            if (segment.type === "common") {
                const commonLen = segment.lines.length;
                lineCount = Math.max(commonLen, 1);
                startLine = visualLineCursor;
                lineNumbers = {
                    left: {
                        primary: buildLineNumberValues(oursCursor, commonLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, commonLen, lineCount),
                    },
                    middle: {
                        primary: buildLineNumberValues(resultCursor, commonLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, commonLen, lineCount),
                    },
                    right: {
                        primary: buildLineNumberValues(theirsCursor, commonLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, commonLen, lineCount),
                    },
                };
                oursCursor += commonLen;
                baseCursor += commonLen;
                theirsCursor += commonLen;
                resultCursor += commonLen;
            } else {
                const resultLines = getResultLines(segment, state.resolutions[segment.id]);
                const oursLen = segment.oursLines.length;
                const theirsLen = segment.theirsLines.length;
                const baseLen = segment.baseLines.length;
                const resultLen = resultLines.length;

                lineCount = Math.max(oursLen, resultLen, theirsLen, 1);
                startLine = visualLineCursor;
                lineNumbers = {
                    left: {
                        primary: buildLineNumberValues(oursCursor, oursLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, baseLen, lineCount),
                    },
                    middle: {
                        primary: buildLineNumberValues(resultCursor, resultLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, baseLen, lineCount),
                    },
                    right: {
                        primary: buildLineNumberValues(theirsCursor, theirsLen, lineCount),
                        secondary: buildLineNumberValues(baseCursor, baseLen, lineCount),
                    },
                };
                oursCursor += oursLen;
                baseCursor += baseLen;
                theirsCursor += theirsLen;
                resultCursor += resultLen;
            }

            visualLineCursor += lineCount;

            let computedConflictOrdinal: number | undefined;
            let computedTrueConflictOrdinal: number | undefined;
            if (segment.type === "conflict") {
                conflictOrdinal += 1;
                computedConflictOrdinal = conflictOrdinal;
                if (segment.changeKind === "conflict") {
                    trueConflictOrdinal += 1;
                    computedTrueConflictOrdinal = trueConflictOrdinal;
                }
            }

            return {
                segment,
                index,
                startLine,
                lineCount,
                lineNumbers,
                conflictOrdinal: computedConflictOrdinal,
                trueConflictOrdinal: computedTrueConflictOrdinal,
            };
        });
    }, [segments, state.resolutions]);

    const conflictSegments = useMemo(
        () => segments.filter((seg): seg is ConflictSegment => seg.type === "conflict"),
        [segments],
    );
    const trueConflicts = useMemo(
        () => conflictSegments.filter((seg) => seg.changeKind === "conflict"),
        [conflictSegments],
    );
    const trueConflictIds = useMemo(() => trueConflicts.map((seg) => seg.id), [trueConflicts]);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setConflictData") {
                setIgnoreMode(
                    event.data.data.diffOptions?.ignoreWhitespace ? "whitespace" : "none",
                );
                dispatch({ type: "SET_DATA", data: event.data.data });
            } else if (event.data.type === "loadError") {
                dispatch({ type: "SET_ERROR", message: event.data.message });
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    useEffect(() => {
        setActiveConflictId((prev) => {
            if (trueConflictIds.length === 0) return null;
            if (prev !== null && trueConflictIds.includes(prev)) return prev;
            const firstUnresolved = trueConflicts.find(
                (seg) => state.resolutions[seg.id] === undefined,
            );
            return firstUnresolved?.id ?? trueConflictIds[0];
        });
    }, [trueConflictIds, trueConflicts, state.resolutions]);

    const handleResolve = useCallback((id: number, resolution: HunkResolution) => {
        setActiveConflictId(id);
        dispatch({ type: "RESOLVE_HUNK", id, resolution });
    }, []);

    const handleApply = useCallback(() => {
        if (!state.data) return;
        const content = buildResultContent(state.data, state.resolutions);
        getVsCodeApi().postMessage({ type: "applyResolution", content });
    }, [state.data, state.resolutions]);

    const handleAcceptAllYours = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            }
        }
    }, [state.data]);

    const handleAcceptAllTheirs = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleApplyNonConflicting = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict" && seg.changeKind === "ours-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            } else if (seg.type === "conflict" && seg.changeKind === "theirs-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleBulkAcceptYours = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptYours" });
    }, []);

    const handleBulkAcceptTheirs = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptTheirs" });
    }, []);

    const handleRetry = useCallback(() => {
        dispatch({ type: "SET_ERROR", message: "" });
        getVsCodeApi().postMessage({ type: "ready" });
    }, []);

    const handleClose = useCallback(() => {
        getVsCodeApi().postMessage({ type: "close" });
    }, []);

    const handleToggleIgnoreMode = useCallback(() => {
        const nextMode: "none" | "whitespace" = ignoreMode === "none" ? "whitespace" : "none";
        setIgnoreMode(nextMode);
        getVsCodeApi().postMessage({ type: "setIgnoreMode", mode: nextMode });
    }, [ignoreMode]);

    const jumpToConflict = useCallback((id: number) => {
        setActiveConflictId(id);
        const target = conflictSectionRefs.current[id];
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, []);

    const moveActiveConflict = useCallback(
        (direction: -1 | 1) => {
            if (trueConflictIds.length === 0) return;
            const currentIndex =
                activeConflictId === null ? -1 : trueConflictIds.indexOf(activeConflictId);
            const fallbackIndex = direction > 0 ? -1 : 0;
            const baseIndex = currentIndex === -1 ? fallbackIndex : currentIndex;
            const nextIndex =
                (((baseIndex + direction) % trueConflictIds.length) + trueConflictIds.length) %
                trueConflictIds.length;
            jumpToConflict(trueConflictIds[nextIndex]);
        },
        [activeConflictId, jumpToConflict, trueConflictIds],
    );

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            const normalizedKey = event.key.toLowerCase();

            if (normalizedKey === "n" || event.key === "F7") {
                event.preventDefault();
                moveActiveConflict(1);
            } else if (normalizedKey === "p" || (event.shiftKey && event.key === "F7")) {
                event.preventDefault();
                moveActiveConflict(-1);
            } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                if (!state.data) return;
                if (!allResolved(state.data.segments, state.resolutions)) return;
                event.preventDefault();
                handleApply();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [handleApply, moveActiveConflict, state.data, state.resolutions]);

    if (state.error) {
        return (
            <div className="loading">
                <div className="error-message">Failed to load conflict data: {state.error}</div>
                <button className="retry-btn" onClick={handleRetry}>
                    Retry
                </button>
            </div>
        );
    }

    if (!state.data) {
        return <div className="loading">Loading conflict data...</div>;
    }

    const total = trueConflictCount(segments);
    const resolved = resolvedTrueConflictCount(segments, state.resolutions);
    const unresolved = total - resolved;
    const canApply = allResolved(segments, state.resolutions);
    const changeCount = conflictSegments.length;
    const oursChanges = paneChangeCount(segments, "ours");
    const theirsChanges = paneChangeCount(segments, "theirs");
    const currentConflictIndex =
        activeConflictId !== null ? trueConflictIds.indexOf(activeConflictId) + 1 : 0;

    const totalVisualLines = Math.max(
        renderedSegments.reduce((sum, item) => sum + item.lineCount, 0),
        1,
    );
    const overviewMarkers: OverviewMarker[] = renderedSegments
        .filter(
            (item): item is (typeof renderedSegments)[number] & { segment: ConflictSegment } => {
                return item.segment.type === "conflict";
            },
        )
        .map((item) => ({
            id: item.segment.id,
            topPct: ((item.startLine - 1) / totalVisualLines) * 100,
            heightPct: Math.min(Math.max((item.lineCount / totalVisualLines) * 100, 1), 30),
            changeKind: item.segment.changeKind,
            resolved:
                item.segment.changeKind !== "conflict" ||
                state.resolutions[item.segment.id] !== undefined,
        }));

    const unresolvedTrueConflictIds = trueConflicts
        .filter((seg) => state.resolutions[seg.id] === undefined)
        .map((seg) => seg.id);
    const nextUnresolvedId =
        unresolvedTrueConflictIds.length > 0 ? unresolvedTrueConflictIds[0] : null;

    return (
        <div
            className={[
                "merge-editor",
                highlightWords ? "words-highlighted" : "",
                showDetails ? "details-expanded" : "",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <div className="merge-toolbar">
                <div className="toolbar-left">
                    <button className="toolbar-btn subtle" onClick={handleApplyNonConflicting}>
                        <span className="toolbar-icon">
                            <IconSpark />
                        </span>
                        Apply non-conflicting changes
                    </button>
                    <div className="toolbar-nav-group">
                        <button
                            className="toolbar-icon-btn"
                            onClick={() => moveActiveConflict(-1)}
                            title="Previous conflict (P / Shift+F7)"
                            disabled={total === 0}
                        >
                            <IconChevronUp />
                        </button>
                        <button
                            className="toolbar-icon-btn"
                            onClick={() => moveActiveConflict(1)}
                            title="Next conflict (N / F7)"
                            disabled={total === 0}
                        >
                            <IconChevronDown />
                        </button>
                    </div>
                    <div className="toolbar-separator" />
                    <button
                        className="toolbar-btn subtle dropdown"
                        onClick={handleToggleIgnoreMode}
                        title="Re-parse conflicts with or without whitespace differences"
                    >
                        <span className="toolbar-icon">
                            <IconFilter />
                        </span>
                        {ignoreMode === "none" ? "Do not ignore" : "Ignore whitespace"}
                        <span className="toolbar-icon dropdown-icon">
                            <IconChevronDown />
                        </span>
                    </button>
                    <button
                        className={`toolbar-btn subtle ${highlightWords ? "active" : ""}`}
                        onClick={() => setHighlightWords((v) => !v)}
                        aria-pressed={highlightWords}
                    >
                        <span className="toolbar-icon">
                            <IconEye />
                        </span>
                        Highlight words
                    </button>
                    <button
                        className={`toolbar-btn subtle ${showDetails ? "active" : ""}`}
                        onClick={() => setShowDetails((v) => !v)}
                        aria-pressed={showDetails}
                    >
                        Show Details
                    </button>
                </div>

                <div className="toolbar-center">
                    <span className="toolbar-status-pill">
                        <span className="toolbar-icon">
                            <IconWarning />
                        </span>
                        {unresolved} unresolved
                    </span>
                    <span className="toolbar-status-pill muted">
                        {resolved}/{total} resolved
                    </span>
                    <span className="toolbar-status-pill muted">
                        {changeCount} change{changeCount === 1 ? "" : "s"}
                    </span>
                    {currentConflictIndex > 0 ? (
                        <button
                            className="toolbar-inline-link"
                            onClick={() => {
                                if (nextUnresolvedId !== null) jumpToConflict(nextUnresolvedId);
                            }}
                            disabled={nextUnresolvedId === null}
                            title="Jump to next unresolved conflict"
                        >
                            Hunk {currentConflictIndex}/{total}
                        </button>
                    ) : null}
                </div>

                <div className="toolbar-right">
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllYours}
                        title="Accept all left-side changes into the result"
                    >
                        <span className="toolbar-icon">
                            <IconArrowRight />
                        </span>
                        Accept All Yours
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllTheirs}
                        title="Accept all right-side changes into the result"
                    >
                        <span className="toolbar-icon">
                            <IconArrowLeft />
                        </span>
                        Accept All Theirs
                    </button>
                </div>
            </div>

            <div className="merge-header">
                <div className="merge-title">
                    <span className="file-path">{state.data.filePath}</span>
                    <span className="conflict-counter">
                        {resolved}/{total} conflicts resolved
                    </span>
                </div>
                <div className="merge-stats">
                    <span className="merge-stat-pill">{changeCount} changes</span>
                    <span className={`merge-stat-pill ${unresolved > 0 ? "warn" : "ok"}`}>
                        {unresolved} conflict{unresolved === 1 ? "" : "s"}
                    </span>
                </div>
            </div>

            <div className="pane-meta-row">
                <div className="pane-meta">
                    <span className="pane-meta-label">
                        <span className="toolbar-icon pane-lock">
                            <IconLock />
                        </span>
                        Changes from {state.data.oursLabel}
                    </span>
                    <span className="pane-meta-right-group">
                        <span className="pane-meta-counts">
                            {oursChanges} changes, {total} conflicts
                        </span>
                        <button className="show-details" onClick={() => setShowDetails((v) => !v)}>
                            {showDetails ? "Hide Details" : "Show Details"}
                        </button>
                    </span>
                </div>
                <div className="pane-meta pane-meta-center">
                    <span>Result {state.data.filePath}</span>
                </div>
                <div className="pane-meta pane-meta-right">
                    <span className="pane-meta-label">
                        <span className="toolbar-icon pane-lock">
                            <IconLock />
                        </span>
                        Changes from {state.data.theirsLabel}
                    </span>
                    <span className="pane-meta-right-group">
                        <span className="pane-meta-counts">
                            {theirsChanges} changes, {total} conflicts
                        </span>
                        <button className="show-details" onClick={() => setShowDetails((v) => !v)}>
                            {showDetails ? "Hide Details" : "Show Details"}
                        </button>
                    </span>
                </div>
            </div>

            <div className="merge-content-shell">
                <div className="merge-content">
                    {renderedSegments.map(
                        ({
                            segment,
                            index,
                            lineCount,
                            lineNumbers,
                            conflictOrdinal,
                            trueConflictOrdinal,
                        }) =>
                            segment.type === "common" ? (
                                <CommonSection
                                    key={index}
                                    segment={segment}
                                    lineCount={lineCount}
                                    lineNumbers={lineNumbers}
                                    highlightWords={highlightWords}
                                />
                            ) : (
                                <ConflictSection
                                    key={index}
                                    segment={segment}
                                    resolution={state.resolutions[segment.id]}
                                    lineCount={lineCount}
                                    lineNumbers={lineNumbers}
                                    onResolve={handleResolve}
                                    onSelect={setActiveConflictId}
                                    setSectionRef={(el) => {
                                        conflictSectionRefs.current[segment.id] = el;
                                    }}
                                    isActive={activeConflictId === segment.id}
                                    showDetails={showDetails}
                                    highlightWords={highlightWords}
                                    conflictOrdinal={conflictOrdinal ?? segment.id + 1}
                                    trueConflictOrdinal={trueConflictOrdinal}
                                />
                            ),
                    )}
                </div>
                <OverviewRail
                    markers={overviewMarkers}
                    activeConflictId={activeConflictId}
                    onJump={jumpToConflict}
                />
            </div>

            <div className="merge-footer">
                <div className="footer-left">
                    <button className="footer-btn secondary ghost" onClick={handleBulkAcceptYours}>
                        Use File Ours
                    </button>
                    <button className="footer-btn secondary ghost" onClick={handleBulkAcceptTheirs}>
                        Use File Theirs
                    </button>
                    <span className="footer-hint">
                        `N`/`P` navigate conflicts • `Ctrl/Cmd+Enter` apply
                    </span>
                </div>
                <div className="footer-right">
                    <button className="footer-btn secondary" onClick={handleClose}>
                        Cancel
                    </button>
                    <button
                        className={`footer-btn primary ${canApply ? "" : "disabled"}`}
                        onClick={handleApply}
                        disabled={!canApply}
                    >
                        Apply ({resolved}/{total})
                    </button>
                </div>
            </div>
        </div>
    );
}

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
