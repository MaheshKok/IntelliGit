// Stateless layout renderer for the undocked webview shell.
// App keeps reducers, effects, callbacks, and derived booleans; this component only renders them.
// The DOM structure and data-testid attributes match the former App return tree.

import React from "react";
import { Box, ChakraProvider } from "@chakra-ui/react";
import type {
    Branch,
    Commit,
    CommitDetail,
    GitWorktree,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../types";
import type { BranchAction, CommitAction, WorktreeAction } from "../../protocol/commitGraphTypes";
import type { RepositoryViewIdentity } from "../../protocol/undockedMessages";
import { BranchColumn } from "../BranchColumn";
import { CommitList } from "../CommitList";
import { CommitInfoPane } from "../commit-info/CommitInfoPane";
import theme from "../commit-panel/theme";
import { t } from "../shared/i18n";
import { ThemeIconFontFaces } from "../shared/components/ThemeIconFontFaces";
import { CommitPanelPane } from "./CommitPanelPane";
import { RepositoryColumn } from "./RepositoryColumn";
import { UndockedHeader } from "./UndockedHeader";
import type { CommitChecksValue, CommitPanelState } from "./commitPanelState";

/**
 * Props consumed by the stateless undocked layout renderer.
 *
 * Includes the graph data, commit-panel data, divider handlers, and action
 * callbacks that the former App return tree referenced.
 */
export interface UndockedLayoutProps {
    iconFonts: ThemeIconFont[];
    cpState: CommitPanelState;
    checkedPaths: Set<string>;
    commitPanelPosition: "left" | "right";
    commitPanelWidth: number;
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    repositories: RepositoryViewIdentity[];
    selectedRepositoryRoot: string | null;
    branches: Branch[];
    worktrees: GitWorktree[];
    selectedBranch: string | null;
    commits: Commit[];
    selectedHash: string | null;
    filterText: string;
    hasMore: boolean;
    unpushedHashes: Set<string>;
    currentBranchName: string | null;
    commitChecks: Map<string, CommitChecksValue>;
    commitChecksEnabled: boolean;
    selectedDetail: CommitDetail | null;
    commitDetailLoading: boolean;
    branchFolderIcon?: ThemeTreeIcon;
    branchFolderExpandedIcon?: ThemeTreeIcon;
    branchFolderIconsByName?: ThemeFolderIconMap;
    commitFolderIcon?: ThemeTreeIcon;
    commitFolderExpandedIcon?: ThemeTreeIcon;
    commitFolderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    canCommit: boolean;
    canPush: boolean;
    pushLabel: string;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    layoutRef: React.MutableRefObject<HTMLDivElement | null>;
    markWidthsHydrated: () => void;
    onLeftCommitPanelDividerMouseDown: (e: React.MouseEvent) => void;
    onLeftCommitPanelDividerKeyDown: (e: React.KeyboardEvent) => void;
    onBranchDividerMouseDown: (e: React.MouseEvent) => void;
    onBranchDividerKeyDown: (e: React.KeyboardEvent) => void;
    onGraphDividerMouseDown: (e: React.MouseEvent) => void;
    onGraphDividerKeyDown: (e: React.KeyboardEvent) => void;
    onRightCommitPanelDividerMouseDown: (e: React.MouseEvent) => void;
    onRightCommitPanelDividerKeyDown: (e: React.KeyboardEvent) => void;
    handleSelectRepository: (repositoryRoot: string) => void;
    handleSelectCommit: (hash: string) => void;
    handleFilterText: (text: string) => void;
    handleLoadMore: () => void;
    handleSelectBranch: (name: string | null) => void;
    handleBranchAction: (action: BranchAction, branchName: string) => void;
    handleDeleteBranches: (branches: Branch[]) => void;
    handleWorktreeAction: (action: WorktreeAction, path: string) => void;
    handleCommitAction: (action: CommitAction, hash: string) => void;
    handleOpenDiff: (commitHash: string, filePath: string) => void;
    handleRequestCommitChecks: (hash: string) => void;
    handleOpenCommitCheckUrl: (url: string) => void;
    handleSignInForCommitChecks: (host: string) => void;
    handleMessageChange: (message: string) => void;
    handleAmendChange: (isAmend: boolean) => void;
    handleCommit: () => void;
    handlePush: () => void;
    handleSync: () => void;
    handleFetch: () => void;
    handlePull: () => void;
    toggleFile: (path: string) => void;
    toggleFolder: (files: WorkingFile[]) => void;
    toggleSection: (files: WorkingFile[]) => void;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
    onDock: () => void;
}

/**
 * Renders the undocked split-pane layout.
 *
 * @param props - All state, callbacks, and refs previously read by App's return tree.
 */
export function UndockedLayout(props: UndockedLayoutProps): React.ReactElement {
    const {
        iconFonts,
        cpState,
        checkedPaths,
        commitPanelPosition,
        commitPanelWidth,
        branchWidth,
        graphWidth,
        infoWidth,
        repositories,
        selectedRepositoryRoot,
        branches,
        worktrees,
        selectedBranch,
        commits,
        selectedHash,
        filterText,
        hasMore,
        unpushedHashes,
        currentBranchName,
        commitChecks,
        commitChecksEnabled,
        selectedDetail,
        commitDetailLoading,
        branchFolderIcon,
        branchFolderExpandedIcon,
        branchFolderIconsByName,
        commitFolderIcon,
        commitFolderExpandedIcon,
        commitFolderIconsByName,
        groupByDir,
        showIgnoredFiles,
        canCommit,
        canPush,
        pushLabel,
        isAllChecked,
        isSomeChecked,
        layoutRef,
        markWidthsHydrated,
        onLeftCommitPanelDividerMouseDown,
        onLeftCommitPanelDividerKeyDown,
        onBranchDividerMouseDown,
        onBranchDividerKeyDown,
        onGraphDividerMouseDown,
        onGraphDividerKeyDown,
        onRightCommitPanelDividerMouseDown,
        onRightCommitPanelDividerKeyDown,
        handleSelectRepository,
        handleSelectCommit,
        handleFilterText,
        handleLoadMore,
        handleSelectBranch,
        handleBranchAction,
        handleDeleteBranches,
        handleWorktreeAction,
        handleCommitAction,
        handleOpenDiff,
        handleRequestCommitChecks,
        handleOpenCommitCheckUrl,
        handleSignInForCommitChecks,
        handleMessageChange,
        handleAmendChange,
        handleCommit,
        handlePush,
        handleSync,
        handleFetch,
        handlePull,
        toggleFile,
        toggleFolder,
        toggleSection,
        onToggleGroupBy,
        onToggleShowIgnoredFiles,
        onDock,
    } = props;

    return (
        <ChakraProvider theme={theme}>
            <ThemeIconFontFaces fonts={iconFonts} />
            <Box display="flex" height="100vh" overflow="hidden" flexDirection="column">
                <UndockedHeader onDock={onDock} />
                <Box ref={layoutRef} display="flex" flex={1} overflow="hidden" minHeight={0}>
                    <RepositoryColumn
                        repositories={repositories}
                        selectedRepositoryRoot={selectedRepositoryRoot}
                        onSelectRepository={handleSelectRepository}
                    />

                    {/* Divider and commit panel — only on left side */}
                    {commitPanelPosition === "left" && (
                        <>
                            <CommitPanelPane
                                width={commitPanelWidth}
                                cpState={cpState}
                                checkedPaths={checkedPaths}
                                onToggleFile={toggleFile}
                                onToggleFolder={toggleFolder}
                                onToggleSection={toggleSection}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onMessageChange={handleMessageChange}
                                onAmendChange={handleAmendChange}
                                onCommit={handleCommit}
                                canCommit={canCommit}
                                onSync={handleSync}
                                onFetch={handleFetch}
                                onPull={handlePull}
                                onPush={handlePush}
                                canPush={canPush}
                                pushLabel={pushLabel}
                                groupByDir={groupByDir}
                                showIgnoredFiles={showIgnoredFiles}
                                onToggleGroupBy={onToggleGroupBy}
                                onToggleShowIgnoredFiles={onToggleShowIgnoredFiles}
                            />

                            <Box
                                as="button"
                                type="button"
                                aria-label={t("a11y.resizeCommitPanel")}
                                data-testid="undocked-left-commit-divider"
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                border={0}
                                p={0}
                                onMouseDown={(e: React.MouseEvent) => {
                                    markWidthsHydrated();
                                    onLeftCommitPanelDividerMouseDown(e);
                                }}
                                onKeyDown={onLeftCommitPanelDividerKeyDown}
                                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                            />
                        </>
                    )}

                    {/* Graph panel */}
                    <Box display="flex" overflow="hidden" flexShrink={0}>
                        {/* react-doctor-disable-next-line react-doctor/no-static-element-interactions */}
                        <div
                            data-testid="undocked-branch-section"
                            style={{ width: branchWidth, flexShrink: 0, overflow: "hidden" }}
                        >
                            <BranchColumn
                                branches={branches}
                                worktrees={worktrees}
                                selectedBranch={selectedBranch}
                                onSelectBranch={handleSelectBranch}
                                onBranchAction={handleBranchAction}
                                onDeleteBranches={handleDeleteBranches}
                                onWorktreeAction={handleWorktreeAction}
                                folderIcon={branchFolderIcon}
                                folderExpandedIcon={branchFolderExpandedIcon}
                                folderIconsByName={branchFolderIconsByName}
                            />
                        </div>

                        <button
                            type="button"
                            aria-label={t("a11y.resizeBranchColumn")}
                            data-testid="undocked-branch-divider"
                            style={{
                                width: 4,
                                flexShrink: 0,
                                cursor: "col-resize",
                                background: "var(--vscode-panel-border)",
                                border: 0,
                                padding: 0,
                            }}
                            onMouseDown={(e) => {
                                markWidthsHydrated();
                                onBranchDividerMouseDown(e);
                            }}
                            onKeyDown={onBranchDividerKeyDown}
                        />

                        <div style={{ display: "flex", overflow: "hidden", flexShrink: 0 }}>
                            {/* react-doctor-disable-next-line react-doctor/no-static-element-interactions */}
                            <div
                                data-testid="undocked-graph-section"
                                style={{
                                    width: graphWidth,
                                    flexShrink: 0,
                                    overflow: "hidden",
                                }}
                            >
                                <CommitList
                                    commits={commits}
                                    selectedHash={selectedHash}
                                    filterText={filterText}
                                    hasMore={hasMore}
                                    unpushedHashes={unpushedHashes}
                                    selectedBranch={selectedBranch}
                                    currentBranchName={currentBranchName}
                                    onSelectCommit={handleSelectCommit}
                                    onFilterText={handleFilterText}
                                    onLoadMore={handleLoadMore}
                                    onCommitAction={handleCommitAction}
                                    commitChecks={commitChecks}
                                    onRequestCommitChecks={
                                        commitChecksEnabled ? handleRequestCommitChecks : undefined
                                    }
                                    onOpenCommitCheckUrl={
                                        commitChecksEnabled ? handleOpenCommitCheckUrl : undefined
                                    }
                                    onSignInForCommitChecks={
                                        commitChecksEnabled
                                            ? handleSignInForCommitChecks
                                            : undefined
                                    }
                                />
                            </div>

                            <button
                                type="button"
                                aria-label={t("a11y.resizeCommitList")}
                                data-testid="undocked-graph-divider"
                                style={{
                                    width: 4,
                                    flexShrink: 0,
                                    cursor: "col-resize",
                                    background: "var(--vscode-panel-border)",
                                    border: 0,
                                    padding: 0,
                                }}
                                onMouseDown={(e: React.MouseEvent) => {
                                    markWidthsHydrated();
                                    onGraphDividerMouseDown(e);
                                }}
                                onKeyDown={onGraphDividerKeyDown}
                            />

                            <div
                                data-testid="undocked-info-section"
                                style={{
                                    width: infoWidth,
                                    flexShrink: 0,
                                    overflow: "hidden",
                                }}
                            >
                                <CommitInfoPane
                                    detail={selectedDetail}
                                    loading={commitDetailLoading}
                                    folderIcon={commitFolderIcon}
                                    folderExpandedIcon={commitFolderExpandedIcon}
                                    folderIconsByName={commitFolderIconsByName}
                                    onOpenDiff={handleOpenDiff}
                                />
                            </div>
                        </div>
                    </Box>

                    {/* Divider and commit panel — only on right side */}
                    {commitPanelPosition === "right" && (
                        <>
                            <Box
                                as="button"
                                type="button"
                                aria-label={t("a11y.resizeCommitPanel")}
                                data-testid="undocked-right-commit-divider"
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                border={0}
                                p={0}
                                onMouseDown={(e: React.MouseEvent) => {
                                    markWidthsHydrated();
                                    onRightCommitPanelDividerMouseDown(e);
                                }}
                                onKeyDown={onRightCommitPanelDividerKeyDown}
                                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                            />

                            <CommitPanelPane
                                width={commitPanelWidth}
                                cpState={cpState}
                                checkedPaths={checkedPaths}
                                onToggleFile={toggleFile}
                                onToggleFolder={toggleFolder}
                                onToggleSection={toggleSection}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onMessageChange={handleMessageChange}
                                onAmendChange={handleAmendChange}
                                onCommit={handleCommit}
                                canCommit={canCommit}
                                onSync={handleSync}
                                onFetch={handleFetch}
                                onPull={handlePull}
                                onPush={handlePush}
                                canPush={canPush}
                                pushLabel={pushLabel}
                                groupByDir={groupByDir}
                                showIgnoredFiles={showIgnoredFiles}
                                onToggleGroupBy={onToggleGroupBy}
                                onToggleShowIgnoredFiles={onToggleShowIgnoredFiles}
                            />
                        </>
                    )}
                </Box>
            </Box>
        </ChakraProvider>
    );
}
