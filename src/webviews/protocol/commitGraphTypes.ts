// Typed message protocol for communication between the commit graph webview
// and the extension host. Defines all inbound and outbound message shapes.

import type {
    Branch,
    Commit,
    CommitChecksSnapshot,
    CommitDetail,
    GitWorktree,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";

/**
 * Branch context-menu action discriminants accepted from graph webviews.
 *
 * These values are forwarded as `intelligit.${action}` command suffixes after
 * the host validates the selected branch still exists, so each value must stay
 * aligned with the branch menu producer and registered VS Code command IDs.
 */
export const BRANCH_ACTION_VALUES = [
    "openWorktree",
    "createWorktreeFromBranch",
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

/**
 * Commit context-menu action discriminants accepted from graph webviews.
 *
 * Unlike branch actions, these values are dispatched through
 * `handleCommitContextAction` rather than composed into command IDs. Keep this
 * list in sync with commit menu items and the host-side exhaustive dispatcher.
 */
export const COMMIT_ACTION_VALUES = [
    "copyRevision",
    "createPatch",
    "cherryPick",
    "checkoutRevision",
    "resetCurrentToHere",
    "revertCommit",
    "pushAllUpToHere",
    "undoCommit",
    "editCommitMessage",
    "squashCommits",
    "dropCommit",
    "interactiveRebaseFromHere",
    "newBranch",
    "newTag",
] as const;

/** Worktree row action discriminants accepted from graph webviews. */
const WORKTREE_ACTION_VALUES = ["open", "delete", "lock", "unlock", "move"] as const;

/** Action value sent by branch context menus and accepted by host branch routing. */
export type BranchAction = (typeof BRANCH_ACTION_VALUES)[number];

/** Action value sent by commit context menus and accepted by host commit routing. */
export type CommitAction = (typeof COMMIT_ACTION_VALUES)[number];

/** Action value sent by worktree context menus and accepted by host worktree routing. */
export type WorktreeAction = (typeof WORKTREE_ACTION_VALUES)[number];

/** Repository transport operation sent by graph sidebar controls. */
export type GraphGitOperation = "fetch" | "pull" | "push" | "sync";

/**
 * Narrows untrusted branch action strings before they cross into VS Code command dispatch.
 */
export function isBranchAction(value: string): value is BranchAction {
    return BRANCH_ACTION_VALUES.includes(value as BranchAction);
}

/**
 * Narrows untrusted commit action strings before they cross into Git-mutating handlers.
 */
export function isCommitAction(value: string): value is CommitAction {
    return COMMIT_ACTION_VALUES.includes(value as CommitAction);
}

/** Narrows untrusted worktree action strings before VS Code command dispatch. */
export function isWorktreeAction(value: string): value is WorktreeAction {
    return WORKTREE_ACTION_VALUES.includes(value as WorktreeAction);
}

/**
 * Commit graph messages sent from a webview to the extension host.
 *
 * The sender may be the dedicated graph webview, the compact graph embedded in
 * the commit panel, or the graph section inside the undocked webview. Treat all
 * hash, branch, and path payloads as webview input; hosts validate hashes and
 * repository-relative paths before firing events or invoking Git.
 */
export type CommitGraphOutbound =
    | {
          /** Lifecycle event requesting initial branch, graph, and detail state. */
          type: "ready";
      }
    | {
          /** Selection event for the commit whose detail panes should be loaded. */
          type: "selectCommit";
          /** Full Git object ID from `Commit.hash`; stable across graph refreshes. */
          hash: string;
      }
    | {
          /** Search request that resets graph pagination and re-runs `git log`. */
          type: "filterText";
          /** Literal grep text supplied by the UI; the host passes it to Git as fixed text. */
          text: string;
      }
    | {
          /** Pagination request for the next `git log` page using the current filters. */
          type: "loadMore";
      }
    | {
          /** Branch-filter request that resets text search and graph pagination. */
          type: "filterBranch";
          /** Git branch display/action name from `Branch.name`, or `null` for all branches. */
          branch: string | null;
      }
    | {
          /** Command requesting a branch context-menu action on the host side. */
          type: "branchAction";
          /** Validated against `BRANCH_ACTION_VALUES` before command dispatch. */
          action: BranchAction;
          /** Git branch action name from the latest branch list; host ignores missing branches. */
          branchName: string;
      }
    | {
          /** Command requesting deletion of command/ctrl-selected branch rows. */
          type: "deleteBranches";
          /** Validated branch names from the latest branch list before command dispatch. */
          branchNames: string[];
      }
    | {
          /** Command requesting a worktree row action on the host side. */
          type: "worktreeAction";
          /** Validated against `WORKTREE_ACTION_VALUES` before command dispatch. */
          action: WorktreeAction;
          /** Absolute worktree path from the latest trusted host snapshot. */
          path: string;
      }
    | {
          /** Command requesting a commit context-menu action on the host side. */
          type: "commitAction";
          /** Validated against `COMMIT_ACTION_VALUES` before Git action dispatch. */
          action: CommitAction;
          /** Full Git object ID for the targeted commit; host validates before dispatch. */
          hash: string;
      }
    | {
          /** Command asking the host to open a committed file diff. */
          type: "openCommitFileDiff";
          /** Full Git object ID from the rendered commit detail. */
          commitHash: string;
          /** Repository-relative file path from Git diff output; host validates before use. */
          filePath: string;
      }
    | {
          /** Request for GitHub check runs and commit statuses for one commit. */
          type: "requestCommitChecks";
          /** Full Git object ID from the rendered commit row. */
          hash: string;
      }
    | {
          /** Request to open a GitHub check/status target URL outside the webview. */
          type: "openCommitCheckUrl";
          /** HTTP(S) target URL returned by GitHub. */
          url: string;
      }
    | {
          /** Command fetching remote refs without changing the current working tree. */
          type: "fetch";
      }
    | {
          /** Command pulling the current branch with rebase semantics. */
          type: "pull";
      }
    | {
          /** Command pushing the current branch to its upstream. */
          type: "push";
      }
    | {
          /** Command pulling the current branch and then pushing it. */
          type: "sync";
      };

/**
 * Commit graph messages sent from the extension host to graph-capable webviews.
 *
 * Payloads are JSON-serializable snapshots produced from Git output and icon
 * theme resolution. Optional icon fields are omitted when the active file icon
 * theme cannot provide a serializable webview-safe resource or glyph payload.
 */
export type CommitGraphInbound =
    | {
          /** Response/update containing a page of `git log` commits. */
          type: "loadCommits";
          /** Commits parsed from Git log output; use `hash`, not row position, as the stable key. */
          commits: Commit[];
          /** Page-size heuristic indicating another `loadMore` request may return more commits. */
          hasMore: boolean;
          /** `false` replaces the current graph; `true` appends to the existing page list. */
          append: boolean;
          /** Full hashes from `git rev-list --branches --not --remotes` used for display badges. */
          unpushedHashes: string[];
      }
    | {
          /** State update carrying branch data and optional folder icon theme metadata. */
          type: "setBranches";
          /** Branches parsed from `git branch -a`; names are display and action identifiers. */
          branches: Branch[];
          /** Worktrees parsed from `git worktree list --porcelain -z` for branch navigation. */
          worktrees?: GitWorktree[];
          /** Default collapsed folder icon for branch tree groups when the theme resolves one. */
          folderIcon?: ThemeTreeIcon;
          /** Default expanded folder icon for branch tree groups when the theme resolves one. */
          folderExpandedIcon?: ThemeTreeIcon;
          /** Named folder icon overrides keyed by file-icon-theme folder name. */
          folderIconsByName?: ThemeFolderIconMap;
          /** Webview-safe font-face payloads needed to render glyph-based theme icons. */
          iconFonts?: ThemeIconFont[];
          /**
           * Whether the current branch has an upstream; absent producers are treated as
           * `true` so older payloads do not incorrectly disable remote Git actions.
           */
          currentBranchHasUpstream?: boolean;
          /** Whether the repository has at least one configured remote for fetch operations. */
          hasRemotes?: boolean;
          /** Number of commits the current branch is ahead of its upstream, when known. */
          currentBranchAhead?: number;
          /** Number of commits the current branch is behind its upstream, when known. */
          currentBranchBehind?: number;
      }
    | {
          /** State update echoing the branch filter that the host accepted. */
          type: "setSelectedBranch";
          /** Accepted Git branch name, or `null` when the filter was cleared or became stale. */
          branch: string | null;
      }
    | {
          /** State update containing the currently selected commit detail. */
          type: "setCommitDetail";
          /** Git `show`/`diff-tree` detail snapshot; `detail.hash` is the stable action ID. */
          detail: CommitDetail;
          /** Default collapsed folder icon for commit file paths when available. */
          folderIcon?: ThemeTreeIcon;
          /** Default expanded folder icon for commit file paths when available. */
          folderExpandedIcon?: ThemeTreeIcon;
          /** Folder icon overrides for paths inside `detail.files`, keyed by folder name. */
          folderIconsByName?: ThemeFolderIconMap;
          /** Webview-safe font-face payloads needed to render glyph-based file icons. */
          iconFonts?: ThemeIconFont[];
      }
    | {
          /** Event clearing commit detail panes after branch/filter changes or no selection. */
          type: "clearCommitDetail";
      }
    | {
          /** Response for a failed Git log request; graph panes may clear stale rows. */
          type: "loadError";
          /** User-visible error text normalized by the host. */
          message: string;
      }
    | {
          /** General host error event for graph-side commands and theme refresh work. */
          type: "error";
          /** User-visible error text normalized by the host. */
          message: string;
      }
    | {
          /** GitHub check/status data for one commit hash. */
          type: "setCommitChecks";
          /** Normalized snapshot keyed by `snapshot.hash`. */
          snapshot: CommitChecksSnapshot;
      };
