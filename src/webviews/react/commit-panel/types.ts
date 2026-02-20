// Typed message protocol for communication between the commit panel webview
// and the extension host. Defines all inbound and outbound message shapes.

import type {
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
    StashEntry,
} from "../../../types";
import type {
    TreeFolder as GenericTreeFolder,
    TreeLeaf as GenericTreeLeaf,
} from "../shared/fileTree";

/** Messages sent FROM the webview TO the extension host. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "stageFiles"; paths: string[] }
    | { type: "unstageFiles"; paths: string[] }
    | { type: "commitSelected"; paths: string[]; message: string; amend: boolean; push: boolean }
    | { type: "commit"; message: string; amend: boolean }
    | { type: "commitAndPush"; message: string; amend: boolean }
    | { type: "getLastCommitMessage" }
    | { type: "rollback"; paths: string[] }
    | { type: "showDiff"; path: string }
    | { type: "shelveSave"; name?: string; paths?: string[] }
    | { type: "shelfPop"; index: number }
    | { type: "shelfApply"; index: number }
    | { type: "shelfDelete"; index: number }
    | { type: "shelfSelect"; index: number }
    | { type: "showShelfDiff"; index: number; path: string }
    | { type: "openFile"; path: string }
    | { type: "deleteFile"; path: string }
    | { type: "showHistory"; path: string };

/** Messages sent FROM the extension host TO the webview. */
export type InboundMessage =
    | {
          type: "update";
          files: WorkingFile[];
          stashes: StashEntry[];
          shelfFiles: WorkingFile[];
          selectedShelfIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "lastCommitMessage"; message: string }
    | { type: "committed" }
    | { type: "refreshing"; active: boolean }
    | { type: "error"; message: string };

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
    isRefreshing: boolean;
    error: string | null;
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
      }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED" }
    | { type: "SET_REFRESHING"; active: boolean }
    | { type: "SET_ERROR"; message: string }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean };

/** A node in the directory tree used for grouped file display. */
export interface TreeNode extends Omit<GenericTreeFolder<WorkingFile>, "children"> {
    children: TreeEntry[];
    descendantFiles: WorkingFile[];
}

/** A leaf file node in the directory tree. */
export type TreeFile = GenericTreeLeaf<WorkingFile>;

export type TreeEntry = TreeNode | TreeFile;
