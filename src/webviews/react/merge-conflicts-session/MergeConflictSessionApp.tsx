import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import type { MergeConflictFile } from "../../../types";
import type { InboundMessage, OutboundMessage } from "./types";
import "./merge-conflicts-session.css";

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
                tabIndex={0}
                aria-selected={selected}
                onClick={() => setSelectedPath(file.path)}
                onDoubleClick={() => openMerge(file.path)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPath(file.path);
                    }
                    if (event.key === "Enter") {
                        openMerge(file.path);
                    }
                }}
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

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
