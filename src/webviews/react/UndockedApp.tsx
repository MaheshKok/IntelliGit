// Unified React app for the undocked editor-tab webview.
// Layout: [BranchCol | CommitList | CommitInfoPane] | divider | [CommitPanel].
// Single message channel handles both graph and commit-panel message types.

import React, { useState, useEffect, useCallback, useRef, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { TabBar } from "./commit-panel/components/TabBar";
import { CommitTab } from "./commit-panel/components/CommitTab";
import { ShelfTab } from "./commit-panel/components/ShelfTab";
import { ThemeIconFontFaces } from "./shared/components";
import { getVsCodeApi } from "./shared/vscodeApi";
import { useCheckedFiles } from "./commit-panel/hooks/useCheckedFiles";
import theme from "./commit-panel/theme";
import { getSettings } from "./shared/settings";
import type {
    Branch,
    Commit,
    CommitDetail,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
    StashEntry,
    AmendBranchCommitSummary,
} from "../../types";
import type { BranchAction, CommitAction } from "./commitGraphTypes";
import type { UnifiedInbound, UnifiedOutbound } from "./undocked/types";

// --- Helpers ----------------------------------------------------------------

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();

const MIN_SECTION_WIDTH = 220;
const DIVIDER_WIDTH = 4;

// Compute equal initial width for all four sections from the viewport.
// Sections: Commit | Branches | Graph | Changes (Info)
// Three dividers (4px each) sit between the four sections.
function computeEqualSectionWidth(): number {
    if (typeof window === "undefined") return 300;
    const available = window.innerWidth - 3 * DIVIDER_WIDTH;
    return Math.max(MIN_SECTION_WIDTH, Math.floor(available / 4));
}

function clampWidth(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function useColumnDrag(
    width: number,
    setWidth: React.Dispatch<React.SetStateAction<number>>,
    min: number,
    max: number,
    invert: boolean,
): (e: React.MouseEvent) => void {
    const draggingRef = useRef(false);
    const moveRef = useRef<((ev: MouseEvent) => void) | null>(null);
    const upRef = useRef<(() => void) | null>(null);
    const widthRef = useRef(width);
    widthRef.current = width;

    useEffect(() => {
        return () => {
            if (draggingRef.current) {
                if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
                if (upRef.current) document.removeEventListener("mouseup", upRef.current);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                draggingRef.current = false;
            }
        };
    }, []);

    return useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            draggingRef.current = true;
            const startX = e.clientX;
            const startWidth = widthRef.current;

            const onMouseMove = (ev: MouseEvent) => {
                if (!draggingRef.current) return;
                const delta = invert ? startX - ev.clientX : ev.clientX - startX;
                setWidth(Math.max(min, Math.min(max, startWidth + delta)));
            };

            const onMouseUp = () => {
                draggingRef.current = false;
                moveRef.current = null;
                upRef.current = null;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            moveRef.current = onMouseMove;
            upRef.current = onMouseUp;
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [setWidth, min, max, invert],
    );
}

// --- Commit-panel state reducer (inlined from useExtensionMessages) ----------

interface CommitPanelState {
    files: WorkingFile[];
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedShelfIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    commitMessage: string;
    isAmend: boolean;
    amendBranchCommits: AmendBranchCommitSummary[];
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
    error: string | null;
    currentBranchHasUpstream: boolean;
}

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
    onCommitAndPush: () => void;
    currentBranchHasUpstream: boolean;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

type CommitPanelAction =
    | {
          type: "SET_FILES_AND_STASHES";
          files: WorkingFile[];
          stashes: StashEntry[];
          shelfFiles: WorkingFile[];
          selectedShelfIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          currentBranchHasUpstream: boolean;
      }
    | { type: "RESTORE_COMMIT_DRAFT"; message: string }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED" }
    | { type: "SET_REFRESHING"; active: boolean }
    | { type: "SET_ERROR"; message: string }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean }
    | { type: "SET_AMEND_BRANCH_COMMITS"; commits: AmendBranchCommitSummary[] };

const initialCommitPanelState: CommitPanelState = {
    files: [],
    stashes: [],
    shelfFiles: [],
    selectedShelfIndex: null,
    folderIcon: undefined,
    folderExpandedIcon: undefined,
    folderIconsByName: undefined,
    iconFonts: [],
    commitMessage: "",
    isAmend: false,
    amendBranchCommits: [],
    amendBranchHistoryLoaded: false,
    isRefreshing: false,
    error: null,
    currentBranchHasUpstream: true,
};

function CommitPanelPane({
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
    onCommitAndPush,
    currentBranchHasUpstream,
    groupByDir,
    onToggleGroupBy,
}: CommitPanelPaneProps): React.ReactElement {
    return (
        <Box
            width={`${width}px`}
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
                            onCommitAndPush={onCommitAndPush}
                            currentBranchHasUpstream={currentBranchHasUpstream}
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

function commitPanelReducer(state: CommitPanelState, action: CommitPanelAction): CommitPanelState {
    switch (action.type) {
        case "SET_FILES_AND_STASHES":
            return {
                ...state,
                files: action.files,
                stashes: action.stashes,
                shelfFiles: action.shelfFiles,
                selectedShelfIndex: action.selectedShelfIndex,
                folderIcon: action.folderIcon ?? state.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? state.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? state.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
                error: null,
            };
        case "SET_REFRESHING":
            if (action.active && state.isAmend) {
                return {
                    ...state,
                    isRefreshing: true,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                };
            }
            return { ...state, isRefreshing: action.active };
        case "RESTORE_COMMIT_DRAFT":
            return { ...state, commitMessage: action.message };
        case "SET_LAST_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "COMMITTED":
            return {
                ...state,
                commitMessage: "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "SET_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "SET_AMEND":
            return {
                ...state,
                isAmend: action.isAmend,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_AMEND_BRANCH_COMMITS":
            if (!state.isAmend) return state;
            return {
                ...state,
                amendBranchCommits: action.commits,
                amendBranchHistoryLoaded: true,
            };
    }
}

// --- Main App ---------------------------------------------------------------

function App(): React.ReactElement {
    // --- Graph-side state ---
    const [commits, setCommits] = useState<Commit[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [selectedDetail, setSelectedDetail] = useState<CommitDetail | null>(null);
    const [branchFolderIcon, setBranchFolderIcon] = useState<ThemeTreeIcon | undefined>(undefined);
    const [branchFolderExpandedIcon, setBranchFolderExpandedIcon] = useState<
        ThemeTreeIcon | undefined
    >(undefined);
    const [commitFolderIcon, setCommitFolderIcon] = useState<ThemeTreeIcon | undefined>(undefined);
    const [commitFolderExpandedIcon, setCommitFolderExpandedIcon] = useState<
        ThemeTreeIcon | undefined
    >(undefined);
    const [commitFolderIconsByName, setCommitFolderIconsByName] = useState<
        ThemeFolderIconMap | undefined
    >(undefined);
    const [branchFolderIconsByName, setBranchFolderIconsByName] = useState<
        ThemeFolderIconMap | undefined
    >(undefined);
    const [iconFonts, setIconFonts] = useState<ThemeIconFont[]>([]);
    const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
    const loadingMore = useRef(false);

    // Guards the cross-session width persistence: stays false until either the
    // extension restores saved widths or the user actually drags a divider.
    // This prevents the initial equal widths (computed before restore) from
    // being sent back to the extension and clobbering the persisted values.
    const widthsHydratedRef = useRef(false);
    const markWidthsHydrated = useCallback(() => {
        widthsHydratedRef.current = true;
    }, []);

    const readInitialWidth = (key: string): number => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.[key];
            const raw = typeof w === "number" ? w : computeEqualSectionWidth();
            return Math.max(MIN_SECTION_WIDTH, raw);
        } catch {
            return Math.max(MIN_SECTION_WIDTH, computeEqualSectionWidth());
        }
    };

    const [branchWidth, setBranchWidth] = useState(() => readInitialWidth("branchWidth"));
    const [graphWidth, setGraphWidth] = useState(() => readInitialWidth("graphWidth"));
    const [infoWidth, setInfoWidth] = useState(() => readInitialWidth("infoWidth"));
    const [commitPanelWidth, setCommitPanelWidth] = useState(() =>
        readInitialWidth("commitPanelWidth"),
    );

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

    const commitPanelPosition = getSettings().commitWindowPosition;

    // --- Drag handlers ---
    const onBranchDividerMouseDown = useColumnDrag(
        branchWidth,
        setBranchWidth,
        MIN_SECTION_WIDTH,
        Number.MAX_SAFE_INTEGER,
        false,
    );
    const onGraphDividerMouseDown = useColumnDrag(
        graphWidth,
        setGraphWidth,
        MIN_SECTION_WIDTH,
        Number.MAX_SAFE_INTEGER,
        false,
    );
    const onCommitPanelDividerMouseDown = useColumnDrag(
        commitPanelWidth,
        setCommitPanelWidth,
        MIN_SECTION_WIDTH,
        Number.MAX_SAFE_INTEGER,
        commitPanelPosition === "right",
    );

    // --- Persist column widths ---
    useEffect(() => {
        try {
            const prev = (vscode.getState() ?? {}) as Record<string, unknown>;
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
                    if (data.append) {
                        setCommits((prev) => [...prev, ...data.commits]);
                    } else {
                        setCommits(data.commits);
                        if (data.commits.length > 0) {
                            setSelectedHash(data.commits[0].hash);
                            vscode.postMessage({
                                type: "selectCommit",
                                hash: data.commits[0].hash,
                            });
                        }
                    }
                    setHasMore(data.hasMore);
                    setUnpushedHashes(new Set(data.unpushedHashes ?? []));
                    return;

                case "setBranches":
                    setBranches(data.branches);
                    setBranchFolderIcon(data.folderIcon);
                    setBranchFolderExpandedIcon(data.folderExpandedIcon);
                    setBranchFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    return;

                case "setSelectedBranch":
                    setSelectedBranch(data.branch ?? null);
                    return;

                case "setCommitDetail":
                    setSelectedDetail(data.detail);
                    setCommitFolderIcon(data.folderIcon);
                    setCommitFolderExpandedIcon(data.folderExpandedIcon);
                    setCommitFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    return;

                case "clearCommitDetail":
                    setSelectedDetail(null);
                    setCommitFolderIcon(undefined);
                    setCommitFolderExpandedIcon(undefined);
                    setCommitFolderIconsByName(undefined);
                    return;

                case "loadError":
                    if (!loadingMore.current) setCommits([]);
                    loadingMore.current = false;
                    setHasMore(false);
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

                // Restore persisted column widths from extension
                case "columnWidths":
                    // Mark hydrated first so the subsequent state updates are
                    // allowed to persist (and future user drags too).
                    markWidthsHydrated();
                    if (typeof data.branchWidth === "number")
                        setBranchWidth(
                            clampWidth(
                                data.branchWidth,
                                MIN_SECTION_WIDTH,
                                Number.MAX_SAFE_INTEGER,
                            ),
                        );
                    if (typeof data.graphWidth === "number")
                        setGraphWidth(
                            clampWidth(data.graphWidth, MIN_SECTION_WIDTH, Number.MAX_SAFE_INTEGER),
                        );
                    if (typeof data.infoWidth === "number")
                        setInfoWidth(
                            clampWidth(data.infoWidth, MIN_SECTION_WIDTH, Number.MAX_SAFE_INTEGER),
                        );
                    if (typeof data.commitPanelWidth === "number")
                        setCommitPanelWidth(
                            clampWidth(
                                data.commitPanelWidth,
                                MIN_SECTION_WIDTH,
                                Number.MAX_SAFE_INTEGER,
                            ),
                        );
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
    }, []);

    // --- Graph-side callbacks ---
    const handleSelectCommit = useCallback((hash: string) => {
        setSelectedHash(hash);
        vscode.postMessage({ type: "selectCommit", hash });
    }, []);

    const handleFilterText = useCallback((text: string) => {
        setFilterText(text);
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
        setSelectedBranch(name);
        loadingMore.current = false;
        vscode.postMessage({ type: "filterBranch", branch: name });
    }, []);

    const handleBranchAction = useCallback((action: BranchAction, branchName: string) => {
        vscode.postMessage({ type: "branchAction", action, branchName });
    }, []);

    const handleCommitAction = useCallback((action: CommitAction, hash: string) => {
        vscode.postMessage({ type: "commitAction", action, hash });
    }, []);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string) => {
        vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
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

    const stageCheckedAndCommit = useCallback(
        (push: boolean) => {
            const msg = cpState.commitMessage.trim();
            vscode.postMessage({
                type: "commitSelected",
                paths: Array.from(checkedPaths),
                message: msg,
                amend: cpState.isAmend,
                push,
            });
        },
        [cpState.commitMessage, cpState.isAmend, checkedPaths],
    );

    const handleCommit = useCallback(() => stageCheckedAndCommit(false), [stageCheckedAndCommit]);
    const handleCommitAndPush = useCallback(() => {
        if (!cpState.currentBranchHasUpstream) {
            vscode.postMessage({ type: "publishBranch" });
            return;
        }
        stageCheckedAndCommit(true);
    }, [cpState.currentBranchHasUpstream, stageCheckedAndCommit]);

    const handleDock = useCallback(() => {
        vscode.postMessage({ type: "dock" });
    }, []);

    // --- Render ---
    return (
        <ChakraProvider theme={theme}>
            <ThemeIconFontFaces fonts={iconFonts} />
            <Box display="flex" height="100vh" overflow="hidden" flexDirection="column">
                <Box
                    as="header"
                    height="32px"
                    flexShrink={0}
                    display="flex"
                    alignItems="center"
                    justifyContent="space-between"
                    px="10px"
                    bg="var(--vscode-sideBar-background)"
                    borderBottom="1px solid var(--vscode-panel-border)"
                    color="var(--vscode-foreground)"
                    fontSize="12px"
                    fontFamily="var(--vscode-font-family)"
                >
                    <Box fontWeight={600}>IntelliGit</Box>
                    <button
                        type="button"
                        onClick={handleDock}
                        title="Dock IntelliGit"
                        aria-label="Dock IntelliGit"
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            height: 24,
                            border: "1px solid var(--vscode-button-border, transparent)",
                            borderRadius: 3,
                            padding: "0 8px",
                            color: "var(--vscode-button-foreground)",
                            background: "var(--vscode-button-secondaryBackground)",
                            font: "inherit",
                            cursor: "pointer",
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                            <path
                                fill="currentColor"
                                d="M2 3h12v10H2V3zm1 1v8h10V4H3zm1 1h3v6H4V5zm4 0h4v2H8V5z"
                            />
                        </svg>
                        Dock
                    </button>
                </Box>
                <Box display="flex" flex={1} overflow="hidden" minHeight={0}>
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
                                onCommitAndPush={handleCommitAndPush}
                                currentBranchHasUpstream={cpState.currentBranchHasUpstream}
                                groupByDir={groupByDir}
                                onToggleGroupBy={() => setGroupByDir((g) => !g)}
                            />

                            <Box
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                onMouseDown={(e) => {
                                    markWidthsHydrated();
                                    onCommitPanelDividerMouseDown(e);
                                }}
                                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                            />
                        </>
                    )}

                    {/* Graph panel */}
                    <Box display="flex" overflow="hidden" flexShrink={0}>
                        <div style={{ width: branchWidth, flexShrink: 0, overflow: "hidden" }}>
                            <BranchColumn
                                branches={branches}
                                selectedBranch={selectedBranch}
                                onSelectBranch={handleSelectBranch}
                                onBranchAction={handleBranchAction}
                                folderIcon={branchFolderIcon}
                                folderExpandedIcon={branchFolderExpandedIcon}
                                folderIconsByName={branchFolderIconsByName}
                            />
                        </div>

                        <div
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
                                    onSelectCommit={handleSelectCommit}
                                    onFilterText={handleFilterText}
                                    onLoadMore={handleLoadMore}
                                    onCommitAction={handleCommitAction}
                                />
                            </div>

                            <div
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
                                width="4px"
                                flexShrink={0}
                                cursor="col-resize"
                                bg="var(--vscode-panel-border)"
                                onMouseDown={(e) => {
                                    markWidthsHydrated();
                                    onCommitPanelDividerMouseDown(e);
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
                                onCommitAndPush={handleCommitAndPush}
                                currentBranchHasUpstream={cpState.currentBranchHasUpstream}
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
