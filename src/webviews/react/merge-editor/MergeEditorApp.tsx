// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, { useCallback, useEffect, useMemo, useReducer } from "react";
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
            return segment.baseLines;
    }
}

function buildResultContent(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): string {
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...getResultLines(seg, resolutions[seg.id]));
        }
    }
    return lines.join("\n");
}

function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): boolean {
    return segments.every((seg) => seg.type === "common" || resolutions[seg.id] !== undefined);
}

function conflictCount(segments: MergeSegment[]): number {
    return segments.filter((seg) => seg.type === "conflict").length;
}

function resolvedCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): number {
    return segments.filter((seg) => seg.type === "conflict" && resolutions[seg.id] !== undefined)
        .length;
}

function padLines(lines: string[], count: number): string[] {
    const padded = [...lines];
    while (padded.length < count) padded.push("");
    return padded;
}

// --- Components ---

function LineNumbers({ count, startLine }: { count: number; startLine: number }) {
    return (
        <div className="line-numbers">
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="line-number">
                    {startLine + i}
                </div>
            ))}
        </div>
    );
}

function CodeBlock({
    lines,
    startLine,
    lineCount,
    className,
}: {
    lines: string[];
    startLine: number;
    lineCount: number;
    className?: string;
}) {
    const padded = padLines(lines, lineCount);

    return (
        <div className={`code-block ${className ?? ""}`}>
            <LineNumbers count={lineCount} startLine={startLine} />
            <div className="code-lines">
                {padded.map((line, i) => (
                    <div key={i} className="code-line">
                        {line || "\u00A0"}
                    </div>
                ))}
            </div>
        </div>
    );
}

function CommonSection({
    segment,
    startLine,
    lineCount,
}: {
    segment: CommonSegment;
    startLine: number;
    lineCount: number;
}) {
    return (
        <div className="segment segment-common">
            <div className="column column-left">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
            <div className="column column-middle">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
            <div className="column column-right">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
        </div>
    );
}

function ConflictSection({
    segment,
    resolution,
    startLine,
    lineCount,
    onResolve,
}: {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    startLine: number;
    lineCount: number;
    onResolve: (id: number, resolution: HunkResolution) => void;
}) {
    const resultLines = getResultLines(segment, resolution);

    const isOurs = resolution === "ours";
    const isTheirs = resolution === "theirs";
    const isResolved = resolution !== undefined;

    return (
        <div className="segment segment-conflict">
            <div className="hunk-toolbar">
                <div className="hunk-cell hunk-left">
                    <span className="hunk-side">Yours</span>
                    <div className="conflict-actions">
                        <button
                            className={`action-btn accept-btn ${isOurs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, isOurs ? "none" : "ours")}
                            title="Accept yours"
                        >
                            →
                        </button>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "theirs")}
                            title="Discard yours (accept theirs)"
                        >
                            ×
                        </button>
                    </div>
                </div>
                <div className={`hunk-cell hunk-middle ${isResolved ? "resolved" : "unresolved"}`}>
                    {isResolved ? `Resolved (${resolution})` : "Unresolved"}
                </div>
                <div className="hunk-cell hunk-right">
                    <div className="conflict-actions">
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Discard theirs (accept yours)"
                        >
                            ×
                        </button>
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, isTheirs ? "none" : "theirs")}
                            title="Accept theirs"
                        >
                            ←
                        </button>
                    </div>
                    <span className="hunk-side">Theirs</span>
                </div>
            </div>

            <div className="hunk-columns">
                <div className={`column column-left conflict-column ${isOurs ? "accepted" : ""}`}>
                    <CodeBlock
                        lines={segment.oursLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className="conflict-ours"
                    />
                </div>

                <div className="column column-middle conflict-column result-column">
                    <CodeBlock
                        lines={resultLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className={`conflict-result ${resolution ? "resolved" : "unresolved"}`}
                    />
                </div>

                <div
                    className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}
                >
                    <CodeBlock
                        lines={segment.theirsLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className="conflict-theirs"
                    />
                </div>
            </div>
        </div>
    );
}

function App() {
    const [state, dispatch] = useReducer(reducer, { data: null, error: null, resolutions: {} });

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setConflictData") {
                dispatch({ type: "SET_DATA", data: event.data.data });
            } else if (event.data.type === "loadError") {
                dispatch({ type: "SET_ERROR", message: event.data.message });
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    const handleResolve = useCallback((id: number, resolution: HunkResolution) => {
        dispatch({ type: "RESOLVE_HUNK", id, resolution });
    }, []);

    const handleApply = useCallback(() => {
        if (!state.data) return;
        const content = buildResultContent(state.data.segments, state.resolutions);
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

    const { segments } = state.data;
    const total = conflictCount(segments);
    const resolved = resolvedCount(segments, state.resolutions);
    const unresolved = total - resolved;
    const canApply = allResolved(segments, state.resolutions);
    const changeCount = segments.length;

    const renderedSegments = useMemo(() => {
        let lineCursor = 1;
        return segments.map((segment, index) => {
            const lineCount =
                segment.type === "common"
                    ? Math.max(segment.lines.length, 1)
                    : Math.max(
                          segment.oursLines.length,
                          getResultLines(segment, state.resolutions[segment.id]).length,
                          segment.theirsLines.length,
                          1,
                      );
            const startLine = lineCursor;
            lineCursor += lineCount;
            return { segment, index, startLine, lineCount };
        });
    }, [segments, state.resolutions]);

    return (
        <div className="merge-editor">
            <div className="merge-toolbar">
                <div className="toolbar-left">
                    <button className="toolbar-btn">Apply non-conflicting changes</button>
                    <button className="toolbar-btn subtle">Do not ignore</button>
                    <button className="toolbar-btn subtle">Highlight words</button>
                </div>
                <div className="toolbar-right">
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllYours}
                        title="Accept all yours"
                    >
                        Accept All Yours
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllTheirs}
                        title="Accept all theirs"
                    >
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
                    {changeCount} change{changeCount === 1 ? "" : "s"}, {unresolved} conflict
                    {unresolved === 1 ? "" : "s"}
                </div>
            </div>

            <div className="pane-meta-row">
                <div className="pane-meta">
                    <span>Changes from {state.data.oursLabel.toLowerCase()}</span>
                    <span className="show-details">Show Details</span>
                </div>
                <div className="pane-meta pane-meta-center">
                    <span>Result</span>
                </div>
                <div className="pane-meta pane-meta-right">
                    <span>Changes from {state.data.theirsLabel.toLowerCase()}</span>
                    <span className="show-details">Show Details</span>
                </div>
            </div>

            <div className="column-headers">
                <div className="column-header left">{state.data.oursLabel}</div>
                <div className="column-header middle">Result</div>
                <div className="column-header right">{state.data.theirsLabel}</div>
            </div>

            <div className="merge-content">
                {renderedSegments.map(({ segment, index, startLine, lineCount }) =>
                    segment.type === "common" ? (
                        <CommonSection
                            key={index}
                            segment={segment}
                            startLine={startLine}
                            lineCount={lineCount}
                        />
                    ) : (
                        <ConflictSection
                            key={index}
                            segment={segment}
                            resolution={state.resolutions[segment.id]}
                            startLine={startLine}
                            lineCount={lineCount}
                            onResolve={handleResolve}
                        />
                    ),
                )}
            </div>

            <div className="merge-footer">
                <div className="footer-left">
                    <button className="footer-btn secondary" onClick={handleBulkAcceptYours}>
                        Accept Left
                    </button>
                    <button className="footer-btn secondary" onClick={handleBulkAcceptTheirs}>
                        Accept Right
                    </button>
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

// --- Styles ---

const STYLES = `
.merge-editor {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 12px;
}

.loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100vh;
    color: var(--vscode-descriptionForeground);
}
.error-message {
    color: var(--vscode-errorForeground, #f48771);
    max-width: 500px;
    text-align: center;
}
.retry-btn {
    padding: 4px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
}
.retry-btn:hover {
    background: var(--vscode-button-hoverBackground);
}

.merge-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground));
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.toolbar-left,
.toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
}
.toolbar-btn {
    height: 20px;
    padding: 0 8px;
    border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 11px;
    line-height: 18px;
    cursor: pointer;
}
.toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}
.toolbar-btn.subtle {
    background: transparent;
    border-color: transparent;
    color: var(--vscode-descriptionForeground);
}
.toolbar-btn.subtle:hover {
    border-color: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.06));
}

.merge-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    flex-shrink: 0;
}
.merge-title {
    display: flex;
    align-items: center;
    gap: 12px;
}
.file-path {
    font-weight: 600;
    font-size: 15px;
    color: var(--vscode-foreground);
}
.conflict-counter {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
}
.merge-stats {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}

.pane-meta-row {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: color-mix(in srgb, var(--vscode-editorGroupHeader-tabsBackground) 80%, transparent);
}
.pane-meta {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.pane-meta-center {
    justify-content: center;
    color: var(--vscode-foreground);
}
.pane-meta-right {
    border-right: none;
}
.show-details {
    color: var(--vscode-textLink-foreground, #4ea1ff);
}

.column-headers {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-editorGroupHeader-tabsBackground);
}
.column-header {
    flex: 1;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--vscode-descriptionForeground);
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.column-header.left {
    color: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #d7ba7d) 90%, white);
}
.column-header.middle {
    text-align: center;
    color: var(--vscode-foreground);
}
.column-header.right {
    text-align: right;
    color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #89d185) 90%, white);
    border-right: none;
}

.merge-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    font-family: "JetBrains Mono", var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 22px;
    background: var(--vscode-editor-background);
}

.segment {
    display: flex;
}
.column {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.column-right {
    border-right: none;
}
.code-block {
    display: grid;
    grid-template-columns: 46px 1fr;
}
.line-numbers {
    background: color-mix(in srgb, var(--vscode-sideBar-background) 45%, transparent);
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
}
.line-number {
    padding: 0 8px 0 4px;
    text-align: right;
    min-height: 22px;
    line-height: 22px;
    font-size: 11px;
    opacity: 0.92;
}
.code-lines {
    min-width: 0;
}
.code-line {
    padding: 0 10px;
    white-space: pre;
    line-height: 22px;
    min-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
}

.segment-common .code-line {
    color: var(--vscode-editor-foreground);
}
.segment-conflict {
    display: block;
    margin: 1px 0 2px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border, #4c566a) 70%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #4c566a) 70%, transparent);
}
.hunk-toolbar {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: color-mix(in srgb, var(--vscode-editorGroupHeader-tabsBackground) 82%, transparent);
}
.hunk-cell {
    min-height: 22px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.hunk-left {
    justify-content: space-between;
}
.hunk-middle {
    justify-content: center;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.2px;
}
.hunk-middle.unresolved {
    background: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(158, 53, 57, 0.45)) 80%, transparent);
    color: var(--vscode-editor-foreground);
}
.hunk-middle.resolved {
    background: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(64, 152, 84, 0.35)) 70%, transparent);
    color: var(--vscode-editor-foreground);
}
.hunk-right {
    justify-content: space-between;
    border-right: none;
}
.hunk-side {
    font-weight: 600;
}

.conflict-column {
    position: relative;
}
.hunk-columns {
    display: flex;
}
.conflict-actions {
    display: flex;
    gap: 3px;
}
.action-btn {
    width: 18px;
    height: 18px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
    background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 70%, transparent);
    color: var(--vscode-foreground);
}
.action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.08));
}
.accept-btn.active {
    border-color: var(--vscode-focusBorder, #4ea1ff);
    background: color-mix(in srgb, var(--vscode-button-background) 62%, transparent);
    color: var(--vscode-button-foreground, #ffffff);
}
.discard-btn:hover {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
}

.conflict-ours .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(158, 53, 57, 0.35)) 72%, transparent);
    color: var(--vscode-editor-foreground);
}
.conflict-theirs .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(57, 127, 78, 0.25)) 58%, transparent);
    color: var(--vscode-editor-foreground);
}
.conflict-result.unresolved .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(111, 40, 44, 0.55)) 82%, transparent);
    color: var(--vscode-editor-foreground);
}
.conflict-result.resolved .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(57, 127, 78, 0.28)) 78%, transparent);
    color: var(--vscode-editor-foreground);
}

.result-column {
    border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.column-left.accepted .conflict-ours .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(158, 53, 57, 0.45)) 95%, transparent);
}
.column-right.accepted .conflict-theirs .code-line {
    background: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(57, 127, 78, 0.36)) 95%, transparent);
}

.merge-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 32px;
    padding: 4px 10px;
    background: color-mix(in srgb, var(--vscode-editorGroupHeader-tabsBackground) 78%, transparent);
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    flex-shrink: 0;
}
.footer-left, .footer-right {
    display: flex;
    gap: 6px;
}
.footer-btn {
    min-height: 22px;
    padding: 0 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    line-height: 20px;
}
.footer-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.footer-btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
}
.footer-btn.primary.disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.footer-btn.secondary {
    background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 70%, transparent);
    color: var(--vscode-button-secondaryForeground);
}
.footer-btn.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}
`;

// --- Mount ---

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
