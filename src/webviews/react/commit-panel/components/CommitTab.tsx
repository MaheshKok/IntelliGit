// The main Commit tab: toolbar + file tree + drag handle + commit area.
// Composes all commit-related sub-components into the commit workflow.

import React, { useRef, useState, useCallback, useEffect } from "react";
import { Flex, Box } from "@chakra-ui/react";
import { Toolbar } from "./Toolbar";
import { FileTree } from "./FileTree";
import { CommitArea } from "./CommitArea";
import { useDragResize } from "../hooks/useDragResize";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type {
    ThemeFolderIconMap,
    ThemeTreeIcon,
    WorkingFile,
    AmendBranchCommitSummary,
} from "../../../../types";
import { AmendContextSection } from "./AmendContextSection";

const MIN_REFRESH_FEEDBACK_MS = 700;

interface Props {
    files: WorkingFile[];
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    commitMessage: string;
    isAmend: boolean;
    amendBranchCommits: AmendBranchCommitSummary[];
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
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
    pushLabel: string;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

/**
 * Renders the working-tree commit workflow and sends toolbar actions to the host.
 *
 * The tab owns local refresh feedback, expand/collapse signals, file-row diff
 * requests, shelf/rollback commands, and the draggable commit-message area while
 * delegating checked-path state to the root commit-panel app.
 */
export function CommitTab({
    files,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    commitMessage,
    isAmend,
    amendBranchCommits,
    amendBranchHistoryLoaded,
    isRefreshing,
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
    pushLabel,
    currentBranchName,
    currentBranchUpstream,
    groupByDir,
    onToggleGroupBy,
}: Props): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const { height: bottomHeight, onMouseDown: onDragMouseDown } = useDragResize(
        170,
        110,
        containerRef,
    );
    const vscode = getVsCodeApi();
    const [expandAllSignal, setExpandAllSignal] = useState(0);
    const [collapseAllSignal, setCollapseAllSignal] = useState(0);
    const [isRefreshFeedbackActive, setIsRefreshFeedbackActive] = useState(false);
    const refreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const clearRefreshFeedbackTimer = useCallback(() => {
        if (refreshFeedbackTimerRef.current) {
            clearTimeout(refreshFeedbackTimerRef.current);
            refreshFeedbackTimerRef.current = undefined;
        }
    }, []);

    const showRefreshFeedback = useCallback(() => {
        clearRefreshFeedbackTimer();
        setIsRefreshFeedbackActive(true);
        refreshFeedbackTimerRef.current = setTimeout(() => {
            setIsRefreshFeedbackActive(false);
            refreshFeedbackTimerRef.current = undefined;
        }, MIN_REFRESH_FEEDBACK_MS);
    }, [clearRefreshFeedbackTimer]);

    useEffect(() => {
        if (isRefreshing) {
            // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
            showRefreshFeedback();
        }
    }, [isRefreshing, showRefreshFeedback]);

    useEffect(() => clearRefreshFeedbackTimer, [clearRefreshFeedbackTimer]);

    const handleRefresh = useCallback(() => {
        showRefreshFeedback();
        vscode.postMessage({ type: "refresh" });
    }, [showRefreshFeedback, vscode]);

    const handleRollback = useCallback(() => {
        vscode.postMessage({ type: "rollback", paths: Array.from(checkedPaths) });
    }, [vscode, checkedPaths]);

    const handleShelve = useCallback(() => {
        const selected = Array.from(checkedPaths);
        vscode.postMessage({
            type: "shelveSave",
            paths: selected.length > 0 ? selected : undefined,
        });
    }, [vscode, checkedPaths]);

    const handleShowDiff = useCallback(() => {
        const selected = Array.from(checkedPaths);
        if (selected.length > 0) {
            vscode.postMessage({ type: "showDiff", path: selected[0] });
        }
    }, [vscode, checkedPaths]);

    const handleFileClick = useCallback(
        (path: string) => {
            vscode.postMessage({ type: "showDiff", path });
        },
        [vscode],
    );

    const handleTrackUnversionedFiles = useCallback(
        (paths: string[]) => {
            vscode.postMessage({ type: "trackUnversionedFiles", paths });
        },
        [vscode],
    );

    return (
        <Flex ref={containerRef} direction="column" flex={1} overflow="hidden">
            <Toolbar
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing || isRefreshFeedbackActive}
                onRollback={handleRollback}
                onToggleGroupBy={onToggleGroupBy}
                onShelve={handleShelve}
                onShowDiff={handleShowDiff}
                onExpandAll={() => setExpandAllSignal((s) => s + 1)}
                onCollapseAll={() => setCollapseAllSignal((s) => s + 1)}
            />

            {isAmend ? (
                <AmendContextSection
                    commits={amendBranchCommits}
                    historyLoaded={amendBranchHistoryLoaded}
                />
            ) : null}

            <Box flex="1 1 auto" overflowY="auto" minH="40px" bg="var(--intelligit-pycharm-panel)">
                <FileTree
                    files={files}
                    groupByDir={groupByDir}
                    folderIcon={folderIcon}
                    folderExpandedIcon={folderExpandedIcon}
                    folderIconsByName={folderIconsByName}
                    checkedPaths={checkedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    onToggleSection={onToggleSection}
                    isAllChecked={isAllChecked}
                    isSomeChecked={isSomeChecked}
                    onFileClick={handleFileClick}
                    onTrackUnversionedFiles={handleTrackUnversionedFiles}
                    expandAllSignal={expandAllSignal}
                    collapseAllSignal={collapseAllSignal}
                />
            </Box>

            {/* Drag handle */}
            <Box
                flex="0 0 4px"
                cursor="row-resize"
                bg="var(--intelligit-pycharm-border)"
                position="relative"
                _hover={{ bg: "var(--intelligit-pycharm-blue)" }}
                onMouseDown={onDragMouseDown}
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

            {/* Bottom area */}
            <Box
                flexShrink={0}
                h={`${bottomHeight}px`}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                <CommitArea
                    commitMessage={commitMessage}
                    isAmend={isAmend}
                    onMessageChange={onMessageChange}
                    onAmendChange={onAmendChange}
                    onCommit={onCommit}
                    onPush={onPush}
                    canCommit={canCommit}
                    canPush={canPush}
                    pushLabel={pushLabel}
                    currentBranchName={currentBranchName}
                    currentBranchUpstream={currentBranchUpstream}
                />
            </Box>
        </Flex>
    );
}
