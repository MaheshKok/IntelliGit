import React, { useCallback, useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitDetail, ThemeFolderIconMap, ThemeIconFont, ThemeTreeIcon } from "../../types";
import type { CommitInfoOutbound, CommitInfoInbound } from "../protocol/commitInfoTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components/ThemeIconFontFaces";

const vscode = getVsCodeApi<CommitInfoOutbound, unknown>();

interface CommitInfoState {
    detail: CommitDetail | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
}

type CommitInfoAction =
    | { type: "clear" }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts: ThemeIconFont[];
      };

const initialCommitInfoState: CommitInfoState = {
    detail: null,
    iconFonts: [],
};

function commitInfoReducer(_state: CommitInfoState, action: CommitInfoAction): CommitInfoState {
    switch (action.type) {
        case "clear":
            return initialCommitInfoState;
        case "setCommitDetail":
            return {
                detail: action.detail,
                folderIcon: action.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName,
                iconFonts: action.iconFonts,
            };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}

/**
 * Hosts the standalone commit-info webview and mirrors extension-owned commit
 * detail, file-icon theme data, and clear messages into local React state.
 */
function App(): React.ReactElement {
    const [state, dispatch] = useReducer(commitInfoReducer, initialCommitInfoState);

    useEffect(() => {
        const handler = (event: MessageEvent<CommitInfoInbound>) => {
            const msg = event.data;
            switch (msg.type) {
                case "clear":
                    dispatch({ type: "clear" });
                    return;
                case "setCommitDetail":
                    dispatch({
                        type: "setCommitDetail",
                        detail: msg.detail,
                        folderIcon: msg.folderIcon,
                        folderExpandedIcon: msg.folderExpandedIcon,
                        folderIconsByName: msg.folderIconsByName,
                        iconFonts: msg.iconFonts ?? [],
                    });
                    return;
                default: {
                    const exhaustive: never = msg;
                    void exhaustive;
                    return;
                }
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string) => {
        vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
    }, []);

    return (
        <>
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <CommitInfoPane
                detail={state.detail}
                folderIcon={state.folderIcon}
                folderExpandedIcon={state.folderExpandedIcon}
                folderIconsByName={state.folderIconsByName}
                onOpenDiff={handleOpenDiff}
            />
        </>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
