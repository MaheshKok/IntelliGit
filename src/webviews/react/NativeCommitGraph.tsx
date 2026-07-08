// Compact commit graph for the commit panel. Reuses the same CommitList
// component as the middle panel — same graph rendering, same tooltips,
// same virtual scrolling. Keeps its own state management to match the
// extension-host message contract.

import React, { useEffect, useCallback, useMemo, useRef, useReducer } from "react";
import { CommitList } from "./CommitList";
import { shouldRequestCommitChecks } from "./commit-list/checksRefresh";
import type { Branch, Commit, CommitChecksSnapshot } from "../../types";
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

type CommitChecksValue = CommitChecksSnapshot | "loading";

interface NativeCommitGraphState {
    commits: Commit[];
    branches: Branch[];
    selectedHash: string | null;
    selectedBranch: string | null;
    hasMore: boolean;
    filterText: string;
    unpushedHashes: Set<string>;
    commitChecks: Map<string, CommitChecksValue>;
    commitChecksEnabled: boolean;
}

type NativeCommitGraphAction =
    | {
          type: "loadCommits";
          commits: Commit[];
          append: boolean;
          hasMore: boolean;
          selectedHash: string | null;
          unpushedHashes?: string[];
      }
    | { type: "setSelectedBranch"; branch: string | null }
    | {
          type: "setBranches";
          branches: Branch[];
          commitChecksEnabled?: boolean;
      }
    | { type: "loadError"; clearCommits: boolean }
    | { type: "setCommitChecks"; snapshot: CommitChecksSnapshot }
    | { type: "markCommitChecksLoading"; hash: string }
    | { type: "selectCommit"; hash: string }
    | { type: "setFilterText"; text: string };

const initialNativeCommitGraphState: NativeCommitGraphState = {
    commits: [],
    branches: [],
    selectedHash: null,
    selectedBranch: null,
    hasMore: false,
    filterText: "",
    unpushedHashes: new Set(),
    commitChecks: new Map(),
    commitChecksEnabled: true,
};

function nativeCommitGraphReducer(
    state: NativeCommitGraphState,
    action: NativeCommitGraphAction,
): NativeCommitGraphState {
    switch (action.type) {
        case "loadCommits":
            return {
                ...state,
                commits: action.append ? [...state.commits, ...action.commits] : action.commits,
                selectedHash: action.selectedHash,
                hasMore: action.hasMore,
                unpushedHashes: new Set(action.unpushedHashes ?? []),
            };
        case "setSelectedBranch":
            return { ...state, selectedBranch: action.branch };
        case "setBranches":
            return {
                ...state,
                branches: action.branches,
                commitChecksEnabled: action.commitChecksEnabled ?? true,
            };
        case "loadError":
            return {
                ...state,
                commits: action.clearCommits ? [] : state.commits,
                hasMore: false,
            };
        case "setCommitChecks": {
            const next = new Map(state.commitChecks);
            next.set(action.snapshot.hash, action.snapshot);
            return { ...state, commitChecks: next };
        }
        case "markCommitChecksLoading": {
            if (state.commitChecks.get(action.hash) !== undefined) return state;
            const next = new Map(state.commitChecks);
            next.set(action.hash, "loading");
            return { ...state, commitChecks: next };
        }
        case "selectCommit":
            return { ...state, selectedHash: action.hash };
        case "setFilterText":
            return { ...state, filterText: action.text };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}

/**
 * Hosts the compact graph used by sidebar and commit-panel contexts, preserving
 * the extension-host commit graph message protocol while hiding branch and detail columns.
 */
export function NativeCommitGraph({
    vscode,
    stateKeyPrefix: _stateKeyPrefix = "",
    sendReady = true,
}: Props): React.ReactElement {
    const [state, dispatch] = useReducer(nativeCommitGraphReducer, initialNativeCommitGraphState);
    const {
        commits,
        branches,
        selectedHash,
        selectedBranch,
        hasMore,
        filterText,
        unpushedHashes,
        commitChecks,
        commitChecksEnabled,
    } = state;
    const loadingMore = useRef(false);
    const selectedHashRef = useRef<string | null>(selectedHash);
    const selectFirstOnNextLoadRef = useRef(false);
    selectedHashRef.current = selectedHash;
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
                case "loadCommits": {
                    loadingMore.current = false;
                    const forceFirstCommit = !data.append && selectFirstOnNextLoadRef.current;
                    const previousSelectedHash = selectedHashRef.current;
                    const firstCommitHash = data.commits[0]?.hash ?? null;
                    const preservesSelectedHash =
                        !data.append &&
                        previousSelectedHash !== null &&
                        data.commits.some((commit) => commit.hash === previousSelectedHash);
                    const nextSelectedHash = forceFirstCommit
                        ? firstCommitHash
                        : preservesSelectedHash
                          ? previousSelectedHash
                          : !data.append
                            ? firstCommitHash
                            : previousSelectedHash;
                    if (!data.append) {
                        selectFirstOnNextLoadRef.current = false;
                    }
                    selectedHashRef.current = nextSelectedHash;
                    dispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        selectedHash: nextSelectedHash,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (
                        !data.append &&
                        nextSelectedHash !== null &&
                        (forceFirstCommit || nextSelectedHash !== previousSelectedHash)
                    ) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: nextSelectedHash,
                        });
                    }
                    break;
                }
                case "setSelectedBranch":
                    selectFirstOnNextLoadRef.current = true;
                    dispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    break;
                case "setBranches":
                    dispatch({
                        type: "setBranches",
                        branches: data.branches,
                        commitChecksEnabled: data.commitChecksEnabled,
                    });
                    break;
                case "loadError":
                    selectFirstOnNextLoadRef.current = false;
                    dispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    break;
                case "setCommitChecks":
                    dispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [sendReady, vscode]);

    const handleSelectCommit = useCallback(
        (hash: string) => {
            dispatch({ type: "selectCommit", hash });
            vscode.postMessage({ type: "selectCommit", hash });
        },
        [vscode],
    );

    const handleFilterText = useCallback(
        (text: string) => {
            dispatch({ type: "setFilterText", text });
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

    const handleRequestCommitChecks = useCallback(
        (hash: string) => {
            const current = commitChecks.get(hash);
            if (!shouldRequestCommitChecks(current)) return;
            // Only show the spinner on the first fetch. A background refresh of an
            // already-displayed snapshot keeps the current badge so it does not flicker.
            if (current === undefined) {
                dispatch({ type: "markCommitChecksLoading", hash });
            }
            vscode.postMessage({ type: "requestCommitChecks", hash });
        },
        [commitChecks, vscode],
    );

    const handleOpenCommitCheckUrl = useCallback(
        (url: string) => {
            vscode.postMessage({ type: "openCommitCheckUrl", url });
        },
        [vscode],
    );
    const handleSignInForCommitChecks = useCallback(
        (host: string) => {
            vscode.postMessage({ type: "signInForCommitChecks", host });
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
            commitChecks={commitChecks}
            onRequestCommitChecks={commitChecksEnabled ? handleRequestCommitChecks : undefined}
            onOpenCommitCheckUrl={commitChecksEnabled ? handleOpenCommitCheckUrl : undefined}
            onSignInForCommitChecks={commitChecksEnabled ? handleSignInForCommitChecks : undefined}
            showSearch={false}
            showAuthorDate={false}
            headerLabel="Graph"
        />
    );
}
