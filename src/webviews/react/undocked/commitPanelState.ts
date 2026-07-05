import type {
    AmendBranchCommitSummary,
    Branch,
    Commit,
    CommitChecksSnapshot,
    CommitDetail,
    GitWorktree,
    StashEntry,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../types";

/** Commit-check state cached by the undocked commit graph. */
export type CommitChecksValue = CommitChecksSnapshot | "loading";

/** Reducer action for graph state owned by the undocked app shell. */
export type GraphAction =
    | {
          type: "loadCommits";
          commits: Commit[];
          append: boolean;
          hasMore: boolean;
          selectedHash: string | null;
          unpushedHashes?: string[];
      }
    | {
          type: "setBranches";
          branches: Branch[];
          worktrees?: GitWorktree[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          commitChecksEnabled?: boolean;
      }
    | { type: "setSelectedBranch"; branch: string | null }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "clearCommitDetail"; loading?: boolean }
    | { type: "setCommitChecks"; snapshot: CommitChecksSnapshot }
    | { type: "markCommitChecksLoading"; hash: string }
    | { type: "loadError"; clearCommits: boolean }
    | { type: "selectCommit"; hash: string }
    | { type: "selectBranch"; branch: string | null }
    | { type: "setFilterText"; text: string };

/**
 * Commit-panel slice owned by the undocked app, mirroring working-tree, stash,
 * amend, theme icon, and upstream state received from extension messages.
 */
export interface CommitPanelState {
    files: WorkingFile[];
    stashes: StashEntry[];
    stashFiles: WorkingFile[];
    selectedStashIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    commitMessage: string;
    isAmend: boolean;
    amendBranchCommits: AmendBranchCommitSummary[];
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
    error: string | null;
    currentBranchHasUpstream: boolean;
    hasRemotes: boolean;
    currentBranchAhead: number;
    currentBranchBehind: number;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
}

/** Reducer actions emitted by unified undocked messages and local commit-panel controls. */
export type CommitPanelAction =
    | {
          type: "SET_FILES_AND_STASHES";
          files: WorkingFile[];
          stashes: StashEntry[];
          stashFiles: WorkingFile[];
          selectedStashIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          currentBranchHasUpstream: boolean;
          hasRemotes?: boolean;
          currentBranchAhead: number;
          currentBranchBehind: number;
          currentBranchName?: string | null;
          currentBranchUpstream?: string | null;
      }
    | { type: "RESTORE_COMMIT_DRAFT"; message: string }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED" }
    | { type: "SET_REFRESHING"; active: boolean }
    | { type: "SET_ERROR"; message: string }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean }
    | { type: "SET_AMEND_BRANCH_COMMITS"; commits: AmendBranchCommitSummary[] };

/** Default commit-panel state before the extension sends the first working-tree update. */
export const initialCommitPanelState: CommitPanelState = {
    files: [],
    stashes: [],
    stashFiles: [],
    selectedStashIndex: null,
    folderIcon: undefined,
    folderExpandedIcon: undefined,
    folderIconsByName: undefined,
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

/**
 * Applies undocked commit-panel updates while preserving icon theme metadata
 * across incremental working-tree refreshes.
 */
export function commitPanelReducer(
    state: CommitPanelState,
    action: CommitPanelAction,
): CommitPanelState {
    switch (action.type) {
        case "SET_FILES_AND_STASHES":
            return {
                ...state,
                files: action.files,
                stashes: action.stashes,
                stashFiles: action.stashFiles,
                selectedStashIndex: action.selectedStashIndex,
                folderIcon: action.folderIcon ?? state.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? state.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? state.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
                hasRemotes: action.hasRemotes ?? state.hasRemotes,
                currentBranchAhead: action.currentBranchAhead,
                currentBranchBehind: action.currentBranchBehind,
                currentBranchName:
                    action.currentBranchName !== undefined
                        ? action.currentBranchName
                        : state.currentBranchName,
                currentBranchUpstream:
                    action.currentBranchUpstream !== undefined
                        ? action.currentBranchUpstream
                        : state.currentBranchUpstream,
                error: null,
            };
        case "SET_REFRESHING":
            if (action.active && state.isAmend) {
                return {
                    ...state,
                    isRefreshing: true,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                };
            }
            return { ...state, isRefreshing: action.active };
        case "RESTORE_COMMIT_DRAFT":
            return { ...state, commitMessage: action.message };
        case "SET_LAST_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "COMMITTED":
            return {
                ...state,
                commitMessage: "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "SET_COMMIT_MESSAGE":
            return { ...state, commitMessage: action.message };
        case "SET_AMEND":
            return {
                ...state,
                isAmend: action.isAmend,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_AMEND_BRANCH_COMMITS":
            if (!state.isAmend) return state;
            return {
                ...state,
                amendBranchCommits: action.commits,
                amendBranchHistoryLoaded: true,
            };
    }
}
