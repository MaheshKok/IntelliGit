// Typed message protocol for communication between the commit panel webview
// and the extension host. Defines all inbound and outbound message shapes.

import type {
    AmendBranchCommitSummary,
    StashEntry,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../../types";

/** Messages sent FROM the webview TO the extension host. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "saveCommitDraft"; message: string }
    | { type: "stageFiles"; paths: string[] }
    | { type: "unstageFiles"; paths: string[] }
    | { type: "commitSelected"; paths: string[]; message: string; amend: boolean; push: boolean }
    | { type: "commit"; message: string; amend: boolean }
    | { type: "commitAndPush"; message: string; amend: boolean }
    | { type: "publishBranch" }
    | { type: "getLastCommitMessage" }
    | { type: "getAmendBranchCommits" }
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
          currentBranchHasUpstream?: boolean;
      }
    | { type: "restoreCommitDraft"; message: string }
    | { type: "lastCommitMessage"; message: string }
    | { type: "amendBranchCommits"; commits: AmendBranchCommitSummary[] }
    | { type: "committed" }
    | { type: "refreshing"; active: boolean }
    | { type: "error"; message: string };
