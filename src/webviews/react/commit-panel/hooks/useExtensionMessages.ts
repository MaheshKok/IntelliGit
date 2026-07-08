// Message bridge between the VS Code extension host and commit panel React app.

import { useEffect, useReducer, type Dispatch } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type {
    CommitPanelAction,
    CommitPanelRepositorySummary,
    InboundMessage,
    MultiRepositoryCommitPanelState,
    RepositoryCommitPanelState,
} from "../types";
import type { WorkingFile } from "../../../../types";

const LEGACY_REPOSITORY_ROOT = "";

function createRepositoryState(
    root: string,
    label: string,
    changedFileCount: number = 0,
): RepositoryCommitPanelState {
    return {
        root,
        label,
        changedFileCount,
        files: [],
        stashes: [],
        stashFiles: [],
        selectedStashIndex: null,
        folderIcon: undefined,
        folderExpandedIcon: undefined,
        folderIconsByName: {},
        iconFonts: [],
        commitMessage: "",
        isAmend: false,
        amendBranchCommits: [],
        amendBranchHistoryLoaded: false,
        isRefreshing: false,
        error: null,
        currentBranchHasUpstream: true,
        hasRemotes: true,
        currentBranchAhead: 0,
        currentBranchBehind: 0,
        currentBranchName: null,
        currentBranchUpstream: null,
    };
}

const initialState: MultiRepositoryCommitPanelState = {
    repositories: [],
    activeRepositoryRoot: null,
    expandedRepositoryRoots: [],
};

function countChangedFiles(files: WorkingFile[]): number {
    const paths = new Set<string>();
    for (const file of files) {
        if (file.status !== "!") paths.add(file.path);
    }
    return paths.size;
}

function targetRoot(state: MultiRepositoryCommitPanelState, repositoryRoot?: string): string {
    return (
        repositoryRoot ??
        state.activeRepositoryRoot ??
        state.repositories[0]?.root ??
        LEGACY_REPOSITORY_ROOT
    );
}

function expandedRootsFor(
    state: MultiRepositoryCommitPanelState,
    repositories: CommitPanelRepositorySummary[],
    activeRepositoryRoot: string | null,
): string[] {
    const knownRoots = new Set(repositories.map((repository) => repository.root));
    const retained = state.expandedRepositoryRoots.filter((root) => knownRoots.has(root));
    if (retained.length > 0) return retained;
    if (state.repositories.length > 0) return [];
    const fallbackRoot = activeRepositoryRoot ?? repositories[0]?.root;
    return fallbackRoot ? [fallbackRoot] : [];
}

function updateRepository(
    state: MultiRepositoryCommitPanelState,
    repositoryRoot: string | undefined,
    update: (repository: RepositoryCommitPanelState) => RepositoryCommitPanelState,
): MultiRepositoryCommitPanelState {
    const root = targetRoot(state, repositoryRoot);
    const index = state.repositories.findIndex((repository) => repository.root === root);
    const existing =
        index >= 0
            ? state.repositories[index]
            : createRepositoryState(root, root === LEGACY_REPOSITORY_ROOT ? "" : root);
    const nextRepository = update(existing);
    const repositories =
        index >= 0
            ? state.repositories.map((repository, currentIndex) =>
                  currentIndex === index ? nextRepository : repository,
              )
            : [...state.repositories, nextRepository];
    const activeRepositoryRoot = state.activeRepositoryRoot ?? root;
    const expandedRepositoryRoots =
        state.expandedRepositoryRoots.length > 0 ? state.expandedRepositoryRoots : [root];
    return { repositories, activeRepositoryRoot, expandedRepositoryRoots };
}

function updateRepositoryMetadata(
    repository: RepositoryCommitPanelState,
    summary: CommitPanelRepositorySummary,
): RepositoryCommitPanelState {
    return {
        ...repository,
        root: summary.root,
        label: summary.label,
        changedFileCount: summary.changedFileCount,
    };
}

function reducer(
    state: MultiRepositoryCommitPanelState,
    action: CommitPanelAction,
): MultiRepositoryCommitPanelState {
    switch (action.type) {
        case "SET_REPOSITORIES": {
            const roots = new Set(action.repositories.map((repository) => repository.root));
            const activeRepositoryRoot =
                action.activeRepositoryRoot !== null && roots.has(action.activeRepositoryRoot)
                    ? action.activeRepositoryRoot
                    : (action.repositories[0]?.root ?? null);
            return {
                repositories: action.repositories.map((summary) => {
                    const existing = state.repositories.find(
                        (repository) => repository.root === summary.root,
                    );
                    return updateRepositoryMetadata(
                        existing ?? createRepositoryState(summary.root, summary.label),
                        summary,
                    );
                }),
                activeRepositoryRoot,
                expandedRepositoryRoots: expandedRootsFor(
                    state,
                    action.repositories,
                    activeRepositoryRoot,
                ),
            };
        }
        case "SET_EXPANDED_REPOSITORIES": {
            const knownRoots = new Set(state.repositories.map((repository) => repository.root));
            return {
                ...state,
                expandedRepositoryRoots: action.repositoryRoots.filter((root) =>
                    knownRoots.has(root),
                ),
            };
        }
        case "SET_FILES_AND_STASHES":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                label: action.repositoryLabel ?? repository.label,
                changedFileCount: action.changedFileCount ?? countChangedFiles(action.files),
                files: action.files,
                stashes: action.stashes,
                stashFiles: action.stashFiles,
                selectedStashIndex: action.selectedStashIndex,
                folderIcon: action.folderIcon ?? repository.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? repository.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? repository.folderIconsByName,
                iconFonts: action.iconFonts ?? repository.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
                hasRemotes: action.hasRemotes ?? repository.hasRemotes,
                currentBranchAhead: action.currentBranchAhead,
                currentBranchBehind: action.currentBranchBehind,
                currentBranchName:
                    action.currentBranchName !== undefined
                        ? action.currentBranchName
                        : repository.currentBranchName,
                currentBranchUpstream:
                    action.currentBranchUpstream !== undefined
                        ? action.currentBranchUpstream
                        : repository.currentBranchUpstream,
                isRefreshing: action.refreshing ?? repository.isRefreshing,
                error: action.error ?? null,
            }));
        case "SET_REFRESHING":
            return updateRepository(state, action.repositoryRoot, (repository) => {
                if (action.active && repository.isAmend) {
                    return {
                        ...repository,
                        isRefreshing: true,
                        amendBranchCommits: [],
                        amendBranchHistoryLoaded: false,
                    };
                }
                return { ...repository, isRefreshing: action.active };
            });
        case "RESTORE_COMMIT_DRAFT":
        case "SET_LAST_COMMIT_MESSAGE":
        case "SET_COMMIT_MESSAGE":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                commitMessage: action.message,
            }));
        case "COMMITTED":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                commitMessage: "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            }));
        case "SET_ERROR":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                error: action.message,
            }));
        case "SET_AMEND":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                isAmend: action.isAmend,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            }));
        case "SET_AMEND_BRANCH_COMMITS":
            return updateRepository(state, action.repositoryRoot, (repository) => {
                if (!repository.isAmend) return repository;
                return {
                    ...repository,
                    amendBranchCommits: action.commits,
                    amendBranchHistoryLoaded: true,
                };
            });
    }
}

/**
 * Subscribes to extension-host commit-panel messages and exposes reducer state.
 *
 * Host snapshots are merged by repository root. Rootless messages target the
 * active repository so the docked panel remains compatible with older producers.
 */
export function useExtensionMessages(): [
    MultiRepositoryCommitPanelState,
    Dispatch<CommitPanelAction>,
] {
    const [state, dispatch] = useReducer(reducer, initialState);

    useEffect(() => {
        const vscode = getVsCodeApi();

        const handler = (event: MessageEvent<InboundMessage>) => {
            const msg = event.data;
            switch (msg.type) {
                case "setRepositories":
                    dispatch({
                        type: "SET_REPOSITORIES",
                        repositories: msg.repositories,
                        activeRepositoryRoot: msg.activeRepositoryRoot,
                    });
                    break;
                case "update":
                    dispatch({
                        type: "SET_FILES_AND_STASHES",
                        repositoryRoot: msg.repositoryRoot,
                        repositoryLabel: msg.repositoryLabel,
                        changedFileCount: msg.changedFileCount,
                        files: msg.files,
                        stashes: msg.stashes,
                        stashFiles: msg.stashFiles,
                        selectedStashIndex: msg.selectedStashIndex,
                        folderIcon: msg.folderIcon,
                        folderExpandedIcon: msg.folderExpandedIcon,
                        folderIconsByName: msg.folderIconsByName,
                        iconFonts: msg.iconFonts,
                        currentBranchHasUpstream: msg.currentBranchHasUpstream ?? true,
                        hasRemotes: msg.hasRemotes,
                        currentBranchAhead: msg.currentBranchAhead ?? 0,
                        currentBranchBehind: msg.currentBranchBehind ?? 0,
                        currentBranchName: msg.currentBranchName,
                        currentBranchUpstream: msg.currentBranchUpstream,
                        refreshing: msg.refreshing,
                        error: msg.error,
                    });
                    break;
                case "restoreCommitDraft":
                    dispatch({
                        type: "RESTORE_COMMIT_DRAFT",
                        repositoryRoot: msg.repositoryRoot,
                        message: msg.message,
                    });
                    break;
                case "lastCommitMessage":
                    dispatch({
                        type: "SET_LAST_COMMIT_MESSAGE",
                        repositoryRoot: msg.repositoryRoot,
                        message: msg.message,
                    });
                    break;
                case "amendBranchCommits":
                    dispatch({
                        type: "SET_AMEND_BRANCH_COMMITS",
                        repositoryRoot: msg.repositoryRoot,
                        commits: msg.commits,
                    });
                    break;
                case "committed":
                    dispatch({ type: "COMMITTED", repositoryRoot: msg.repositoryRoot });
                    break;
                case "refreshing":
                    dispatch({
                        type: "SET_REFRESHING",
                        repositoryRoot: msg.repositoryRoot,
                        active: msg.active,
                    });
                    break;
                case "error":
                    dispatch({ type: "SET_ERROR", message: msg.message });
                    break;
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });

        return () => window.removeEventListener("message", handler);
    }, []);

    return [state, dispatch];
}
