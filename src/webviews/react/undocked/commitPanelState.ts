import type {
    AmendBranchCommitSummary,
    StashEntry,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../types";

/**
 * Commit-panel slice owned by the undocked app, mirroring working-tree, shelf,
 * amend, theme icon, and upstream state received from extension messages.
 */
export interface CommitPanelState {
    files: WorkingFile[];
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedShelfIndex: number | null;
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
}

/** Reducer actions emitted by unified undocked messages and local commit-panel controls. */
export type CommitPanelAction =
    | {
          type: "SET_FILES_AND_STASHES";
          files: WorkingFile[];
          stashes: StashEntry[];
          shelfFiles: WorkingFile[];
          selectedShelfIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          currentBranchHasUpstream: boolean;
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
    shelfFiles: [],
    selectedShelfIndex: null,
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
                shelfFiles: action.shelfFiles,
                selectedShelfIndex: action.selectedShelfIndex,
                folderIcon: action.folderIcon ?? state.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? state.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? state.folderIconsByName,
                iconFonts: action.iconFonts ?? state.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
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
