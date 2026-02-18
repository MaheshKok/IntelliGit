// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useRef, useEffect, useMemo, useState, useCallback } from "react";
import type { Commit } from "../../types";
import { computeGraph, LANE_WIDTH, DOT_RADIUS, ROW_HEIGHT } from "./graph";
import { formatDateTime } from "./shared/date";
import { REF_BADGE_COLORS } from "./shared/tokens";
import { ContextMenu, type MenuItem } from "./shared/components/ContextMenu";

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
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        commit: Commit;
    } | null>(null);

    const graphRows = useMemo(() => computeGraph(commits), [commits]);
    const maxCols = useMemo(() => Math.max(1, ...graphRows.map((r) => r.numColumns)), [graphRows]);
    const graphWidth = maxCols * LANE_WIDTH + 12;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || commits.length === 0) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bgColor =
            getComputedStyle(document.documentElement)
                .getPropertyValue("--vscode-editor-background")
                .trim() || "#1e1e1e";

        const dpr = window.devicePixelRatio || 1;
        const totalHeight = commits.length * ROW_HEIGHT;
        canvas.width = graphWidth * dpr;
        canvas.height = totalHeight * dpr;
        canvas.style.width = `${graphWidth}px`;
        canvas.style.height = `${totalHeight}px`;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, graphWidth, totalHeight);
        ctx.lineCap = "round";

        for (let i = 0; i < graphRows.length; i++) {
            const row = graphRows[i];
            const y = i * ROW_HEIGHT;
            const cy = y + ROW_HEIGHT / 2;
            const cx = row.column * LANE_WIDTH + LANE_WIDTH / 2 + 4;

            // Pass-through vertical lines
            for (const lane of row.passThroughLanes) {
                const lx = lane.column * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                ctx.beginPath();
                ctx.strokeStyle = lane.color;
                ctx.lineWidth = 2;
                ctx.moveTo(lx, y);
                ctx.lineTo(lx, y + ROW_HEIGHT);
                ctx.stroke();
            }

            // Line from top of row to commit dot
            if (i > 0) {
                const prev = graphRows[i - 1];
                const incoming =
                    prev.connectionsDown.some((c) => c.toCol === row.column) ||
                    prev.passThroughLanes.some((l) => l.column === row.column);
                if (incoming) {
                    ctx.beginPath();
                    ctx.strokeStyle = row.color;
                    ctx.lineWidth = 2;
                    ctx.moveTo(cx, y);
                    ctx.lineTo(cx, cy);
                    ctx.stroke();
                }
            }

            // Connection lines down to parents
            for (const conn of row.connectionsDown) {
                const fx = conn.fromCol * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                const tx = conn.toCol * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                ctx.beginPath();
                ctx.strokeStyle = conn.color;
                ctx.lineWidth = 2;
                if (conn.fromCol === conn.toCol) {
                    ctx.moveTo(fx, cy);
                    ctx.lineTo(tx, y + ROW_HEIGHT);
                } else {
                    ctx.moveTo(fx, cy);
                    ctx.bezierCurveTo(
                        fx,
                        cy + ROW_HEIGHT * 0.4,
                        tx,
                        y + ROW_HEIGHT - ROW_HEIGHT * 0.3,
                        tx,
                        y + ROW_HEIGHT,
                    );
                }
                ctx.stroke();
            }

            // Commit dot -- ring style
            ctx.beginPath();
            ctx.fillStyle = bgColor;
            ctx.arc(cx, cy, DOT_RADIUS + 1, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.strokeStyle = row.color;
            ctx.lineWidth = 2.5;
            ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.fillStyle = row.color;
            ctx.arc(cx, cy, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }, [graphRows, graphWidth, commits.length]);

    const isUnpushedCommit = useCallback(
        (hash: string): boolean => {
            for (const unpushed of unpushedHashes) {
                if (hash.startsWith(unpushed) || unpushed.startsWith(hash)) return true;
            }
            return false;
        },
        [unpushedHashes],
    );

    const handleRowContextMenu = useCallback((e: React.MouseEvent, commit: Commit) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, commit });
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

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Filter bar */}
            <div
                style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--vscode-panel-border)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexShrink: 0,
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    style={{ opacity: 0.5, flexShrink: 0 }}
                >
                    <path
                        fill="currentColor"
                        d="M11.7 10.3a6 6 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5zM6 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"
                    />
                </svg>
                <input
                    type="text"
                    placeholder="Text or hash"
                    value={filterText}
                    onChange={(e) => onFilterText(e.target.value)}
                    style={{
                        flex: 1,
                        maxWidth: 300,
                        padding: "3px 8px",
                        background: "var(--vscode-input-background)",
                        color: "var(--vscode-input-foreground)",
                        border: "1px solid var(--vscode-input-border)",
                        borderRadius: "3px",
                        fontSize: "12px",
                        outline: "none",
                    }}
                />
            </div>

            {/* Column headers */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    height: 22,
                    fontSize: "11px",
                    borderBottom: "1px solid var(--vscode-panel-border)",
                    opacity: 0.5,
                    paddingLeft: graphWidth,
                    paddingRight: 8,
                    flexShrink: 0,
                }}
            >
                <span style={{ flex: 1 }}>Commit</span>
                <span style={{ width: 120, textAlign: "right" }}>Author</span>
                <span style={{ width: 140, textAlign: "right", marginLeft: 8 }}>Date</span>
            </div>

            {/* Scrollable commit list */}
            <div
                style={{ flex: 1, overflow: "auto" }}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
                        onLoadMore();
                    }
                }}
            >
                <div style={{ position: "relative", minHeight: commits.length * ROW_HEIGHT }}>
                    <canvas
                        ref={canvasRef}
                        style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
                    />

                    {commits.map((commit) => (
                        <div
                            key={commit.hash}
                            onClick={() => onSelectCommit(commit.hash)}
                            onContextMenu={(e) => handleRowContextMenu(e, commit)}
                            style={{
                                height: ROW_HEIGHT,
                                display: "flex",
                                alignItems: "center",
                                paddingLeft: graphWidth,
                                paddingRight: 8,
                                cursor: "pointer",
                                fontSize: "12px",
                                whiteSpace: "nowrap",
                                background:
                                    selectedHash === commit.hash
                                        ? "var(--vscode-list-activeSelectionBackground)"
                                        : "transparent",
                                color:
                                    selectedHash === commit.hash
                                        ? "var(--vscode-list-activeSelectionForeground)"
                                        : "inherit",
                            }}
                        >
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                                {commit.message}
                            </span>

                            {commit.refs.length > 0 && (
                                <span
                                    style={{
                                        display: "flex",
                                        gap: "3px",
                                        marginLeft: 8,
                                        flexShrink: 0,
                                    }}
                                >
                                    {commit.refs.map((ref) => (
                                        <RefLabel key={ref} name={ref} />
                                    ))}
                                </span>
                            )}

                            <span
                                style={{
                                    width: 120,
                                    textAlign: "right",
                                    opacity: 0.7,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    flexShrink: 0,
                                    marginLeft: 8,
                                }}
                            >
                                {commit.author}
                            </span>

                            <span
                                style={{
                                    width: 140,
                                    textAlign: "right",
                                    opacity: 0.5,
                                    flexShrink: 0,
                                    marginLeft: 8,
                                    fontSize: "11px",
                                }}
                            >
                                {formatDateTime(commit.date)}
                            </span>
                        </div>
                    ))}

                    {hasMore && (
                        <div
                            style={{
                                padding: "8px",
                                textAlign: "center",
                                fontSize: "11px",
                                opacity: 0.5,
                            }}
                        >
                            Loading more...
                        </div>
                    )}
                </div>
            </div>
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getCommitMenuItems(
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

function getCommitMenuItems(isUnpushed: boolean, defaultCheckoutBranch: string | null): MenuItem[] {
    const isPushed = !isUnpushed;

    const items: MenuItem[] = [
        { label: "Copy Revision Number", action: "copyRevision", icon: iconCopy() },
        { label: "Create Patch...", action: "createPatch", icon: iconPatch() },
        { label: "Cherry-Pick", action: "cherryPick", icon: iconCherry() },
        { separator: true, label: "", action: "sep-checkout" },
    ];

    items.push({
        label: defaultCheckoutBranch ? `Checkout '${defaultCheckoutBranch}'` : "Checkout",
        action: "checkoutMain",
        disabled: !defaultCheckoutBranch,
    });
    items.push({ label: "Checkout Revision", action: "checkoutRevision" });

    items.push({ separator: true, label: "", action: "sep-reset" });
    items.push({
        label: "Reset Current Branch to Here...",
        action: "resetCurrentToHere",
        icon: iconReset(),
    });
    items.push({ label: "Revert Commit", action: "revertCommit" });
    items.push({
        label: "Undo Commit...",
        action: "undoCommit",
        disabled: isPushed,
    });

    items.push({ separator: true, label: "", action: "sep-history" });
    items.push({
        label: "Edit Commit Message...",
        action: "editCommitMessage",
        disabled: isPushed,
    });
    items.push({ label: "Drop Commits", action: "dropCommits", disabled: isPushed });
    items.push({
        label: "Interactively Rebase from Here...",
        action: "interactiveRebaseFromHere",
        disabled: isPushed,
    });

    items.push({ separator: true, label: "", action: "sep-create" });
    items.push({ label: "New Branch...", action: "newBranch" });
    items.push({ label: "New Tag...", action: "newTag" });

    // Ensure stable unique keys for separators.
    return items.map((item, idx) =>
        item.separator ? { ...item, action: `${item.action}-${idx}` } : item,
    );
}

function RefLabel({ name }: { name: string }) {
    const isHead = name.includes("HEAD");
    const isTag = name.startsWith("tag:");
    let bg: string;
    let fg: string;

    if (isHead) {
        bg = REF_BADGE_COLORS.head.bg;
        fg = REF_BADGE_COLORS.head.fg;
    } else if (isTag) {
        bg = REF_BADGE_COLORS.tag.bg;
        fg = REF_BADGE_COLORS.tag.fg;
    } else if (name.startsWith("origin/")) {
        bg = REF_BADGE_COLORS.remote.bg;
        fg = REF_BADGE_COLORS.remote.fg;
    } else {
        bg = REF_BADGE_COLORS.local.bg;
        fg = REF_BADGE_COLORS.local.fg;
    }

    return (
        <span
            style={{
                padding: "1px 6px",
                borderRadius: "3px",
                fontSize: "10px",
                background: bg,
                color: fg,
                lineHeight: "16px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 160,
                display: "inline-block",
            }}
        >
            {name}
        </span>
    );
}

function iconCopy(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M3 2h8a1 1 0 0 1 1 1v1h-1V3H3v8H2V3a1 1 0 0 1 1-1zm2 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1v8h8V6H5z"
            />
        </svg>
    );
}

function iconPatch(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M6.5 1a2.5 2.5 0 0 0 0 5h1V4h1v2h1a2.5 2.5 0 1 0 0-5h-1v2h-1V1h-1zm-4 7h4v1h-4V8zm0 3h7v1h-7v-1zm6 1.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zm1 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"
            />
        </svg>
    );
}

function iconCherry(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M8.2 3.2a2.2 2.2 0 1 0-2.4-2.2h1a1.2 1.2 0 1 1 1.2 1.2H6.9c-2.6 0-4.7 2-4.7 4.6 0 2.2 1.8 4 4 4a3.9 3.9 0 0 0 2-7.2V3.2zm-2 6.6a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8zm4.6-5.2a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8z"
            />
        </svg>
    );
}

function iconReset(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M8 2a6 6 0 1 1-4.8 2.4L1 6.6V2h4.6L4 3.6A5 5 0 1 0 8 3v-1z"
            />
        </svg>
    );
}
