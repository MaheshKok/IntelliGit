import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import { t } from "../shared/i18n";
import type { MergeConflictFile } from "../../../types";
import type { InboundMessage, OutboundMessage } from "../../protocol/mergeConflictSessionTypes";
import "./merge-conflicts-session.css";

/** Acquires the typed VS Code API for merge-conflict session commands. */
function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

/** Returns the display directory for a conflicted path, using `.` at repo root. */
function directoryName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx <= 0) return ".";
    return filePath.slice(0, idx);
}

/** Returns the basename portion used in the conflict-session table row. */
function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx < 0) return filePath;
    return filePath.slice(idx + 1);
}

/**
 * Renders the merge-conflict session dashboard, maps extension session data into
 * selectable rows, posts file-scoped accept/open commands, and sends session-level
 * refresh/close commands.
 */
function App() {
    const [sourceBranch, setSourceBranch] = useState(t("mergeSession.defaultSource"));
    const [targetBranch, setTargetBranch] = useState(t("mergeSession.defaultTarget"));
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
            <div className="session-header">{t("mergeSession.title")}</div>
            <div className="session-subtitle">
                {t("mergeSession.subtitle.pre")}
                <strong>{sourceBranch}</strong>
                {t("mergeSession.subtitle.mid")}
                <strong>{targetBranch}</strong>
                {t("mergeSession.subtitle.post")}
            </div>

            <div className="session-main">
                <div className="table-wrap">
                    <div className="table-meta">
                        {t("mergeSession.unresolvedFiles", { count: files.length })}
                    </div>
                    {error ? <div className="error">{error}</div> : null}
                    <table className="conflict-table">
                        <thead>
                            <tr>
                                <th>{t("mergeSession.col.name")}</th>
                                <th>{t("mergeSession.col.yours", { branch: targetBranch })}</th>
                                <th>{t("mergeSession.col.theirs", { branch: sourceBranch })}</th>
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
                        type="button"
                        className="action-btn"
                        disabled={!selectedFile}
                        onClick={() => acceptSelected("acceptYours")}
                    >
                        {t("mergeSession.acceptYours")}
                    </button>
                    <button
                        type="button"
                        className="action-btn"
                        disabled={!selectedFile}
                        onClick={() => acceptSelected("acceptTheirs")}
                    >
                        {t("mergeSession.acceptTheirs")}
                    </button>
                    <button
                        type="button"
                        className="action-btn primary"
                        disabled={!selectedFile}
                        onClick={() => selectedFile && openMerge(selectedFile.path)}
                    >
                        {t("mergeSession.merge")}
                    </button>
                    <button type="button" className="action-btn" onClick={refresh}>
                        {t("common.refresh")}
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
                    {t("mergeSession.groupByDirectory")}
                </label>
                <button type="button" className="close-btn" onClick={close}>
                    {t("common.close")}
                </button>
            </div>
        </div>
    );
}

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
