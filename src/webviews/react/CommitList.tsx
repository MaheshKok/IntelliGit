// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useRef, useEffect, useMemo } from 'react';
import type { Commit } from '../../types';
import { computeGraph, COLORS, LANE_WIDTH, DOT_RADIUS, ROW_HEIGHT } from './graph';

interface Props {
    commits: Commit[];
    selectedHash: string | null;
    filterText: string;
    hasMore: boolean;
    onSelectCommit: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void;
}

export function CommitList({
    commits, selectedHash, filterText, hasMore,
    onSelectCommit, onFilterText, onLoadMore,
}: Props): React.ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const graphRows = useMemo(() => computeGraph(commits), [commits]);
    const maxCols = useMemo(() => Math.max(1, ...graphRows.map(r => r.numColumns)), [graphRows]);
    const graphWidth = maxCols * LANE_WIDTH + 12;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || commits.length === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const bgColor = getComputedStyle(document.documentElement)
            .getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

        const dpr = window.devicePixelRatio || 1;
        const totalHeight = commits.length * ROW_HEIGHT;
        canvas.width = graphWidth * dpr;
        canvas.height = totalHeight * dpr;
        canvas.style.width = `${graphWidth}px`;
        canvas.style.height = `${totalHeight}px`;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, graphWidth, totalHeight);
        ctx.lineCap = 'round';

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
                const incoming = prev.connectionsDown.some(c => c.toCol === row.column)
                    || prev.passThroughLanes.some(l => l.column === row.column);
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
                        fx, cy + ROW_HEIGHT * 0.4,
                        tx, y + ROW_HEIGHT - ROW_HEIGHT * 0.3,
                        tx, y + ROW_HEIGHT,
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Filter bar */}
            <div style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--vscode-panel-border)',
                display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
            }}>
                <svg width="14" height="14" viewBox="0 0 16 16" style={{ opacity: 0.5, flexShrink: 0 }}>
                    <path fill="currentColor" d="M11.7 10.3a6 6 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5zM6 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>
                </svg>
                <input
                    type="text"
                    placeholder="Text or hash"
                    value={filterText}
                    onChange={(e) => onFilterText(e.target.value)}
                    style={{
                        flex: 1, maxWidth: 300, padding: '3px 8px',
                        background: 'var(--vscode-input-background)',
                        color: 'var(--vscode-input-foreground)',
                        border: '1px solid var(--vscode-input-border)',
                        borderRadius: '3px', fontSize: '12px', outline: 'none',
                    }}
                />
            </div>

            {/* Column headers */}
            <div style={{
                display: 'flex', alignItems: 'center', height: 22, fontSize: '11px',
                borderBottom: '1px solid var(--vscode-panel-border)',
                opacity: 0.5, paddingLeft: graphWidth, paddingRight: 8, flexShrink: 0,
            }}>
                <span style={{ flex: 1 }}>Commit</span>
                <span style={{ width: 120, textAlign: 'right' }}>Author</span>
                <span style={{ width: 140, textAlign: 'right', marginLeft: 8 }}>Date</span>
            </div>

            {/* Scrollable commit list */}
            <div
                style={{ flex: 1, overflow: 'auto' }}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
                        onLoadMore();
                    }
                }}
            >
                <div style={{ position: 'relative', minHeight: commits.length * ROW_HEIGHT }}>
                    <canvas
                        ref={canvasRef}
                        style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
                    />

                    {commits.map((commit) => (
                        <div
                            key={commit.hash}
                            onClick={() => onSelectCommit(commit.hash)}
                            style={{
                                height: ROW_HEIGHT,
                                display: 'flex', alignItems: 'center',
                                paddingLeft: graphWidth, paddingRight: 8,
                                cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap',
                                background: selectedHash === commit.hash
                                    ? 'var(--vscode-list-activeSelectionBackground)'
                                    : 'transparent',
                                color: selectedHash === commit.hash
                                    ? 'var(--vscode-list-activeSelectionForeground)'
                                    : 'inherit',
                            }}
                        >
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {commit.message}
                            </span>

                            {commit.refs.length > 0 && (
                                <span style={{ display: 'flex', gap: '3px', marginLeft: 8, flexShrink: 0 }}>
                                    {commit.refs.map(ref => (
                                        <RefLabel key={ref} name={ref} />
                                    ))}
                                </span>
                            )}

                            <span style={{
                                width: 120, textAlign: 'right', opacity: 0.7,
                                overflow: 'hidden', textOverflow: 'ellipsis',
                                flexShrink: 0, marginLeft: 8,
                            }}>
                                {commit.author}
                            </span>

                            <span style={{
                                width: 140, textAlign: 'right', opacity: 0.5,
                                flexShrink: 0, marginLeft: 8, fontSize: '11px',
                            }}>
                                {fmtDate(commit.date)}
                            </span>
                        </div>
                    ))}

                    {hasMore && (
                        <div style={{
                            padding: '8px', textAlign: 'center', fontSize: '11px', opacity: 0.5,
                        }}>
                            Loading more...
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function RefLabel({ name }: { name: string }) {
    const isHead = name.includes('HEAD');
    const isTag = name.startsWith('tag:');
    let bg: string;
    let fg: string;

    if (isHead) {
        bg = '#4CAF50';
        fg = '#fff';
    } else if (isTag) {
        bg = '#FF9800';
        fg = '#fff';
    } else if (name.startsWith('origin/')) {
        bg = '#2196F3';
        fg = '#fff';
    } else {
        bg = '#6d6dea';
        fg = '#fff';
    }

    return (
        <span style={{
            padding: '1px 6px', borderRadius: '3px', fontSize: '10px',
            background: bg, color: fg, lineHeight: '16px',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160,
            display: 'inline-block',
        }}>
            {name}
        </span>
    );
}

function fmtDate(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', {
            month: 'numeric', day: 'numeric', year: '2-digit',
            hour: 'numeric', minute: '2-digit',
        });
    } catch {
        return iso;
    }
}
