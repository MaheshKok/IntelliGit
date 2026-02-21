// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, { useCallback, useEffect, useReducer, useRef } from "react";
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

function CodeBlock({ lines, className }: { lines: string[]; className?: string }) {
    return (
        <div className={`code-block ${className ?? ""}`}>
            {lines.map((line, i) => (
                <div key={i} className="code-line">
                    {line || "\u00A0"}
                </div>
            ))}
        </div>
    );
}

function CommonSection({ segment }: { segment: CommonSegment }) {
    return (
        <div className="segment segment-common">
            <div className="column column-left">
                <CodeBlock lines={segment.lines} />
            </div>
            <div className="column column-middle">
                <CodeBlock lines={segment.lines} />
            </div>
            <div className="column column-right">
                <CodeBlock lines={segment.lines} />
            </div>
        </div>
    );
}

function ConflictSection({
    segment,
    resolution,
    onResolve,
}: {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    onResolve: (id: number, resolution: HunkResolution) => void;
}) {
    const maxLines = Math.max(segment.oursLines.length, segment.theirsLines.length, 1);
    const resultLines = getResultLines(segment, resolution);

    const padLines = (lines: string[], count: number) => {
        const padded = [...lines];
        while (padded.length < count) padded.push("");
        return padded;
    };

    const isOurs = resolution === "ours";
    const isTheirs = resolution === "theirs";

    return (
        <div className="segment segment-conflict">
            {/* Left: Ours */}
            <div className={`column column-left conflict-column ${isOurs ? "accepted" : ""}`}>
                <div className="conflict-header">
                    <span className="conflict-label">Yours</span>
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
                            ✕
                        </button>
                    </div>
                </div>
                <CodeBlock
                    lines={padLines(segment.oursLines, maxLines)}
                    className="conflict-ours"
                />
            </div>

            {/* Middle: Result */}
            <div className="column column-middle conflict-column result-column">
                <div className="conflict-header result-header">
                    <span className="conflict-label">
                        {resolution ? `Result (${resolution})` : "Unresolved"}
                    </span>
                </div>
                <CodeBlock
                    lines={padLines(resultLines, maxLines)}
                    className={`conflict-result ${resolution ? "resolved" : "unresolved"}`}
                />
            </div>

            {/* Right: Theirs */}
            <div className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}>
                <div className="conflict-header">
                    <div className="conflict-actions">
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Discard theirs (accept yours)"
                        >
                            ✕
                        </button>
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, isTheirs ? "none" : "theirs")}
                            title="Accept theirs"
                        >
                            ←
                        </button>
                    </div>
                    <span className="conflict-label">Theirs</span>
                </div>
                <CodeBlock
                    lines={padLines(segment.theirsLines, maxLines)}
                    className="conflict-theirs"
                />
            </div>
        </div>
    );
}

function App() {
    const [state, dispatch] = useReducer(reducer, { data: null, error: null, resolutions: {} });
    const scrollRef = useRef<HTMLDivElement>(null);

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
    const canApply = allResolved(segments, state.resolutions);

    return (
        <div className="merge-editor">
            {/* Header */}
            <div className="merge-header">
                <div className="merge-title">
                    <span className="file-path">{state.data.filePath}</span>
                    <span className="conflict-counter">
                        {resolved}/{total} conflicts resolved
                    </span>
                </div>
                <div className="merge-header-actions">
                    <button
                        className="header-btn"
                        onClick={handleAcceptAllYours}
                        title="Accept all yours"
                    >
                        Accept All Yours
                    </button>
                    <button
                        className="header-btn"
                        onClick={handleAcceptAllTheirs}
                        title="Accept all theirs"
                    >
                        Accept All Theirs
                    </button>
                </div>
            </div>

            {/* Column headers */}
            <div className="column-headers">
                <div className="column-header left">{state.data.oursLabel}</div>
                <div className="column-header middle">Result</div>
                <div className="column-header right">{state.data.theirsLabel}</div>
            </div>

            {/* Content */}
            <div className="merge-content" ref={scrollRef}>
                {segments.map((segment, index) =>
                    segment.type === "common" ? (
                        <CommonSection key={index} segment={segment} />
                    ) : (
                        <ConflictSection
                            key={index}
                            segment={segment}
                            resolution={state.resolutions[segment.id]}
                            onResolve={handleResolve}
                        />
                    ),
                )}
            </div>

            {/* Footer */}
            <div className="merge-footer">
                <div className="footer-left">
                    <button className="footer-btn secondary" onClick={handleBulkAcceptYours}>
                        Accept Yours
                    </button>
                    <button className="footer-btn secondary" onClick={handleBulkAcceptTheirs}>
                        Accept Theirs
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
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
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

/* Header */
.merge-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
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
    color: var(--vscode-foreground);
}
.conflict-counter {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}
.merge-header-actions {
    display: flex;
    gap: 6px;
}
.header-btn {
    padding: 3px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
}
.header-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

/* Column headers */
.column-headers {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.column-header {
    flex: 1;
    padding: 4px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editorGroupHeader-tabsBackground);
}
.column-header.left {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #4fc1ff);
}
.column-header.middle {
    text-align: center;
    color: var(--vscode-foreground);
}
.column-header.right {
    text-align: right;
    color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
}

/* Content */
.merge-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
}

/* Segments */
.segment {
    display: flex;
}
.column {
    flex: 1;
    min-width: 0;
    overflow: hidden;
}
.code-block {
    padding: 0;
}
.code-line {
    padding: 0 8px;
    white-space: pre;
    line-height: 20px;
    min-height: 20px;
}

/* Common segments */
.segment-common .code-line {
    color: var(--vscode-editor-foreground);
}
.segment-common .column-middle {
    border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

/* Conflict segments */
.segment-conflict {
    border-top: 2px solid var(--vscode-merge-border, var(--vscode-panel-border, #555));
    border-bottom: 2px solid var(--vscode-merge-border, var(--vscode-panel-border, #555));
    margin: 2px 0;
}
.conflict-column {
    position: relative;
}
.conflict-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px;
    font-size: 11px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.result-header {
    justify-content: center;
}
.conflict-label {
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
}
.conflict-actions {
    display: flex;
    gap: 4px;
}
.action-btn {
    width: 24px;
    height: 20px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    line-height: 1;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
.action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}
.accept-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.discard-btn:hover {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
}

/* Conflict code backgrounds */
.conflict-ours .code-line {
    background: var(--vscode-merge-currentContentBackground, rgba(64, 200, 174, 0.12));
    color: var(--vscode-editor-foreground);
}
.conflict-theirs .code-line {
    background: var(--vscode-merge-incomingContentBackground, rgba(64, 166, 255, 0.12));
    color: var(--vscode-editor-foreground);
}
.conflict-result.unresolved .code-line {
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.08));
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}
.conflict-result.resolved .code-line {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 255, 0, 0.08));
    color: var(--vscode-editor-foreground);
}

.result-column {
    border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.column-left.accepted .conflict-ours .code-line {
    background: var(--vscode-merge-currentContentBackground, rgba(64, 200, 174, 0.25));
}
.column-right.accepted .conflict-theirs .code-line {
    background: var(--vscode-merge-incomingContentBackground, rgba(64, 166, 255, 0.25));
}

/* Footer */
.merge-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    flex-shrink: 0;
}
.footer-left, .footer-right {
    display: flex;
    gap: 6px;
}
.footer-btn {
    padding: 4px 14px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
}
.footer-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.footer-btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
}
.footer-btn.primary.disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.footer-btn.secondary {
    background: var(--vscode-button-secondaryBackground);
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
