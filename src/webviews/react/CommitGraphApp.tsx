// Stripped React app for the bottom-panel commit graph webview.
// Contains only the CommitList (canvas graph + rows) and a filter bar.
// Branch selection and commit details are handled by native VS Code tree views.

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { CommitList } from './CommitList';
import type { Commit, GitLogResponse } from '../../types';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface GraphMessage {
    type: 'loadCommits';
    commits: Commit[];
    hasMore: boolean;
    append: boolean;
}

function App(): React.ReactElement {
    const [commits, setCommits] = useState<Commit[]>([]);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [filterBranch, setFilterBranch] = useState<string | null>(null);

    useEffect(() => {
        vscode.postMessage({ type: 'ready' });

        const handler = (event: MessageEvent) => {
            const data = event.data as GraphMessage;
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

    return (
        <CommitList
            commits={commits}
            selectedHash={selectedHash}
            filterText={filterText}
            filterBranch={filterBranch}
            hasMore={hasMore}
            onSelectCommit={handleSelectCommit}
            onFilterText={handleFilterText}
            onLoadMore={handleLoadMore}
        />
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
