// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Commit, CommitChecksSnapshot } from "../../types";
import { computeGraph, LANE_WIDTH, ROW_HEIGHT } from "./graph";
import { ContextMenu } from "./shared/components/ContextMenu";
import { ClearIcon, SearchIcon } from "./shared/components/Icons";
import { getCommitMenuItems } from "./commit-list/commitMenu";
import { CommitListRows } from "./commit-list/CommitListRows";
import { commitHashesMatch, retryDelaysForCommitChecks } from "./commit-list/checksRefresh";
import { useCommitGraphCanvas } from "./commit-list/useCommitGraphCanvas";
import { isCommitAction, type CommitAction } from "../protocol/commitGraphTypes";
import { JETBRAINS_UI } from "./shared/tokens";
import { t } from "./shared/i18n";
import {
    AUTHOR_COL_WIDTH,
    BRANCH_SCOPE_STYLE,
    CHECKS_COL_WIDTH,
    DATE_COL_WIDTH,
    FILTER_BAR_STYLE,
    FILTER_CLEAR_BUTTON_STYLE,
    FILTER_ICON_STYLE,
    FILTER_INPUT_STYLE,
    FILTER_INPUT_WRAP_STYLE,
    headerRowStyle,
    ROOT_STYLE,
} from "./commit-list/styles";

const MIN_PREFIX_LENGTH = 7;
const MAX_GRAPH_WIDTH = JETBRAINS_UI.graph.maxWidth;

/**
 * Allows cherry-pick actions when the graph is scoped to a non-current branch,
 * or when the current branch is unavailable and the extension must decide.
 */
// Utility export is covered by webview unit tests; moving it would only churn local imports.
// react-doctor-disable-next-line react-doctor/only-export-components
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
    currentBranchHeadHash?: string | null;
    onSelectCommit: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void | Promise<void>;
    onCommitAction: (action: CommitAction, hash: string) => void;
    onCommitHover?: (commit: Commit, event: React.MouseEvent) => void;
    onCommitUnhover?: () => void;
    commitChecks?: ReadonlyMap<string, CommitChecksSnapshot | "loading">;
    onRequestCommitChecks?: (hashes: string[], force?: boolean) => void;
    onOpenCommitCheckUrl?: (url: string) => void;
    onSignInForCommitChecks?: (host: string) => void;
    showSearch?: boolean;
    showAuthorDate?: boolean;
    headerLabel?: string;
    /**
     * Host-driven visibility of the surface embedding this list. Defaults to
     * `true`. Commit-check demand is withheld and retry timers stay disarmed
     * while `false`, because `document.visibilityState` is unreliable inside a
     * VS Code webview iframe (it reports `"visible"` even when the view/tab is
     * hidden). Hosts forward real `WebviewView`/`WebviewPanel` visibility.
     */
    isViewVisible?: boolean;
}

type RetryAttempt = { state: CommitChecksSnapshot["state"]; attempt: number };

/**
 * Renders a virtualized commit list with an aligned canvas lane graph, optional
 * search chrome, branch-scope context actions, and incremental load-more support.
 * Commit-check demand tracks only the exact viewport and is cleared while the
 * host reports the surface hidden (`isViewVisible === false`) or when the
 * surface unmounts. Pending snapshots and a pushed current HEAD use bounded
 * retry schedules.
 */
export function CommitList({
    commits,
    selectedHash,
    filterText,
    hasMore,
    unpushedHashes,
    selectedBranch,
    currentBranchName,
    currentBranchHeadHash,
    onSelectCommit,
    onFilterText,
    onLoadMore,
    onCommitAction,
    onCommitHover,
    onCommitUnhover,
    commitChecks,
    onRequestCommitChecks,
    onOpenCommitCheckUrl,
    onSignInForCommitChecks,
    showSearch = true,
    showAuthorDate = true,
    headerLabel,
    isViewVisible = true,
}: Props): React.ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const viewportResizeObserverRef = useRef<ResizeObserver | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: Commit } | null>(
        null,
    );
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const isLoadingMoreRef = useRef(false);
    const retryTimerRef = useRef<number | null>(null);
    // Keep cleanup wired to the latest callback without turning callback replacement into an event.
    // react-doctor-disable-next-line react-doctor/no-event-handler
    const onRequestCommitChecksRef = useRef(onRequestCommitChecks);
    // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init
    const checkRetryAttempts = useRef(new Map<string, RetryAttempt>());

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

    const setViewportNode = useCallback((node: HTMLDivElement | null) => {
        viewportResizeObserverRef.current?.disconnect();
        viewportResizeObserverRef.current = null;
        viewportRef.current = node;
        if (!node) return;

        const updateHeight = () => setViewportHeight(node.clientHeight);
        updateHeight();

        const observer = new ResizeObserver(updateHeight);
        observer.observe(node);
        viewportResizeObserverRef.current = observer;
    }, []);

    useEffect(() => () => viewportResizeObserverRef.current?.disconnect(), []);

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

    const renderedCommits = useMemo(
        () => commits.slice(visibleRange.start, visibleRange.end),
        [commits, visibleRange.end, visibleRange.start],
    );

    const requestRange = useMemo(() => {
        if (commits.length === 0) return { start: 0, end: 0 };
        const effectiveHeight = Math.max(ROW_HEIGHT, viewportHeight);
        return {
            start: Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)),
            end: Math.min(commits.length, Math.ceil((scrollTop + effectiveHeight) / ROW_HEIGHT)),
        };
    }, [commits.length, scrollTop, viewportHeight]);
    const requestedCommitHashes = useMemo(
        () =>
            Array.from(
                new Set(
                    commits
                        .slice(requestRange.start, requestRange.end)
                        .map((commit) => commit.hash),
                ),
            ),
        [commits, requestRange.end, requestRange.start],
    );

    useEffect(() => {
        const previousCallback = onRequestCommitChecksRef.current;
        if (previousCallback && !onRequestCommitChecks) previousCallback([], false);
        onRequestCommitChecksRef.current = onRequestCommitChecks;
    }, [onRequestCommitChecks]);

    // Replaces this surface's exact-viewport demand whenever the viewport changes
    // or host visibility flips. Withholds demand (posts []) while hidden; the
    // retry effect below clears any armed timer via its cleanup on the same flip.
    // react-doctor-disable-next-line react-doctor/no-effect-event-handler, react-doctor/exhaustive-deps
    useEffect(() => {
        if (!onRequestCommitChecks) return;
        // react-doctor-disable-next-line react-doctor/no-prop-callback-in-effect, react-doctor/no-pass-live-state-to-parent, react-doctor/no-pass-data-to-parent
        onRequestCommitChecks(isViewVisible ? requestedCommitHashes : [], false);
    }, [onRequestCommitChecks, requestedCommitHashes, isViewVisible]);

    useEffect(
        () => () => {
            onRequestCommitChecksRef.current?.([], false);
        },
        [],
    );

    // Retry scheduling is bounded per visible hash and never publishes hidden demand.
    // react-doctor-disable-next-line react-doctor/no-effect-event-handler, react-doctor/exhaustive-deps
    useEffect(() => {
        if (!onRequestCommitChecks || !isViewVisible) return;

        /** Arms one timer for the earliest remaining interval and advances only due hashes. */
        const scheduleNextRetry = (): void => {
            let nextDelay: number | undefined;

            for (const hash of requestedCommitHashes) {
                const snapshot = commitChecks?.get(hash);
                if (!snapshot || snapshot === "loading") {
                    checkRetryAttempts.current.delete(hash);
                    continue;
                }

                const schedule = retryDelaysForCommitChecks(snapshot, {
                    isCurrentHead:
                        currentBranchHeadHash !== null &&
                        currentBranchHeadHash !== undefined &&
                        commitHashesMatch(hash, currentBranchHeadHash),
                    isUnpushed: isUnpushedCommit(hash),
                });
                if (schedule.length === 0) {
                    checkRetryAttempts.current.delete(hash);
                    continue;
                }

                const previous = checkRetryAttempts.current.get(hash);
                const attempt =
                    previous?.state === snapshot.state
                        ? previous
                        : { state: snapshot.state, attempt: 0 };
                checkRetryAttempts.current.set(hash, attempt);
                const delay = schedule[attempt.attempt];
                if (delay !== undefined && (nextDelay === undefined || delay < nextDelay)) {
                    nextDelay = delay;
                }
            }

            if (nextDelay === undefined) return;
            const dueDelay = nextDelay;
            const timer = window.setTimeout(() => {
                if (retryTimerRef.current === timer) retryTimerRef.current = null;

                const dueHashes: string[] = [];
                for (const hash of requestedCommitHashes) {
                    const snapshot = commitChecks?.get(hash);
                    if (!snapshot || snapshot === "loading") continue;
                    const attempt = checkRetryAttempts.current.get(hash);
                    if (!attempt || attempt.state !== snapshot.state) continue;
                    const schedule = retryDelaysForCommitChecks(snapshot, {
                        isCurrentHead:
                            currentBranchHeadHash !== null &&
                            currentBranchHeadHash !== undefined &&
                            commitHashesMatch(hash, currentBranchHeadHash),
                        isUnpushed: isUnpushedCommit(hash),
                    });
                    if (schedule[attempt.attempt] !== dueDelay) continue;
                    checkRetryAttempts.current.set(hash, {
                        state: snapshot.state,
                        attempt: attempt.attempt + 1,
                    });
                    dueHashes.push(hash);
                }

                if (dueHashes.length > 0) onRequestCommitChecks(dueHashes, true);
                scheduleNextRetry();
            }, dueDelay);
            retryTimerRef.current = timer;
        };

        // Retry timing derives from current snapshots; it is not parent-state synchronization.
        // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent
        scheduleNextRetry();
        return () => {
            if (retryTimerRef.current !== null) {
                window.clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
        };
    }, [
        commitChecks,
        currentBranchHeadHash,
        isViewVisible,
        isUnpushedCommit,
        onRequestCommitChecks,
        requestedCommitHashes,
    ]);

    /** Keeps row-triggered loading aligned with this surface's full exact-viewport demand. */
    const handleRequestCommitChecksFromRow = useCallback(() => {
        onRequestCommitChecks?.(requestedCommitHashes, false);
    }, [onRequestCommitChecks, requestedCommitHashes]);

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
                            aria-label={t("commit.search.placeholder")}
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

            <CommitListRows
                commits={commits}
                visibleCommits={renderedCommits}
                visibleRange={visibleRange}
                graphWidth={graphWidth}
                graphRows={graphRows}
                canvasRef={canvasRef}
                setViewportNode={setViewportNode}
                selectedHash={selectedHash}
                unpushedHashes={unpushedHashes}
                isUnpushedCommit={isUnpushedCommit}
                hasMore={hasMore}
                showAuthorDate={showAuthorDate}
                commitChecks={commitChecks}
                onSelectCommit={onSelectCommit}
                onRequestCommitChecks={
                    onRequestCommitChecks ? handleRequestCommitChecksFromRow : undefined
                }
                onOpenCommitCheckUrl={onOpenCommitCheckUrl}
                onSignInForCommitChecks={onSignInForCommitChecks}
                onCommitHover={onCommitHover}
                onCommitUnhover={onCommitUnhover}
                onRowContextMenu={handleRowContextMenu}
                onScroll={handleScroll}
            />

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
