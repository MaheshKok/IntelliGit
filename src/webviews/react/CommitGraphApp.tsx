// React app for the bottom-panel commit graph webview.
// Layout: [BranchColumn (resizable)] | [drag-handle] | [CommitList + search bar] | [drag-handle] | [CommitInfoPane].
// Branch filtering from the inline branch tree posts back to the extension host.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
import type {
    Branch,
    Commit,
    CommitDetail,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
} from "./commitGraphTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components";

const vscode = getVsCodeApi<CommitGraphOutbound, unknown>();
const MIN_BRANCH_WIDTH = 80;
const MAX_BRANCH_WIDTH = 500;
const DEFAULT_BRANCH_WIDTH = 260;
const MIN_INFO_WIDTH = 250;
const MAX_INFO_WIDTH = 760;
const DEFAULT_INFO_WIDTH = 330;

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

function App(): React.ReactElement {
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
    const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
    const loadingMore = useRef(false);
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

    useEffect(() => {
        vscode.postMessage({ type: "ready" });

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            switch (data.type) {
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
                    break;
                case "setBranches":
                    setBranches(data.branches);
                    setBranchFolderIcon(data.folderIcon);
                    setBranchFolderExpandedIcon(data.folderExpandedIcon);
                    setBranchFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    break;
                case "setSelectedBranch":
                    setSelectedBranch(data.branch ?? null);
                    break;
                case "setCommitDetail":
                    setSelectedDetail(data.detail);
                    setCommitFolderIcon(data.folderIcon);
                    setCommitFolderExpandedIcon(data.folderExpandedIcon);
                    setCommitFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    break;
                case "clearCommitDetail":
                    setSelectedDetail(null);
                    setCommitFolderIcon(undefined);
                    setCommitFolderExpandedIcon(undefined);
                    setCommitFolderIconsByName(undefined);
                    break;
                case "error":
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, []);

    useEffect(() => {
        try {
            const prev = (vscode.getState() ?? {}) as Record<string, unknown>;
            vscode.setState({ ...prev, branchWidth, infoWidth });
        } catch {
            /* ignore persistence errors */
        }
    }, [branchWidth, infoWidth]);

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

    return (
        <>
            <ThemeIconFontFaces fonts={iconFonts} />
            <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
                {/* Branch column */}
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

                {/* Resizable divider */}
                <div
                    data-testid="commit-graph-divider"
                    onMouseDown={onDividerMouseDown}
                    style={{
                        width: 4,
                        flexShrink: 0,
                        cursor: "col-resize",
                        background: "var(--vscode-panel-border)",
                    }}
                />

                {/* Commit graph + files/details in one unified panel */}
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
                        data-testid="commit-info-divider"
                        onMouseDown={onInfoDividerMouseDown}
                        style={{
                            width: 4,
                            flexShrink: 0,
                            cursor: "col-resize",
                            background: "var(--vscode-panel-border)",
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
                        />
                    </div>
                </div>
            </div>
        </>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
