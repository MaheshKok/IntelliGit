// React app for the bottom-panel commit graph webview.
// Layout: [BranchColumn (resizable)] | [drag-handle] | [CommitList + search bar].
// Branch filtering from the inline branch tree posts back to the extension host.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BranchColumn } from './BranchColumn';
import { CommitList } from './CommitList';
import type { Branch, Commit } from '../../types';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const MIN_BRANCH_WIDTH = 80;
const MAX_BRANCH_WIDTH = 500;
const DEFAULT_BRANCH_WIDTH = 200;

function App(): React.ReactElement {
    const [commits, setCommits] = useState<Commit[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [branchWidth, setBranchWidth] = useState(DEFAULT_BRANCH_WIDTH);
    const dragging = useRef(false);

    useEffect(() => {
        vscode.postMessage({ type: 'ready' });

        const handler = (event: MessageEvent) => {
            const data = event.data;
            switch (data.type) {
                case 'loadCommits':
                    if (data.append) {
                        setCommits(prev => [...prev, ...data.commits]);
                    } else {
                        setCommits(data.commits);
                        if (data.commits.length > 0) {
                            setSelectedHash(data.commits[0].hash);
                            vscode.postMessage({ type: 'selectCommit', hash: data.commits[0].hash });
                        }
                    }
                    setHasMore(data.hasMore);
                    break;
                case 'setBranches':
                    setBranches(data.branches);
                    break;
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    const handleSelectCommit = useCallback((hash: string) => {
        setSelectedHash(hash);
        vscode.postMessage({ type: 'selectCommit', hash });
    }, []);

    const handleFilterText = useCallback((text: string) => {
        setFilterText(text);
        if (text.length >= 3 || text.length === 0) {
            vscode.postMessage({ type: 'filterText', text });
        }
    }, []);

    const handleLoadMore = useCallback(() => {
        vscode.postMessage({ type: 'loadMore' });
    }, []);

    const handleSelectBranch = useCallback((name: string | null) => {
        setSelectedBranch(name);
        vscode.postMessage({ type: 'filterBranch', branch: name });
    }, []);

    // Resizable divider via mouse events on document
    const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragging.current = true;
        const startX = e.clientX;
        const startWidth = branchWidth;

        const onMouseMove = (ev: MouseEvent) => {
            if (!dragging.current) return;
            const delta = ev.clientX - startX;
            const newWidth = Math.max(MIN_BRANCH_WIDTH, Math.min(MAX_BRANCH_WIDTH, startWidth + delta));
            setBranchWidth(newWidth);
        };

        const onMouseUp = () => {
            dragging.current = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [branchWidth]);

    return (
        <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
            {/* Branch column */}
            <div style={{ width: branchWidth, flexShrink: 0, overflow: 'hidden' }}>
                <BranchColumn
                    branches={branches}
                    selectedBranch={selectedBranch}
                    onSelectBranch={handleSelectBranch}
                />
            </div>

            {/* Resizable divider */}
            <div
                onMouseDown={onDividerMouseDown}
                style={{
                    width: 4,
                    flexShrink: 0,
                    cursor: 'col-resize',
                    background: 'var(--vscode-panel-border)',
                }}
            />

            {/* Commit graph + list */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <CommitList
                    commits={commits}
                    selectedHash={selectedHash}
                    filterText={filterText}
                    hasMore={hasMore}
                    onSelectCommit={handleSelectCommit}
                    onFilterText={handleFilterText}
                    onLoadMore={handleLoadMore}
                />
            </div>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
