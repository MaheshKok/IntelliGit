// Typed message protocol for communication between the commit graph webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { Branch, Commit, CommitDetail } from "../../types";

export const BRANCH_ACTION_VALUES = [
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

export const COMMIT_ACTION_VALUES = [
    "copyRevision",
    "createPatch",
    "cherryPick",
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

export type BranchAction = (typeof BRANCH_ACTION_VALUES)[number];
export type CommitAction = (typeof COMMIT_ACTION_VALUES)[number];

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
    | { type: "commitAction"; action: CommitAction; hash: string };

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
    | { type: "setSelectedBranch"; branch: string | null }
    | { type: "setCommitDetail"; detail: CommitDetail }
    | { type: "clearCommitDetail" };
