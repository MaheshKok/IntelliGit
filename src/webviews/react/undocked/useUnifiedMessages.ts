// Owns the unified extension-host message listener for the undocked webview.
// The hook keeps graph, commit-panel, settings, and layout restore messages on the existing single channel.
// Width hydration logic stays byte-for-byte equivalent to the former App effect.

/* eslint-disable react-hooks/exhaustive-deps -- Dependency array intentionally matches the pre-extraction effect. */

import { useEffect, useRef } from "react";
import type React from "react";
import type {
    RepositoryViewIdentity,
    UnifiedInbound,
    UnifiedOutbound,
} from "../../protocol/undockedMessages";
import { getVsCodeApi } from "../shared/vscodeApi";
import { normalizeSectionWidths, type SectionWidths } from "./sectionWidths";
import type { CommitPanelAction, GraphAction } from "./commitPanelState";

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();

/**
 * Parameters for wiring the undocked message bridge into reducer dispatchers.
 *
 * Carries reducer dispatchers, graph pagination state, width hydration controls,
 * the layout measurement ref, and the host-driven commit-panel position setter.
 */
export interface UseUnifiedMessagesParams {
    graphDispatch: React.Dispatch<GraphAction>;
    cpDispatch: React.Dispatch<CommitPanelAction>;
    loadingMore: React.MutableRefObject<boolean>;
    selectedHash: string | null;
    selectedRepositoryRoot: string | null;
    setRepositories: (repositories: RepositoryViewIdentity[]) => void;
    setSelectedRepositoryRoot: (root: string) => void;
    markWidthsHydrated: () => void;
    setSectionWidths: (next: SectionWidths) => void;
    layoutRef: React.MutableRefObject<HTMLDivElement | null>;
    setCommitPanelPosition: (pos: "left" | "right") => void;
    setViewVisible: (visible: boolean) => void;
}

/**
 * Subscribes to unified undocked messages from the extension host.
 *
 * @param params - Reducer dispatchers, width controls, and layout setters used by the message switch.
 */
export function useUnifiedMessages(params: UseUnifiedMessagesParams): void {
    const {
        graphDispatch,
        cpDispatch,
        loadingMore,
        selectedHash,
        selectedRepositoryRoot,
        setRepositories,
        setSelectedRepositoryRoot,
        markWidthsHydrated,
        setSectionWidths,
        layoutRef,
        setCommitPanelPosition,
        setViewVisible,
    } = params;
    const selectedHashRef = useRef<string | null>(selectedHash);
    selectedHashRef.current = selectedHash;
    const selectedRepositoryRootRef = useRef<string | null>(selectedRepositoryRoot);
    selectedRepositoryRootRef.current = selectedRepositoryRoot;

    useEffect(() => {
        const handler = (event: MessageEvent<UnifiedInbound>) => {
            const data = event.data;

            switch (data.type) {
                case "repositories": {
                    const previousRoot = selectedRepositoryRootRef.current;
                    setRepositories(data.repositories);
                    setSelectedRepositoryRoot(data.selectedRepositoryRoot);
                    if (previousRoot !== data.selectedRepositoryRoot) {
                        selectedRepositoryRootRef.current = data.selectedRepositoryRoot;
                        selectedHashRef.current = null;
                        loadingMore.current = false;
                        graphDispatch({ type: "resetRepository" });
                        cpDispatch({ type: "RESET_REPOSITORY" });
                    }
                    return;
                }

                // --- Graph-side messages ---
                case "loadCommits":
                    loadingMore.current = false;
                    const previousSelectedHash = selectedHashRef.current;
                    const nextSelectedHash =
                        !data.append &&
                        previousSelectedHash !== null &&
                        data.commits.some((commit) => commit.hash === previousSelectedHash)
                            ? previousSelectedHash
                            : !data.append
                              ? (data.commits[0]?.hash ?? null)
                              : previousSelectedHash;
                    selectedHashRef.current = nextSelectedHash;
                    graphDispatch({
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
                        nextSelectedHash !== previousSelectedHash
                    ) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: nextSelectedHash,
                        });
                    }
                    return;

                case "setBranches":
                    graphDispatch({
                        type: "setBranches",
                        branches: data.branches,
                        worktrees: data.worktrees,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        commitChecksEnabled: data.commitChecksEnabled,
                    });
                    return;

                case "setSelectedBranch":
                    graphDispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    return;

                case "setCommitDetail":
                    graphDispatch({
                        type: "setCommitDetail",
                        detail: data.detail,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                    });
                    return;

                case "clearCommitDetail":
                    graphDispatch({ type: "clearCommitDetail", loading: data.loading ?? false });
                    return;

                case "setCommitChecks":
                    graphDispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    return;

                case "setViewVisibility":
                    setViewVisible(data.visible);
                    return;

                case "loadError":
                    graphDispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    console.error("[IntelliGit] Load error:", data.message);
                    return;

                // --- Commit-panel-side messages ---
                case "update":
                    cpDispatch({
                        type: "SET_FILES_AND_STASHES",
                        files: data.files,
                        stashes: data.stashes,
                        stashFiles: data.stashFiles,
                        selectedStashIndex: data.selectedStashIndex,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        currentBranchHasUpstream: data.currentBranchHasUpstream ?? true,
                        hasRemotes: data.hasRemotes,
                        currentBranchAhead: data.currentBranchAhead ?? 0,
                        currentBranchBehind: data.currentBranchBehind ?? 0,
                        currentBranchName: data.currentBranchName,
                        currentBranchUpstream: data.currentBranchUpstream,
                    });
                    return;

                case "restoreCommitDraft":
                    cpDispatch({ type: "RESTORE_COMMIT_DRAFT", message: data.message });
                    return;

                case "lastCommitMessage":
                    cpDispatch({ type: "SET_LAST_COMMIT_MESSAGE", message: data.message });
                    return;

                case "amendBranchCommits":
                    cpDispatch({ type: "SET_AMEND_BRANCH_COMMITS", commits: data.commits });
                    return;

                case "committed":
                    cpDispatch({ type: "COMMITTED" });
                    return;

                case "refreshing":
                    cpDispatch({ type: "SET_REFRESHING", active: data.active });
                    return;

                case "settings":
                    setCommitPanelPosition(data.commitWindowPosition);
                    return;

                // Restore persisted column widths from extension
                case "columnWidths":
                    // Mark hydrated first so the subsequent state updates are
                    // allowed to persist (and future user drags too).
                    markWidthsHydrated();
                    {
                        const measuredWidth = layoutRef.current?.clientWidth;
                        const totalWidth =
                            typeof measuredWidth === "number" && measuredWidth > 0
                                ? measuredWidth
                                : undefined;
                        const normalized = normalizeSectionWidths(
                            {
                                branchWidth: data.branchWidth,
                                graphWidth: data.graphWidth,
                                infoWidth: data.infoWidth,
                                commitPanelWidth: data.commitPanelWidth,
                            },
                            totalWidth,
                        );
                        setSectionWidths(normalized);
                    }
                    return;

                case "error":
                    cpDispatch({ type: "SET_ERROR", message: data.message });
                    console.error("[IntelliGit] Extension error:", data.message);
                    return;
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });

        return () => window.removeEventListener("message", handler);
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, [markWidthsHydrated, setSectionWidths]);
}
