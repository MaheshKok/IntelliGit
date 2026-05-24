// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConflictSegment, HunkResolution, InboundMessage, OutboundMessage } from "./types";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import {
    IconArrowRight,
    IconArrowLeft,
    IconChevronUp,
    IconChevronDown,
    IconSpark,
    IconEye,
    IconFilter,
    IconLock,
    IconWarning,
} from "./icons";
import {
    reducer,
    getResultLines,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
} from "./mergeState";
import {
    buildLineNumberValues,
    CommonSection,
    ConflictSection,
    OverviewRail,
    type SegmentPaneLineNumbers,
    type OverviewMarker,
} from "./segments";
import "./merge-editor.css";

// --- VS Code API ---

function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

// --- App ---

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

            if (normalizedKey === "p" || (event.shiftKey && event.key === "F7")) {
                event.preventDefault();
                moveActiveConflict(-1);
            } else if (normalizedKey === "n" || event.key === "F7") {
                event.preventDefault();
                moveActiveConflict(1);
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
            ordinal: item.conflictOrdinal ?? 0,
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
    const nextUnresolvedId = (() => {
        if (unresolvedTrueConflictIds.length === 0) return null;
        if (activeConflictId === null) return unresolvedTrueConflictIds[0];
        const activeIdx = unresolvedTrueConflictIds.indexOf(activeConflictId);
        const nextIdx = activeIdx + 1;
        return nextIdx < unresolvedTrueConflictIds.length
            ? unresolvedTrueConflictIds[nextIdx]
            : unresolvedTrueConflictIds[0];
    })();

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
                            aria-label="Previous conflict"
                            disabled={total === 0}
                        >
                            <IconChevronUp />
                        </button>
                        <button
                            className="toolbar-icon-btn"
                            onClick={() => moveActiveConflict(1)}
                            title="Next conflict (N / F7)"
                            aria-label="Next conflict"
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
