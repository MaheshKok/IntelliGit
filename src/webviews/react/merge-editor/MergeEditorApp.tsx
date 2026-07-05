// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
    ConflictSegment,
    HunkResolution,
    InboundMessage,
    MergeSegment,
    OutboundMessage,
} from "./types";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import { t } from "../shared/i18n";
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
    getEffectiveResultLines,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
    isTrueConflict,
} from "./mergeState";
import {
    CommonSection,
    ConflictSection,
    OverviewRail,
    type SegmentPaneLineNumbers,
    type OverviewMarker,
} from "./segments";
import { buildLineNumberValues } from "./lineNumbers";
import { initShiki, isShikiReady, langForPath, detectTheme } from "./shikiHighlighter";
import { SyntaxHighlightProvider } from "./syntaxHighlightContext";
import "./merge-editor.css";

const EMPTY_SEGMENTS: MergeSegment[] = [];

/** Horizontal padding of a `.code-line` (0 9px), added to the content width. */
const LINE_PADDING_PX = 18;

// --- VS Code API ---

/** Acquires the typed VS Code API for the interactive three-way merge editor. */
function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

// --- App ---

/**
 * Hosts the three-way merge editor, translating conflict data into synchronized
 * pane rows, local hunk resolutions, overview markers, keyboard navigation, and
 * extension apply/ignore-mode commands.
 */
// Webview entrypoint owns merge-editor state orchestration and root render side effects.
// react-doctor-disable-next-line react-doctor/only-export-components, react-doctor/no-giant-component
function App() {
    const [state, dispatch] = useReducer(reducer, {
        data: null,
        error: null,
        resolutions: {},
        edits: {},
        dismissals: {},
    });
    const [showDetails, setShowDetails] = useState(false);
    const [highlightWords, setHighlightWords] = useState(true);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");
    const [activeConflictId, setActiveConflictId] = useState<number | null>(null);
    const [shikiReady, setShikiReady] = useState(isShikiReady());
    // ponytail: theme sampled once at mount. VS Code reloads the webview on a
    // live theme switch, so re-reading the body class on every render buys
    // nothing — reopen the merge editor to pick up a changed theme.
    const [shikiTheme] = useState(detectTheme());
    const segments = state.data?.segments ?? EMPTY_SEGMENTS;
    const filePath = state.data?.filePath;
    const syntaxHighlightState = useMemo(
        () => ({
            ready: shikiReady,
            lang: filePath ? langForPath(filePath) : null,
            theme: shikiTheme,
        }),
        [shikiReady, filePath, shikiTheme],
    );

    const conflictSectionRefs = useRef<Record<number, HTMLDivElement | null>>({});
    const mergeContentRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const horizontalScrollInnerRef = useRef<HTMLDivElement | null>(null);
    const updateHorizontalScrollWidthRef = useRef<() => void>(() => undefined);
    const lastPaneClientWidthRef = useRef(0);

    const scrollSyncRef = useRef<{ raf: number; left: number }>({ raf: 0, left: 0 });
    const syncHorizontalScroll = useCallback((left: number, source?: HTMLElement | null) => {
        const sync = scrollSyncRef.current;
        sync.left = left;
        if (sync.raf) return;
        sync.raf = requestAnimationFrame(() => {
            sync.raf = 0;
            const targetLeft = sync.left;
            const panes =
                mergeContentRef.current?.querySelectorAll<HTMLElement>(".code-lines") ?? [];
            for (const pane of panes) {
                if (pane === source) continue;
                const max = Math.max(0, pane.scrollWidth - pane.clientWidth);
                const paneLeft = Math.min(targetLeft, max);
                if (Math.abs(pane.scrollLeft - paneLeft) >= 1) pane.scrollLeft = paneLeft;
            }
            const bar = horizontalScrollRef.current;
            if (bar && bar !== source && Math.abs(bar.scrollLeft - targetLeft) >= 1) {
                bar.scrollLeft = targetLeft;
            }
        });
    }, []);

    const handlePaneScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            if (target.classList.contains("code-lines")) {
                const left = target.scrollLeft;
                const sharedLeft = scrollSyncRef.current.left;
                if (Math.abs(left - sharedLeft) < 1) return;
                const max = target.scrollWidth - target.clientWidth;
                if (left > max - 1 && sharedLeft > max - 1) return;
                syncHorizontalScroll(left, target);
                return;
            }
            if (scrollSyncRef.current.left > 0) {
                syncHorizontalScroll(scrollSyncRef.current.left, target);
            }
        },
        [syncHorizontalScroll],
    );
    const handleHorizontalScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            syncHorizontalScroll(event.currentTarget.scrollLeft, event.currentTarget);
        },
        [syncHorizontalScroll],
    );
    // Widest line across every pane, derived from the data rather than the DOM.
    // The monospace editor font makes 1ch == one glyph, so this length sizes the
    // synthetic scrollbar without measuring each pane — and it counts lines in
    // offscreen segments whose content-visibility-collapsed scrollWidth would
    // otherwise read short.
    const maxLineLength = useMemo(() => {
        let max = 1;
        for (const segment of segments) {
            if (segment.type === "common") {
                for (const line of segment.lines) max = Math.max(max, line.length);
            } else {
                for (const line of segment.oursLines) max = Math.max(max, line.length);
                for (const line of segment.theirsLines) max = Math.max(max, line.length);
                for (const line of segment.baseLines) max = Math.max(max, line.length);
                // Auto-merged lines splice both sides together, so a merged line
                // can be longer than any single side.
                for (const line of segment.autoResolvedLines ?? []) {
                    max = Math.max(max, line.length);
                }
            }
        }
        for (const lines of Object.values(state.edits)) {
            for (const line of lines) max = Math.max(max, line.length);
        }
        return max;
    }, [segments, state.edits]);
    const updateHorizontalScrollWidth = useCallback(() => {
        const bar = horizontalScrollRef.current;
        const inner = horizontalScrollInnerRef.current;
        const content = mergeContentRef.current;
        if (!bar || !inner || !content) return;
        // The narrowest pane overflows first, so it sets the shared scroll extent.
        // Column widths follow normal flow even under content-visibility (only
        // height collapses), so one segment's panes give the right clientWidth
        // without walking every segment.
        const firstPanes = content
            .querySelector(".segment")
            ?.querySelectorAll<HTMLElement>(".code-lines");
        let minClientWidth = Infinity;
        for (const pane of firstPanes ?? []) {
            // A skipped (content-visibility) segment's panes report 0; ignore
            // those and fall back to the last real width below.
            if (pane.clientWidth > 0) {
                minClientWidth = Math.min(minClientWidth, pane.clientWidth);
            }
        }
        // ponytail: reuse the last real width when the first segment is offscreen
        // and layout-skipped. It only drifts if the window is resized while
        // scrolled past segment 0, and self-corrects on the next render tick.
        if (minClientWidth === Infinity) {
            minClientWidth = lastPaneClientWidthRef.current;
        } else {
            lastPaneClientWidthRef.current = minClientWidth;
        }
        // 100% == bar width; the ch term is the content width (monospace) and the
        // px terms add the line padding and subtract the visible pane, leaving
        // exactly the overflow the bar must cover.
        inner.style.width = `calc(100% + ${maxLineLength}ch + ${LINE_PADDING_PX}px - ${minClientWidth}px)`;
        const maxScroll = Math.max(0, inner.offsetWidth - bar.clientWidth);
        bar.hidden = maxScroll < 1;
        if (scrollSyncRef.current.left > maxScroll) {
            syncHorizontalScroll(maxScroll);
        }
    }, [maxLineLength, syncHorizontalScroll]);
    useEffect(() => {
        updateHorizontalScrollWidthRef.current = updateHorizontalScrollWidth;
    }, [updateHorizontalScrollWidth]);
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
            let renderKey: string;

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
                renderKey = `common-${oursCursor}-${baseCursor}-${theirsCursor}-${commonLen}-${segment.lines[0] ?? ""}`;
                oursCursor += commonLen;
                baseCursor += commonLen;
                theirsCursor += commonLen;
                resultCursor += commonLen;
            } else {
                const resultLines = getEffectiveResultLines(
                    segment,
                    state.resolutions[segment.id],
                    state.edits[segment.id],
                );
                const oursLen = segment.oursLines.length;
                const theirsLen = segment.theirsLines.length;
                const baseLen = segment.baseLines.length;
                const resultLen = resultLines.length;

                // Panes render contiguously from the hunk top (PyCharm-style),
                // so the hunk height is simply the tallest pane.
                lineCount = Math.max(oursLen, theirsLen, resultLen, 1);
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
                renderKey = `conflict-${segment.id}`;
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
                if (isTrueConflict(segment)) {
                    trueConflictOrdinal += 1;
                    computedTrueConflictOrdinal = trueConflictOrdinal;
                }
            }

            return {
                segment,
                index,
                renderKey,
                startLine,
                lineCount,
                lineNumbers,
                conflictOrdinal: computedConflictOrdinal,
                trueConflictOrdinal: computedTrueConflictOrdinal,
            };
        });
    }, [segments, state.resolutions, state.edits]);

    useEffect(() => {
        const raf = requestAnimationFrame(updateHorizontalScrollWidth);
        return () => cancelAnimationFrame(raf);
    }, [renderedSegments, updateHorizontalScrollWidth]);

    useEffect(() => {
        const handleResize = () => updateHorizontalScrollWidthRef.current();
        window.addEventListener("resize", handleResize);
        const sync = scrollSyncRef.current;
        return () => {
            window.removeEventListener("resize", handleResize);
            if (sync.raf) cancelAnimationFrame(sync.raf);
        };
    }, []);

    const conflictSegments = useMemo(
        () => segments.filter((seg): seg is ConflictSegment => seg.type === "conflict"),
        [segments],
    );
    const trueConflicts = useMemo(
        () => conflictSegments.filter(isTrueConflict),
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

    // Lazily initialize the Shiki highlighter once; flip ready so consumers
    // switch from the fallback tokenizer to grammar-accurate colors.
    useEffect(() => {
        if (shikiReady) return;
        if (initShiki()) setShikiReady(true);
    }, [shikiReady]);

    useEffect(() => {
        setActiveConflictId((prev) => {
            if (trueConflictIds.length === 0) return null;
            if (prev !== null && trueConflictIds.includes(prev)) return prev;
            const firstUnresolved = trueConflicts.find(
                (seg) =>
                    state.resolutions[seg.id] === undefined && state.edits[seg.id] === undefined,
            );
            return firstUnresolved?.id ?? trueConflictIds[0];
        });
    }, [trueConflictIds, trueConflicts, state.resolutions, state.edits]);

    const handleResolve = useCallback((id: number, resolution: HunkResolution) => {
        setActiveConflictId(id);
        dispatch({ type: "RESOLVE_HUNK", id, resolution });
    }, []);

    const handleEditResult = useCallback((id: number, lines: string[]) => {
        setActiveConflictId(id);
        dispatch({ type: "EDIT_HUNK_RESULT", id, lines });
    }, []);

    const handleDismissSide = useCallback((id: number, side: "ours" | "theirs") => {
        setActiveConflictId(id);
        dispatch({ type: "DISMISS_SIDE", id, side });
    }, []);

    const registerConflictSectionRef = useCallback((id: number, el: HTMLDivElement | null) => {
        conflictSectionRefs.current[id] = el;
    }, []);

    const handleApply = useCallback(() => {
        if (!state.data) return;
        const content = buildResultContent(state.data, state.resolutions, state.edits);
        getVsCodeApi().postMessage({ type: "applyResolution", content });
    }, [state.data, state.resolutions, state.edits]);

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

    const handleOpenConflictSession = useCallback(() => {
        getVsCodeApi().postMessage({ type: "openConflictSession" });
    }, []);

    const handleAbortMerge = useCallback(() => {
        getVsCodeApi().postMessage({ type: "abortMerge" });
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

    const resolveActiveFromKeyboard = useCallback(
        (resolution: HunkResolution) => {
            if (!state.data) return;
            const targetId =
                activeConflictId !== null
                    ? activeConflictId
                    : trueConflicts.find(
                          (seg) =>
                              state.resolutions[seg.id] === undefined &&
                              state.edits[seg.id] === undefined,
                      )?.id;
            if (targetId === undefined) return;
            const segment = state.data.segments.find(
                (seg): seg is ConflictSegment => seg.type === "conflict" && seg.id === targetId,
            );
            if (!segment) return;
            // Stacking both sides (in either order) only makes sense when both
            // sides changed the same region.
            if (
                (resolution === "both" || resolution === "both-reversed") &&
                segment.changeKind !== "conflict"
            )
                return;
            handleResolve(targetId, resolution);
            // IntelliJ-style: move on to the next unresolved conflict after applying.
            const targetIndex = trueConflicts.findIndex((seg) => seg.id === targetId);
            const ordered = [
                ...trueConflicts.slice(targetIndex + 1),
                ...trueConflicts.slice(0, Math.max(targetIndex, 0)),
            ];
            const next = ordered.find(
                (seg) =>
                    seg.id !== targetId &&
                    state.resolutions[seg.id] === undefined &&
                    state.edits[seg.id] === undefined,
            );
            if (next) jumpToConflict(next.id);
        },
        [
            activeConflictId,
            handleResolve,
            jumpToConflict,
            state.data,
            state.edits,
            state.resolutions,
            trueConflicts,
        ],
    );

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            const normalizedKey = event.key.toLowerCase();
            const hasCommandModifier = event.ctrlKey || event.metaKey;
            const plainKey = !hasCommandModifier && !event.altKey;

            if ((normalizedKey === "p" && plainKey) || (event.shiftKey && event.key === "F7")) {
                event.preventDefault();
                moveActiveConflict(-1);
            } else if ((normalizedKey === "n" && plainKey) || event.key === "F7") {
                event.preventDefault();
                moveActiveConflict(1);
            } else if (hasCommandModifier && event.key === "ArrowLeft") {
                event.preventDefault();
                resolveActiveFromKeyboard("ours");
            } else if (hasCommandModifier && event.key === "ArrowRight") {
                event.preventDefault();
                resolveActiveFromKeyboard("theirs");
            } else if (normalizedKey === "b" && plainKey) {
                event.preventDefault();
                resolveActiveFromKeyboard("both");
            } else if (normalizedKey === "x" && plainKey) {
                event.preventDefault();
                resolveActiveFromKeyboard("none");
            } else if (hasCommandModifier && event.key === "Enter") {
                if (!state.data) return;
                if (!allResolved(state.data.segments, state.resolutions, state.edits)) return;
                event.preventDefault();
                handleApply();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        handleApply,
        moveActiveConflict,
        resolveActiveFromKeyboard,
        state.data,
        state.resolutions,
        state.edits,
    ]);

    if (state.error) {
        return (
            <div className="loading">
                <div className="error-message">{t("merge.error.load", { error: state.error })}</div>
                <button type="button" className="retry-btn" onClick={handleRetry}>
                    {t("merge.error.retry")}
                </button>
            </div>
        );
    }

    if (!state.data) {
        return <div className="loading">{t("merge.loading")}</div>;
    }

    const total = trueConflictCount(segments);
    const resolved = resolvedTrueConflictCount(segments, state.resolutions, state.edits);
    const unresolved = total - resolved;
    const canApply = allResolved(segments, state.resolutions, state.edits);
    const changeCount = conflictSegments.length;
    // One-sided hunks auto-resolve to the changed side, so they never block Apply.
    const autoResolvedCount = changeCount - total;
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
                !isTrueConflict(item.segment) ||
                state.resolutions[item.segment.id] !== undefined ||
                state.edits[item.segment.id] !== undefined,
        }));

    const unresolvedTrueConflictIds = trueConflicts
        .filter(
            (seg) => state.resolutions[seg.id] === undefined && state.edits[seg.id] === undefined,
        )
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

    // Widen the line-number gutter with the largest line number so editor-size
    // digits never clip, floored at the base width for small files. When the
    // host supplied editor.fontSize, use it as the code size, overriding the
    // unreliable --vscode-editor-font-size webview variable.
    const gutterDigits = Math.max(String(totalVisualLines).length, 2);
    const rootStyle = {
        "--merge-line-number-gutter": `max(37px, calc(${gutterDigits}ch + 14px))`,
        ...(state.data.editorFontSize
            ? { "--merge-code-font-size": `${state.data.editorFontSize}px` }
            : {}),
    } as React.CSSProperties;

    return (
        <SyntaxHighlightProvider value={syntaxHighlightState}>
            <div
                style={rootStyle}
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
                        <button
                            type="button"
                            className="toolbar-btn subtle"
                            onClick={handleApplyNonConflicting}
                            disabled={autoResolvedCount === 0}
                        >
                            <span className="toolbar-icon">
                                <IconSpark />
                            </span>
                            {t("merge.toolbar.applyNonConflicting")}
                        </button>
                        <div className="toolbar-nav-group">
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                onClick={() => moveActiveConflict(-1)}
                                title={t("merge.toolbar.prevConflict.title")}
                                aria-label={t("merge.toolbar.prevConflict.label")}
                                disabled={total === 0}
                            >
                                <IconChevronUp />
                            </button>
                            <button
                                type="button"
                                className="toolbar-icon-btn"
                                onClick={() => moveActiveConflict(1)}
                                title={t("merge.toolbar.nextConflict.title")}
                                aria-label={t("merge.toolbar.nextConflict.label")}
                                disabled={total === 0}
                            >
                                <IconChevronDown />
                            </button>
                        </div>
                        <div className="toolbar-separator" />
                        <button
                            type="button"
                            className="toolbar-btn subtle dropdown"
                            onClick={handleToggleIgnoreMode}
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
                            onClick={() => setHighlightWords((v) => !v)}
                            aria-pressed={highlightWords}
                        >
                            <span className="toolbar-icon">
                                <IconEye />
                            </span>
                            {t("merge.toolbar.highlightWords")}
                        </button>
                        <button
                            type="button"
                            className={`toolbar-btn subtle ${showDetails ? "active" : ""}`}
                            onClick={() => setShowDetails((v) => !v)}
                            aria-pressed={showDetails}
                        >
                            {t("merge.toolbar.showDetails")}
                        </button>
                    </div>

                    <div className="toolbar-center">
                        <span className="toolbar-status-pill">
                            <span className="toolbar-icon">
                                <IconWarning />
                            </span>
                            {t("merge.status.unresolved", { count: unresolved })}
                        </span>
                        <span className="toolbar-status-pill muted">
                            {t("merge.status.resolved", { resolved, total })}
                        </span>
                        <span className="toolbar-status-pill muted">
                            {t("merge.count.changes", { count: changeCount })}
                        </span>
                        {currentConflictIndex > 0 ? (
                            <button
                                type="button"
                                className="toolbar-inline-link"
                                onClick={() => {
                                    if (nextUnresolvedId !== null) jumpToConflict(nextUnresolvedId);
                                }}
                                disabled={nextUnresolvedId === null}
                                title={t("merge.toolbar.jumpUnresolved.title")}
                            >
                                {t("merge.status.hunk", { current: currentConflictIndex, total })}
                            </button>
                        ) : null}
                    </div>

                    <div className="toolbar-right">
                        <button
                            type="button"
                            className="toolbar-btn"
                            onClick={handleAcceptAllYours}
                            title={t("merge.toolbar.acceptAllYours.title")}
                        >
                            <span className="toolbar-icon">
                                <IconArrowRight />
                            </span>
                            {t("merge.toolbar.acceptAllYours.label")}
                        </button>
                        <button
                            type="button"
                            className="toolbar-btn"
                            onClick={handleAcceptAllTheirs}
                            title={t("merge.toolbar.acceptAllTheirs.title")}
                        >
                            <span className="toolbar-icon">
                                <IconArrowLeft />
                            </span>
                            {t("merge.toolbar.acceptAllTheirs.label")}
                        </button>
                    </div>
                </div>

                <div className="merge-header">
                    <div className="merge-title">
                        <span className="file-path">{state.data.filePath}</span>
                        <span className="conflict-counter">
                            {t("merge.header.conflictsResolved", { resolved, total })}
                        </span>
                    </div>
                    <div className="merge-stats">
                        <span className="merge-stat-pill">
                            {t("merge.count.changes", { count: changeCount })}
                        </span>
                        {autoResolvedCount > 0 ? (
                            <span className="merge-stat-pill ok">
                                {t("merge.header.autoResolved", { count: autoResolvedCount })}
                            </span>
                        ) : null}
                        <span className={`merge-stat-pill ${unresolved > 0 ? "warn" : "ok"}`}>
                            {t("merge.count.conflicts", { count: unresolved })}
                        </span>
                    </div>
                </div>

                <div className="pane-meta-row">
                    <div className="pane-meta">
                        <span className="pane-meta-label">
                            <span className="toolbar-icon pane-lock">
                                <IconLock />
                            </span>
                            {t("merge.pane.changesFrom", { label: state.data.oursLabel })}
                        </span>
                        <span className="pane-meta-right-group">
                            <span className="pane-meta-counts">
                                {t("merge.count.changes", { count: oursChanges })},{" "}
                                {t("merge.count.conflicts", { count: total })}
                            </span>
                            <button
                                type="button"
                                className="show-details"
                                onClick={() => setShowDetails((v) => !v)}
                            >
                                {showDetails
                                    ? t("merge.toolbar.hideDetails")
                                    : t("merge.toolbar.showDetails")}
                            </button>
                        </span>
                    </div>
                    <div className="pane-meta pane-meta-center">
                        <span>{t("merge.pane.result", { path: state.data.filePath })}</span>
                    </div>
                    <div className="pane-meta pane-meta-right">
                        <span className="pane-meta-label">
                            <span className="toolbar-icon pane-lock">
                                <IconLock />
                            </span>
                            {t("merge.pane.changesFrom", { label: state.data.theirsLabel })}
                        </span>
                        <span className="pane-meta-right-group">
                            <span className="pane-meta-counts">
                                {t("merge.count.changes", { count: theirsChanges })},{" "}
                                {t("merge.count.conflicts", { count: total })}
                            </span>
                            <button
                                type="button"
                                className="show-details"
                                onClick={() => setShowDetails((v) => !v)}
                            >
                                {showDetails
                                    ? t("merge.toolbar.hideDetails")
                                    : t("merge.toolbar.showDetails")}
                            </button>
                        </span>
                    </div>
                </div>

                <div className="merge-content-shell">
                    <div
                        ref={mergeContentRef}
                        className="merge-content"
                        onScrollCapture={handlePaneScroll}
                    >
                        <div className="merge-scroll-width">
                            {renderedSegments.map(
                                ({
                                    segment,
                                    renderKey,
                                    lineCount,
                                    lineNumbers,
                                    conflictOrdinal,
                                    trueConflictOrdinal,
                                }) =>
                                    segment.type === "common" ? (
                                        <CommonSection
                                            key={renderKey}
                                            segment={segment}
                                            lineCount={lineCount}
                                            lineNumbers={lineNumbers}
                                            highlightWords={highlightWords}
                                        />
                                    ) : (
                                        <ConflictSection
                                            key={renderKey}
                                            segment={segment}
                                            resolution={state.resolutions[segment.id]}
                                            editedLines={state.edits[segment.id]}
                                            dismissed={state.dismissals[segment.id]}
                                            lineCount={lineCount}
                                            lineNumbers={lineNumbers}
                                            onResolve={handleResolve}
                                            onEditResult={handleEditResult}
                                            onDismiss={handleDismissSide}
                                            onSelect={setActiveConflictId}
                                            onSectionRef={registerConflictSectionRef}
                                            isActive={activeConflictId === segment.id}
                                            showDetails={showDetails}
                                            highlightWords={highlightWords}
                                            conflictOrdinal={conflictOrdinal ?? segment.id + 1}
                                            trueConflictOrdinal={trueConflictOrdinal}
                                        />
                                    ),
                            )}
                        </div>
                    </div>
                    <div
                        ref={horizontalScrollRef}
                        className="merge-horizontal-scroll"
                        aria-hidden="true"
                        onScroll={handleHorizontalScroll}
                    >
                        <div
                            ref={horizontalScrollInnerRef}
                            className="merge-horizontal-scroll-inner"
                        />
                    </div>
                    <OverviewRail
                        markers={overviewMarkers}
                        activeConflictId={activeConflictId}
                        onJump={jumpToConflict}
                    />
                </div>

                <div className="merge-footer">
                    <div className="footer-left">
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleBulkAcceptYours}
                        >
                            {t("merge.footer.useFileOurs")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleBulkAcceptTheirs}
                        >
                            {t("merge.footer.useFileTheirs")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary ghost"
                            onClick={handleOpenConflictSession}
                        >
                            {t("mergeSession.title")}
                        </button>
                        <span className="footer-hint">{t("merge.footer.hint")}</span>
                    </div>
                    <div className="footer-right">
                        <button
                            type="button"
                            className="footer-btn danger"
                            onClick={handleAbortMerge}
                        >
                            {t("merge.action.abortMerge")}
                        </button>
                        <button
                            type="button"
                            className="footer-btn secondary"
                            onClick={handleClose}
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            className={`footer-btn primary ${canApply ? "" : "disabled"}`}
                            onClick={handleApply}
                            disabled={!canApply}
                        >
                            {t("merge.footer.apply", { resolved, total })}
                        </button>
                    </div>
                </div>
            </div>
        </SyntaxHighlightProvider>
    );
}

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
