// Unified React app for the undocked editor-tab webview.
// Layout: [BranchCol | CommitList | CommitInfoPane] | divider | [CommitPanel].
// Single message channel handles both graph and commit-panel message types.

import React, { useState, useEffect, useCallback, useMemo, useRef, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi } from "./shared/vscodeApi";
import { useCheckedFiles } from "./commit-panel/hooks/useCheckedFiles";
import { getSettings } from "./shared/settings";
import {
    commitPanelReducer,
    initialCommitPanelState,
    type CommitChecksValue,
    type GraphAction,
} from "./undocked/commitPanelState";
import { canRunCommitAction } from "./commit-panel/commitEligibility";
import {
    computeEqualSectionWidths,
    migrateSectionWidths,
    normalizeSectionWidths,
    sectionWidthsAreClose,
    type SectionWidthKey,
    type SectionWidths,
} from "./undocked/sectionWidths";
import { UndockedLayout } from "./undocked/UndockedLayout";
import { resizeSectionPair, useColumnPairDrag } from "./undocked/useColumnPairDrag";
import { useUnifiedMessages } from "./undocked/useUnifiedMessages";
import { useUndockedActions } from "./undocked/useUndockedActions";
import type {
    Branch,
    Commit,
    CommitDetail,
    GitWorktree,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";
import type { UnifiedOutbound } from "../protocol/undockedMessages";

// --- Helpers ----------------------------------------------------------------

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();
const KEYBOARD_RESIZE_STEP = 16;

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
                selectedHash: action.selectedHash,
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

function readInitialWidths(): SectionWidths {
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
}

// Webview entrypoint owns root orchestration and root render side effects; splitting further is not useful here.
// react-doctor-disable-next-line react-doctor/only-export-components, react-doctor/no-giant-component
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
    const handleSectionPairKeyDown = useCallback(
        (event: React.KeyboardEvent, firstKey: SectionWidthKey, secondKey: SectionWidthKey) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            markWidthsHydrated();
            const delta = event.key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
            setSectionWidths(resizeSectionPair(sectionWidths, firstKey, secondKey, delta));
        },
        [markWidthsHydrated, sectionWidths, setSectionWidths],
    );
    const onLeftCommitPanelDividerKeyDown = useCallback(
        (event: React.KeyboardEvent) =>
            handleSectionPairKeyDown(event, "commitPanelWidth", "branchWidth"),
        [handleSectionPairKeyDown],
    );
    const onBranchDividerKeyDown = useCallback(
        (event: React.KeyboardEvent) =>
            handleSectionPairKeyDown(event, "branchWidth", "graphWidth"),
        [handleSectionPairKeyDown],
    );
    const onGraphDividerKeyDown = useCallback(
        (event: React.KeyboardEvent) => handleSectionPairKeyDown(event, "graphWidth", "infoWidth"),
        [handleSectionPairKeyDown],
    );
    const onRightCommitPanelDividerKeyDown = useCallback(
        (event: React.KeyboardEvent) =>
            handleSectionPairKeyDown(event, "infoWidth", "commitPanelWidth"),
        [handleSectionPairKeyDown],
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
    useUnifiedMessages({
        graphDispatch,
        cpDispatch,
        loadingMore,
        selectedHash,
        markWidthsHydrated,
        setSectionWidths,
        layoutRef,
        setCommitPanelPosition,
    });

    const canCommit = canRunCommitAction(cpState.isAmend, checkedPaths.size, cpState.commitMessage);
    const shouldPublishBranch = !cpState.currentBranchHasUpstream;
    const canPush = shouldPublishBranch
        ? cpState.currentBranchName !== null
        : cpState.currentBranchAhead > 0;
    const pushLabel = shouldPublishBranch ? "commit.action.publishAndPush" : "common.push";

    // --- Graph and commit-panel callbacks ---
    const actions = useUndockedActions({
        graphDispatch,
        cpDispatch,
        loadingMore,
        commitChecks,
        commitMessage: cpState.commitMessage,
        isAmend: cpState.isAmend,
        checkedPaths,
        shouldPublishBranch,
    });

    const onToggleGroupBy = useCallback(() => {
        setGroupByDir((g) => !g);
    }, []);

    // --- Render ---
    return (
        <UndockedLayout
            iconFonts={iconFonts}
            cpState={cpState}
            checkedPaths={checkedPaths}
            commitPanelPosition={commitPanelPosition}
            commitPanelWidth={commitPanelWidth}
            branchWidth={branchWidth}
            graphWidth={graphWidth}
            infoWidth={infoWidth}
            branches={branches}
            worktrees={worktrees}
            selectedBranch={selectedBranch}
            commits={commits}
            selectedHash={selectedHash}
            filterText={filterText}
            hasMore={hasMore}
            unpushedHashes={unpushedHashes}
            currentBranchName={currentBranchName}
            commitChecks={commitChecks}
            commitChecksEnabled={commitChecksEnabled}
            selectedDetail={selectedDetail}
            branchFolderIcon={branchFolderIcon}
            branchFolderExpandedIcon={branchFolderExpandedIcon}
            branchFolderIconsByName={branchFolderIconsByName}
            commitFolderIcon={commitFolderIcon}
            commitFolderExpandedIcon={commitFolderExpandedIcon}
            commitFolderIconsByName={commitFolderIconsByName}
            groupByDir={groupByDir}
            canCommit={canCommit}
            canPush={canPush}
            pushLabel={pushLabel}
            isAllChecked={isAllChecked}
            isSomeChecked={isSomeChecked}
            layoutRef={layoutRef}
            markWidthsHydrated={markWidthsHydrated}
            onLeftCommitPanelDividerMouseDown={onLeftCommitPanelDividerMouseDown}
            onLeftCommitPanelDividerKeyDown={onLeftCommitPanelDividerKeyDown}
            onBranchDividerMouseDown={onBranchDividerMouseDown}
            onBranchDividerKeyDown={onBranchDividerKeyDown}
            onGraphDividerMouseDown={onGraphDividerMouseDown}
            onGraphDividerKeyDown={onGraphDividerKeyDown}
            onRightCommitPanelDividerMouseDown={onRightCommitPanelDividerMouseDown}
            onRightCommitPanelDividerKeyDown={onRightCommitPanelDividerKeyDown}
            handleSelectCommit={actions.handleSelectCommit}
            handleFilterText={actions.handleFilterText}
            handleLoadMore={actions.handleLoadMore}
            handleSelectBranch={actions.handleSelectBranch}
            handleBranchAction={actions.handleBranchAction}
            handleDeleteBranches={actions.handleDeleteBranches}
            handleWorktreeAction={actions.handleWorktreeAction}
            handleCommitAction={actions.handleCommitAction}
            handleOpenDiff={actions.handleOpenDiff}
            handleRequestCommitChecks={actions.handleRequestCommitChecks}
            handleOpenCommitCheckUrl={actions.handleOpenCommitCheckUrl}
            handleSignInForCommitChecks={actions.handleSignInForCommitChecks}
            handleMessageChange={actions.handleMessageChange}
            handleAmendChange={actions.handleAmendChange}
            handleCommit={actions.handleCommit}
            handlePush={actions.handlePush}
            handleSync={actions.handleSync}
            handleFetch={actions.handleFetch}
            handlePull={actions.handlePull}
            toggleFile={toggleFile}
            toggleFolder={toggleFolder}
            toggleSection={toggleSection}
            onToggleGroupBy={onToggleGroupBy}
            onDock={actions.handleDock}
        />
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
