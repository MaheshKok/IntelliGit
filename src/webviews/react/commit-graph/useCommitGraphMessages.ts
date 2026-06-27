// Owns the CommitGraphPanel window-message bridge for extension-host events.
// The hook stays separate from render logic so the root component remains small.
// It preserves the existing VS Code webview message contract without changing dispatch behavior.

import { useEffect } from "react";
import type React from "react";
import type { CommitGraphInbound } from "../../protocol/commitGraphTypes";
import type { CommitGraphPanelAction } from "./types";
import type { VsCodeApi } from "../shared/vscodeApi";

/**
 * Subscribes to extension-host commit graph messages and dispatches panel state updates.
 *
 * `loadingMore` remains caller-owned because the root component also controls pagination requests.
 */
export function useCommitGraphMessages(params: {
    vscode: VsCodeApi;
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    sendReady: boolean;
    loadingMore: React.MutableRefObject<boolean>;
}): void {
    const { vscode, dispatch, sendReady, loadingMore } = params;

    useEffect(() => {
        if (sendReady) {
            vscode.postMessage({ type: "ready" });
        }

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            if (
                !data ||
                typeof data !== "object" ||
                typeof (data as { type?: unknown }).type !== "string"
            ) {
                return;
            }
            switch (data.type) {
                case "loadCommits":
                    loadingMore.current = false;
                    dispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (!data.append && data.commits.length > 0) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: data.commits[0].hash,
                        });
                    }
                    break;
                case "setBranches":
                    dispatch({
                        type: "setBranches",
                        branches: data.branches,
                        worktrees: data.worktrees,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        commitChecksEnabled: data.commitChecksEnabled,
                    });
                    break;
                case "setSelectedBranch":
                    dispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    break;
                case "setCommitDetail":
                    dispatch({
                        type: "setCommitDetail",
                        detail: data.detail,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                    });
                    break;
                case "clearCommitDetail":
                    dispatch({ type: "clearCommitDetail" });
                    break;
                case "setCommitChecks":
                    dispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    break;
                case "loadError":
                    dispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    console.error("[IntelliGit] Load error:", data.message);
                    break;
                case "error":
                    console.error("[IntelliGit] Extension error:", data);
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
        // Keep the original root effect subscription lifetime; dispatch and loadingMore are stable.
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, [sendReady, vscode]); // eslint-disable-line react-hooks/exhaustive-deps
}
