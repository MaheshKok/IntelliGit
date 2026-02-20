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
    isRefreshing: false,
    error: null,
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
                folderIcon: action.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                error: null,
            };
        case "SET_REFRESHING":
            return { ...state, isRefreshing: action.active };
        case "SET_LAST_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "COMMITTED":
            return { ...state, commitMessage: "", isAmend: false };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "SET_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "SET_AMEND":
            return { ...state, isAmend: action.isAmend };
    }
}

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
                    });
                    break;
                case "lastCommitMessage":
                    dispatch({ type: "SET_LAST_COMMIT_MESSAGE", message: msg.message });
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
