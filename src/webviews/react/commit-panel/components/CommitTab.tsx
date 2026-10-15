import React, { useRef } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { AmendContextSection } from "./AmendContextSection";
import { CommitArea } from "./CommitArea";
import { ChangelistGroups } from "./ChangelistGroups";
import { ShelveDialog } from "./ShelveDialog";
import { Toolbar } from "./Toolbar";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { useDragResize } from "../hooks/useDragResize";
import { type CommitTabProps, useCommitTabController } from "./CommitTabController";
import { t } from "../../shared/i18n";
import { useChangelists } from "../hooks/useChangelists";
import { ChangelistToolbar } from "./ChangelistToolbar";

/** Renders the working-tree commit workflow and delegates its interaction state to a controller. */
export function CommitTab(props: CommitTabProps): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const {
        height: bottomHeight,
        onMouseDown: onDragMouseDown,
        onKeyDown: onDragKeyDown,
    } = useDragResize(220, 180, containerRef);
    const workflow = useChangelists(props);
    const controller = useCommitTabController({
        ...props,
        files: workflow.files,
        checkedPaths: workflow.checkedPaths,
    });
    return (
        <CommitTabLayout
            bottomHeight={bottomHeight}
            containerRef={containerRef}
            controller={controller}
            onDragMouseDown={onDragMouseDown}
            onDragKeyDown={onDragKeyDown}
            props={props}
            workflow={workflow}
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
    workflow: ReturnType<typeof useChangelists>;
}

/** Composes the stable commit-tab view from host data and controller callbacks. */
function CommitTabLayout({
    bottomHeight,
    containerRef,
    controller,
    onDragMouseDown,
    onDragKeyDown,
    props,
    workflow,
}: CommitTabLayoutProps): React.ReactElement {
    const partialFileActions = [...workflow.checkedPaths].some((file) =>
        workflow.partialPaths.has(file),
    );
    const composer = scopedComposerProps(props, workflow);
    return (
        <Flex
            ref={containerRef}
            data-testid="commit-tab"
            direction="column"
            flex={1}
            overflow="hidden"
            onContextMenu={partialFileActions ? undefined : controller.onCommitTabContextMenu}
        >
            <Toolbar
                disableFileMutations={partialFileActions}
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
                hasFiles={props.files.length > 0}
                onExpandAll={controller.onExpandAll}
                onCollapseAll={controller.onCollapseAll}
                showAbortMerge={controller.hasMergeConflicts}
                onAbortMerge={controller.handleAbortMerge}
                activeOperation={controller.activeOperation}
                rebaseControl={controller.rebaseControl}
                onContinueRebase={controller.handleContinueRebase}
                onAbortRebase={controller.handleAbortRebase}
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
            <ChangelistToolbar
                workflow={workflow}
                disabled={props.wholeIndexOperationInProgress === true}
            />
            {workflow.error || workflow.draft.error ? (
                <div role="alert">{workflow.draft.error ?? workflow.error}</div>
            ) : null}
            <Box flex="1 1 auto" overflowY="auto" minH="40px" bg="var(--intelligit-pycharm-panel)">
                <ChangelistGroups
                    workflow={workflow}
                    files={props.files}
                    tree={{
                        repositoryRoot: props.repositoryRoot,
                        files: workflow.files,
                        groupByDir: props.groupByDir,
                        showIgnoredFiles: props.showIgnoredFiles,
                        folderIcon: props.folderIcon,
                        folderExpandedIcon: props.folderExpandedIcon,
                        folderIconsByName: props.folderIconsByName,
                        checkedPaths: workflow.checkedPaths,
                        partialPaths: workflow.partialPaths,
                        onToggleFile: workflow.toggleFile,
                        onToggleFolder: workflow.toggleFolder,
                        onToggleSection: workflow.toggleSection,
                        isAllChecked: workflow.allChecked,
                        isSomeChecked: workflow.someChecked,
                        onFileClick: controller.handleFileClick,
                        onTrackUnversionedFiles: controller.handleTrackUnversionedFiles,
                        onShelfFileDragStart: partialFileActions
                            ? undefined
                            : props.onShelfFileDragStart,
                        expandAllSignal: controller.expandAllSignal,
                        collapseAllSignal: controller.collapseAllSignal,
                    }}
                />
            </Box>
            <CommitResizeHandle onDragMouseDown={onDragMouseDown} onDragKeyDown={onDragKeyDown} />
            <Box
                onFocusCapture={workflow.draft.focus}
                flexShrink={0}
                h={`${bottomHeight}px`}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                <CommitArea
                    commitMessage={workflow.draft.message}
                    draftScope={
                        workflow.metadata
                            ? workflow.filter === "all"
                                ? t("changes.all")
                                : workflow.metadata.lists.find(
                                      (list) => list.id === workflow.filter,
                                  )?.name
                            : undefined
                    }
                    isAmend={props.isAmend}
                    onMessageChange={workflow.draft.change}
                    onCommit={() => workflow.commit()}
                    onPush={() => workflow.commit(true)}
                    onForcePush={props.onForcePush}
                    {...composer}
                    pushLabel={props.pushLabel}
                    currentBranchAhead={props.currentBranchAhead}
                    currentBranchName={props.currentBranchName}
                    currentBranchUpstream={props.currentBranchUpstream}
                    hasCommits={props.hasCommits}
                    hasCheckedPaths={workflow.checkedPaths.size > 0}
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

/** Keeps legacy readiness behavior until metadata arrives and fences scope-aware composer actions. */
function scopedComposerProps(props: CommitTabProps, workflow: ReturnType<typeof useChangelists>) {
    const ready =
        !workflow.busy &&
        !workflow.draft.pending &&
        !workflow.draft.error &&
        !props.isRefreshing &&
        !props.wholeIndexOperationInProgress;
    const hasCommit = workflow.hasEligibleSelection && workflow.draft.message.trim().length > 0;
    return {
        canCommit:
            ready &&
            (workflow.metadata
                ? hasCommit && (!props.isAmend || workflow.filter === "all")
                : props.canCommit),
        canPush: ready && (props.canPush || hasCommit),
        generationStatus: workflow.metadata
            ? workflow.draft.generationStatus
            : props.generationStatus,
        onGenerateMessage: workflow.metadata ? workflow.draft.generate : props.onGenerateMessage,
        onCancelGeneration: workflow.metadata ? workflow.draft.cancel : props.onCancelGeneration,
        onAmendChange: workflow.metadata ? workflow.draft.amend : props.onAmendChange,
    };
}
