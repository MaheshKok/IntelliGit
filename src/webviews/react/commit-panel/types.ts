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

/** Reducer state for the commit panel app. */
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
    /** False until the host responds to `getAmendBranchCommits` for the current amend session. */
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
    error: string | null;
    currentBranchHasUpstream: boolean;
}

/** Actions dispatched by the message handler and UI events. */
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

/** A node in the directory tree used for grouped file display. */
export interface TreeNode extends Omit<GenericTreeFolder<WorkingFile>, "children"> {
    children: TreeEntry[];
    descendantFiles: WorkingFile[];
}

/** A leaf file node in the directory tree. */
type TreeFile = GenericTreeLeaf<WorkingFile>;

export type TreeEntry = TreeNode | TreeFile;
