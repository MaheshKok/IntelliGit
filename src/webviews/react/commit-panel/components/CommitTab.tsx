// The main Commit tab: toolbar + file tree + drag handle + commit area.
// Composes all commit-related sub-components into the commit workflow.

import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
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
import { ContextMenu, type MenuItem } from "../../shared/components/ContextMenu";
import { t } from "../../shared/i18n";
import { ShelveDialog, type ShelveDialogSubmit } from "./ShelveDialog";

const MIN_REFRESH_FEEDBACK_MS = 700;
let shelfRequestSequence = 0;

function nextShelfRequestId(): string {
    shelfRequestSequence += 1;
    return `shelf-${Date.now()}-${shelfRequestSequence}`;
}

interface Props {
    repositoryRoot?: string;
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
    showIgnoredFiles: boolean;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
    catalogGeneration: number;
    onShelfFileDragStart?: (
        event: React.DragEvent<HTMLElement>,
        file: WorkingFile,
        checkedPaths: ReadonlySet<string>,
    ) => void;
}

/**
 * Renders the working-tree commit workflow and sends toolbar actions to the host.
 *
 * The tab owns local refresh feedback, expand/collapse signals, file-row diff
 * requests, stash/rollback commands, and the draggable commit-message area while
 * delegating checked-path state to the root commit-panel app.
 */
// Independent commit workflow flags come from different host state; grouping them would hide intent.
// react-doctor-disable-next-line react-doctor/no-many-boolean-props
export function CommitTab({
    repositoryRoot,
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
    showIgnoredFiles,
    onToggleGroupBy,
    onToggleShowIgnoredFiles,
    catalogGeneration,
    onShelfFileDragStart,
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
    const [shelfMenuPosition, setShelfMenuPosition] = useState<{ x: number; y: number } | null>(
        null,
    );
    const [isShelveDialogOpen, setIsShelveDialogOpen] = useState(false);
    const [defaultShelfName, setDefaultShelfName] = useState("");
    const shelfDialogFocusRef = useRef<HTMLElement | null>(null);
    const refreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const hasMergeConflicts = files.some((file) => file.status === "U");
    const shelvePaths = useMemo(() => {
        const selected = Array.from(checkedPaths);
        return selected.length > 0 ? selected : files.map((file) => file.path);
    }, [checkedPaths, files]);
    const openShelfMenuAt = useCallback(
        (x: number, y: number) => {
            setDefaultShelfName(commitMessage || t("shelf.defaultName"));
            setShelfMenuPosition({ x, y });
        },
        [commitMessage],
    );

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
        // Host refresh state drives transient visual feedback; this is prop synchronization.
        // react-doctor-disable-next-line react-doctor/no-event-handler
        if (isRefreshing) {
            // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
            showRefreshFeedback();
        }
    }, [isRefreshing, showRefreshFeedback]);

    useEffect(() => clearRefreshFeedbackTimer, [clearRefreshFeedbackTimer]);

    const handleRefresh = useCallback(() => {
        showRefreshFeedback();
        vscode.postMessage({ type: "refresh", ...(repositoryRoot ? { repositoryRoot } : {}) });
    }, [repositoryRoot, showRefreshFeedback, vscode]);

    const handleRollback = useCallback(() => {
        vscode.postMessage({
            type: "rollback",
            ...(repositoryRoot ? { repositoryRoot } : {}),
            paths: Array.from(checkedPaths),
        });
    }, [repositoryRoot, vscode, checkedPaths]);

    const handleStash = useCallback(() => {
        const selected = Array.from(checkedPaths);
        vscode.postMessage({
            type: "stashSave",
            ...(repositoryRoot ? { repositoryRoot } : {}),
            paths: selected.length > 0 ? selected : undefined,
        });
    }, [repositoryRoot, vscode, checkedPaths]);

    const handleShelve = useCallback(
        (input: ShelveDialogSubmit, silent: boolean, keepLocal: boolean) => {
            if (input.paths.length === 0) return;
            const requestId = nextShelfRequestId();
            vscode.postMessage({
                type: "shelveSave",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                requestId,
                name: input.name,
                paths: input.paths,
                silent,
                keepLocal,
                idempotencyToken: requestId,
                expectedCatalogGeneration: catalogGeneration,
            });
        },
        [catalogGeneration, repositoryRoot, vscode],
    );

    const handleOpenShelfMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            shelfDialogFocusRef.current = event.currentTarget;
            const rect = event.currentTarget.getBoundingClientRect();
            openShelfMenuAt(rect.left, rect.bottom + 4);
        },
        [openShelfMenuAt],
    );
    const shelfMenuItems = useMemo<MenuItem[]>(
        () => [
            {
                label: t("shelf.action.shelveChangesMenu"),
                action: "openDialog",
                disabled: shelvePaths.length === 0,
            },
            {
                label: t("shelf.action.shelveSilently"),
                action: "silent",
                disabled: shelvePaths.length === 0,
            },
            {
                label: t("shelf.action.save"),
                action: "keepLocal",
                disabled: shelvePaths.length === 0,
            },
        ],
        [shelvePaths.length],
    );
    const handleSelectShelfMenuItem = useCallback(
        (action: string) => {
            setShelfMenuPosition(null);
            if (action === "openDialog") setIsShelveDialogOpen(true);
            if (action === "silent")
                handleShelve({ name: defaultShelfName, paths: shelvePaths }, true, false);
            if (action === "keepLocal")
                handleShelve({ name: defaultShelfName, paths: shelvePaths }, false, true);
        },
        [defaultShelfName, handleShelve, shelvePaths],
    );

    const handleShowDiff = useCallback(() => {
        const selected = Array.from(checkedPaths);
        if (selected.length > 0) {
            vscode.postMessage({
                type: "showDiff",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                path: selected[0],
            });
        }
    }, [repositoryRoot, vscode, checkedPaths]);

    const handleAbortMerge = useCallback(() => {
        vscode.postMessage({ type: "abortMerge", ...(repositoryRoot ? { repositoryRoot } : {}) });
    }, [repositoryRoot, vscode]);

    const handleFileClick = useCallback(
        (path: string) => {
            vscode.postMessage({
                type: "showDiff",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                path,
            });
        },
        [repositoryRoot, vscode],
    );

    const handleTrackUnversionedFiles = useCallback(
        (paths: string[]) => {
            vscode.postMessage({
                type: "trackUnversionedFiles",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                paths,
            });
        },
        [repositoryRoot, vscode],
    );

    return (
        <Flex
            ref={containerRef}
            data-testid="commit-tab"
            direction="column"
            flex={1}
            overflow="hidden"
            onContextMenu={(event) => {
                if (
                    event.target instanceof Element &&
                    event.target.closest("[data-vscode-context]")
                )
                    return;
                event.preventDefault();
                openShelfMenuAt(event.clientX, event.clientY);
            }}
        >
            <Toolbar
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing || isRefreshFeedbackActive}
                groupByDir={groupByDir}
                showIgnoredFiles={showIgnoredFiles}
                onRollback={handleRollback}
                onToggleGroupBy={onToggleGroupBy}
                onToggleShowIgnoredFiles={onToggleShowIgnoredFiles}
                onStash={handleStash}
                onOpenShelfMenu={handleOpenShelfMenu}
                onShowDiff={handleShowDiff}
                onExpandAll={() => setExpandAllSignal((s) => s + 1)}
                onCollapseAll={() => setCollapseAllSignal((s) => s + 1)}
                showAbortMerge={hasMergeConflicts}
                onAbortMerge={handleAbortMerge}
            />
            {shelfMenuPosition ? (
                <ContextMenu
                    x={shelfMenuPosition.x}
                    y={shelfMenuPosition.y}
                    minWidth={190}
                    items={shelfMenuItems}
                    onSelect={handleSelectShelfMenuItem}
                    onClose={() => setShelfMenuPosition(null)}
                />
            ) : null}

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
                    showIgnoredFiles={showIgnoredFiles}
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
                    onShelfFileDragStart={onShelfFileDragStart}
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
            {isShelveDialogOpen ? (
                <ShelveDialog
                    files={files}
                    defaultName={defaultShelfName}
                    selectedPaths={shelvePaths}
                    returnFocusTarget={shelfDialogFocusRef.current}
                    onClose={() => setIsShelveDialogOpen(false)}
                    onSubmit={(input) => {
                        handleShelve(input, false, false);
                        setIsShelveDialogOpen(false);
                    }}
                />
            ) : null}
        </Flex>
    );
}
