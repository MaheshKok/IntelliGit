import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import type { MergeConflictFile } from "../../../types";
import type { InboundMessage, OutboundMessage } from "./types";

function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

function directoryName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx <= 0) return ".";
    return filePath.slice(0, idx);
}

function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx < 0) return filePath;
    return filePath.slice(idx + 1);
}

function App() {
    const [sourceBranch, setSourceBranch] = useState("incoming branch");
    const [targetBranch, setTargetBranch] = useState("current branch");
    const [files, setFiles] = useState<MergeConflictFile[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [groupByDirectory, setGroupByDirectory] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setSessionData") {
                const next = event.data.data;
                setSourceBranch(next.sourceBranch);
                setTargetBranch(next.targetBranch);
                setFiles(next.files);
                setError(null);
                setSelectedPath((prev) =>
                    prev && next.files.some((file) => file.path === prev)
                        ? prev
                        : (next.files[0]?.path ?? null),
                );
                return;
            }
            if (event.data.type === "loadError") {
                setError(event.data.message);
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    const selectedFile = useMemo(
        () => files.find((file) => file.path === selectedPath) ?? null,
        [files, selectedPath],
    );

    const groupedFiles = useMemo(() => {
        const groups = new Map<string, MergeConflictFile[]>();
        for (const file of files) {
            const dir = directoryName(file.path);
            const list = groups.get(dir);
            if (list) {
                list.push(file);
            } else {
                groups.set(dir, [file]);
            }
        }
        return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    }, [files]);

    const openMerge = useCallback((filePath: string) => {
        getVsCodeApi().postMessage({ type: "openMerge", filePath });
    }, []);

    const acceptSelected = useCallback(
        (side: "acceptYours" | "acceptTheirs") => {
            if (!selectedFile) return;
            getVsCodeApi().postMessage({ type: side, filePath: selectedFile.path });
        },
        [selectedFile],
    );

    const refresh = useCallback(() => {
        getVsCodeApi().postMessage({ type: "refresh" });
    }, []);

    const close = useCallback(() => {
        getVsCodeApi().postMessage({ type: "close" });
    }, []);

    const renderRow = (file: MergeConflictFile) => {
        const selected = selectedPath === file.path;
        return (
            <tr
                key={file.path}
                className={selected ? "row selected" : "row"}
                onClick={() => setSelectedPath(file.path)}
                onDoubleClick={() => openMerge(file.path)}
            >
                <td className="name-cell" title={file.path}>
                    <span className="file-name">{fileName(file.path)}</span>
                    <span className="file-path">{directoryName(file.path)}</span>
                </td>
                <td>{file.ours}</td>
                <td>{file.theirs}</td>
            </tr>
        );
    };

    return (
        <div className="session-root">
            <div className="session-header">Conflicts</div>
            <div className="session-subtitle">
                Merging branch <strong>{sourceBranch}</strong> into branch{" "}
                <strong>{targetBranch}</strong>
            </div>

            <div className="session-main">
                <div className="table-wrap">
                    <div className="table-meta">
                        {files.length} unresolved file{files.length === 1 ? "" : "s"}
                    </div>
                    {error ? <div className="error">{error}</div> : null}
                    <table className="conflict-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Yours ({targetBranch})</th>
                                <th>Theirs ({sourceBranch})</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groupByDirectory
                                ? groupedFiles.map(([dir, items]) => (
                                      <React.Fragment key={dir}>
                                          <tr className="group-row">
                                              <td colSpan={3}>{dir}</td>
                                          </tr>
                                          {items.map(renderRow)}
                                      </React.Fragment>
                                  ))
                                : files.map(renderRow)}
                        </tbody>
                    </table>
                </div>

                <div className="action-column">
                    <button
                        className="action-btn"
                        disabled={!selectedFile}
                        onClick={() => acceptSelected("acceptYours")}
                    >
                        Accept Yours
                    </button>
                    <button
                        className="action-btn"
                        disabled={!selectedFile}
                        onClick={() => acceptSelected("acceptTheirs")}
                    >
                        Accept Theirs
                    </button>
                    <button
                        className="action-btn primary"
                        disabled={!selectedFile}
                        onClick={() => selectedFile && openMerge(selectedFile.path)}
                    >
                        Merge...
                    </button>
                    <button className="action-btn" onClick={refresh}>
                        Refresh
                    </button>
                </div>
            </div>

            <div className="session-footer">
                <label className="group-toggle">
                    <input
                        type="checkbox"
                        checked={groupByDirectory}
                        onChange={(event) => setGroupByDirectory(event.target.checked)}
                    />
                    Group files by directory
                </label>
                <button className="close-btn" onClick={close}>
                    Close
                </button>
            </div>
        </div>
    );
}

const STYLES = `
.session-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 10px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    gap: 8px;
}

.session-header {
    font-size: 14px;
    font-weight: 700;
}

.session-subtitle {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.session-main {
    display: grid;
    grid-template-columns: 1fr 132px;
    gap: 8px;
    min-height: 0;
    flex: 1;
}

.table-wrap {
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}

.table-meta {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.error {
    padding: 6px 8px;
    color: var(--vscode-errorForeground, #f48771);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.conflict-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 12px;
}

.conflict-table thead th {
    position: sticky;
    top: 0;
    text-align: left;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.conflict-table thead th:first-child {
    width: 56%;
}

.conflict-table thead th:nth-child(2),
.conflict-table thead th:nth-child(3) {
    width: 22%;
}

.conflict-table tbody {
    display: block;
    overflow: auto;
    height: calc(100vh - 180px);
}

.conflict-table thead,
.conflict-table tbody tr {
    display: table;
    width: 100%;
    table-layout: fixed;
}

.row td {
    padding: 6px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #333) 70%, transparent);
}

.row:hover {
    background: color-mix(in srgb, var(--vscode-list-hoverBackground, #2a2d2e) 70%, transparent);
    cursor: pointer;
}

.row.selected {
    background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground, #3a3d41) 80%, transparent);
}

.group-row td {
    padding: 6px 8px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-editorGroupHeader-tabsBackground, #2a2d2e) 70%, transparent);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.name-cell {
    display: flex;
    align-items: baseline;
    gap: 8px;
    white-space: nowrap;
    overflow: hidden;
}

.file-name {
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
}

.file-path {
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
}

.action-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.action-btn,
.close-btn {
    height: 30px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
}

.action-btn:hover,
.close-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.action-btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
}

.action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.session-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.group-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}
`;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
