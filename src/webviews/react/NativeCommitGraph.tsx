// Compact commit graph for the commit panel. Reuses the same CommitList
// component as the middle panel — same graph rendering, same tooltips,
// same virtual scrolling. Keeps its own state management to match the
// extension-host message contract.

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { CommitList } from "./CommitList";
import type { Branch, Commit } from "../../types";
import type {
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
} from "../protocol/commitGraphTypes";
import type { OutboundMessage as CommitPanelOutbound } from "./commit-panel/types";
import type { VsCodeApi } from "./shared/vscodeApi";

interface Props {
    vscode: VsCodeApi<CommitGraphOutbound | CommitPanelOutbound, Record<string, unknown>>;
    stateKeyPrefix?: string;
    sendReady?: boolean;
}

export function NativeCommitGraph({
    vscode,
    stateKeyPrefix: _stateKeyPrefix = "",
    sendReady = true,
}: Props): React.ReactElement {
    const [commits, setCommits] = useState<Commit[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
    const loadingMore = useRef(false);
    const currentBranchName = useMemo(
        () => branches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null,
        [branches],
    );

    useEffect(() => {
        if (sendReady) {
            vscode.postMessage({ type: "ready" });
        }

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            if (
                !data ||
                typeof data !== "object" ||
                typeof (data as { type?: unknown }).type !== "string"
            ) {
                return;
            }
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
                case "setSelectedBranch":
                    setSelectedBranch(data.branch ?? null);
                    break;
                case "setBranches":
                    setBranches(data.branches);
                    break;
                case "loadError":
                    if (!loadingMore.current) setCommits([]);
                    loadingMore.current = false;
                    setHasMore(false);
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [sendReady, vscode]);

    const handleSelectCommit = useCallback(
        (hash: string) => {
            setSelectedHash(hash);
            vscode.postMessage({ type: "selectCommit", hash });
        },
        [vscode],
    );

    const handleFilterText = useCallback(
        (text: string) => {
            setFilterText(text);
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

    const handleCommitAction = useCallback(
        (action: CommitAction, hash: string) => {
            vscode.postMessage({ type: "commitAction", action, hash });
        },
        [vscode],
    );

    return (
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
            showSearch={false}
            showAuthorDate={false}
            headerLabel="Graph"
        />
    );
}
