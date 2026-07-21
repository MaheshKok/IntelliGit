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
 * Optional repository selector for webview commands that operate on Git or repository files.
 *
 * Rootless messages remain valid during the single-repository UI transition; when present, the
 * extension host must reject roots that are not in its current repository runtime map.
 */
type RepositoryScopedMessage<T extends { type: string }> = T & {
    /** Absolute repository root originally supplied by host repository hydration. */
    repositoryRoot?: string;
};

/** Optional repository identity attached to host messages derived from a repository runtime. */
type RepositoryIdentifiedMessage<T extends { type: string }> = T & {
    /** Absolute repository root for the runtime that produced this payload. */
    repositoryRoot?: string;
};

/** Minimal repository identity sent from the extension host to the commit-panel webview. */
interface CommitPanelRepositorySummary {
    /** Absolute filesystem path to the Git repository root. */
    root: string;
    /** Stable display label for repository pickers and headings. */
    label: string;
    /** Last-known non-ignored changed-file count for collapsed repository rows. */
    changedFileCount: number;
}

/** Full host-side snapshot for one commit-panel repository runtime. */
export interface CommitPanelRepositorySnapshot {
    /** Absolute filesystem path to the Git repository root that produced this snapshot. */
    repositoryRoot?: string;
    /** Stable display label for repository rows. */
    repositoryLabel?: string;
    /** Last-known non-ignored unique changed-file count for this repository. */
    changedFileCount?: number;
    /** Working-tree and index entries parsed from `git status` and numstat output. */
    files: WorkingFile[];
    /** Stashed changes parsed from `git stash list`; indices are not stable after refresh. */
    stashes: StashEntry[];
    /** Files for `selectedStashIndex`, parsed from `git stash show` output. */
    stashFiles: WorkingFile[];
    /** Selected `stash@{n}` index, or `null` when no stash entry is available. */
    selectedStashIndex: number | null;
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
    /** Whether this repository is currently running a host refresh. */
    refreshing?: boolean;
    /** Last repository-scoped refresh error, or `null` when the latest snapshot is healthy. */
    error?: string | null;
}

/**
 * Commit panel messages sent from the webview to the extension host.
 *
 * Commands that carry paths use repository-relative Git paths originally
 * supplied in `WorkingFile.path` or stashed file entries. The host treats every
 * path and stash index as untrusted webview input and revalidates before Git or
 * filesystem operations.
 */
export type OutboundMessage =
    | {
          /** Lifecycle event requesting working-tree, stash, graph, and draft state. */
          type: "ready";
      }
    | RepositoryScopedMessage<{
          /** User event requesting a fresh working-tree and stash snapshot. */
          type: "refresh";
      }>
    | {
          /** Repository accordion state sent by the webview so the host can watch expanded rows. */
          type: "setExpandedRepositories";
          /** Absolute repository roots that are currently expanded in the docked commit panel. */
          repositoryRoots: string[];
      }
    | RepositoryScopedMessage<{
          /** Command aborting the active merge after host confirmation. */
          type: "abortMerge";
      }>
    | RepositoryScopedMessage<{
          /** View option controlling whether ignored files are included in working-tree snapshots. */
          type: "setShowIgnoredFiles";
          /** True asks the host to include `git status --ignored` rows; false restores the default. */
          showIgnoredFiles: boolean;
      }>
    | RepositoryScopedMessage<{
          /** Command fetching remote refs without changing the current working tree. */
          type: "fetch";
      }>
    | RepositoryScopedMessage<{
          /** Command pulling the current branch with rebase semantics. */
          type: "pull";
      }>
    | RepositoryScopedMessage<{
          /** Command pushing the current branch to its upstream. */
          type: "push";
      }>
    | RepositoryScopedMessage<{
          /** Command pulling the current branch and then pushing it. */
          type: "sync";
      }>
    | RepositoryScopedMessage<{
          /** Persistence event storing the commit message draft in workspace state. */
          type: "saveCommitDraft";
          /** Plain commit message text scoped by repository root; empty text clears storage. */
          message: string;
      }>
    | RepositoryScopedMessage<{
          /** Command staging selected working-tree files. */
          type: "stageFiles";
          /** Repository-relative paths from `WorkingFile.path`; empty arrays are a no-op. */
          paths: string[];
      }>
    | RepositoryScopedMessage<{
          /** Command unstaging selected index entries. */
          type: "unstageFiles";
          /** Repository-relative paths from `WorkingFile.path`; empty arrays are a no-op. */
          paths: string[];
      }>
    | RepositoryScopedMessage<{
          /** Command marking selected unversioned paths as intent-to-add. */
          type: "trackUnversionedFiles";
          /** Repository-relative unversioned paths from `WorkingFile.path`; host revalidates status. */
          paths: string[];
      }>
    | RepositoryScopedMessage<{
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
      }>
    | RepositoryScopedMessage<{
          /** Command committing currently staged changes without staging panel selections first. */
          type: "commit";
          /** Commit message after UI trimming; the host allows empty text only while amending. */
          message: string;
          /** Whether the host should run the commit as an amend operation. */
          amend: boolean;
      }>
    | RepositoryScopedMessage<{
          /** Command committing currently staged changes and then pushing. */
          type: "commitAndPush";
          /** Commit message after UI trimming; the host allows empty text only while amending. */
          message: string;
          /** Whether the host should run the commit as an amend operation. */
          amend: boolean;
      }>
    | RepositoryScopedMessage<{
          /** Command delegating publish-branch setup to the extension host. */
          type: "publishBranch";
      }>
    | RepositoryScopedMessage<{
          /** Request for the latest commit message used to prefill amend text. */
          type: "getLastCommitMessage";
      }>
    | RepositoryScopedMessage<{
          /** Request for branch-local history shown as amend context. */
          type: "getAmendBranchCommits";
      }>
    | RepositoryScopedMessage<{
          /** Command rolling back selected paths, or all changes when no path is selected. */
          type: "rollback";
          /** Repository-relative paths from `WorkingFile.path`; empty means rollback all. */
          paths: string[];
      }>
    | RepositoryScopedMessage<{
          /** Command opening the VS Code working-tree diff for a selected file. */
          type: "showDiff";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }>
    | RepositoryScopedMessage<{
          /** Command saving selected or all changes to the Git stash. */
          type: "stashSave";
          /** Optional stash message; host defaults to a generic stash name when absent. */
          name?: string;
          /** Repository-relative paths to stash; omitted means stash all tracked/untracked changes. */
          paths?: string[];
      }>
    | RepositoryScopedMessage<{
          /** Command applying and dropping a stashed change via `git stash pop`. */
          type: "stashPop";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
      }>
    | RepositoryScopedMessage<{
          /** Command applying a stashed change without dropping it. */
          type: "stashApply";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
      }>
    | RepositoryScopedMessage<{
          /** Command deleting a stashed change after host confirmation. */
          type: "stashDelete";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
          /** Optional correlation token echoed when host-side mutation handling finishes. */
          requestId?: string;
      }>
    | RepositoryScopedMessage<{
          /** Typed unstash command targeting the current branch. */
          type: "stashUnstash";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
          /** Current-branch mode permits apply or pop behavior. */
          mode: "currentBranch";
          /** Whether to keep the stash entry after restoring it. */
          action: "apply" | "pop";
          /** Whether Git must restore the stash's index state with `--index`. */
          reinstateIndex: boolean;
          /** Optional correlation token echoed when host-side mutation handling finishes. */
          requestId?: string;
      }>
    | RepositoryScopedMessage<{
          /** Typed unstash command restoring the stash on a new branch. */
          type: "stashUnstash";
          /** Current `stash@{n}` index from `StashEntry.index`; unstable after stash mutations. */
          index: number;
          /** Branch mode always lets `git stash branch` restore the index and drop on success. */
          mode: "branch";
          /** New local branch name, revalidated by the host and Git boundary. */
          branchName: string;
          /** Optional correlation token echoed when host-side mutation handling finishes. */
          requestId?: string;
      }>
    | RepositoryScopedMessage<{
          /** Command permanently clearing every stash after host confirmation. */
          type: "stashClear";
          /** Optional correlation token echoed when host-side mutation handling finishes. */
          requestId?: string;
      }>
    | RepositoryScopedMessage<{
          /** Request loading the file list for one stashed change. */
          type: "stashSelect";
          /** Current `stash@{n}` index whose files should populate `stashFiles`. */
          index: number;
      }>
    | RepositoryScopedMessage<{
          /** Command opening a diff for one stash file, or every file when `path` is absent. */
          type: "showStashDiff";
          /** Current `stash@{n}` index containing the file. */
          index: number;
          /** Optional repository-relative path from the selected stash file list. */
          path?: string;
          /** Preview defaults to true; false requests a persistent editor tab. */
          preview?: boolean;
      }>
    | RepositoryScopedMessage<{
          /** Command opening a working-tree file in the editor. */
          type: "openFile";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }>
    | RepositoryScopedMessage<{
          /** Command deleting a working-tree file after host confirmation. */
          type: "deleteFile";
          /** Repository-relative path from the working-tree snapshot. */
          path: string;
      }>;

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
          /** Repository list hydration for host-owned multi-repository state. */
          type: "setRepositories";
          /** Discovered repositories known to the host, in display order. */
          repositories: CommitPanelRepositorySummary[];
          /** Active host repository root, or `null` when no repository is selected. */
          activeRepositoryRoot: string | null;
      }
    | ({
          /** State update for working-tree files, stashes, and render-only icon metadata. */
          type: "update";
      } & CommitPanelRepositorySnapshot)
    | RepositoryIdentifiedMessage<{
          /** State update restoring the repository-scoped commit draft from workspace state. */
          type: "restoreCommitDraft";
          /** Plain draft text; empty string means no saved draft. */
          message: string;
      }>
    | RepositoryIdentifiedMessage<{
          /** Response to `getLastCommitMessage` for amend prefill. */
          type: "lastCommitMessage";
          /** Full body from `git log -1 --format=%B`, or empty string when unavailable. */
          message: string;
      }>
    | RepositoryIdentifiedMessage<{
          /** Response to `getAmendBranchCommits` for amend context display. */
          type: "amendBranchCommits";
          /** Git log summaries from upstream-to-HEAD when possible, otherwise recent HEAD history. */
          commits: AmendBranchCommitSummary[];
      }>
    | RepositoryIdentifiedMessage<{
          /** Event indicating a commit completed and the webview should clear committed state. */
          type: "committed";
      }>
    | RepositoryIdentifiedMessage<{
          /** Event acknowledging that a correlated stash mutation attempt has fully finished. */
          type: "stashMutationCompleted";
          /** Correlation token supplied by the initiating webview request. */
          requestId: string;
      }>
    | RepositoryIdentifiedMessage<{
          /** Status event toggling refresh affordances while host refresh work is active. */
          type: "refreshing";
          /** `true` starts visible refresh feedback; `false` clears it after host completion. */
          active: boolean;
      }>
    | {
          /** Accepted graph text filter mirrored back to graph UI state. */
          type: "setFilterText";
          /** Text filter currently owned by the extension host. */
          text: string;
      }
    | RepositoryIdentifiedMessage<{
          /** General or repository-scoped host error event for commit-panel commands. */
          type: "error";
          /** User-visible error text normalized by the host. */
          message: string;
      }>;
