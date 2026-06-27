// Stateless scroll viewport for the commit list. Renders the canvas lane graph,
// virtualized commit rows, and the load-more footer. Owns no hooks or state -
// all values are received as props from CommitList.

import React from "react";
import type { Commit, CommitChecksSnapshot } from "../../../types";
import { ROW_HEIGHT, computeGraph } from "../graph";
import { t } from "../shared/i18n";
import { CommitRow } from "./CommitRow";
import {
    CANVAS_STYLE,
    contentContainerStyle,
    LOADING_MORE_STYLE,
    SCROLL_VIEWPORT_STYLE,
} from "./styles";

interface CommitListRowsProps {
    commits: Commit[];
    visibleCommits: Commit[];
    visibleRange: { start: number; end: number };
    graphWidth: number;
    graphRows: ReturnType<typeof computeGraph>;
    canvasRef: React.RefObject<HTMLCanvasElement>;
    setViewportNode: (node: HTMLDivElement | null) => void;
    selectedHash: string | null;
    unpushedHashes: Set<string>;
    isUnpushedCommit: (hash: string) => boolean;
    hasMore: boolean;
    showAuthorDate: boolean;
    commitChecks?: ReadonlyMap<string, CommitChecksSnapshot | "loading">;
    onSelectCommit: (hash: string) => void;
    onRequestCommitChecks?: (hash: string) => void;
    onOpenCommitCheckUrl?: (url: string) => void;
    onSignInForCommitChecks?: (host: string) => void;
    onCommitHover?: (commit: Commit, event: React.MouseEvent) => void;
    onCommitUnhover?: () => void;
    onRowContextMenu: (event: React.MouseEvent, commit: Commit) => void;
    onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

/** Renders the scroll viewport, graph canvas, visible commit rows, and load footer. */
export function CommitListRows({
    commits,
    visibleCommits,
    visibleRange,
    graphWidth,
    graphRows,
    canvasRef,
    setViewportNode,
    selectedHash,
    isUnpushedCommit,
    hasMore,
    showAuthorDate,
    commitChecks,
    onSelectCommit,
    onRequestCommitChecks,
    onOpenCommitCheckUrl,
    onSignInForCommitChecks,
    onCommitHover,
    onCommitUnhover,
    onRowContextMenu,
    onScroll,
}: CommitListRowsProps): React.ReactElement {
    return (
        <div
            ref={setViewportNode}
            data-testid="commit-list-viewport"
            style={SCROLL_VIEWPORT_STYLE}
            onScroll={onScroll}
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
                                onContextMenu={onRowContextMenu}
                                onHover={onCommitHover}
                                onUnhover={onCommitUnhover}
                                showAuthorDate={showAuthorDate}
                                checks={commitChecks?.get(commit.hash)}
                                onRequestChecks={onRequestCommitChecks}
                                onOpenCheckUrl={onOpenCommitCheckUrl}
                                onSignIn={onSignInForCommitChecks}
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
    );
}
