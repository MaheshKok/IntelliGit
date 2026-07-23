import React from "react";
import { Box } from "@chakra-ui/react";
import { TabBar } from "../commit-panel/components/TabBar";
import { CommitTab } from "../commit-panel/components/CommitTab";
import { StashTab } from "../commit-panel/components/StashTab";
import { ShelfTab } from "../commit-panel/components/ShelfTab";
import { getVsCodeApi } from "../commit-panel/hooks/useVsCodeApi";
import type { WorkingFile } from "../../../types";
import type { CommitPanelState } from "./commitPanelState";

interface CommitPanelPaneProps {
    width: number;
    repositoryRoot?: string;
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
    onSync: () => void;
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    canPush: boolean;
    pushLabel: string;
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
}

/**
 * Embeds the shared commit/stash tab UI inside the undocked layout while routing
 * all selection, amend, commit, and grouping callbacks back to the app shell.
 */
// Pass-through pane props mirror independent child controls, not a mutually exclusive variant.
// react-doctor-disable-next-line react-doctor/no-many-boolean-props
export function CommitPanelPane({
    width,
    repositoryRoot,
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
    onSync,
    onFetch,
    onPull,
    onPush,
    canPush,
    pushLabel,
    groupByDir,
    showIgnoredFiles,
    onToggleGroupBy,
    onToggleShowIgnoredFiles,
}: CommitPanelPaneProps): React.ReactElement {
    const vscode = getVsCodeApi();
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
                    onSync={onSync}
                    onFetch={onFetch}
                    onPull={onPull}
                    onPush={onPush}
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
                            pushLabel={pushLabel}
                            currentBranchName={cpState.currentBranchName}
                            currentBranchUpstream={cpState.currentBranchUpstream}
                            folderIcon={cpState.folderIcon}
                            folderExpandedIcon={cpState.folderExpandedIcon}
                            folderIconsByName={cpState.folderIconsByName}
                            groupByDir={groupByDir}
                            showIgnoredFiles={showIgnoredFiles}
                            onToggleGroupBy={onToggleGroupBy}
                            onToggleShowIgnoredFiles={onToggleShowIgnoredFiles}
                            catalogGeneration={cpState.catalogGeneration}
                        />
                    }
                    stashContent={
                        <StashTab
                            currentBranchName={cpState.currentBranchName}
                            stashes={cpState.stashes}
                            stashFiles={cpState.stashFiles}
                            selectedIndex={cpState.selectedStashIndex}
                            folderIcon={cpState.folderIcon}
                            folderExpandedIcon={cpState.folderExpandedIcon}
                            folderIconsByName={cpState.folderIconsByName}
                            groupByDir={groupByDir}
                            onToggleGroupBy={onToggleGroupBy}
                        />
                    }
                    shelfContent={
                        <ShelfTab
                            repositoryRoot={repositoryRoot}
                            shelves={cpState.shelves}
                            shelfFiles={cpState.shelfFiles}
                            selectedShelfId={cpState.selectedShelfId}
                            catalogGeneration={cpState.catalogGeneration}
                            groupByDir={groupByDir}
                            outcome={cpState.shelfMutationOutcome ?? undefined}
                            onSelect={(message) => vscode.postMessage(message)}
                            onUnshelve={(message) => vscode.postMessage(message)}
                            onUnshelveSilently={(message) => vscode.postMessage(message)}
                            onRename={(message) => vscode.postMessage(message)}
                            onDelete={(message) => vscode.postMessage(message)}
                            onShowDiff={(message) => vscode.postMessage(message)}
                            onCompareWithLocal={(message) => vscode.postMessage(message)}
                            onRestoreGhost={(message) => vscode.postMessage(message)}
                            onImportPatch={(message) => vscode.postMessage(message)}
                            onExportPatch={(message) => vscode.postMessage(message)}
                            onCleanUp={(message) => vscode.postMessage(message)}
                            onOpenConflictEditor={(message) => vscode.postMessage(message)}
                            onResolveStructural={(message) => vscode.postMessage(message)}
                        />
                    }
                />
            </Box>
        </Box>
    );
}
