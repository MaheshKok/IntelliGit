// Typed message protocol for communication between the commit graph webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { Branch, Commit } from "../../types";

export type BranchAction =
    | "checkout"
    | "newBranchFrom"
    | "checkoutAndRebase"
    | "rebaseCurrentOnto"
    | "mergeIntoCurrent"
    | "updateBranch"
    | "pushBranch"
    | "renameBranch"
    | "deleteBranch";

export type CommitAction =
    | "copyRevision"
    | "createPatch"
    | "cherryPick"
    | "checkoutMain"
    | "checkoutRevision"
    | "resetCurrentToHere"
    | "revertCommit"
    | "undoCommit"
    | "editCommitMessage"
    | "dropCommit"
    | "interactiveRebaseFromHere"
    | "newBranch"
    | "newTag";

export const BRANCH_ACTION_VALUES: readonly BranchAction[] = [
    "checkout",
    "newBranchFrom",
    "checkoutAndRebase",
    "rebaseCurrentOnto",
    "mergeIntoCurrent",
    "updateBranch",
    "pushBranch",
    "renameBranch",
    "deleteBranch",
] as const;

export const COMMIT_ACTION_VALUES: readonly CommitAction[] = [
    "copyRevision",
    "createPatch",
    "cherryPick",
    "checkoutMain",
    "checkoutRevision",
    "resetCurrentToHere",
    "revertCommit",
    "undoCommit",
    "editCommitMessage",
    "dropCommit",
    "interactiveRebaseFromHere",
    "newBranch",
    "newTag",
] as const;

export function isBranchAction(value: string): value is BranchAction {
    return BRANCH_ACTION_VALUES.includes(value as BranchAction);
}

export function isCommitAction(value: string): value is CommitAction {
    return COMMIT_ACTION_VALUES.includes(value as CommitAction);
}

/** Messages sent FROM the webview TO the extension host. */
export type CommitGraphOutbound =
    | { type: "ready" }
    | { type: "selectCommit"; hash: string }
    | { type: "filterText"; text: string }
    | { type: "loadMore" }
    | { type: "filterBranch"; branch: string | null }
    | { type: "branchAction"; action: BranchAction; branchName: string }
    | { type: "commitAction"; action: CommitAction; hash: string; targetBranch?: string };

/** Messages sent FROM the extension host TO the webview. */
export type CommitGraphInbound =
    | {
          type: "loadCommits";
          commits: Commit[];
          hasMore: boolean;
          append: boolean;
          unpushedHashes: string[];
      }
    | { type: "setBranches"; branches: Branch[] }
    | { type: "setSelectedBranch"; branch: string | null };
