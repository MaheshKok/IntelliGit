// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { TabBar } from "./components/TabBar";
import { CommitTab } from "./components/CommitTab";
import { ShelfTab } from "./components/ShelfTab";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { useCheckedFiles } from "./hooks/useCheckedFiles";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { ThemeIconFontFaces } from "../shared/components";

function App(): React.ReactElement {
    const [state, dispatch] = useExtensionMessages();
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(state.files);

    const vscode = getVsCodeApi();
    const [groupByDir, setGroupByDir] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return typeof saved?.groupByDir === "boolean" ? saved.groupByDir : true;
    });

    useEffect(() => {
        if (!state.isAmend) return;
        if (state.isRefreshing) return;
        vscode.postMessage({ type: "getAmendBranchCommits" });
    }, [state.isAmend, state.isRefreshing, vscode]);

    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({ ...prev, groupByDir });
    }, [groupByDir, vscode]);

    const handleMessageChange = useCallback(
        (message: string) => {
            dispatch({ type: "SET_COMMIT_MESSAGE", message });
            vscode.postMessage({ type: "saveCommitDraft", message });
        },
        [dispatch, vscode],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            dispatch({ type: "SET_AMEND", isAmend });
            if (isAmend) {
                vscode.postMessage({ type: "getLastCommitMessage" });
            }
        },
        [dispatch, vscode],
    );

    const stageCheckedAndCommit = useCallback(
        (push: boolean) => {
            const msg = state.commitMessage.trim();
            vscode.postMessage({
                type: "commitSelected",
                paths: Array.from(checkedPaths),
                message: msg,
                amend: state.isAmend,
                push,
            });
        },
        [vscode, state.commitMessage, state.isAmend, checkedPaths],
    );

    const handleCommit = useCallback(() => {
        stageCheckedAndCommit(false);
    }, [stageCheckedAndCommit]);

    const handleCommitAndPush = useCallback(() => {
        if (!state.currentBranchHasUpstream) {
            vscode.postMessage({ type: "publishBranch" });
            return;
        }
        stageCheckedAndCommit(true);
    }, [stageCheckedAndCommit, state.currentBranchHasUpstream, vscode]);

    return (
        <Box display="flex" flexDirection="column" h="100%" bg="var(--intelligit-pycharm-panel)">
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <TabBar
                stashCount={state.stashes.length}
                commitContent={
                    <CommitTab
                        files={state.files}
                        commitMessage={state.commitMessage}
                        isAmend={state.isAmend}
                        amendBranchCommits={state.amendBranchCommits}
                        amendBranchHistoryLoaded={state.amendBranchHistoryLoaded}
                        isRefreshing={state.isRefreshing}
                        checkedPaths={checkedPaths}
                        onToggleFile={toggleFile}
                        onToggleFolder={toggleFolder}
                        onToggleSection={toggleSection}
                        isAllChecked={isAllChecked}
                        isSomeChecked={isSomeChecked}
                        onMessageChange={handleMessageChange}
                        onAmendChange={handleAmendChange}
                        onCommit={handleCommit}
                        onCommitAndPush={handleCommitAndPush}
                        currentBranchHasUpstream={state.currentBranchHasUpstream}
                        folderIcon={state.folderIcon}
                        folderExpandedIcon={state.folderExpandedIcon}
                        folderIconsByName={state.folderIconsByName}
                        groupByDir={groupByDir}
                        onToggleGroupBy={() => setGroupByDir((g) => !g)}
                    />
                }
                shelfContent={
                    <ShelfTab
                        stashes={state.stashes}
                        shelfFiles={state.shelfFiles}
                        selectedIndex={state.selectedShelfIndex}
                        folderIcon={state.folderIcon}
                        folderExpandedIcon={state.folderExpandedIcon}
                        folderIconsByName={state.folderIconsByName}
                        groupByDir={groupByDir}
                        onToggleGroupBy={() => setGroupByDir((g) => !g)}
                    />
                }
            />
        </Box>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
