// Unified React app for the undocked editor-tab webview.
// Layout: [BranchCol | CommitList | CommitInfoPane] | divider | [CommitPanel].
// Single message channel handles both graph and commit-panel message types.

import React, { useState, useEffect, useCallback, useMemo, useRef, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
import { shouldRequestCommitChecks } from "./commit-list/checksRefresh";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components/ThemeIconFontFaces";
import { getVsCodeApi } from "./shared/vscodeApi";
import { useCheckedFiles } from "./commit-panel/hooks/useCheckedFiles";
import theme from "./commit-panel/theme";
import { getSettings } from "./shared/settings";
import { CommitPanelPane } from "./undocked/CommitPanelPane";
import { commitPanelReducer, initialCommitPanelState } from "./undocked/commitPanelState";
import { canRunCommitAction } from "./commit-panel/commitEligibility";
import {
    computeEqualSectionWidths,
    migrateSectionWidths,
    normalizeSectionWidths,
    sectionWidthsAreClose,
    type SectionWidths,
} from "./undocked/sectionWidths";
import { UndockedHeader } from "./undocked/UndockedHeader";
import { useColumnPairDrag } from "./undocked/useColumnPairDrag";
import type {
    Branch,
    Commit,
    CommitChecksSnapshot,
    CommitDetail,
    GitWorktree,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";
import type { BranchAction, CommitAction, WorktreeAction } from "../protocol/commitGraphTypes";
import type { UnifiedInbound, UnifiedOutbound } from "../protocol/undockedMessages";

// --- Helpers ----------------------------------------------------------------

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();

type CommitChecksValue = CommitChecksSnapshot | "loading";

interface GraphState {
    commits: Commit[];
    branches: Branch[];
    worktrees: GitWorktree[];
    selectedHash: string | null;
    selectedBranch: string | null;
    hasMore: boolean;
    filterText: string;
    selectedDetail: CommitDetail | null;
    branchFolderIcon?: ThemeTreeIcon;
    branchFolderExpandedIcon?: ThemeTreeIcon;
    commitFolderIcon?: ThemeTreeIcon;
    commitFolderExpandedIcon?: ThemeTreeIcon;
    commitFolderIconsByName?: ThemeFolderIconMap;
    branchFolderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    unpushedHashes: Set<string>;
    commitChecks: Map<string, CommitChecksValue>;
    commitChecksEnabled: boolean;
}

type GraphAction =
    | {
          type: "loadCommits";
          commits: Commit[];
          append: boolean;
          hasMore: boolean;
          unpushedHashes?: string[];
      }
    | {
          type: "setBranches";
          branches: Branch[];
          worktrees?: GitWorktree[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          commitChecksEnabled?: boolean;
      }
    | { type: "setSelectedBranch"; branch: string | null }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "clearCommitDetail" }
    | { type: "setCommitChecks"; snapshot: CommitChecksSnapshot }
    | { type: "markCommitChecksLoading"; hash: string }
    | { type: "loadError"; clearCommits: boolean }
    | { type: "selectCommit"; hash: string }
    | { type: "selectBranch"; branch: string | null }
    | { type: "setFilterText"; text: string };

const initialGraphState: GraphState = {
    commits: [],
    branches: [],
    worktrees: [],
    selectedHash: null,
    selectedBranch: null,
    hasMore: false,
    filterText: "",
    selectedDetail: null,
    iconFonts: [],
    unpushedHashes: new Set(),
    commitChecks: new Map(),
    commitChecksEnabled: true,
};

function graphReducer(state: GraphState, action: GraphAction): GraphState {
    switch (action.type) {
        case "loadCommits":
            return {
                ...state,
                commits: action.append ? [...state.commits, ...action.commits] : action.commits,
                selectedHash:
                    !action.append && action.commits.length > 0
                        ? action.commits[0].hash
                        : state.selectedHash,
                hasMore: action.hasMore,
                unpushedHashes: new Set(action.unpushedHashes ?? []),
            };
        case "setBranches":
            return {
                ...state,
                branches: action.branches,
                worktrees: action.worktrees ?? [],
                branchFolderIcon: action.folderIcon,
                branchFolderExpandedIcon: action.folderExpandedIcon,
                branchFolderIconsByName: action.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                commitChecksEnabled: action.commitChecksEnabled ?? true,
            };
        case "setSelectedBranch":
            return { ...state, selectedBranch: action.branch };
        case "setCommitDetail":
            return {
                ...state,
                selectedDetail: action.detail,
                commitFolderIcon: action.folderIcon,
                commitFolderExpandedIcon: action.folderExpandedIcon,
                commitFolderIconsByName: action.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
            };
        case "clearCommitDetail":
            return {
                ...state,
                selectedDetail: null,
                commitFolderIcon: undefined,
                commitFolderExpandedIcon: undefined,
                commitFolderIconsByName: undefined,
            };
        case "setCommitChecks": {
            const next = new Map(state.commitChecks);
            next.set(action.snapshot.hash, action.snapshot);
            return { ...state, commitChecks: next };
        }
        case "markCommitChecksLoading": {
            if (state.commitChecks.get(action.hash) !== undefined) return state;
            const next = new Map(state.commitChecks);
            next.set(action.hash, "loading");
            return { ...state, commitChecks: next };
        }
        case "loadError":
            return {
                ...state,
                commits: action.clearCommits ? [] : state.commits,
                hasMore: false,
            };
        case "selectCommit":
            return { ...state, selectedHash: action.hash };
        case "selectBranch":
            return { ...state, selectedBranch: action.branch };
        case "setFilterText":
            return { ...state, filterText: action.text };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}

function App(): React.ReactElement {
    // --- Graph-side state ---
    const [graphState, graphDispatch] = useReducer(graphReducer, initialGraphState);
    const {
        commits,
        branches,
        worktrees,
        selectedHash,
        selectedBranch,
        hasMore,
        filterText,
        selectedDetail,
        branchFolderIcon,
        branchFolderExpandedIcon,
        commitFolderIcon,
        commitFolderExpandedIcon,
        commitFolderIconsByName,
        branchFolderIconsByName,
        iconFonts,
        unpushedHashes,
        commitChecks,
        commitChecksEnabled,
    } = graphState;
    const loadingMore = useRef(false);
    const currentBranchName = useMemo(
        () => branches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null,
        [branches],
    );

    // Guards the cross-session width persistence: stays false until either the
    // extension restores saved widths or the user actually drags a divider.
    // This prevents the initial equal widths (computed before restore) from
    // being sent back to the extension and clobbering the persisted values.
    const widthsHydratedRef = useRef(false);
    const markWidthsHydrated = useCallback(() => {
        widthsHydratedRef.current = true;
    }, []);

    const readInitialWidths = (): SectionWidths => {
        try {
            const state = vscode.getState();
            const migrated = migrateSectionWidths(state);
            if (migrated) {
                return normalizeSectionWidths(migrated);
            }
            return computeEqualSectionWidths();
        } catch {
            return computeEqualSectionWidths();
        }
    };
    const initialWidths = useRef<SectionWidths | null>(null);
    if (!initialWidths.current) initialWidths.current = readInitialWidths();

    const [sectionWidths, setSectionWidthsState] = useState<SectionWidths>(
        () => initialWidths.current!,
    );
    const { branchWidth, graphWidth, infoWidth, commitPanelWidth } = sectionWidths;
    const layoutRef = useRef<HTMLDivElement | null>(null);
    const sectionWidthsRef = useRef(sectionWidths);
    sectionWidthsRef.current = sectionWidths;
    const setSectionWidths = useCallback((next: SectionWidths) => {
        setSectionWidthsState(next);
    }, []);

    useEffect(() => {
        const normalizeForCurrentWidth = () => {
            const measuredWidth = layoutRef.current?.clientWidth;
            const totalWidth =
                typeof measuredWidth === "number" && measuredWidth > 0 ? measuredWidth : undefined;
            const normalized = normalizeSectionWidths(sectionWidthsRef.current, totalWidth);
            if (!sectionWidthsAreClose(sectionWidthsRef.current, normalized)) {
                setSectionWidths(normalized);
            }
        };

        normalizeForCurrentWidth();
        window.addEventListener("resize", normalizeForCurrentWidth);
        window.visualViewport?.addEventListener("resize", normalizeForCurrentWidth);

        let resizeObserver: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined" && layoutRef.current) {
            resizeObserver = new ResizeObserver(normalizeForCurrentWidth);
            resizeObserver.observe(layoutRef.current);
        }

        return () => {
            window.removeEventListener("resize", normalizeForCurrentWidth);
            window.visualViewport?.removeEventListener("resize", normalizeForCurrentWidth);
            resizeObserver?.disconnect();
        };
    }, [setSectionWidths]);

    // --- Commit-panel state ---
    const [cpState, cpDispatch] = useReducer(commitPanelReducer, initialCommitPanelState);
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(cpState.files);

    const [groupByDir, setGroupByDir] = useState<boolean>(() => {
        try {
            const saved = vscode.getState?.();
            return typeof saved?.groupByDir === "boolean" ? saved.groupByDir : true;
        } catch {
            return true;
        }
    });

    const [commitPanelPosition, setCommitPanelPosition] = useState<"left" | "right">(
        () => getSettings().commitWindowPosition,
    );

    // --- Drag handlers ---
    const onBranchDividerMouseDown = useColumnPairDrag(
        sectionWidths,
        setSectionWidths,
        "branchWidth",
        "graphWidth",
    );
    const onGraphDividerMouseDown = useColumnPairDrag(
        sectionWidths,
        setSectionWidths,
        "graphWidth",
        "infoWidth",
    );
    const onLeftCommitPanelDividerMouseDown = useColumnPairDrag(
        sectionWidths,
        setSectionWidths,
        "commitPanelWidth",
        "branchWidth",
    );
    const onRightCommitPanelDividerMouseDown = useColumnPairDrag(
        sectionWidths,
        setSectionWidths,
        "infoWidth",
        "commitPanelWidth",
    );

    // --- Persist column widths ---
    useEffect(() => {
        try {
            const prev = vscode.getState() ?? {};
            vscode.setState({ ...prev, branchWidth, graphWidth, infoWidth, commitPanelWidth });
        } catch {
            /* ignore */
        }
    }, [branchWidth, graphWidth, infoWidth, commitPanelWidth]);

    // --- Send column widths to extension for cross-session persistence ---
    const widthSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        // Never persist until hydrated, otherwise the pre-restore equal widths
        // would overwrite the user's saved widths in the extension.
        if (!widthsHydratedRef.current) return;
        if (widthSendTimer.current) clearTimeout(widthSendTimer.current);
        widthSendTimer.current = setTimeout(() => {
            vscode.postMessage({
                type: "columnWidths",
                branchWidth,
                graphWidth,
                infoWidth,
                commitPanelWidth,
            });
        }, 300); // debounce: only fire 300ms after the last drag event
        return () => {
            if (widthSendTimer.current) clearTimeout(widthSendTimer.current);
        };
    }, [branchWidth, graphWidth, infoWidth, commitPanelWidth]);

    // --- Persist groupByDir ---
    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({ ...prev, groupByDir });
    }, [groupByDir]);

    // --- Amend auto-fetch ---
    useEffect(() => {
        if (!cpState.isAmend || cpState.isRefreshing) return;
        vscode.postMessage({ type: "getAmendBranchCommits" });
    }, [cpState.isAmend, cpState.isRefreshing]);

    // --- Single message handler for both sides ---
    useEffect(() => {
        const handler = (event: MessageEvent<UnifiedInbound>) => {
            const data = event.data;

            switch (data.type) {
                // --- Graph-side messages ---
                case "loadCommits":
                    loadingMore.current = false;
                    graphDispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (!data.append && data.commits.length > 0) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: data.commits[0].hash,
                        });
                    }
                    return;

                case "setBranches":
                    graphDispatch({
                        type: "setBranches",
                        branches: data.branches,
                        worktrees: data.worktrees,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        commitChecksEnabled: data.commitChecksEnabled,
                    });
                    return;

                case "setSelectedBranch":
                    graphDispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    return;

                case "setCommitDetail":
                    graphDispatch({
                        type: "setCommitDetail",
                        detail: data.detail,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                    });
                    return;

                case "clearCommitDetail":
                    graphDispatch({ type: "clearCommitDetail" });
                    return;

                case "setCommitChecks":
                    graphDispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    return;

                case "loadError":
                    graphDispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    console.error("[IntelliGit] Load error:", data.message);
                    return;

                // --- Commit-panel-side messages ---
                case "update":
                    cpDispatch({
                        type: "SET_FILES_AND_STASHES",
                        files: data.files,
                        stashes: data.stashes,
                        shelfFiles: data.shelfFiles,
                        selectedShelfIndex: data.selectedShelfIndex,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        currentBranchHasUpstream: data.currentBranchHasUpstream ?? true,
                        hasRemotes: data.hasRemotes,
                        currentBranchAhead: data.currentBranchAhead ?? 0,
                        currentBranchBehind: data.currentBranchBehind ?? 0,
                        currentBranchName: data.currentBranchName,
                        currentBranchUpstream: data.currentBranchUpstream,
                    });
                    return;

                case "restoreCommitDraft":
                    cpDispatch({ type: "RESTORE_COMMIT_DRAFT", message: data.message });
                    return;

                case "lastCommitMessage":
                    cpDispatch({ type: "SET_LAST_COMMIT_MESSAGE", message: data.message });
                    return;

                case "amendBranchCommits":
                    cpDispatch({ type: "SET_AMEND_BRANCH_COMMITS", commits: data.commits });
                    return;

                case "committed":
                    cpDispatch({ type: "COMMITTED" });
                    return;

                case "refreshing":
                    cpDispatch({ type: "SET_REFRESHING", active: data.active });
                    return;

                case "settings":
                    setCommitPanelPosition(data.commitWindowPosition);
                    return;

                // Restore persisted column widths from extension
                case "columnWidths":
                    // Mark hydrated first so the subsequent state updates are
                    // allowed to persist (and future user drags too).
                    markWidthsHydrated();
                    {
                        const measuredWidth = layoutRef.current?.clientWidth;
                        const totalWidth =
                            typeof measuredWidth === "number" && measuredWidth > 0
                                ? measuredWidth
                                : undefined;
                        const normalized = normalizeSectionWidths(
                            {
                                branchWidth: data.branchWidth,
                                graphWidth: data.graphWidth,
                                infoWidth: data.infoWidth,
                                commitPanelWidth: data.commitPanelWidth,
                            },
                            totalWidth,
                        );
                        setSectionWidths(normalized);
                    }
                    return;

                case "error":
                    cpDispatch({ type: "SET_ERROR", message: data.message });
                    console.error("[IntelliGit] Extension error:", data.message);
                    return;
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });

        return () => window.removeEventListener("message", handler);
    }, [markWidthsHydrated, setSectionWidths]);

    // --- Graph-side callbacks ---
    const handleSelectCommit = useCallback((hash: string) => {
        graphDispatch({ type: "selectCommit", hash });
        vscode.postMessage({ type: "selectCommit", hash });
    }, []);

    const handleFilterText = useCallback((text: string) => {
        graphDispatch({ type: "setFilterText", text });
        if (text.length >= 3 || text.length === 0) {
            loadingMore.current = false;
            vscode.postMessage({ type: "filterText", text });
        }
    }, []);

    const handleLoadMore = useCallback(() => {
        if (loadingMore.current) return;
        loadingMore.current = true;
        vscode.postMessage({ type: "loadMore" });
    }, []);

    const handleSelectBranch = useCallback((name: string | null) => {
        graphDispatch({ type: "selectBranch", branch: name });
        loadingMore.current = false;
        vscode.postMessage({ type: "filterBranch", branch: name });
    }, []);

    const handleBranchAction = useCallback((action: BranchAction, branchName: string) => {
        vscode.postMessage({ type: "branchAction", action, branchName });
    }, []);

    const handleDeleteBranches = useCallback((branches: Branch[]) => {
        vscode.postMessage({ type: "deleteBranches", branches });
    }, []);

    const handleWorktreeAction = useCallback((action: WorktreeAction, path: string) => {
        vscode.postMessage({ type: "worktreeAction", action, path });
    }, []);

    const handleCommitAction = useCallback((action: CommitAction, hash: string) => {
        vscode.postMessage({ type: "commitAction", action, hash });
    }, []);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string) => {
        vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
    }, []);

    const handleRequestCommitChecks = useCallback(
        (hash: string) => {
            if (!shouldRequestCommitChecks(commitChecks.get(hash))) return;
            graphDispatch({ type: "markCommitChecksLoading", hash });
            vscode.postMessage({ type: "requestCommitChecks", hash });
        },
        [commitChecks],
    );

    const handleOpenCommitCheckUrl = useCallback((url: string) => {
        vscode.postMessage({ type: "openCommitCheckUrl", url });
    }, []);

    const handleSignInForCommitChecks = useCallback((host: string) => {
        vscode.postMessage({ type: "signInForCommitChecks", host });
    }, []);

    // --- Commit-panel callbacks ---
    const handleMessageChange = useCallback((message: string) => {
        cpDispatch({ type: "SET_COMMIT_MESSAGE", message });
        vscode.postMessage({ type: "saveCommitDraft", message });
    }, []);

    const handleAmendChange = useCallback((isAmend: boolean) => {
        cpDispatch({ type: "SET_AMEND", isAmend });
        if (isAmend) {
            vscode.postMessage({ type: "getLastCommitMessage" });
        }
    }, []);

    const canCommit = canRunCommitAction(cpState.isAmend, checkedPaths.size, cpState.commitMessage);
    const shouldPublishBranch = !cpState.currentBranchHasUpstream;
    const canPush = shouldPublishBranch
        ? cpState.currentBranchName !== null
        : cpState.currentBranchAhead > 0;
    const pushLabel = shouldPublishBranch ? "commit.action.publishAndPush" : "common.push";

    const handleCommit = useCallback(() => {
        const msg = cpState.commitMessage.trim();
        vscode.postMessage({
            type: "commitSelected",
            message: msg,
            amend: cpState.isAmend,
            push: false,
            paths: Array.from(checkedPaths),
        });
    }, [cpState.commitMessage, cpState.isAmend, checkedPaths]);

    const handlePush = useCallback(() => {
        vscode.postMessage({ type: shouldPublishBranch ? "publishBranch" : "push" });
    }, [shouldPublishBranch]);

    const handleSync = useCallback(() => {
        vscode.postMessage({ type: "sync" });
    }, []);

    const handleFetch = useCallback(() => {
        vscode.postMessage({ type: "fetch" });
    }, []);

    const handlePull = useCallback(() => {
        vscode.postMessage({ type: "pull" });
    }, []);

    const handleDock = useCallback(() => {
        vscode.postMessage({ type: "dock" });
    }, []);

    // --- Render ---
    return (
        <ChakraProvider theme={theme}>
            <ThemeIconFontFaces fonts={iconFonts} />
            <Box display="flex" height="100vh" overflow="hidden" flexDirection="column">
                <UndockedHeader onDock={handleDock} />
                <Box ref={layoutRef} display="flex" flex={1} overflow="hidden" minHeight={0}>
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
                                onToggleGroupBy={() => setGroupByDir((g) => !g)}
                            />

                            <Box
                                data-testid="undocked-left-commit-divider"
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                onMouseDown={(e) => {
                                    markWidthsHydrated();
                                    onLeftCommitPanelDividerMouseDown(e);
                                }}
                                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                            />
                        </>
                    )}

                    {/* Graph panel */}
                    <Box display="flex" overflow="hidden" flexShrink={0}>
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

                        <div
                            data-testid="undocked-branch-divider"
                            style={{
                                width: 4,
                                flexShrink: 0,
                                cursor: "col-resize",
                                background: "var(--vscode-panel-border)",
                            }}
                            onMouseDown={(e) => {
                                markWidthsHydrated();
                                onBranchDividerMouseDown(e);
                            }}
                        />

                        <div style={{ display: "flex", overflow: "hidden", flexShrink: 0 }}>
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

                            <div
                                data-testid="undocked-graph-divider"
                                style={{
                                    width: 4,
                                    flexShrink: 0,
                                    cursor: "col-resize",
                                    background: "var(--vscode-panel-border)",
                                }}
                                onMouseDown={(e) => {
                                    markWidthsHydrated();
                                    onGraphDividerMouseDown(e);
                                }}
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
                                data-testid="undocked-right-commit-divider"
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                onMouseDown={(e) => {
                                    markWidthsHydrated();
                                    onRightCommitPanelDividerMouseDown(e);
                                }}
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
                                onToggleGroupBy={() => setGroupByDir((g) => !g)}
                            />
                        </>
                    )}
                </Box>
            </Box>
        </ChakraProvider>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
