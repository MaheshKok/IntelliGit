// Typed message protocol for communication between the commit panel webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { WorkingFile, StashEntry } from "../../../types";

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
    | { type: "stashSave"; name: string; paths?: string[] }
    | { type: "stashPop"; index: number }
    | { type: "stashApply"; index: number }
    | { type: "stashDrop"; index: number }
    | { type: "openFile"; path: string }
    | { type: "deleteFile"; path: string }
    | { type: "showHistory"; path: string };

/** Messages sent FROM the extension host TO the webview. */
export type InboundMessage =
    | { type: "update"; files: WorkingFile[]; stashes: StashEntry[] }
    | { type: "lastCommitMessage"; message: string }
    | { type: "committed" }
    | { type: "error"; message: string };

/** Reducer state for the commit panel app. */
export interface CommitPanelState {
    files: WorkingFile[];
    stashes: StashEntry[];
    commitMessage: string;
    isAmend: boolean;
    error: string | null;
}

/** Actions dispatched by the message handler and UI events. */
export type CommitPanelAction =
    | { type: "SET_FILES_AND_STASHES"; files: WorkingFile[]; stashes: StashEntry[] }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED" }
    | { type: "SET_ERROR"; message: string }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean };

/** A node in the directory tree used for grouped file display. */
export interface TreeNode {
    type: "folder";
    name: string;
    path: string;
    children: TreeEntry[];
}

/** A leaf file node in the directory tree. */
export interface TreeFile {
    type: "file";
    file: WorkingFile;
}

export type TreeEntry = TreeNode | TreeFile;
