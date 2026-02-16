// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect } from "react";
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
    // Suppress VS Code's default webview context menu globally
    useEffect(() => {
        const suppress = (e: Event) => e.preventDefault();
        document.addEventListener("contextmenu", suppress);
        return () => document.removeEventListener("contextmenu", suppress);
    }, []);

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
        (action: "commit" | "commitAndPush") => {
            const msg = state.commitMessage.trim();
            if (!msg && !state.isAmend) return;
            const toStage = Array.from(checkedPaths);
            if (toStage.length > 0) {
                vscode.postMessage({ type: "stageFiles", paths: toStage });
            }
            setTimeout(
                () => {
                    vscode.postMessage({
                        type: action,
                        message: msg,
                        amend: state.isAmend,
                    });
                },
                toStage.length > 0 ? 300 : 0,
            );
        },
        [vscode, state.commitMessage, state.isAmend, checkedPaths],
    );

    const handleCommit = useCallback(() => {
        stageCheckedAndCommit("commit");
    }, [stageCheckedAndCommit]);

    const handleCommitAndPush = useCallback(() => {
        stageCheckedAndCommit("commitAndPush");
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
                shelfContent={<ShelfTab stashes={state.stashes} />}
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
