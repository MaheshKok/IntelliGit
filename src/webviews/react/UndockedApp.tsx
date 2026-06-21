// Unified React app for the undocked editor-tab webview.
// Layout: [BranchCol | CommitList | CommitInfoPane] | divider | [CommitPanel].
// Single message channel handles both graph and commit-panel message types.

import React, { useState, useEffect, useCallback, useMemo, useRef, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components";
import { getVsCodeApi } from "./shared/vscodeApi";
import { useCheckedFiles } from "./commit-panel/hooks/useCheckedFiles";
import theme from "./commit-panel/theme";
import { getSettings } from "./shared/settings";
import { CommitPanelPane } from "./undocked/CommitPanelPane";
import { commitPanelReducer, initialCommitPanelState } from "./undocked/commitPanelState";
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
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";
import type { BranchAction, CommitAction } from "../protocol/commitGraphTypes";
import type { UnifiedInbound, UnifiedOutbound } from "../protocol/undockedMessages";

// --- Helpers ----------------------------------------------------------------

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();

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
    const [commitChecks, setCommitChecks] = useState<Map<string, CommitChecksSnapshot | "loading">>(
        new Map(),
    );
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

    const [branchWidth, setBranchWidth] = useState(() => initialWidths.current!.branchWidth);
    const [graphWidth, setGraphWidth] = useState(() => initialWidths.current!.graphWidth);
    const [infoWidth, setInfoWidth] = useState(() => initialWidths.current!.infoWidth);
    const [commitPanelWidth, setCommitPanelWidth] = useState(
        () => initialWidths.current!.commitPanelWidth,
    );
    const sectionWidths: SectionWidths = {
        branchWidth,
        graphWidth,
        infoWidth,
        commitPanelWidth,
    };
    const layoutRef = useRef<HTMLDivElement | null>(null);
    const sectionWidthsRef = useRef(sectionWidths);
    sectionWidthsRef.current = sectionWidths;
    const setSectionWidths = useCallback((next: SectionWidths) => {
        setBranchWidth(next.branchWidth);
        setGraphWidth(next.graphWidth);
        setInfoWidth(next.infoWidth);
        setCommitPanelWidth(next.commitPanelWidth);
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

                case "setCommitChecks":
                    setCommitChecks((prev) => {
                        const next = new Map(prev);
                        next.set(data.snapshot.hash, data.snapshot);
                        return next;
                    });
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

    const handleDeleteBranches = useCallback((branchNames: string[]) => {
        vscode.postMessage({ type: "deleteBranches", branchNames });
    }, []);

    const handleCommitAction = useCallback((action: CommitAction, hash: string) => {
        vscode.postMessage({ type: "commitAction", action, hash });
    }, []);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string) => {
        vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
    }, []);

    const handleRequestCommitChecks = useCallback(
        (hash: string) => {
            const cached = commitChecks.get(hash);
            if (cached && (cached === "loading" || cached.state !== "pending")) return;
            setCommitChecks((prev) => {
                const latest = prev.get(hash);
                if (latest && (latest === "loading" || latest.state !== "pending")) return prev;
                const next = new Map(prev);
                next.set(hash, "loading");
                return next;
            });
            vscode.postMessage({ type: "requestCommitChecks", hash });
        },
        [commitChecks],
    );

    const handleOpenCommitCheckUrl = useCallback((url: string) => {
        vscode.postMessage({ type: "openCommitCheckUrl", url });
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
                                onCommitAndPush={handleCommitAndPush}
                                currentBranchHasUpstream={cpState.currentBranchHasUpstream}
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
                                selectedBranch={selectedBranch}
                                onSelectBranch={handleSelectBranch}
                                onBranchAction={handleBranchAction}
                                onDeleteBranches={handleDeleteBranches}
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
                                    onRequestCommitChecks={handleRequestCommitChecks}
                                    onOpenCommitCheckUrl={handleOpenCommitCheckUrl}
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
