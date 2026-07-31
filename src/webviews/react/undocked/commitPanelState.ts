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
import type {
    PerEntryResult,
    ShelfEntry,
    ShelfMutationStatus,
} from "../../protocol/commitPanelMessages";
import { commitMessageGenerationPrefix } from "../shared/commitMessageDraft";

/** Commit-check state cached by the undocked commit graph. */
export type CommitChecksValue = CommitChecksSnapshot | "loading";

/** Transient lifecycle for the single commit-message generation request in the undocked view. */
export interface CommitMessageGenerationState {
    status: "idle" | "requested" | "running";
    requestId?: string;
    snapshot?: string;
}

/** Reducer action for graph state owned by the undocked app shell. */
export type GraphAction =
    | { type: "resetRepository" }
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
    shelves: ShelfEntry[];
    catalogGeneration: number;
    selectedShelfId: string | null;
    shelfMutationOutcome: {
        requestId: string;
        status: ShelfMutationStatus;
        entries: PerEntryResult[];
        message?: string;
        shelfId?: string;
        newGeneration?: number;
    } | null;
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
    generation: CommitMessageGenerationState;
    hasCommits: boolean;
    wholeIndexOperationInProgress: boolean;
}

/** Reducer actions emitted by unified undocked messages and local commit-panel controls. */
export type CommitPanelAction =
    | { type: "RESET_REPOSITORY" }
    | {
          type: "SET_FILES_AND_STASHES";
          files: WorkingFile[];
          stashes: StashEntry[];
          stashFiles: WorkingFile[];
          selectedStashIndex: number | null;
          shelves: ShelfEntry[];
          catalogGeneration: number;
          selectedShelfId: string | null;
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
          hasCommits?: boolean;
          wholeIndexOperationInProgress?: boolean;
      }
    | { type: "RESTORE_COMMIT_DRAFT"; message: string }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED"; clearCommitMessage?: boolean }
    | { type: "SET_REFRESHING"; active: boolean }
    | { type: "SET_ERROR"; message: string }
    | {
          type: "SET_SHELF_MUTATION_OUTCOME";
          requestId: string;
          status: ShelfMutationStatus;
          entries: PerEntryResult[];
          message?: string;
          shelfId?: string;
          newGeneration?: number;
      }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean }
    | {
          type: "REQUEST_COMMIT_MESSAGE_GENERATION";
          requestId: string;
          snapshot: string;
      }
    | {
          type: "COMMIT_MESSAGE_GENERATION_EVENT";
          requestId: string;
          kind: "start" | "chunk" | "done" | "cancelled" | "error";
          text?: string;
          superseded?: boolean;
      }
    | { type: "SET_AMEND_BRANCH_COMMITS"; commits: AmendBranchCommitSummary[] };

/** Default commit-panel state before the extension sends the first working-tree update. */
export const initialCommitPanelState: CommitPanelState = {
    files: [],
    stashes: [],
    stashFiles: [],
    selectedStashIndex: null,
    shelves: [],
    catalogGeneration: 0,
    selectedShelfId: null,
    shelfMutationOutcome: null,
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
    generation: { status: "idle" },
    hasCommits: false,
    wholeIndexOperationInProgress: false,
};

/**
 * Applies one generation event after the reducer has validated its request identity.
 *
 * Terminal events restore the saved draft when required and clear the active marker so later
 * draft messages may update the state again.
 */
function applyGenerationEvent(
    state: CommitPanelState,
    action: Extract<CommitPanelAction, { type: "COMMIT_MESSAGE_GENERATION_EVENT" }>,
): CommitPanelState {
    switch (action.kind) {
        case "start":
            return state.generation.status === "requested"
                ? {
                      ...state,
                      commitMessage: commitMessageGenerationPrefix(
                          state.generation.snapshot ?? state.commitMessage,
                      ),
                      generation: { ...state.generation, status: "running" },
                  }
                : state;
        case "chunk":
            return state.generation.status === "running"
                ? { ...state, commitMessage: state.commitMessage + (action.text ?? "") }
                : state;
        case "done":
            return {
                ...state,
                ...(action.superseded
                    ? { commitMessage: state.generation.snapshot ?? state.commitMessage }
                    : {}),
                generation: { status: "idle" },
            };
        case "cancelled":
        case "error":
            return {
                ...state,
                commitMessage: state.generation.snapshot ?? state.commitMessage,
                generation: { status: "idle" },
            };
    }
}

/**
 * Applies undocked commit-panel updates while preserving icon theme metadata
 * across incremental working-tree refreshes.
 */
export function commitPanelReducer(
    state: CommitPanelState,
    action: CommitPanelAction,
): CommitPanelState {
    switch (action.type) {
        case "RESET_REPOSITORY":
            return initialCommitPanelState;
        case "SET_FILES_AND_STASHES":
            return {
                ...state,
                files: action.files,
                stashes: action.stashes,
                stashFiles: action.stashFiles,
                selectedStashIndex: action.selectedStashIndex,
                shelves: action.shelves,
                catalogGeneration: action.catalogGeneration,
                selectedShelfId: action.selectedShelfId,
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
                hasCommits: action.hasCommits ?? state.hasCommits,
                wholeIndexOperationInProgress:
                    action.wholeIndexOperationInProgress ?? state.wholeIndexOperationInProgress,
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
        case "SET_LAST_COMMIT_MESSAGE":
        case "SET_COMMIT_MESSAGE":
            if (state.generation.status !== "idle") return state;
            return { ...state, commitMessage: action.message };
        case "COMMITTED":
            return {
                ...state,
                commitMessage: action.clearCommitMessage === false ? state.commitMessage : "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "SET_SHELF_MUTATION_OUTCOME":
            return {
                ...state,
                shelfMutationOutcome: {
                    requestId: action.requestId,
                    status: action.status,
                    entries: action.entries,
                    message: action.message,
                    shelfId: action.shelfId,
                    newGeneration: action.newGeneration,
                },
            };
        case "SET_AMEND":
            if (state.generation.status !== "idle") return state;
            return {
                ...state,
                isAmend: action.isAmend,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            };
        case "REQUEST_COMMIT_MESSAGE_GENERATION":
            if (state.generation.status !== "idle") return state;
            return {
                ...state,
                generation: {
                    status: "requested",
                    requestId: action.requestId,
                    snapshot: action.snapshot,
                },
            };
        case "COMMIT_MESSAGE_GENERATION_EVENT":
            if (
                state.generation.status === "idle" ||
                state.generation.requestId !== action.requestId
            ) {
                return state;
            }
            return applyGenerationEvent(state, action);
        case "SET_AMEND_BRANCH_COMMITS":
            if (!state.isAmend) return state;
            return {
                ...state,
                amendBranchCommits: action.commits,
                amendBranchHistoryLoaded: true,
            };
    }
}
