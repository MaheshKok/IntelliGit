// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { TabBar } from "./components/TabBar";
import { CommitTab } from "./components/CommitTab";
import { StashTab } from "./components/StashTab";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { useCheckedFiles } from "./hooks/useCheckedFiles";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { ThemeIconFontFaces } from "../shared/components/ThemeIconFontFaces";
import { canRunCommitAction } from "./commitEligibility";

/**
 * Root commit-panel React app wired to the VS Code webview host.
 *
 * This component owns panel-level message sending for commit, push, publish,
 * amend-message loading, draft persistence, and the local group-by-directory
 * preference shared by the commit and stash tabs.
 */
// Webview entrypoint owns root render side effects; Fast Refresh component-export rule is not applicable here.
// react-doctor-disable-next-line react-doctor/only-export-components
function App(): React.ReactElement {
    const [state, dispatch] = useExtensionMessages();
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(state.files);

    const vscode = getVsCodeApi();
    const [groupByDir, setGroupByDir] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return typeof saved?.groupByDir === "boolean" ? saved.groupByDir : true;
    });
    const [showIgnoredFiles, setShowIgnoredFiles] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return saved?.showIgnoredFiles === true;
    });
    const showIgnoredFilesPostedRef = useRef(false);

    useEffect(() => {
        if (!state.isAmend) return;
        if (state.isRefreshing) return;
        vscode.postMessage({ type: "getAmendBranchCommits" });
    }, [state.isAmend, state.isRefreshing, vscode]);

    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({ ...prev, groupByDir, showIgnoredFiles });
    }, [groupByDir, showIgnoredFiles, vscode]);

    useEffect(() => {
        const shouldPost = showIgnoredFilesPostedRef.current || showIgnoredFiles;
        showIgnoredFilesPostedRef.current = true;
        if (!shouldPost) return;
        vscode.postMessage({ type: "setShowIgnoredFiles", showIgnoredFiles });
    }, [showIgnoredFiles, vscode]);

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

    const canCommit = canRunCommitAction(state.isAmend, checkedPaths.size, state.commitMessage);
    const shouldPublishBranch = !state.currentBranchHasUpstream;
    const canPush = shouldPublishBranch
        ? state.currentBranchName !== null
        : state.currentBranchAhead > 0;
    const pushLabel = shouldPublishBranch ? "commit.action.publishAndPush" : "common.push";

    const handleCommit = useCallback(() => {
        const msg = state.commitMessage.trim();
        vscode.postMessage({
            type: "commitSelected",
            message: msg,
            amend: state.isAmend,
            push: false,
            paths: Array.from(checkedPaths),
        });
    }, [vscode, state.commitMessage, state.isAmend, checkedPaths]);

    const handlePush = useCallback(() => {
        vscode.postMessage({ type: shouldPublishBranch ? "publishBranch" : "push" });
    }, [vscode, shouldPublishBranch]);

    const handleSync = useCallback(() => {
        vscode.postMessage({ type: "sync" });
    }, [vscode]);

    const handleFetch = useCallback(() => {
        vscode.postMessage({ type: "fetch" });
    }, [vscode]);

    const handlePull = useCallback(() => {
        vscode.postMessage({ type: "pull" });
    }, [vscode]);

    return (
        <Box display="flex" flexDirection="column" h="100%" bg="var(--intelligit-pycharm-panel)">
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <TabBar
                stashCount={state.stashes.length}
                onSync={handleSync}
                onFetch={handleFetch}
                onPull={handlePull}
                onPush={handlePush}
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
                        canCommit={canCommit}
                        onPush={handlePush}
                        canPush={canPush}
                        pushLabel={pushLabel}
                        currentBranchName={state.currentBranchName}
                        currentBranchUpstream={state.currentBranchUpstream}
                        folderIcon={state.folderIcon}
                        folderExpandedIcon={state.folderExpandedIcon}
                        folderIconsByName={state.folderIconsByName}
                        groupByDir={groupByDir}
                        showIgnoredFiles={showIgnoredFiles}
                        onToggleGroupBy={() => setGroupByDir((g) => !g)}
                        onToggleShowIgnoredFiles={() => setShowIgnoredFiles((show) => !show)}
                    />
                }
                stashContent={
                    <StashTab
                        stashes={state.stashes}
                        stashFiles={state.stashFiles}
                        selectedIndex={state.selectedStashIndex}
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
