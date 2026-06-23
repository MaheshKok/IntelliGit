// Listens for messages from the extension host and dispatches actions
// to a useReducer-based state. Sends "ready" on mount.

import { useEffect, useReducer } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type { CommitPanelState, CommitPanelAction, InboundMessage } from "../types";

const initialState: CommitPanelState = {
    files: [],
    stashes: [],
    shelfFiles: [],
    selectedShelfIndex: null,
    folderIcon: undefined,
    folderExpandedIcon: undefined,
    folderIconsByName: undefined,
    iconFonts: [],
    commitMessage: "",
    isAmend: false,
    amendBranchCommits: [],
    amendBranchHistoryLoaded: false,
    isRefreshing: false,
    error: null,
    currentBranchHasUpstream: true,
    currentBranchAhead: 0,
    currentBranchBehind: 0,
};

function reducer(state: CommitPanelState, action: CommitPanelAction): CommitPanelState {
    switch (action.type) {
        case "SET_FILES_AND_STASHES":
            return {
                ...state,
                files: action.files,
                stashes: action.stashes,
                shelfFiles: action.shelfFiles,
                selectedShelfIndex: action.selectedShelfIndex,
                folderIcon: action.folderIcon ?? state.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? state.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? state.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
                currentBranchAhead: action.currentBranchAhead,
                currentBranchBehind: action.currentBranchBehind,
                error: null,
            };
        case "SET_REFRESHING":
            if (action.active && state.isAmend) {
                return {
                    ...state,
                    isRefreshing: true,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                };
            }
            return { ...state, isRefreshing: action.active };
        case "RESTORE_COMMIT_DRAFT":
            return { ...state, commitMessage: action.message };
        case "SET_LAST_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "COMMITTED":
            return {
                ...state,
                commitMessage: "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "SET_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "SET_AMEND":
            if (action.isAmend) {
                return {
                    ...state,
                    isAmend: true,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                };
            }
            return {
                ...state,
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_AMEND_BRANCH_COMMITS":
            if (!state.isAmend) {
                return state;
            }
            return {
                ...state,
                amendBranchCommits: action.commits,
                amendBranchHistoryLoaded: true,
            };
    }
}

/**
 * Connects the commit-panel reducer to extension-host webview messages.
 *
 * The hook sends the initial `ready` message on mount, applies host snapshots to
 * local reducer state, and ignores late amend-history payloads once amend mode is
 * no longer active.
 */
export function useExtensionMessages(): [CommitPanelState, React.Dispatch<CommitPanelAction>] {
    const [state, dispatch] = useReducer(reducer, initialState);

    useEffect(() => {
        const vscode = getVsCodeApi();

        const handler = (event: MessageEvent<InboundMessage>) => {
            const msg = event.data;
            switch (msg.type) {
                case "update":
                    dispatch({
                        type: "SET_FILES_AND_STASHES",
                        files: msg.files,
                        stashes: msg.stashes,
                        shelfFiles: msg.shelfFiles,
                        selectedShelfIndex: msg.selectedShelfIndex,
                        folderIcon: msg.folderIcon,
                        folderExpandedIcon: msg.folderExpandedIcon,
                        folderIconsByName: msg.folderIconsByName,
                        iconFonts: msg.iconFonts,
                        currentBranchHasUpstream: msg.currentBranchHasUpstream ?? true,
                        currentBranchAhead: msg.currentBranchAhead ?? 0,
                        currentBranchBehind: msg.currentBranchBehind ?? 0,
                    });
                    break;
                case "restoreCommitDraft":
                    dispatch({ type: "RESTORE_COMMIT_DRAFT", message: msg.message });
                    break;
                case "lastCommitMessage":
                    dispatch({ type: "SET_LAST_COMMIT_MESSAGE", message: msg.message });
                    break;
                case "amendBranchCommits":
                    dispatch({ type: "SET_AMEND_BRANCH_COMMITS", commits: msg.commits });
                    break;
                case "committed":
                    dispatch({ type: "COMMITTED" });
                    break;
                case "refreshing":
                    dispatch({ type: "SET_REFRESHING", active: msg.active });
                    break;
                case "error":
                    dispatch({ type: "SET_ERROR", message: msg.message });
                    break;
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });

        return () => window.removeEventListener("message", handler);
    }, []);

    return [state, dispatch];
}
