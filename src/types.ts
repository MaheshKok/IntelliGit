/**
 * Git branch metadata shared by extension-host services and webview branch renderers.
 *
 * The branch name is the display/action name accepted by Git commands. Remote-only
 * branches set `isRemote` and may omit `remote` when the upstream cannot be parsed
 * from Git's branch listing output.
 */
export interface Branch {
    name: string;
    hash: string;
    isRemote: boolean;
    isCurrent: boolean;
    upstream?: string;
    remote?: string;
    ahead: number;
    behind: number;
}

/** Lifecycle state of a Git worktree as reported by `git worktree list --porcelain`. */
export type WorktreeState = "main" | "linked" | "bare" | "detached";

/**
 * One Git worktree parsed from `git worktree list --porcelain -z`.
 *
 * `path` is absolute. `branch` is the short branch name with the `refs/heads/`
 * prefix stripped, or null when the worktree is detached or bare.
 */
export interface GitWorktree {
    path: string;
    head: string | null;
    branch: string | null;
    state: WorktreeState;
    /** True for Git's first reported record, even when that worktree is detached. */
    isMain: boolean;
    isCurrent: boolean;
    isLocked: boolean;
    lockedReason?: string;
    isPrunable: boolean;
    prunableReason?: string;
}

/**
 * Resolved icon payload that can be rendered inside VS Code webviews.
 *
 * A URI points to a webview-safe image resource, while glyph metadata mirrors icon
 * fonts from the active file icon theme. Consumers should prefer `uri` when present
 * and fall back to glyph rendering only when image data is unavailable.
 */
export interface ThemeTreeIcon {
    uri?: string;
    glyph?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    fontStyle?: string;
}

interface ThemeNamedFolderIcon {
    collapsed?: ThemeTreeIcon;
    expanded?: ThemeTreeIcon;
}

/**
 * Maps file-icon-theme folder names to their collapsed and expanded webview icons.
 */
export type ThemeFolderIconMap = Record<string, ThemeNamedFolderIcon>;

/**
 * Font-face descriptor extracted from the active file icon theme for webview use.
 *
 * The extension host resolves the source path before sending it across the webview
 * boundary so React code can inject CSS without touching local filesystem paths.
 */
export interface ThemeIconFont {
    fontFamily: string;
    src: string;
    format?: string;
    weight?: string;
    style?: string;
}

/**
 * Compact commit row used by graph, history, and branch-aware webview lists.
 *
 * `hash` remains the stable action identifier; `shortHash` and `refs` are display
 * metadata parsed from Git output and should not be used as unique keys.
 */
export interface Commit {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    email: string;
    date: string;
    parentHashes: string[];
    refs: string[];
}

/** Normalized GitHub check/status state rendered by commit graph rows. */
export type CommitCheckState =
    | "success"
    | "failure"
    | "pending"
    | "skipped"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "unknown"
    | "none"
    | "unavailable";

/** One GitHub Checks API or commit-status row shown inside the commit-checks popover. */
export interface CommitCheckItem {
    name: string;
    description: string;
    state: CommitCheckState;
    source: "check-run" | "status";
    url?: string;
}

/** Host-normalized check/status snapshot for one commit hash. */
export interface CommitChecksSnapshot {
    hash: string;
    state: CommitCheckState;
    summary: string;
    items: CommitCheckItem[];
    error?: string;
}

/**
 * Per-file change summary for a committed revision.
 *
 * Status codes follow Git numstat/name-status semantics and may include rename or
 * copy entries where `path` is the post-change display path.
 */
export interface CommitFile {
    path: string;
    status: "A" | "M" | "D" | "R" | "C" | "T";
    additions: number;
    deletions: number;
    icon?: ThemeTreeIcon;
}

/**
 * Full commit detail payload sent to panes that render metadata and changed files.
 *
 * The file list is already normalized for webview display; consumers should request
 * fresh details by `hash` rather than mutating this payload when a repository changes.
 */
export interface CommitDetail {
    hash: string;
    shortHash: string;
    message: string;
    body: string;
    author: string;
    email: string;
    date: string;
    parentHashes: string[];
    refs: string[];
    files: CommitFile[];
}

/**
 * Working-tree file state shared between the extension host and commit panel.
 *
 * Paths are repository-relative action identifiers. `staged` describes whether the
 * entry came from the index side of Git status, not whether every change for that
 * path is staged.
 */
export interface WorkingFile {
    path: string;
    status: "M" | "A" | "D" | "U" | "?" | "R" | "C";
    staged: boolean;
    additions: number;
    deletions: number;
    icon?: ThemeTreeIcon;
}

/** One line of history shown when amending a commit (JetBrains-style context). */
export interface AmendBranchCommitSummary {
    shortHash: string;
    subject: string;
    date: string;
}

/**
 * Stash entry metadata parsed from Git's stash list for panel display and actions.
 *
 * The numeric `index` maps to the current `stash@{n}` position, so consumers must
 * refresh before acting if the stash stack may have changed.
 */
export interface StashEntry {
    index: number;
    message: string;
    date: string;
    hash: string;
}

type MergeConflictSideState = "Modified" | "Added" | "Deleted";

/**
 * Conflict entry shown in the merge-conflict session UI.
 *
 * `path` is repository-relative, `code` is the Git status pair, and the side states
 * describe how ours/theirs changed the file so the UI can label accept actions.
 */
export interface MergeConflictFile {
    path: string;
    code: string;
    ours: MergeConflictSideState;
    theirs: MergeConflictSideState;
}
