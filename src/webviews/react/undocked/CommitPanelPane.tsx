import React from "react";
import { Box } from "@chakra-ui/react";
import { TabBar } from "../commit-panel/components/TabBar";
import { CommitTab } from "../commit-panel/components/CommitTab";
import { ShelfTab } from "../commit-panel/components/ShelfTab";
import type { WorkingFile } from "../../../types";
import type { CommitPanelState } from "./commitPanelState";

interface CommitPanelPaneProps {
    width: number;
    cpState: CommitPanelState;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    canCommit: boolean;
    onPush: () => void;
    canPush: boolean;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

/**
 * Embeds the shared commit/shelf tab UI inside the undocked layout while routing
 * all selection, amend, commit, and grouping callbacks back to the app shell.
 */
export function CommitPanelPane({
    width,
    cpState,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onMessageChange,
    onAmendChange,
    onCommit,
    canCommit,
    onPush,
    canPush,
    groupByDir,
    onToggleGroupBy,
}: CommitPanelPaneProps): React.ReactElement {
    return (
        <Box
            data-testid="undocked-commit-panel-section"
            style={{ width: `${width}px` }}
            flexShrink={0}
            overflow="hidden"
            display="flex"
            flexDirection="column"
        >
            <Box flex={1} overflow="hidden" display="flex" flexDirection="column">
                <TabBar
                    stashCount={cpState.stashes.length}
                    commitContent={
                        <CommitTab
                            files={cpState.files}
                            commitMessage={cpState.commitMessage}
                            isAmend={cpState.isAmend}
                            amendBranchCommits={cpState.amendBranchCommits}
                            amendBranchHistoryLoaded={cpState.amendBranchHistoryLoaded}
                            isRefreshing={cpState.isRefreshing}
                            checkedPaths={checkedPaths}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            onToggleSection={onToggleSection}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onMessageChange={onMessageChange}
                            onAmendChange={onAmendChange}
                            onCommit={onCommit}
                            canCommit={canCommit}
                            onPush={onPush}
                            canPush={canPush}
                            folderIcon={cpState.folderIcon}
                            folderExpandedIcon={cpState.folderExpandedIcon}
                            folderIconsByName={cpState.folderIconsByName}
                            groupByDir={groupByDir}
                            onToggleGroupBy={onToggleGroupBy}
                        />
                    }
                    shelfContent={
                        <ShelfTab
                            stashes={cpState.stashes}
                            shelfFiles={cpState.shelfFiles}
                            selectedIndex={cpState.selectedShelfIndex}
                            folderIcon={cpState.folderIcon}
                            folderExpandedIcon={cpState.folderExpandedIcon}
                            folderIconsByName={cpState.folderIconsByName}
                            groupByDir={groupByDir}
                            onToggleGroupBy={onToggleGroupBy}
                        />
                    }
                />
            </Box>
        </Box>
    );
}
