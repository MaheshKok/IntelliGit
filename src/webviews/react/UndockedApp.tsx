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

const MIN_BRANCH_WIDTH = 80;
const MAX_BRANCH_WIDTH = 500;
const DEFAULT_BRANCH_WIDTH = 260;
const MIN_INFO_WIDTH = 250;
const MAX_INFO_WIDTH = 760;
const DEFAULT_INFO_WIDTH = 330;
const DEFAULT_COMMIT_PANEL_WIDTH = 360;
const MIN_COMMIT_PANEL_WIDTH = 260;
const MAX_COMMIT_PANEL_WIDTH = 600;

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
};

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

    const [branchWidth, setBranchWidth] = useState(() => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.branchWidth;
            return typeof w === "number" ? w : DEFAULT_BRANCH_WIDTH;
        } catch {
            return DEFAULT_BRANCH_WIDTH;
        }
    });
    const [infoWidth, setInfoWidth] = useState(() => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.infoWidth;
            return typeof w === "number" ? w : DEFAULT_INFO_WIDTH;
        } catch {
            return DEFAULT_INFO_WIDTH;
        }
    });
    const [commitPanelWidth, setCommitPanelWidth] = useState(() => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.commitPanelWidth;
            return typeof w === "number" ? w : DEFAULT_COMMIT_PANEL_WIDTH;
        } catch {
            return DEFAULT_COMMIT_PANEL_WIDTH;
        }
    });

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

    // --- Drag handlers ---
    const onBranchDividerMouseDown = useColumnDrag(
        branchWidth,
        setBranchWidth,
        MIN_BRANCH_WIDTH,
        MAX_BRANCH_WIDTH,
        false,
    );
    const onInfoDividerMouseDown = useColumnDrag(
        infoWidth,
        setInfoWidth,
        MIN_INFO_WIDTH,
        MAX_INFO_WIDTH,
        true,
    );
    const onCommitPanelDividerMouseDown = useColumnDrag(
        commitPanelWidth,
        setCommitPanelWidth,
        MIN_COMMIT_PANEL_WIDTH,
        MAX_COMMIT_PANEL_WIDTH,
        true,
    );

    // --- Persist column widths ---
    useEffect(() => {
        try {
            const prev = (vscode.getState() ?? {}) as Record<string, unknown>;
            vscode.setState({ ...prev, branchWidth, infoWidth, commitPanelWidth });
        } catch {
            /* ignore */
        }
    }, [branchWidth, infoWidth, commitPanelWidth]);

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
    const handleCommitAndPush = useCallback(
        () => stageCheckedAndCommit(true),
        [stageCheckedAndCommit],
    );

    // --- Render ---
    return (
        <ChakraProvider theme={theme}>
            <ThemeIconFontFaces fonts={iconFonts} />
            <Box display="flex" height="100vh" overflow="hidden">
                {/* ======== LEFT: Graph panel ======== */}
                <Box flex={1} display="flex" overflow="hidden" minWidth={0}>
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
                        onMouseDown={onBranchDividerMouseDown}
                    />

                    <div style={{ flex: 1, overflow: "hidden", display: "flex", minWidth: 0 }}>
                        <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
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
                            onMouseDown={onInfoDividerMouseDown}
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

                {/* ======== Divider between graph and commit panel ======== */}
                <Box
                    width="4px"
                    flexShrink={0}
                    cursor="col-resize"
                    bg="var(--vscode-panel-border)"
                    onMouseDown={onCommitPanelDividerMouseDown}
                    _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                />

                {/* ======== RIGHT: Commit panel ======== */}
                <Box
                    width={`${commitPanelWidth}px`}
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
                                    onToggleFile={toggleFile}
                                    onToggleFolder={toggleFolder}
                                    onToggleSection={toggleSection}
                                    isAllChecked={isAllChecked}
                                    isSomeChecked={isSomeChecked}
                                    onMessageChange={handleMessageChange}
                                    onAmendChange={handleAmendChange}
                                    onCommit={handleCommit}
                                    onCommitAndPush={handleCommitAndPush}
                                    folderIcon={cpState.folderIcon}
                                    folderExpandedIcon={cpState.folderExpandedIcon}
                                    folderIconsByName={cpState.folderIconsByName}
                                    groupByDir={groupByDir}
                                    onToggleGroupBy={() => setGroupByDir((g) => !g)}
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
                                />
                            }
                        />
                    </Box>
                </Box>
            </Box>
        </ChakraProvider>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
