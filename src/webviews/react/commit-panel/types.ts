// React reducer and tree types for the commit panel app.

import type {
    AmendBranchCommitSummary,
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
import type {
    TreeFolder as GenericTreeFolder,
    TreeLeaf as GenericTreeLeaf,
} from "../shared/fileTree";

export type { InboundMessage, OutboundMessage } from "../../protocol/commitPanelMessages";

/**
 * Reducer state for the commit panel app.
 *
 * The extension host owns the working-tree, stash, icon-theme, and upstream
 * status snapshots. The React panel owns transient commit-draft, amend, and
 * refresh state so UI interactions can stay responsive while host messages are
 * in flight.
 */
interface CommitPanelState {
    files: WorkingFile[];
    stashes: StashEntry[];
    stashFiles: WorkingFile[];
    selectedStashIndex: number | null;
    shelves: ShelfEntry[];
    catalogGeneration: number;
    selectedShelfId: string | null;
    shelfRemoveOnUnshelve: boolean;
    shelfHealth: import("../../protocol/commitPanelMessages").ShelfHealthWarning[];
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
    /** False until the host responds to `getAmendBranchCommits` for the current amend session. */
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
    error: string | null;
    currentBranchHasUpstream: boolean;
    hasRemotes: boolean;
    currentBranchAhead: number;
    currentBranchBehind: number;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
    /** Optional additive operation snapshot; undefined means an older host supplied no classification. */
    activeOperation?: "none" | "merge" | "cherry-pick" | "revert" | "rebase";
    /** Present only when the host classified the active operation as a rebase. */
    rebaseControl?: "owned" | "unowned" | "foreign";
}

/** Summary row supplied by the extension host for a known Git repository. */
export interface CommitPanelRepositorySummary {
    root: string;
    label: string;
    /** Native Git classification supplied by static repository-list hydration. */
    kind: "repository" | "worktree";
    changedFileCount: number;
}

/** Transient, root-scoped lifecycle state for one host commit-message generation request. */
interface CommitMessageGenerationState {
    status: "idle" | "requested" | "running";
    /** Host correlation token while a request is active. */
    requestId?: string;
    /** Draft captured before the host clears the editor at the `start` lifecycle event. */
    snapshot?: string;
}

/** Commit-panel state for one repository row in the docked multi-repository view. */
export interface RepositoryCommitPanelState extends CommitPanelState {
    root: string;
    label: string;
    /** Native Git classification retained across repository snapshot updates. */
    kind: "repository" | "worktree";
    changedFileCount: number;
    /** Lifecycle for the only generation request this repository row may own at once. */
    generation: CommitMessageGenerationState;
    /** Whether this repository has a reachable HEAD commit, as reported by the host. */
    hasCommits: boolean;
    /** Whether a whole-index operation currently fences a new generation request. */
    wholeIndexOperationInProgress: boolean;
}

/** Root commit-panel state keyed by repository root. */
export interface MultiRepositoryCommitPanelState {
    repositories: RepositoryCommitPanelState[];
    activeRepositoryRoot: string | null;
    expandedRepositoryRoots: string[];
}

/**
 * Actions dispatched by host messages and commit-panel UI events.
 *
 * Host-sourced updates replace repository snapshots, while local actions keep
 * the commit message and amend mode coherent until the extension confirms a
 * commit, refresh, or amend-history response.
 */
export type CommitPanelAction =
    | {
          type: "SET_REPOSITORIES";
          repositories: CommitPanelRepositorySummary[];
          activeRepositoryRoot: string | null;
      }
    | { type: "SET_EXPANDED_REPOSITORIES"; repositoryRoots: string[] }
    | {
          type: "SET_FILES_AND_STASHES";
          repositoryRoot?: string;
          repositoryLabel?: string;
          changedFileCount?: number;
          files: WorkingFile[];
          stashes: StashEntry[];
          stashFiles: WorkingFile[];
          selectedStashIndex: number | null;
          shelves: ShelfEntry[];
          catalogGeneration: number;
          selectedShelfId: string | null;
          shelfRemoveOnUnshelve: boolean;
          shelfHealth: import("../../protocol/commitPanelMessages").ShelfHealthWarning[];
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
          activeOperation?: "none" | "merge" | "cherry-pick" | "revert" | "rebase";
          rebaseControl?: "owned" | "unowned" | "foreign";
          hasCommits?: boolean;
          wholeIndexOperationInProgress?: boolean;
          refreshing?: boolean;
          error?: string | null;
      }
    | { type: "RESTORE_COMMIT_DRAFT"; repositoryRoot?: string; message: string }
    | { type: "SET_LAST_COMMIT_MESSAGE"; repositoryRoot?: string; message: string }
    | { type: "COMMITTED"; repositoryRoot?: string; clearCommitMessage?: boolean }
    | { type: "SET_REFRESHING"; repositoryRoot?: string; active: boolean }
    | { type: "SET_ERROR"; repositoryRoot?: string; message: string }
    | {
          type: "SET_SHELF_MUTATION_OUTCOME";
          repositoryRoot?: string;
          status: ShelfMutationStatus;
          entries: PerEntryResult[];
          requestId: string;
          message?: string;
          shelfId?: string;
          newGeneration?: number;
      }
    | { type: "SET_COMMIT_MESSAGE"; repositoryRoot?: string; message: string }
    | { type: "SET_AMEND"; repositoryRoot?: string; isAmend: boolean }
    | {
          /** Starts a locally initiated request and captures the draft before host messages arrive. */
          type: "REQUEST_COMMIT_MESSAGE_GENERATION";
          repositoryRoot: string;
          requestId: string;
          snapshot: string;
      }
    | {
          /** Applies one host lifecycle event only when its root and request ID match active state. */
          type: "COMMIT_MESSAGE_GENERATION_EVENT";
          repositoryRoot: string;
          requestId: string;
          kind: "start" | "chunk" | "done" | "cancelled" | "error";
          text?: string;
          superseded?: boolean;
      }
    | {
          type: "SET_AMEND_BRANCH_COMMITS";
          repositoryRoot?: string;
          commits: AmendBranchCommitSummary[];
      };

/**
 * Directory node used by grouped commit-panel file trees.
 *
 * `descendantFiles` is derived from the full subtree so folder checkboxes can
 * toggle every nested working-tree path without re-walking child entries at the
 * call site.
 */
export interface TreeNode extends Omit<GenericTreeFolder<WorkingFile>, "children"> {
    children: TreeEntry[];
    descendantFiles: WorkingFile[];
}

/** A leaf file node in the directory tree. */
type TreeFile = GenericTreeLeaf<WorkingFile>;

/** File or directory entry rendered by the commit-panel tree. */
export type TreeEntry = TreeNode | TreeFile;
