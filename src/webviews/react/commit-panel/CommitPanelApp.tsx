// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { TabBar } from "./components/TabBar";
import { CommitTab } from "./components/CommitTab";
import { ShelfTab } from "./components/ShelfTab";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { useCheckedFiles } from "./hooks/useCheckedFiles";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { useDragResize } from "./hooks/useDragResize";
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
        stageCheckedAndCommit(true);
    }, [stageCheckedAndCommit]);

    const containerRef = useRef<HTMLDivElement>(null);
    const savedBottomHeight = vscode.getState?.()?.bottomPanelHeight;
    const { height: bottomHeight, onMouseDown } = useDragResize(
        typeof savedBottomHeight === "number" ? savedBottomHeight : 120,
        40,
        containerRef,
        {
            maxReservedHeight: 120,
            onResize: (h: number) => {
                const prev = vscode.getState?.() ?? {};
                vscode.setState({ ...prev, bottomPanelHeight: h });
            },
        },
    );

    return (
        <Box ref={containerRef} display="flex" flexDirection="column" h="100%">
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <Box flex={1} overflow="hidden" display="flex" flexDirection="column">
                <TabBar
                    stashCount={state.stashes.length}
                    commitContent={
                        <CommitTab
                            files={state.files}
                            commitMessage={state.commitMessage}
                            isAmend={state.isAmend}
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
                        />
                    }
                />
            </Box>
            <Box
                h="5px"
                flexShrink={0}
                cursor="row-resize"
                bg="var(--vscode-panel-border)"
                onMouseDown={onMouseDown}
                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
            />
            <Box
                h={`${bottomHeight}px`}
                flexShrink={0}
                overflow="auto"
                display="flex"
                alignItems="center"
                justifyContent="center"
            >
                <Box color="var(--vscode-descriptionForeground)" fontSize="13px" fontStyle="italic">
                    Coming...
                </Box>
            </Box>
        </Box>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
