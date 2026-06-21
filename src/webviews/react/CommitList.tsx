// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Commit, CommitChecksSnapshot } from "../../types";
import { computeGraph, LANE_WIDTH, ROW_HEIGHT } from "./graph";
import { ContextMenu } from "./shared/components/ContextMenu";
import { ClearIcon, SearchIcon } from "./shared/components/Icons";
import { getCommitMenuItems } from "./commit-list/commitMenu";
import { CommitRow } from "./commit-list/CommitRow";
import { useCommitGraphCanvas } from "./commit-list/useCommitGraphCanvas";
import { isCommitAction, type CommitAction } from "../protocol/commitGraphTypes";
import { JETBRAINS_UI } from "./shared/tokens";
import { t } from "./shared/i18n";
import {
    AUTHOR_COL_WIDTH,
    BRANCH_SCOPE_STYLE,
    CANVAS_STYLE,
    CHECKS_COL_WIDTH,
    contentContainerStyle,
    DATE_COL_WIDTH,
    FILTER_BAR_STYLE,
    FILTER_CLEAR_BUTTON_STYLE,
    FILTER_ICON_STYLE,
    FILTER_INPUT_STYLE,
    FILTER_INPUT_WRAP_STYLE,
    headerRowStyle,
    LOADING_MORE_STYLE,
    ROOT_STYLE,
    SCROLL_VIEWPORT_STYLE,
} from "./commit-list/styles";

const MIN_PREFIX_LENGTH = 7;
const MAX_GRAPH_WIDTH = JETBRAINS_UI.graph.maxWidth;

/**
 * Allows cherry-pick actions when the graph is scoped to a non-current branch,
 * or when the current branch is unavailable and the extension must decide.
 */
export function canCherryPickFromBranchScope(
    selectedBranch: string | null,
    currentBranchName?: string | null,
): boolean {
    return selectedBranch !== null && (!currentBranchName || selectedBranch !== currentBranchName);
}

interface Props {
    commits: Commit[];
    selectedHash: string | null;
    filterText: string;
    hasMore: boolean;
    unpushedHashes: Set<string>;
    selectedBranch: string | null;
    currentBranchName?: string | null;
    onSelectCommit: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void | Promise<void>;
    onCommitAction: (action: CommitAction, hash: string) => void;
    onCommitHover?: (commit: Commit, event: React.MouseEvent) => void;
    onCommitUnhover?: () => void;
    commitChecks?: ReadonlyMap<string, CommitChecksSnapshot | "loading">;
    onRequestCommitChecks?: (hash: string) => void;
    onOpenCommitCheckUrl?: (url: string) => void;
    showSearch?: boolean;
    showAuthorDate?: boolean;
    headerLabel?: string;
}

/**
 * Renders a virtualized commit list with an aligned canvas lane graph, optional
 * search chrome, branch-scope context actions, and incremental load-more support.
 */
export function CommitList({
    commits,
    selectedHash,
    filterText,
    hasMore,
    unpushedHashes,
    selectedBranch,
    currentBranchName,
    onSelectCommit,
    onFilterText,
    onLoadMore,
    onCommitAction,
    onCommitHover,
    onCommitUnhover,
    commitChecks,
    onRequestCommitChecks,
    onOpenCommitCheckUrl,
    showSearch = true,
    showAuthorDate = true,
    headerLabel,
}: Props): React.ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: Commit } | null>(
        null,
    );
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const isLoadingMoreRef = useRef(false);

    const graphRows = useMemo(() => computeGraph(commits), [commits]);
    const maxCols = useMemo(
        () => graphRows.reduce((max, row) => Math.max(max, row.numColumns), 1),
        [graphRows],
    );
    const graphWidth = Math.min(maxCols * LANE_WIDTH + 12, MAX_GRAPH_WIDTH);

    useCommitGraphCanvas({
        canvasRef,
        viewportRef,
        rows: graphRows,
        graphWidth,
    });

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;

        const updateHeight = () => setViewportHeight(viewport.clientHeight);
        updateHeight();

        const observer = new ResizeObserver(updateHeight);
        observer.observe(viewport);

        return () => {
            observer.disconnect();
        };
    }, []);

    const unpushedLookup = useMemo(() => {
        const exact = new Set(unpushedHashes);
        const prefixes = new Set<string>();
        // Build prefix lookup so truncated hashes match full hashes (and vice versa).
        for (const hash of unpushedHashes) {
            const start = Math.min(MIN_PREFIX_LENGTH, hash.length);
            for (let i = start; i <= hash.length; i++) {
                prefixes.add(hash.slice(0, i));
            }
        }
        return { exact, prefixes };
    }, [unpushedHashes]);

    const isUnpushedCommit = useCallback(
        (hash: string): boolean => {
            if (unpushedLookup.prefixes.has(hash)) return true;
            const start = Math.min(MIN_PREFIX_LENGTH, hash.length);
            for (let i = start; i <= hash.length; i++) {
                if (unpushedLookup.exact.has(hash.slice(0, i))) return true;
            }
            return false;
        },
        [unpushedLookup],
    );

    const handleRowContextMenu = useCallback((event: React.MouseEvent, commit: Commit) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, commit });
    }, []);

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            if (!isCommitAction(action)) return;
            onCommitAction(action, contextMenu.commit.hash);
        },
        [contextMenu, onCommitAction],
    );

    const handleScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const el = event.currentTarget;
            setScrollTop(el.scrollTop);
            if (
                hasMore &&
                !isLoadingMoreRef.current &&
                el.scrollTop + el.clientHeight >= el.scrollHeight - 100
            ) {
                isLoadingMoreRef.current = true;
                Promise.resolve(onLoadMore())
                    .catch(() => undefined)
                    .finally(() => {
                        isLoadingMoreRef.current = false;
                    });
            }
        },
        [hasMore, onLoadMore],
    );

    const visibleRange = useMemo(() => {
        if (commits.length === 0) {
            return { start: 0, end: 0 };
        }
        const overscan = 8;
        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
        const end = Math.min(
            commits.length,
            Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan,
        );
        return { start, end };
    }, [commits.length, scrollTop, viewportHeight]);

    const visibleCommits = useMemo(
        () => commits.slice(visibleRange.start, visibleRange.end),
        [commits, visibleRange.end, visibleRange.start],
    );
    useEffect(() => {
        if (!onRequestCommitChecks) return;
        for (const commit of visibleCommits) {
            if (!commitChecks?.has(commit.hash)) onRequestCommitChecks(commit.hash);
        }
    }, [commitChecks, onRequestCommitChecks, visibleCommits]);

    const branchScopeLabel = selectedBranch
        ? t("commit.scope.branch", { branch: selectedBranch })
        : t("commit.scope.allBranches");
    const canCherryPickFromSelectedScope = canCherryPickFromBranchScope(
        selectedBranch,
        currentBranchName,
    );

    return (
        <div style={ROOT_STYLE}>
            {showSearch ? (
                <div style={FILTER_BAR_STYLE}>
                    <SearchIcon size={16} style={FILTER_ICON_STYLE} />
                    <div style={FILTER_INPUT_WRAP_STYLE}>
                        <input
                            type="text"
                            placeholder={t("commit.search.placeholder")}
                            value={filterText}
                            onChange={(event) => onFilterText(event.target.value)}
                            style={FILTER_INPUT_STYLE}
                        />
                        {filterText.length > 0 && (
                            <button
                                type="button"
                                aria-label={t("commit.search.clear")}
                                title={t("commit.search.clear")}
                                onClick={() => onFilterText("")}
                                style={FILTER_CLEAR_BUTTON_STYLE}
                            >
                                <ClearIcon size={12} />
                            </button>
                        )}
                    </div>
                    <span style={BRANCH_SCOPE_STYLE} title={branchScopeLabel}>
                        {branchScopeLabel}
                    </span>
                </div>
            ) : null}

            {headerLabel ? null : (
                <div style={headerRowStyle(graphWidth)}>
                    <span style={{ flex: 1 }}>{t("commit.list.header.commit")}</span>
                    {showAuthorDate && (
                        <>
                            <span style={{ width: AUTHOR_COL_WIDTH, textAlign: "right" }}>
                                {t("commit.list.header.author")}
                            </span>
                            <span
                                style={{ width: DATE_COL_WIDTH, textAlign: "right", marginLeft: 4 }}
                            >
                                {t("commit.list.header.date")}
                            </span>
                            {onRequestCommitChecks && onOpenCommitCheckUrl ? (
                                <span style={{ width: CHECKS_COL_WIDTH, marginLeft: 4 }} />
                            ) : null}
                        </>
                    )}
                </div>
            )}

            <div
                ref={viewportRef}
                data-testid="commit-list-viewport"
                style={SCROLL_VIEWPORT_STYLE}
                onScroll={handleScroll}
            >
                <div style={contentContainerStyle(commits.length + (hasMore ? 1 : 0))}>
                    <canvas ref={canvasRef} style={CANVAS_STYLE} />

                    <div
                        style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: visibleRange.start * ROW_HEIGHT,
                            zIndex: 2,
                        }}
                    >
                        {visibleCommits.map((commit, offset) => {
                            const idx = visibleRange.start + offset;
                            return (
                                <CommitRow
                                    key={commit.hash}
                                    commit={commit}
                                    graphWidth={graphWidth}
                                    isSelected={selectedHash === commit.hash}
                                    isUnpushed={isUnpushedCommit(commit.hash)}
                                    laneColor={graphRows[idx]?.color}
                                    onSelect={onSelectCommit}
                                    onContextMenu={handleRowContextMenu}
                                    onHover={onCommitHover}
                                    onUnhover={onCommitUnhover}
                                    showAuthorDate={showAuthorDate}
                                    checks={commitChecks?.get(commit.hash)}
                                    onRequestChecks={onRequestCommitChecks}
                                    onOpenCheckUrl={onOpenCommitCheckUrl}
                                />
                            );
                        })}
                    </div>

                    {hasMore && (
                        <div
                            style={{
                                ...LOADING_MORE_STYLE,
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: commits.length * ROW_HEIGHT,
                            }}
                        >
                            {t("commit.loadingMore")}
                        </div>
                    )}
                </div>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getCommitMenuItems(
                        contextMenu.commit,
                        isUnpushedCommit(contextMenu.commit.hash),
                        canCherryPickFromSelectedScope,
                    )}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                    minWidth={320}
                />
            )}
        </div>
    );
}
