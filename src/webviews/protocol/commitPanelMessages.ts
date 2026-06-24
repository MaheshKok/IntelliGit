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

/**
 * Commit panel messages sent from the webview to the extension host.
 *
 * Commands that carry paths use repository-relative Git paths originally
 * supplied in `WorkingFile.path` or shelved file entries. The host treats every
 * path and stash index as untrusted webview input and revalidates before Git or
 * filesystem operations.
 */
export type OutboundMessage =
    | {
          /** Lifecycle event requesting working-tree, shelf, graph, and draft state. */
          type: "ready";
      }
    | {
          /** User event requesting a fresh working-tree and shelf snapshot. */
          type: "refresh";
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
      }
    | {
          /** Persistence event storing the commit message draft in workspace state. */
          type: "saveCommitDraft";
          /** Plain commit message text scoped by repository root; empty text clears storage. */
          message: string;
      }
    | {
          /** Command staging selected working-tree files. */
          type: "stageFiles";
          /** Repository-relative paths from `WorkingFile.path`; empty arrays are a no-op. */
          paths: string[];
      }
    | {
          /** Command unstaging selected index entries. */
          type: "unstageFiles";
          /** Repository-relative paths from `WorkingFile.path`; empty arrays are a no-op. */
          paths: string[];
      }
    | {
          /** Command marking selected unversioned paths as intent-to-add. */
          type: "trackUnversionedFiles";
          /** Repository-relative unversioned paths from `WorkingFile.path`; host revalidates status. */
          paths: string[];
      }
    | {
          /** Command staging selected paths and then committing, optionally pushing. */
          type: "commitSelected";
          /** Repository-relative paths to stage before commit; empty is valid only for amend. */
          paths: string[];
          /** Commit message after UI trimming; the host allows empty text only while amending. */
          message: string;
          /** Whether the host should run the commit as an amend operation. */
          amend: boolean;
          /** Whether a successful commit should be followed by a push. */
          push: boolean;
      }
    | {
          /** Command committing currently staged changes without staging panel selections first. */
          type: "commit";
          /** Commit message after UI trimming; the host allows empty text only while amending. */
          message: string;
          /** Whether the host should run the commit as an amend operation. */
          amend: boolean;
      }
    | {
          /** Command committing currently staged changes and then pushing. */
          type: "commitAndPush";
          /** Commit message after UI trimming; the host allows empty text only while amending. */
          message: string;
          /** Whether the host should run the commit as an amend operation. */
          amend: boolean;
      }
    | {
          /** Command delegating publish-branch setup to the extension host. */
          type: "publishBranch";
      }
    | {
          /** Request for the latest commit message used to prefill amend text. */
          type: "getLastCommitMessage";
      }
    | {
          /** Request for branch-local history shown as amend context. */
          type: "getAmendBranchCommits";
      }
    | {
          /** Command rolling back selected paths, or all changes when no path is selected. */
          type: "rollback";
          /** Repository-relative paths from `WorkingFile.path`; empty means rollback all. */
          paths: string[];
      }
    | {
          /** Command opening the VS Code working-tree diff for a selected file. */
          type: "showDiff";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }
    | {
          /** Command saving selected or all changes to Git stash-backed IntelliGit shelf. */
          type: "shelveSave";
          /** Optional stash message; host defaults to a generic shelf name when absent. */
          name?: string;
          /** Repository-relative paths to shelve; omitted means shelve all tracked/untracked changes. */
          paths?: string[];
      }
    | {
          /** Command applying and dropping a shelved change via `git stash pop`. */
          type: "shelfPop";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
      }
    | {
          /** Command applying a shelved change without dropping it. */
          type: "shelfApply";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
      }
    | {
          /** Command deleting a shelved change after host confirmation. */
          type: "shelfDelete";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
      }
    | {
          /** Request loading the file list for one shelved change. */
          type: "shelfSelect";
          /** Current `stash@{n}` index whose files should populate `shelfFiles`. */
          index: number;
      }
    | {
          /** Command opening a preview diff for one file inside a shelved change. */
          type: "showShelfDiff";
          /** Current `stash@{n}` index containing the file. */
          index: number;
          /** Repository-relative path from the selected shelf file list. */
          path: string;
      }
    | {
          /** Command opening a working-tree file in the editor. */
          type: "openFile";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }
    | {
          /** Command deleting a working-tree file after host confirmation. */
          type: "deleteFile";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }
    | {
          /** Command opening a text view of Git history for a working-tree file. */
          type: "showHistory";
          /** Repository-relative path passed to `git log --follow`. */
          path: string;
      };

/**
 * Commit panel messages sent from the extension host to the webview.
 *
 * State payloads are JSON-serializable snapshots derived from Git status, stash
 * output, workspace-state drafts, and icon theme resolution. Optional icon and
 * upstream fields preserve compatibility when a producer cannot resolve that
 * data for the current view.
 */
export type InboundMessage =
    | {
          /** State update for working-tree files, shelves, and render-only icon metadata. */
          type: "update";
          /** Working-tree and index entries parsed from `git status` and numstat output. */
          files: WorkingFile[];
          /** Shelved changes parsed from `git stash list`; indices are not stable after refresh. */
          stashes: StashEntry[];
          /** Files for `selectedShelfIndex`, parsed from `git stash show` output. */
          shelfFiles: WorkingFile[];
          /** Selected `stash@{n}` index, or `null` when no shelf entry is available. */
          selectedShelfIndex: number | null;
          /** Default collapsed folder icon for file trees when the theme resolves one. */
          folderIcon?: ThemeTreeIcon;
          /** Default expanded folder icon for file trees when the theme resolves one. */
          folderExpandedIcon?: ThemeTreeIcon;
          /** Folder icon overrides keyed by file-icon-theme folder name. */
          folderIconsByName?: ThemeFolderIconMap;
          /** Webview-safe font-face payloads needed to render glyph-based file icons. */
          iconFonts?: ThemeIconFont[];
          /**
           * Whether the current branch has an upstream; absent producers are treated as
           * `true` so older payloads do not incorrectly switch the UI to Publish Branch.
           */
          currentBranchHasUpstream?: boolean;
          /** Whether the repository has at least one configured remote for fetch operations. */
          hasRemotes?: boolean;
          /** Number of commits the current branch is ahead of its upstream, when known. */
          currentBranchAhead?: number;
          /** Number of commits the current branch is behind its upstream, when known. */
          currentBranchBehind?: number;
          /** Current local branch name, when the repository is not detached. */
          currentBranchName?: string | null;
          /** Current branch upstream tracking ref, when configured. */
          currentBranchUpstream?: string | null;
      }
    | {
          /** State update restoring the repository-scoped commit draft from workspace state. */
          type: "restoreCommitDraft";
          /** Plain draft text; empty string means no saved draft. */
          message: string;
      }
    | {
          /** Response to `getLastCommitMessage` for amend prefill. */
          type: "lastCommitMessage";
          /** Full body from `git log -1 --format=%B`, or empty string when unavailable. */
          message: string;
      }
    | {
          /** Response to `getAmendBranchCommits` for amend context display. */
          type: "amendBranchCommits";
          /** Git log summaries from upstream-to-HEAD when possible, otherwise recent HEAD history. */
          commits: AmendBranchCommitSummary[];
      }
    | {
          /** Event indicating a commit completed and the webview should clear committed state. */
          type: "committed";
      }
    | {
          /** Status event toggling refresh affordances while host refresh work is active. */
          type: "refreshing";
          /** `true` starts visible refresh feedback; `false` clears it after host completion. */
          active: boolean;
      }
    | {
          /** General host error event for commit-panel commands. */
          type: "error";
          /** User-visible error text normalized by the host. */
          message: string;
      };
