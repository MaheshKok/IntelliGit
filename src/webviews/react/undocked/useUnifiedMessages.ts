// Owns the unified extension-host message listener for the undocked webview.
// The hook keeps graph, commit-panel, settings, and layout restore messages on the existing single channel.
// Width hydration logic stays byte-for-byte equivalent to the former App effect.

import { useEffect, useRef } from "react";
import type React from "react";
import type {
    RepositoryViewIdentity,
    UnifiedInbound,
    UnifiedOutbound,
} from "../../protocol/undockedMessages";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { SectionWidths } from "./sectionWidths";
import type { CommitPanelAction, CommitPanelState, GraphAction } from "./commitPanelState";

const vscode = getVsCodeApi<UnifiedOutbound, Record<string, unknown>>();

/**
 * Parameters for wiring the undocked message bridge into reducer dispatchers.
 *
 * Carries reducer dispatchers, graph pagination state, width hydration controls,
 * the layout measurement ref, and the host-driven commit-panel position setter.
 */
export interface UseUnifiedMessagesParams {
    graphDispatch: React.Dispatch<GraphAction>;
    cpDispatch: React.Dispatch<CommitPanelAction>;
    /** Applies a commit-panel action and exposes its reduced next state for synchronous follow-up work. */
    applyCommitPanelAction: (action: CommitPanelAction) => CommitPanelState;
    cpStateRef: React.MutableRefObject<CommitPanelState>;
    loadingMore: React.MutableRefObject<boolean>;
    selectedHash: string | null;
    selectedRepositoryRoot: string | null;
    setRepositories: (repositories: RepositoryViewIdentity[]) => void;
    setSelectedRepositoryRoot: (root: string) => void;
    markWidthsHydrated: () => void;
    setSectionWidths: (next: SectionWidths) => void;
    layoutRef: React.MutableRefObject<HTMLDivElement | null>;
    setCommitPanelPosition: (pos: "left" | "right") => void;
    setViewVisible: (visible: boolean) => void;
    onShowRebaseDialog: (dialog: Extract<UnifiedInbound, { type: "showRebaseDialog" }>) => void;
}

type MessageContext = Omit<UseUnifiedMessagesParams, "selectedHash" | "selectedRepositoryRoot"> & {
    selectedHashRef: React.MutableRefObject<string | null>;
    selectedRepositoryRootRef: React.MutableRefObject<string | null>;
};

type GraphInboundMessage = Extract<
    UnifiedInbound,
    {
        type:
            | "loadCommits"
            | "setBranches"
            | "setSelectedBranch"
            | "setCommitDetail"
            | "clearCommitDetail"
            | "setCommitChecks"
            | "setViewVisibility"
            | "showRebaseDialog"
            | "loadError";
    }
>;

type CommitPanelInboundMessage = Extract<
    UnifiedInbound,
    {
        type:
            | "update"
            | "restoreCommitDraft"
            | "lastCommitMessage"
            | "amendBranchCommits"
            | "committed"
            | "commitMessageGeneration"
            | "shelfMutationCompleted"
            | "refreshing"
            | "error";
    }
>;

/** Identifies messages owned by the undocked graph reducer and selection state. */
function isGraphMessage(data: UnifiedInbound): data is GraphInboundMessage {
    return [
        "loadCommits",
        "setBranches",
        "setSelectedBranch",
        "setCommitDetail",
        "clearCommitDetail",
        "setCommitChecks",
        "setViewVisibility",
        "showRebaseDialog",
        "loadError",
    ].includes(data.type);
}

/** Identifies messages owned by the undocked commit-panel reducer. */
function isCommitPanelMessage(data: UnifiedInbound): data is CommitPanelInboundMessage {
    return [
        "update",
        "restoreCommitDraft",
        "lastCommitMessage",
        "amendBranchCommits",
        "committed",
        "commitMessageGeneration",
        "shelfMutationCompleted",
        "refreshing",
        "error",
    ].includes(data.type);
}

/** Identifies host settings that restore the undocked layout. */
function isLayoutMessage(
    data: UnifiedInbound,
): data is Extract<UnifiedInbound, { type: "settings" | "columnWidths" }> {
    return data.type === "settings" || data.type === "columnWidths";
}

/** Applies a repository selection message before resetting graph and commit-panel state. */
function handleRepositoriesMessage(
    data: Extract<UnifiedInbound, { type: "repositories" }>,
    context: MessageContext,
): void {
    const previousRoot = context.selectedRepositoryRootRef.current;
    context.setRepositories(data.repositories);
    context.setSelectedRepositoryRoot(data.selectedRepositoryRoot);
    if (previousRoot !== data.selectedRepositoryRoot) {
        context.selectedRepositoryRootRef.current = data.selectedRepositoryRoot;
        context.selectedHashRef.current = null;
        context.loadingMore.current = false;
        context.graphDispatch({ type: "resetRepository" });
        context.cpDispatch({ type: "RESET_REPOSITORY" });
    }
}

/** Applies messages that update graph data, selection, visibility, and load state. */
function handleGraphMessage(data: GraphInboundMessage, context: MessageContext): void {
    switch (data.type) {
        case "loadCommits": {
            context.loadingMore.current = false;
            const previousSelectedHash = context.selectedHashRef.current;
            const nextSelectedHash =
                !data.append &&
                previousSelectedHash !== null &&
                data.commits.some((commit) => commit.hash === previousSelectedHash)
                    ? previousSelectedHash
                    : !data.append
                      ? (data.commits[0]?.hash ?? null)
                      : previousSelectedHash;
            context.selectedHashRef.current = nextSelectedHash;
            context.graphDispatch({
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
                nextSelectedHash !== previousSelectedHash
            ) {
                vscode.postMessage({ type: "selectCommit", hash: nextSelectedHash });
            }
            return;
        }
        case "setBranches":
            context.graphDispatch({
                type: "setBranches",
                branches: data.branches,
                worktrees: data.worktrees,
                folderIcon: data.folderIcon,
                folderExpandedIcon: data.folderExpandedIcon,
                folderIconsByName: data.folderIconsByName,
                iconFonts: data.iconFonts,
                commitChecksEnabled: data.commitChecksEnabled,
            });
            return;
        case "setSelectedBranch":
            context.graphDispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
            return;
        case "setCommitDetail":
            context.graphDispatch({
                type: "setCommitDetail",
                detail: data.detail,
                folderIcon: data.folderIcon,
                folderExpandedIcon: data.folderExpandedIcon,
                folderIconsByName: data.folderIconsByName,
                iconFonts: data.iconFonts,
            });
            return;
        case "clearCommitDetail":
            context.graphDispatch({ type: "clearCommitDetail", loading: data.loading ?? false });
            return;
        case "setCommitChecks":
            context.graphDispatch({ type: "setCommitChecks", snapshot: data.snapshot });
            return;
        case "setViewVisibility":
            context.setViewVisible(data.visible);
            return;
        case "showRebaseDialog":
            context.onShowRebaseDialog(data);
            return;
        case "loadError":
            context.graphDispatch({
                type: "loadError",
                clearCommits: !context.loadingMore.current,
            });
            context.loadingMore.current = false;
            console.error("[IntelliGit] Load error:", data.message);
            return;
    }
}

/** Applies messages that update the commit-panel state for the selected repository. */
function handleCommitPanelMessage(data: CommitPanelInboundMessage, context: MessageContext): void {
    switch (data.type) {
        case "update":
            if (data.repositoryRoot !== context.selectedRepositoryRootRef.current) return;
            context.cpDispatch({
                type: "SET_FILES_AND_STASHES",
                files: data.files,
                stashes: data.stashes,
                stashFiles: data.stashFiles,
                selectedStashIndex: data.selectedStashIndex,
                shelves: data.shelves ?? [],
                catalogGeneration: data.catalogGeneration ?? 0,
                selectedShelfId: data.selectedShelfId ?? null,
                folderIcon: data.folderIcon,
                folderExpandedIcon: data.folderExpandedIcon,
                folderIconsByName: data.folderIconsByName,
                iconFonts: data.iconFonts,
                currentBranchHasUpstream: data.currentBranchHasUpstream ?? true,
                hasRemotes: data.hasRemotes,
                currentBranchAhead: data.currentBranchAhead ?? 0,
                currentBranchBehind: data.currentBranchBehind ?? 0,
                currentBranchName: data.currentBranchName,
                currentBranchUpstream: data.currentBranchUpstream,
                hasCommits: data.hasCommits,
                wholeIndexOperationInProgress: data.wholeIndexOperationInProgress,
                activeOperation: data.activeOperation,
                rebaseControl: data.rebaseControl,
            });
            return;
        case "restoreCommitDraft":
            if (data.repositoryRoot === context.selectedRepositoryRootRef.current) {
                context.cpDispatch({ type: "RESTORE_COMMIT_DRAFT", message: data.message });
            }
            return;
        case "lastCommitMessage":
            if (data.repositoryRoot === context.selectedRepositoryRootRef.current) {
                context.cpDispatch({ type: "SET_LAST_COMMIT_MESSAGE", message: data.message });
            }
            return;
        case "amendBranchCommits":
            if (data.repositoryRoot === context.selectedRepositoryRootRef.current) {
                context.cpDispatch({ type: "SET_AMEND_BRANCH_COMMITS", commits: data.commits });
            }
            return;
        case "committed":
            if (data.repositoryRoot === context.selectedRepositoryRootRef.current) {
                context.cpDispatch({
                    type: "COMMITTED",
                    clearCommitMessage: data.clearCommitMessage,
                });
            }
            return;
        case "commitMessageGeneration": {
            if (data.repositoryRoot !== context.selectedRepositoryRootRef.current) return;
            const generation = context.cpStateRef.current.generation;
            if (generation.status === "idle" || generation.requestId !== data.requestId) return;
            const nextState = context.applyCommitPanelAction({
                type: "COMMIT_MESSAGE_GENERATION_EVENT",
                requestId: data.requestId,
                kind: data.kind,
                text: data.text,
                superseded: data.superseded,
            });
            if (
                (data.kind === "done" || data.kind === "cancelled" || data.kind === "error") &&
                !data.superseded
            ) {
                vscode.postMessage({
                    type: "saveCommitDraft",
                    repositoryRoot: data.repositoryRoot,
                    message: nextState.commitMessage,
                });
            }
            return;
        }
        case "shelfMutationCompleted":
            context.cpDispatch({
                type: "SET_SHELF_MUTATION_OUTCOME",
                requestId: data.requestId,
                status: data.status,
                entries: data.entries,
                message: data.message,
                shelfId: data.shelfId,
                newGeneration: data.newGeneration,
            });
            return;
        case "refreshing":
            context.cpDispatch({ type: "SET_REFRESHING", active: data.active });
            return;
        case "error":
            context.cpDispatch({ type: "SET_ERROR", message: data.message });
            console.error("[IntelliGit] Extension error:", data.message);
            return;
    }
}

/** Restores layout settings emitted by the extension host. */
function handleLayoutMessage(
    data: Extract<UnifiedInbound, { type: "settings" | "columnWidths" }>,
    context: MessageContext,
): void {
    if (data.type === "settings") {
        context.setCommitPanelPosition(data.commitWindowPosition);
        return;
    }
    context.markWidthsHydrated();
    context.setSectionWidths({
        repositoryWidth: data.repositoryWidth,
        branchWidth: data.branchWidth,
        graphWidth: data.graphWidth,
        infoWidth: data.infoWidth,
        commitPanelWidth: data.commitPanelWidth,
    });
}

/**
 * Subscribes to unified undocked messages from the extension host.
 *
 * @param params - Reducer dispatchers, width controls, and layout setters used by the message switch.
 */
export function useUnifiedMessages(params: UseUnifiedMessagesParams): void {
    const {
        graphDispatch,
        cpDispatch,
        applyCommitPanelAction,
        cpStateRef,
        loadingMore,
        selectedHash,
        selectedRepositoryRoot,
        setRepositories,
        setSelectedRepositoryRoot,
        markWidthsHydrated,
        setSectionWidths,
        layoutRef,
        setCommitPanelPosition,
        setViewVisible,
        onShowRebaseDialog,
    } = params;
    const selectedHashRef = useRef<string | null>(selectedHash);
    selectedHashRef.current = selectedHash;
    const selectedRepositoryRootRef = useRef<string | null>(selectedRepositoryRoot);
    selectedRepositoryRootRef.current = selectedRepositoryRoot;

    useEffect(() => {
        const context: MessageContext = {
            graphDispatch,
            cpDispatch,
            applyCommitPanelAction,
            cpStateRef,
            loadingMore,
            setRepositories,
            setSelectedRepositoryRoot,
            markWidthsHydrated,
            setSectionWidths,
            layoutRef,
            setCommitPanelPosition,
            setViewVisible,
            onShowRebaseDialog,
            selectedHashRef,
            selectedRepositoryRootRef,
        };
        const handler = (event: MessageEvent<UnifiedInbound>) => {
            const data = event.data;
            if (data.type === "repositories") return handleRepositoriesMessage(data, context);
            if (isGraphMessage(data)) return handleGraphMessage(data, context);
            if (isCommitPanelMessage(data)) return handleCommitPanelMessage(data, context);
            if (isLayoutMessage(data)) return handleLayoutMessage(data, context);
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });

        return () => window.removeEventListener("message", handler);
    }, [
        cpDispatch,
        applyCommitPanelAction,
        cpStateRef,
        graphDispatch,
        layoutRef,
        loadingMore,
        markWidthsHydrated,
        setCommitPanelPosition,
        setRepositories,
        setSectionWidths,
        setSelectedRepositoryRoot,
        setViewVisible,
        onShowRebaseDialog,
    ]);
}
