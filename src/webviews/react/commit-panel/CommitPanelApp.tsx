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
import { useDragResize } from "./hooks/useDragResize";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { ThemeIconFontFaces } from "../shared/components";
import { ChevronIcon } from "../shared/components/Icons";
import { NativeCommitGraph } from "../NativeCommitGraph";

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
        stageCheckedAndCommit(true);
    }, [stageCheckedAndCommit]);

    const containerRef = useRef<HTMLDivElement>(null);
    const savedBottomHeight = vscode.getState?.()?.commitGraphPanelHeight;
    const { height: graphHeight, onMouseDown } = useDragResize(
        typeof savedBottomHeight === "number" ? savedBottomHeight : 220,
        120,
        containerRef,
        {
            maxReservedHeight: 180,
            onResize: (h: number) => {
                const prev = vscode.getState?.() ?? {};
                vscode.setState({ ...prev, commitGraphPanelHeight: h });
            },
        },
    );

    const [graphCollapsed, setGraphCollapsed] = useState(false);
    const [commitCollapsed, setCommitCollapsed] = useState(false);

    const sectionHeader: React.CSSProperties = {
        display: "flex",
        alignItems: "center",
        height: 24,
        paddingLeft: 8,
        paddingRight: 8,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        userSelect: "none",
        flexShrink: 0,
        background: "var(--vscode-sideBarSectionHeader-background)",
        color: "var(--vscode-foreground)",
        borderBottom: "1px solid var(--vscode-panel-border)",
    };

    const sectionBodyStyle = (
        collapsed: boolean,
        sizing: Pick<React.CSSProperties, "flexGrow" | "flexShrink" | "flexBasis">,
    ): React.CSSProperties => ({
        display: "flex",
        flexDirection: "column",
        flexGrow: collapsed ? 0 : sizing.flexGrow,
        flexShrink: collapsed ? 0 : sizing.flexShrink,
        flexBasis: collapsed ? 0 : sizing.flexBasis,
        minHeight: 0,
        overflow: "hidden",
        opacity: collapsed ? 0 : 1,
        pointerEvents: collapsed ? "none" : "auto",
        transition: "opacity 0.12s ease",
    });

    return (
        <Box ref={containerRef} display="flex" flexDirection="column" h="100%">
            <ThemeIconFontFaces fonts={state.iconFonts} />

            {/* Changes section header */}
            <div style={sectionHeader} onClick={() => setCommitCollapsed((c) => !c)}>
                <ChevronIcon expanded={!commitCollapsed} />
                Changes
            </div>

            {/* Changes section body */}
            <div
                data-testid="commit-panel-changes-body"
                style={sectionBodyStyle(commitCollapsed, {
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: 0,
                })}
            >
                <Box flex={1} minH={0} overflow="hidden" display="flex" flexDirection="column">
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
            </div>

            {/* Resize handle */}
            {!commitCollapsed && !graphCollapsed && (
                <Box
                    data-testid="commit-panel-resize-handle"
                    h="5px"
                    flexShrink={0}
                    cursor="row-resize"
                    bg="var(--vscode-panel-border)"
                    onMouseDown={onMouseDown}
                    _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                />
            )}

            {/* Graph section header */}
            <div style={sectionHeader} onClick={() => setGraphCollapsed((c) => !c)}>
                <ChevronIcon expanded={!graphCollapsed} />
                Graph
            </div>

            {/* Graph section body */}
            <div
                data-testid="commit-panel-graph-body"
                style={sectionBodyStyle(graphCollapsed, {
                    flexGrow: 0,
                    flexShrink: 0,
                    flexBasis: "auto",
                })}
            >
                <Box h={`${graphHeight}px`} flexShrink={0} overflow="hidden" minH="120px">
                    <NativeCommitGraph
                        vscode={vscode}
                        stateKeyPrefix="commitPanelGraph"
                        sendReady={false}
                    />
                </Box>
            </div>
        </Box>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
