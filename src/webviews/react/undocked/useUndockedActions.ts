// Provides the undocked webview's graph and commit-panel command callbacks.
// The hook only moves existing useCallback bodies out of App; it owns no state.
// Each dependency array matches the callback it replaced.

/* eslint-disable react-hooks/exhaustive-deps -- Dependency arrays intentionally match pre-extraction callbacks. */

import { useCallback } from "react";
import type React from "react";
import type { Branch } from "../../../types";
import type { BranchAction, CommitAction, WorktreeAction } from "../../protocol/commitGraphTypes";
import type { UnifiedOutbound } from "../../protocol/undockedMessages";
import { getVsCodeApi } from "../shared/vscodeApi";
import type {
    CommitMessageGenerationState,
    CommitPanelAction,
    GraphAction,
} from "./commitPanelState";

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();
let commitMessageGenerationRequestSequence = 0;

/** Creates an opaque client-local token for one undocked generation request. */
function nextCommitMessageGenerationRequestId(): string {
    commitMessageGenerationRequestSequence += 1;
    return `undocked-commit-message-${Date.now()}-${commitMessageGenerationRequestSequence}`;
}

/**
 * Parameters for graph and commit-panel command callback extraction.
 *
 * Carries graph and commit-panel dispatchers plus the state slices each moved
 * callback already closed over in App.
 */
export interface UseUndockedActionsParams {
    graphDispatch: React.Dispatch<GraphAction>;
    cpDispatch: React.Dispatch<CommitPanelAction>;
    loadingMore: React.MutableRefObject<boolean>;
    commitMessage: string;
    isAmend: boolean;
    generation: CommitMessageGenerationState;
    hasCommits: boolean;
    wholeIndexOperationInProgress: boolean;
    checkedPaths: Set<string>;
    selectedRepositoryRoot: string | null;
    shouldPublishBranch: boolean;
}

/** Callback set consumed by the undocked layout and child panes. */
export interface UndockedActions {
    handleSelectRepository: (repositoryRoot: string) => void;
    handleSelectCommit: (hash: string) => void;
    handleFilterText: (text: string) => void;
    handleLoadMore: () => void;
    handleSelectBranch: (name: string | null) => void;
    handleBranchAction: (action: BranchAction, branchName: string) => void;
    handleDeleteBranches: (branches: Branch[]) => void;
    handleWorktreeAction: (action: WorktreeAction, path: string) => void;
    handleCommitAction: (action: CommitAction, hash: string) => void;
    handleOpenDiff: (commitHash: string, filePath: string) => void;
    handleRequestCommitChecks: (hashes: string[], force?: boolean) => void;
    handleOpenCommitCheckUrl: (url: string) => void;
    handleSignInForCommitChecks: (host: string) => void;
    handleMessageChange: (message: string) => void;
    handleAmendChange: (isAmend: boolean) => void;
    handleGenerateMessage: () => void;
    handleCancelGeneration: () => void;
    handleCommit: () => void;
    handlePush: () => void;
    handleOpenRepository: () => void;
    handleSync: () => void;
    handleFetch: () => void;
    handlePull: () => void;
    handleDock: () => void;
}

/**
 * Returns the undocked graph and commit-panel command callbacks.
 *
 * @param params - State slices and dispatchers closed over by the existing callbacks.
 */
export function useUndockedActions(params: UseUndockedActionsParams): UndockedActions {
    const {
        graphDispatch,
        cpDispatch,
        loadingMore,
        commitMessage,
        isAmend,
        generation,
        hasCommits,
        wholeIndexOperationInProgress,
        checkedPaths,
        selectedRepositoryRoot,
        shouldPublishBranch,
    } = params;
    const handleSelectRepository = useCallback((repositoryRoot: string) => {
        loadingMore.current = false;
        graphDispatch({ type: "resetRepository" });
        cpDispatch({ type: "RESET_REPOSITORY" });
        vscode.postMessage({ type: "selectRepository", repositoryRoot });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, []);

    const handleSelectCommit = useCallback((hash: string) => {
        graphDispatch({ type: "selectCommit", hash });
        vscode.postMessage({ type: "selectCommit", hash });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, []);

    const handleFilterText = useCallback((text: string) => {
        graphDispatch({ type: "setFilterText", text });
        if (text.length >= 3 || text.length === 0) {
            loadingMore.current = false;
            vscode.postMessage({ type: "filterText", text });
        }
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, []);

    const handleLoadMore = useCallback(() => {
        if (loadingMore.current) return;
        loadingMore.current = true;
        vscode.postMessage({ type: "loadMore" });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, []);

    const handleSelectBranch = useCallback((name: string | null) => {
        graphDispatch({ type: "selectBranch", branch: name });
        loadingMore.current = false;
        vscode.postMessage({ type: "filterBranch", branch: name });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, []);

    const handleBranchAction = useCallback((action: BranchAction, branchName: string) => {
        vscode.postMessage({ type: "branchAction", action, branchName });
    }, []);

    const handleDeleteBranches = useCallback((branches: Branch[]) => {
        vscode.postMessage({ type: "deleteBranches", branches });
    }, []);

    const handleWorktreeAction = useCallback((action: WorktreeAction, path: string) => {
        vscode.postMessage({ type: "worktreeAction", action, path });
    }, []);

    const handleCommitAction = useCallback((action: CommitAction, hash: string) => {
        vscode.postMessage({ type: "commitAction", action, hash });
    }, []);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string) => {
        vscode.postMessage({ type: "openCommitFileDiff", commitHash, filePath });
    }, []);

    const handleRequestCommitChecks = useCallback(
        (hashes: string[], force = false) => {
            for (const hash of hashes) graphDispatch({ type: "markCommitChecksLoading", hash });
            vscode.postMessage({ type: "requestVisibleCommitChecks", hashes, force });
        },
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
        [graphDispatch],
    );

    const handleOpenCommitCheckUrl = useCallback((url: string) => {
        vscode.postMessage({ type: "openCommitCheckUrl", url });
    }, []);

    const handleSignInForCommitChecks = useCallback((host: string) => {
        vscode.postMessage({ type: "signInForCommitChecks", host });
    }, []);

    const handleMessageChange = useCallback(
        (message: string) => {
            if (generation.status !== "idle") return;
            cpDispatch({ type: "SET_COMMIT_MESSAGE", message });
            if (selectedRepositoryRoot) {
                vscode.postMessage({
                    type: "saveCommitDraft",
                    repositoryRoot: selectedRepositoryRoot,
                    message,
                });
            }
        },
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
        [generation.status, selectedRepositoryRoot],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            if (generation.status !== "idle" || (isAmend && !hasCommits)) return;
            cpDispatch({ type: "SET_AMEND", isAmend });
            if (isAmend) {
                vscode.postMessage({ type: "getLastCommitMessage" });
            }
        },
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
        [generation.status, hasCommits],
    );

    const handleGenerateMessage = useCallback(() => {
        const hasGenerationInput = isAmend ? hasCommits : checkedPaths.size > 0;
        if (
            !selectedRepositoryRoot ||
            generation.status !== "idle" ||
            wholeIndexOperationInProgress ||
            !hasGenerationInput
        ) {
            return;
        }
        const requestId = nextCommitMessageGenerationRequestId();
        cpDispatch({
            type: "REQUEST_COMMIT_MESSAGE_GENERATION",
            requestId,
            snapshot: commitMessage,
        });
        vscode.postMessage({
            type: "generateCommitMessage",
            repositoryRoot: selectedRepositoryRoot,
            requestId,
            paths: Array.from(checkedPaths),
            amend: isAmend,
        });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, [
        checkedPaths,
        commitMessage,
        generation.status,
        hasCommits,
        isAmend,
        selectedRepositoryRoot,
        wholeIndexOperationInProgress,
    ]);

    const handleCancelGeneration = useCallback(() => {
        const { requestId, status } = generation;
        if (
            !selectedRepositoryRoot ||
            (status !== "requested" && status !== "running") ||
            !requestId
        ) {
            return;
        }
        vscode.postMessage({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: selectedRepositoryRoot,
            requestId,
        });
    }, [generation, selectedRepositoryRoot]);

    const handleCommit = useCallback(() => {
        if (generation.status !== "idle" || (isAmend && !hasCommits)) return;
        const msg = commitMessage.trim();
        vscode.postMessage({
            type: "commitSelected",
            message: msg,
            amend: isAmend,
            push: false,
            paths: Array.from(checkedPaths),
        });
    }, [checkedPaths, commitMessage, generation.status, hasCommits, isAmend]);

    const handlePush = useCallback(() => {
        vscode.postMessage({ type: shouldPublishBranch ? "publishBranch" : "push" });
    }, [shouldPublishBranch]);

    const handleSync = useCallback(() => {
        vscode.postMessage({ type: "sync" });
    }, []);

    const handleOpenRepository = useCallback(() => {
        vscode.postMessage({ type: "openRepository" });
    }, []);

    const handleFetch = useCallback(() => {
        vscode.postMessage({ type: "fetch" });
    }, []);

    const handlePull = useCallback(() => {
        vscode.postMessage({ type: "pull" });
    }, []);

    const handleDock = useCallback(() => {
        vscode.postMessage({ type: "dock" });
    }, []);

    return {
        handleSelectRepository,
        handleSelectCommit,
        handleFilterText,
        handleLoadMore,
        handleSelectBranch,
        handleBranchAction,
        handleDeleteBranches,
        handleWorktreeAction,
        handleCommitAction,
        handleOpenDiff,
        handleRequestCommitChecks,
        handleOpenCommitCheckUrl,
        handleSignInForCommitChecks,
        handleMessageChange,
        handleAmendChange,
        handleGenerateMessage,
        handleCancelGeneration,
        handleCommit,
        handlePush,
        handleOpenRepository,
        handleSync,
        handleFetch,
        handlePull,
        handleDock,
    };
}
