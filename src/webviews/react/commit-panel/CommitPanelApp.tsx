// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { TabBar } from "./components/TabBar";
import { CommitTab } from "./components/CommitTab";
import { ShelfTab } from "./components/ShelfTab";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { useCheckedFiles } from "./hooks/useCheckedFiles";
import { getVsCodeApi } from "./hooks/useVsCodeApi";

function App(): React.ReactElement {
    const [state, dispatch] = useExtensionMessages();
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(state.files);

    const vscode = getVsCodeApi();

    const handleMessageChange = useCallback(
        (message: string) => {
            dispatch({ type: "SET_COMMIT_MESSAGE", message });
        },
        [dispatch],
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
            if (!msg && !state.isAmend) return;
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
        stageCheckedAndCommit(true);
    }, [stageCheckedAndCommit]);

    return (
        <Box display="flex" flexDirection="column" h="100%">
            <TabBar
                stashCount={state.stashes.length}
                commitContent={
                    <CommitTab
                        files={state.files}
                        commitMessage={state.commitMessage}
                        isAmend={state.isAmend}
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
                    />
                }
                shelfContent={
                    <ShelfTab
                        stashes={state.stashes}
                        shelfFiles={state.shelfFiles}
                        selectedIndex={state.selectedShelfIndex}
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
