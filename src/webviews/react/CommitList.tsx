// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { Commit } from "../../types";
import { computeGraph, LANE_WIDTH } from "./graph";
import { ContextMenu } from "./shared/components/ContextMenu";
import { getCommitMenuItems } from "./commit-list/commitMenu";
import { CommitRow } from "./commit-list/CommitRow";
import { useCommitGraphCanvas } from "./commit-list/useCommitGraphCanvas";
import {
    AUTHOR_COL_WIDTH,
    CANVAS_STYLE,
    contentContainerStyle,
    DATE_COL_WIDTH,
    FILTER_BAR_STYLE,
    FILTER_ICON_STYLE,
    FILTER_INPUT_STYLE,
    headerRowStyle,
    LOADING_MORE_STYLE,
    ROOT_STYLE,
    SCROLL_VIEWPORT_STYLE,
} from "./commit-list/styles";

interface Props {
    commits: Commit[];
    selectedHash: string | null;
    filterText: string;
    hasMore: boolean;
    unpushedHashes: Set<string>;
    defaultCheckoutBranch: string | null;
    onSelectCommit: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void;
    onCommitAction: (action: string, hash: string, targetBranch?: string) => void;
}

export function CommitList({
    commits,
    selectedHash,
    filterText,
    hasMore,
    unpushedHashes,
    defaultCheckoutBranch,
    onSelectCommit,
    onFilterText,
    onLoadMore,
    onCommitAction,
}: Props): React.ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: Commit } | null>(
        null,
    );

    const graphRows = useMemo(() => computeGraph(commits), [commits]);
    const maxCols = useMemo(
        () => graphRows.reduce((max, row) => Math.max(max, row.numColumns), 1),
        [graphRows],
    );
    const graphWidth = maxCols * LANE_WIDTH + 12;

    useCommitGraphCanvas({
        canvasRef,
        rows: graphRows,
        graphWidth,
        rowCount: commits.length,
    });

    const isUnpushedCommit = useCallback(
        (hash: string): boolean => {
            for (const unpushed of unpushedHashes) {
                if (hash.startsWith(unpushed) || unpushed.startsWith(hash)) return true;
            }
            return false;
        },
        [unpushedHashes],
    );

    const handleRowContextMenu = useCallback((event: React.MouseEvent, commit: Commit) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, commit });
    }, []);

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            const target =
                action === "checkoutMain" ? (defaultCheckoutBranch ?? undefined) : undefined;
            onCommitAction(action, contextMenu.commit.hash, target);
        },
        [contextMenu, defaultCheckoutBranch, onCommitAction],
    );

    const handleScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const el = event.currentTarget;
            if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
                onLoadMore();
            }
        },
        [hasMore, onLoadMore],
    );

    return (
        <div style={ROOT_STYLE}>
            <div style={FILTER_BAR_STYLE}>
                <svg width="14" height="14" viewBox="0 0 16 16" style={FILTER_ICON_STYLE}>
                    <path
                        fill="currentColor"
                        d="M11.7 10.3a6 6 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5zM6 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"
                    />
                </svg>
                <input
                    type="text"
                    placeholder="Text or hash"
                    value={filterText}
                    onChange={(event) => onFilterText(event.target.value)}
                    style={FILTER_INPUT_STYLE}
                />
            </div>

            <div style={headerRowStyle(graphWidth)}>
                <span style={{ flex: 1 }}>Commit</span>
                <span style={{ width: AUTHOR_COL_WIDTH, textAlign: "right" }}>Author</span>
                <span style={{ width: DATE_COL_WIDTH, textAlign: "right", marginLeft: 8 }}>
                    Date
                </span>
            </div>

            <div style={SCROLL_VIEWPORT_STYLE} onScroll={handleScroll}>
                <div style={contentContainerStyle(commits.length)}>
                    <canvas ref={canvasRef} style={CANVAS_STYLE} />

                    {commits.map((commit, idx) => (
                        <CommitRow
                            key={commit.hash}
                            commit={commit}
                            graphWidth={graphWidth}
                            isSelected={selectedHash === commit.hash}
                            isUnpushed={isUnpushedCommit(commit.hash)}
                            laneColor={graphRows[idx]?.color}
                            onSelect={onSelectCommit}
                            onContextMenu={handleRowContextMenu}
                        />
                    ))}

                    {hasMore && <div style={LOADING_MORE_STYLE}>Loading more...</div>}
                </div>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getCommitMenuItems(
                        contextMenu.commit,
                        isUnpushedCommit(contextMenu.commit.hash),
                        defaultCheckoutBranch,
                    )}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                    minWidth={380}
                />
            )}
        </div>
    );
}
