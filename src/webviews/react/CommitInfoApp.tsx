import React, { useCallback, useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitDetail, ThemeFolderIconMap, ThemeIconFont, ThemeTreeIcon } from "../../types";
import type { CommitInfoOutbound, CommitInfoInbound } from "../protocol/commitInfoTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { openChecksTab } from "./commit-info/checks/checksTabState";
import { ThemeIconFontFaces } from "./shared/components/ThemeIconFontFaces";

const vscode = getVsCodeApi<CommitInfoOutbound, unknown>();

interface CommitInfoState {
    detail: CommitDetail | null;
    loading: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    ciRepoKey?: string;
    commitChecksEnabled?: boolean;
}

type CommitInfoAction =
    | { type: "clear"; loading?: boolean }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts: ThemeIconFont[];
          ciRepoKey?: string;
          commitChecksEnabled?: boolean;
      };

const initialCommitInfoState: CommitInfoState = {
    detail: null,
    loading: false,
    iconFonts: [],
};

function commitInfoReducer(_state: CommitInfoState, action: CommitInfoAction): CommitInfoState {
    switch (action.type) {
        case "clear":
            return { ...initialCommitInfoState, loading: action.loading ?? false };
        case "setCommitDetail":
            return {
                detail: action.detail,
                loading: false,
                folderIcon: action.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName,
                iconFonts: action.iconFonts,
                ciRepoKey: action.ciRepoKey,
                commitChecksEnabled: action.commitChecksEnabled,
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
// Webview entrypoint owns root render side effects; Fast Refresh component-export rule is not applicable here.
// react-doctor-disable-next-line react-doctor/only-export-components
function App(): React.ReactElement {
    const [state, dispatch] = useReducer(commitInfoReducer, initialCommitInfoState);

    useEffect(() => {
        // Repository of the detail on screen, mirrored from the messages that set or clear it.
        let shownRepoKey: string | undefined;
        // An "Open in Checks" received while nothing is shown waits for the next detail, whose
        // repository decides whether it applies.
        let heldRepoKey: string | undefined;
        const handler = (event: MessageEvent<CommitInfoInbound>) => {
            const msg = event.data;
            switch (msg.type) {
                case "clear":
                    shownRepoKey = undefined;
                    dispatch({ type: "clear", loading: msg.loading ?? false });
                    return;
                case "setCommitDetail":
                    shownRepoKey = msg.ciRepoKey;
                    if (heldRepoKey !== undefined && heldRepoKey === shownRepoKey) openChecksTab();
                    heldRepoKey = undefined;
                    dispatch({
                        type: "setCommitDetail",
                        detail: msg.detail,
                        folderIcon: msg.folderIcon,
                        folderExpandedIcon: msg.folderExpandedIcon,
                        folderIconsByName: msg.folderIconsByName,
                        iconFonts: msg.iconFonts ?? [],
                        ciRepoKey: msg.ciRepoKey,
                        commitChecksEnabled: msg.commitChecksEnabled,
                    });
                    return;
                case "openChecksTab":
                    // The sidebar graph selects the row itself; this view only switches the tab.
                    if (shownRepoKey === undefined) heldRepoKey = msg.repoKey;
                    else if (msg.repoKey === shownRepoKey) openChecksTab();
                    return;
                case "commitCiDetail":
                case "commitCiDetailInvalidated":
                case "ciLogPreview":
                case "ciLogResult":
                    // useCommitCiDetail and the job's log panel listen for their own messages.
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
                loading={state.loading}
                folderIcon={state.folderIcon}
                folderExpandedIcon={state.folderExpandedIcon}
                folderIconsByName={state.folderIconsByName}
                onOpenDiff={handleOpenDiff}
                ciRepoKey={state.ciRepoKey}
                commitChecksEnabled={state.commitChecksEnabled}
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
