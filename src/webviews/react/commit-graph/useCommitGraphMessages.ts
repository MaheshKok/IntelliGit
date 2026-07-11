// Owns the CommitGraphPanel window-message bridge for extension-host events.
// The hook stays separate from render logic so the root component remains small.
// It preserves the existing VS Code webview message contract without changing dispatch behavior.

import { useEffect, useRef } from "react";
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
    selectedHash: string | null;
    setViewVisible: (visible: boolean) => void;
}): void {
    const { vscode, dispatch, sendReady, loadingMore, selectedHash, setViewVisible } = params;
    const selectedHashRef = useRef<string | null>(selectedHash);
    const selectFirstOnNextLoadRef = useRef(false);
    selectedHashRef.current = selectedHash;

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
                case "loadCommits": {
                    loadingMore.current = false;
                    const forceFirstCommit = !data.append && selectFirstOnNextLoadRef.current;
                    const previousSelectedHash = selectedHashRef.current;
                    const firstCommitHash = data.commits[0]?.hash ?? null;
                    const preservesSelectedHash =
                        !data.append &&
                        previousSelectedHash !== null &&
                        data.commits.some((commit) => commit.hash === previousSelectedHash);
                    const nextSelectedHash = forceFirstCommit
                        ? firstCommitHash
                        : preservesSelectedHash
                          ? previousSelectedHash
                          : !data.append
                            ? firstCommitHash
                            : previousSelectedHash;
                    if (!data.append) {
                        selectFirstOnNextLoadRef.current = false;
                    }
                    selectedHashRef.current = nextSelectedHash;
                    dispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        selectedHash: nextSelectedHash,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (
                        !data.append &&
                        nextSelectedHash !== null &&
                        (forceFirstCommit || nextSelectedHash !== previousSelectedHash)
                    ) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: nextSelectedHash,
                        });
                    }
                    break;
                }
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
                    selectFirstOnNextLoadRef.current = true;
                    dispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    break;
                case "setFilterText":
                    dispatch({ type: "setFilterText", text: data.text });
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
                    dispatch({ type: "clearCommitDetail", loading: data.loading ?? false });
                    break;
                case "setCommitChecks":
                    dispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    break;
                case "setViewVisibility":
                    setViewVisible(data.visible);
                    break;
                case "loadError":
                    selectFirstOnNextLoadRef.current = false;
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
