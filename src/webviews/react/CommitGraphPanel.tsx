import React, { useState, useEffect, useCallback, useMemo, useRef, useReducer } from "react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
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
import type {
    BranchAction,
    CommitAction,
    CommitGraphOutbound,
    WorktreeAction,
} from "../protocol/commitGraphTypes";
import type { OutboundMessage as CommitPanelOutbound } from "./commit-panel/types";
import type { VsCodeApi } from "./shared/vscodeApi";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { shouldRequestCommitChecks } from "./commit-list/checksRefresh";
import { ThemeIconFontFaces } from "./shared/components/ThemeIconFontFaces";
import { JETBRAINS_UI } from "./shared/tokens";
import { useCommitGraphMessages } from "./commit-graph/useCommitGraphMessages";
import type { CommitGraphPanelAction } from "./commit-graph/types";

export type { CommitGraphPanelAction } from "./commit-graph/types";

const MIN_BRANCH_WIDTH = 80;
const MAX_BRANCH_WIDTH = 500;
const DEFAULT_BRANCH_WIDTH = 260;
const MIN_INFO_WIDTH = 250;
const MAX_INFO_WIDTH = 760;
const DEFAULT_INFO_WIDTH = 330;

interface Props {
    vscode: VsCodeApi<CommitGraphOutbound | CommitPanelOutbound, Record<string, unknown>>;
    stateKeyPrefix?: string;
    sendReady?: boolean;
}

/** Builds persisted webview-state keys without adding a leading separator. */
function stateKey(prefix: string, key: string): string {
    return prefix ? `${prefix}.${key}` : key;
}

/**
 * Creates a column-resize mouse handler that clamps a single panel width and
 * cleans global drag listeners when the drag completes or the component unmounts.
 */
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

    const cleanupDrag = useCallback(() => {
        if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
        if (upRef.current) document.removeEventListener("mouseup", upRef.current);
        moveRef.current = null;
        upRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        draggingRef.current = false;
    }, []);

    useEffect(() => cleanupDrag, [cleanupDrag]);

    return useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            cleanupDrag();
            draggingRef.current = true;
            const startX = e.clientX;
            const startWidth = widthRef.current;

            const onMouseMove = (ev: MouseEvent) => {
                if (!draggingRef.current) return;
                const delta = invert ? startX - ev.clientX : ev.clientX - startX;
                setWidth(Math.max(min, Math.min(max, startWidth + delta)));
            };

            const onMouseUp = () => {
                cleanupDrag();
            };

            moveRef.current = onMouseMove;
            upRef.current = onMouseUp;
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [cleanupDrag, setWidth, min, max, invert],
    );
}

type CommitChecksValue = CommitChecksSnapshot | "loading";

interface CommitGraphPanelState {
    commits: Commit[];
    branches: Branch[];
    worktrees: GitWorktree[];
    selectedHash: string | null;
    selectedBranch: string | null;
    hasMore: boolean;
    filterText: string;
    selectedDetail: CommitDetail | null;
    commitChecks: Map<string, CommitChecksValue>;
    branchFolderIcon?: ThemeTreeIcon;
    branchFolderExpandedIcon?: ThemeTreeIcon;
    commitFolderIcon?: ThemeTreeIcon;
    commitFolderExpandedIcon?: ThemeTreeIcon;
    commitFolderIconsByName?: ThemeFolderIconMap;
    branchFolderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    unpushedHashes: Set<string>;
    commitChecksEnabled: boolean;
}

const initialCommitGraphPanelState: CommitGraphPanelState = {
    commits: [],
    branches: [],
    worktrees: [],
    selectedHash: null,
    selectedBranch: null,
    hasMore: false,
    filterText: "",
    selectedDetail: null,
    commitChecks: new Map(),
    iconFonts: [],
    unpushedHashes: new Set(),
    commitChecksEnabled: true,
};

function commitGraphPanelReducer(
    state: CommitGraphPanelState,
    action: CommitGraphPanelAction,
): CommitGraphPanelState {
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

/**
 * Coordinates the full commit graph webview: branch filtering, virtualized
 * commit history, detail pane updates, extension messages, and persisted column widths.
 */
export function CommitGraphPanel({
    vscode,
    stateKeyPrefix = "",
    sendReady = true,
}: Props): React.ReactElement {
    const [state, dispatch] = useReducer(commitGraphPanelReducer, initialCommitGraphPanelState);
    const {
        commits,
        branches,
        worktrees,
        selectedHash,
        selectedBranch,
        hasMore,
        filterText,
        selectedDetail,
        commitChecks,
        branchFolderIcon,
        branchFolderExpandedIcon,
        commitFolderIcon,
        commitFolderExpandedIcon,
        commitFolderIconsByName,
        branchFolderIconsByName,
        iconFonts,
        unpushedHashes,
        commitChecksEnabled,
    } = state;
    const [branchWidth, setBranchWidth] = useState(() => {
        try {
            const state = vscode.getState();
            const w = state?.[stateKey(stateKeyPrefix, "branchWidth")];
            return typeof w === "number" ? w : DEFAULT_BRANCH_WIDTH;
        } catch {
            return DEFAULT_BRANCH_WIDTH;
        }
    });
    const [infoWidth, setInfoWidth] = useState(() => {
        try {
            const state = vscode.getState();
            const w = state?.[stateKey(stateKeyPrefix, "infoWidth")];
            return typeof w === "number" ? w : DEFAULT_INFO_WIDTH;
        } catch {
            return DEFAULT_INFO_WIDTH;
        }
    });
    const loadingMore = useRef(false);
    const currentBranchName = useMemo(
        () => branches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null,
        [branches],
    );
    const onDividerMouseDown = useColumnDrag(
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

    useCommitGraphMessages({ vscode, dispatch, sendReady, loadingMore });

    useEffect(() => {
        try {
            const prev = vscode.getState() ?? {};
            // False positive: vscode.setState is the VS Code webview persistence API (acquireVsCodeApi().setState),
            // not a React parent callback. CommitGraphPanel is a webview root — no React parent exists.
            // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent
            vscode.setState({
                ...prev,
                [stateKey(stateKeyPrefix, "branchWidth")]: branchWidth,
                [stateKey(stateKeyPrefix, "infoWidth")]: infoWidth,
            });
        } catch {
            /* ignore persistence errors */
        }
    }, [branchWidth, infoWidth, stateKeyPrefix, vscode]);

    const handleSelectCommit = useCallback(
        (hash: string) => {
            dispatch({ type: "selectCommit", hash });
            vscode.postMessage({ type: "selectCommit", hash });
        },
        [vscode],
    );

    const handleFilterText = useCallback(
        (text: string) => {
            dispatch({ type: "setFilterText", text });
            if (text.length >= 3 || text.length === 0) {
                loadingMore.current = false;
                vscode.postMessage({ type: "filterText", text });
            }
        },
        [vscode],
    );

    const handleLoadMore = useCallback(() => {
        if (loadingMore.current) return;
        loadingMore.current = true;
        vscode.postMessage({ type: "loadMore" });
    }, [vscode]);

    const handleSelectBranch = useCallback(
        (name: string | null) => {
            dispatch({ type: "selectBranch", branch: name });
            loadingMore.current = false;
            vscode.postMessage({ type: "filterBranch", branch: name });
        },
        [vscode],
    );

    const handleBranchAction = useCallback(
        (action: BranchAction, branchName: string) => {
            vscode.postMessage({ type: "branchAction", action, branchName });
        },
        [vscode],
    );

    const handleDeleteBranches = useCallback(
        (branches: Branch[]) => {
            vscode.postMessage({ type: "deleteBranches", branches });
        },
        [vscode],
    );

    const handleWorktreeAction = useCallback(
        (action: WorktreeAction, path: string) => {
            vscode.postMessage({ type: "worktreeAction", action, path });
        },
        [vscode],
    );

    const handleCommitAction = useCallback(
        (action: CommitAction, hash: string) => {
            vscode.postMessage({ type: "commitAction", action, hash });
        },
        [vscode],
    );

    const handleOpenDiff = useCallback(
        (commitHash: string, filePath: string) => {
            vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
        },
        [vscode],
    );

    const handleRequestCommitChecks = useCallback(
        (hash: string) => {
            const current = commitChecks.get(hash);
            if (!shouldRequestCommitChecks(current)) return;
            // Only show the spinner on the first fetch. A background refresh of an
            // already-displayed snapshot keeps the current badge so it does not flicker.
            if (current === undefined) {
                dispatch({ type: "markCommitChecksLoading", hash });
            }
            vscode.postMessage({ type: "requestCommitChecks", hash });
        },
        [commitChecks, vscode],
    );

    const handleOpenCommitCheckUrl = useCallback(
        (url: string) => {
            vscode.postMessage({ type: "openCommitCheckUrl", url });
        },
        [vscode],
    );
    const handleSignInForCommitChecks = useCallback(
        (host: string) => {
            vscode.postMessage({ type: "signInForCommitChecks", host });
        },
        [vscode],
    );
    return (
        <>
            <ThemeIconFontFaces fonts={iconFonts} />
            <div
                style={{
                    display: "flex",
                    height: "100%",
                    overflow: "hidden",
                    background: JETBRAINS_UI.color.editor,
                    color: JETBRAINS_UI.color.foreground,
                }}
            >
                <div style={{ width: branchWidth, flexShrink: 0, overflow: "hidden" }}>
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
                    data-testid="commit-graph-divider"
                    onMouseDown={onDividerMouseDown}
                    style={{
                        width: 4,
                        flexShrink: 0,
                        cursor: "col-resize",
                        background: JETBRAINS_UI.color.divider,
                    }}
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
                                commitChecksEnabled ? handleSignInForCommitChecks : undefined
                            }
                        />
                    </div>
                    <div
                        data-testid="commit-info-divider"
                        onMouseDown={onInfoDividerMouseDown}
                        style={{
                            width: 4,
                            flexShrink: 0,
                            cursor: "col-resize",
                            background: JETBRAINS_UI.color.divider,
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
            </div>
        </>
    );
}
