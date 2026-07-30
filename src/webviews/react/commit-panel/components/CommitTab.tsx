import React, { useRef } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { AmendContextSection } from "./AmendContextSection";
import { CommitArea } from "./CommitArea";
import { FileTree } from "./FileTree";
import { ShelveDialog } from "./ShelveDialog";
import { Toolbar } from "./Toolbar";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { useDragResize } from "../hooks/useDragResize";
import { type CommitTabProps, useCommitTabController } from "./CommitTabController";

/** Renders the working-tree commit workflow and delegates its interaction state to a controller. */
export function CommitTab(props: CommitTabProps): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const {
        height: bottomHeight,
        onMouseDown: onDragMouseDown,
        onKeyDown: onDragKeyDown,
    } = useDragResize(170, 110, containerRef);
    const controller = useCommitTabController(props);
    return (
        <CommitTabLayout
            bottomHeight={bottomHeight}
            containerRef={containerRef}
            controller={controller}
            onDragMouseDown={onDragMouseDown}
            onDragKeyDown={onDragKeyDown}
            props={props}
        />
    );
}

interface CommitTabLayoutProps {
    bottomHeight: number;
    containerRef: React.RefObject<HTMLDivElement>;
    controller: ReturnType<typeof useCommitTabController>;
    onDragMouseDown: React.MouseEventHandler<HTMLDivElement>;
    onDragKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
    props: CommitTabProps;
}

/** Composes the stable commit-tab view from host data and controller callbacks. */
function CommitTabLayout({
    bottomHeight,
    containerRef,
    controller,
    onDragMouseDown,
    onDragKeyDown,
    props,
}: CommitTabLayoutProps): React.ReactElement {
    return (
        <Flex
            ref={containerRef}
            data-testid="commit-tab"
            direction="column"
            flex={1}
            overflow="hidden"
            onContextMenu={controller.onCommitTabContextMenu}
        >
            <Toolbar
                onRefresh={controller.handleRefresh}
                isRefreshing={props.isRefreshing || controller.isRefreshFeedbackActive}
                groupByDir={props.groupByDir}
                showIgnoredFiles={props.showIgnoredFiles}
                onRollback={controller.handleRollback}
                onToggleGroupBy={props.onToggleGroupBy}
                onToggleShowIgnoredFiles={props.onToggleShowIgnoredFiles}
                onStash={controller.handleStash}
                onOpenShelfMenu={controller.handleOpenShelfMenu}
                onShowDiff={controller.handleShowDiff}
                onExpandAll={controller.onExpandAll}
                onCollapseAll={controller.onCollapseAll}
                showAbortMerge={controller.hasMergeConflicts}
                onAbortMerge={controller.handleAbortMerge}
            />
            {controller.shelfMenuPosition ? (
                <ContextMenu
                    x={controller.shelfMenuPosition.x}
                    y={controller.shelfMenuPosition.y}
                    minWidth={190}
                    items={controller.shelfMenuItems}
                    onSelect={controller.handleSelectShelfMenuItem}
                    onClose={controller.closeShelfMenu}
                />
            ) : null}
            {props.isAmend ? (
                <AmendContextSection
                    commits={props.amendBranchCommits}
                    historyLoaded={props.amendBranchHistoryLoaded}
                />
            ) : null}
            <Box flex="1 1 auto" overflowY="auto" minH="40px" bg="var(--intelligit-pycharm-panel)">
                <FileTree
                    files={props.files}
                    groupByDir={props.groupByDir}
                    showIgnoredFiles={props.showIgnoredFiles}
                    folderIcon={props.folderIcon}
                    folderExpandedIcon={props.folderExpandedIcon}
                    folderIconsByName={props.folderIconsByName}
                    checkedPaths={props.checkedPaths}
                    onToggleFile={props.onToggleFile}
                    onToggleFolder={props.onToggleFolder}
                    onToggleSection={props.onToggleSection}
                    isAllChecked={props.isAllChecked}
                    isSomeChecked={props.isSomeChecked}
                    onFileClick={controller.handleFileClick}
                    onTrackUnversionedFiles={controller.handleTrackUnversionedFiles}
                    onShelfFileDragStart={props.onShelfFileDragStart}
                    expandAllSignal={controller.expandAllSignal}
                    collapseAllSignal={controller.collapseAllSignal}
                />
            </Box>
            <CommitResizeHandle onDragMouseDown={onDragMouseDown} onDragKeyDown={onDragKeyDown} />
            <Box
                flexShrink={0}
                h={`${bottomHeight}px`}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                <CommitArea
                    commitMessage={props.commitMessage}
                    isAmend={props.isAmend}
                    onMessageChange={props.onMessageChange}
                    onAmendChange={props.onAmendChange}
                    onCommit={props.onCommit}
                    onPush={props.onPush}
                    canCommit={props.canCommit}
                    canPush={props.canPush}
                    pushLabel={props.pushLabel}
                    currentBranchAhead={props.currentBranchAhead}
                    currentBranchName={props.currentBranchName}
                    currentBranchUpstream={props.currentBranchUpstream}
                    generationStatus={props.generationStatus}
                    onGenerateMessage={props.onGenerateMessage}
                    onCancelGeneration={props.onCancelGeneration}
                    hasCommits={props.hasCommits}
                    hasCheckedPaths={props.checkedPaths.size > 0}
                    wholeIndexOperationInProgress={props.wholeIndexOperationInProgress}
                />
            </Box>
            {controller.isShelveDialogOpen ? (
                <ShelveDialog
                    files={props.files}
                    defaultName={controller.defaultShelfName}
                    selectedPaths={controller.shelvePaths}
                    returnFocusTarget={controller.shelfDialogFocusRef.current}
                    onClose={controller.closeShelveDialog}
                    onSubmit={controller.submitShelveDialog}
                />
            ) : null}
        </Flex>
    );
}

/** Preserves the original pointer target and visual affordance for resizing the commit area. */
function CommitResizeHandle({
    onDragMouseDown,
    onDragKeyDown,
}: Pick<CommitTabLayoutProps, "onDragMouseDown" | "onDragKeyDown">): React.ReactElement {
    return (
        <Box
            flex="0 0 4px"
            cursor="row-resize"
            role="separator"
            aria-orientation="horizontal"
            tabIndex={0}
            bg="var(--intelligit-pycharm-border)"
            position="relative"
            _hover={{ bg: "var(--intelligit-pycharm-blue)" }}
            onMouseDown={onDragMouseDown}
            onKeyDown={onDragKeyDown}
            _after={{
                content: '""',
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                w: "26px",
                h: "2px",
                bg: "var(--vscode-descriptionForeground)",
                opacity: 0.35,
                borderRadius: "1px",
            }}
        />
    );
}
