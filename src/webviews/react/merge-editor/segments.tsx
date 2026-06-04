// Merge editor segment rendering components.
// CommonSection renders unchanged code lines across all three panes.
// ConflictSection renders conflict hunks with per-hunk resolution controls.
// OverviewRail provides a minimap of conflict locations for quick navigation.

import React, { useMemo } from "react";
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
import { getResultLines } from "./mergeState";
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

function HighlightedLine({ line }: { line: string }): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    return <>{renderSyntaxHighlightedNodes(line, "line")}</>;
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

// --- Line numbers ---

export type LineNumberValue = number | null;

interface LineNumberSpec {
    primary: LineNumberValue[];
    secondary?: LineNumberValue[];
}

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

// --- Code block ---

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

// --- Hunk helpers ---

export interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
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

export function CommonSection({
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

export interface ConflictSectionProps {
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

export function ConflictSection({
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
}

// --- Overview rail ---

export interface OverviewMarker {
    id: number;
    ordinal: number;
    topPct: number;
    heightPct: number;
    changeKind: ConflictSegment["changeKind"];
    resolved: boolean;
}

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
