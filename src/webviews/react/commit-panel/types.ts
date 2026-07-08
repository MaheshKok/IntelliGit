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
}

/** Summary row supplied by the extension host for a known Git repository. */
export interface CommitPanelRepositorySummary {
    root: string;
    label: string;
    changedFileCount: number;
}

/** Commit-panel state for one repository row in the docked multi-repository view. */
export interface RepositoryCommitPanelState extends CommitPanelState {
    root: string;
    label: string;
    changedFileCount: number;
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
          refreshing?: boolean;
          error?: string | null;
      }
    | { type: "RESTORE_COMMIT_DRAFT"; repositoryRoot?: string; message: string }
    | { type: "SET_LAST_COMMIT_MESSAGE"; repositoryRoot?: string; message: string }
    | { type: "COMMITTED"; repositoryRoot?: string }
    | { type: "SET_REFRESHING"; repositoryRoot?: string; active: boolean }
    | { type: "SET_ERROR"; repositoryRoot?: string; message: string }
    | { type: "SET_COMMIT_MESSAGE"; repositoryRoot?: string; message: string }
    | { type: "SET_AMEND"; repositoryRoot?: string; isAmend: boolean }
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
