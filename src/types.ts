import type { ProviderCiCapabilities } from "./shared/ci/capabilities";

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
    /** True when Git reports this local branch as checked out in any worktree. */
    isCheckedOutInWorktree?: boolean;
    /** Absolute worktree path for the matching checked-out local branch. */
    worktreePath?: string;
    /** True when the matching checked-out worktree is the active repository root. */
    isCurrentWorktree?: boolean;
    /** True when the branch matches the repository's default branch reference. */
    isDefault?: boolean;
    /** Unix commit timestamp for the branch tip, used for stable chronological sorting. */
    committerDate?: number;
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

/** Theme icon pair used when a folder has distinct collapsed and expanded artwork. */
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

/**
 * Whether a check state has not settled yet and is worth re-fetching.
 *
 * `"pending"` means CI is still running. `"none"` covers a just-pushed commit
 * whose checks have not been registered by GitHub yet; it must be re-fetched so
 * the status appears without a manual refresh. All other states are terminal.
 */
export function isPendingCheckState(state: CommitCheckState): boolean {
    return state === "pending" || state === "none";
}

/** One GitHub Checks API or commit-status row shown inside the commit-checks popover. */
export interface CommitCheckItem {
    name: string;
    description: string;
    state: CommitCheckState;
    source: "check-run" | "status";
    url?: string;
    /** Execution identity (check-run id or status context); dedup inside one commit only. */
    id?: string;
    /** Logical check identity across commits (see `logicalCheckId`). */
    logicalId?: string;
}

/** Host-normalized check/status snapshot for one commit hash. */
export interface CommitChecksSnapshot {
    hash: string;
    state: CommitCheckState;
    summary: string;
    items: CommitCheckItem[];
    error?: string;
    /**
     * Host to sign into when this snapshot is `unavailable` because a token is missing
     * or rejected (401/403). Present only when signing in can resolve the failure, so the
     * popover can offer a host-targeted "Sign in" button. Absent for generic network or
     * HTTP errors, terminal states, and GitHub (which uses VS Code's built-in session).
     */
    signInHost?: string;
}

/** Identifier for a supported commit-check host. */
export type ProviderId = "github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server";

/**
 * Execution state of one CI run, job or step; `running` is the only state with a live timer.
 *
 * @public consumed by later CI tab phases.
 */
export type CiState =
    "queued" | "running" | "success" | "failure" | "cancelled" | "skipped" | "neutral" | "unknown";

/**
 * Whether every item of a bounded collection was read. Separate from completion: a
 * finished run can still be shown only in part.
 *
 * @public consumed by later CI tab phases.
 */
export type CiCoverage = "full" | { reason: "pageBound" | "rejectedNext"; shown: number };

/**
 * Progress of the in-memory scan for failed jobs past the page bound; never persisted.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiFailedScan {
    state: "running" | "paused" | "stopped" | "done";
    /** Failed items found past the bound so far. */
    found: number;
    /** Set when `state` is `"stopped"`. */
    error?: string;
}

/**
 * One step of a CI job.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiStep {
    number: number;
    name: string;
    state: CiState;
    startedAt?: string;
    completedAt?: string;
}

/** One CI job (GitHub Actions job, GitLab job, Bitbucket Cloud step). */
export interface CiJob {
    /** Execution id; dedup inside one commit only. */
    id: string;
    /** Logical check identity across commits. */
    logicalId: string;
    /** GitHub only: check-run id parsed from the job's check-run link. */
    checkRunId?: string;
    name: string;
    checkName: string;
    state: CiState;
    url?: string;
    startedAt?: string;
    completedAt?: string;
    attempt?: number;
    steps: CiStep[];
    /** GitHub only, from the check run's `output.annotations_count`. */
    annotationCount?: number;
    optional?: boolean;
    required?: "yes" | "no" | "unknown";
    /** Provider failure text, at most 2 000 characters. */
    failureSummary?: string;
    /** `null` = unknown, `undefined` = not asked. */
    usualDurationMs?: number | null;
}

/** One workflow run or pipeline with its jobs. */
export interface CiRun {
    id: string;
    name: string;
    url?: string;
    state: CiState;
    /** GitHub workflow id; absent for providers without a workflow concept. */
    workflowId?: string;
    event?: string;
    actor?: string;
    ref?: string;
    runNumber?: number;
    attempt?: number;
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    usualDurationMs?: number | null;
    jobs: CiJob[];
    /** Coverage of the jobs/steps collection (page bound or a refused next link). */
    jobsCoverage: CiCoverage;
    /** Present while failed items past the bound are being found. */
    failedScan?: CiFailedScan;
}

/**
 * A check outside the run tree: statuses, third-party checks, Bitbucket Server builds.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiFlatCheck {
    /** Execution identity: check-run id, status context or build key. */
    id?: string;
    logicalId?: string;
    name: string;
    description: string;
    state: CommitCheckState;
    source: "check-run" | "status" | "build";
    url?: string;
    durationMs?: number | null;
    required?: "yes" | "no" | "unknown";
    usualDurationMs?: number | null;
}

/**
 * One attempt of a job on one commit.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiAttempt {
    attempt: number;
    executionId: string;
    state: CiState;
    startedAt?: string;
    completedAt?: string;
}

/**
 * Attempt history of one logical job inside one run.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiAttemptHistory {
    /** GitHub workflow run id; GitLab pipeline id. */
    runId: string;
    logicalId: string;
    /** Chronological, unique by `executionId`. */
    attempts: CiAttempt[];
    coverage: CiCoverage;
}

/** CI detail for one commit, as providers return it and as it is persisted. */
export interface CommitCiDetailData {
    hash: string;
    provider: ProviderId;
    /** No run, job or flat check is queued, running or pending. */
    complete: boolean;
    /** Same aggregate rule as the snapshot (failure wins). */
    outcome: CommitCheckState;
    runs: CiRun[];
    /** Coverage of the run/pipeline list itself. */
    runsCoverage: CiCoverage;
    otherChecks: CiFlatCheck[];
    /** Coverage of the flat check list itself. */
    otherChecksCoverage: CiCoverage;
    requiredStatus?: "known" | "partial" | "unknown";
    attemptHistory?: CiAttemptHistory[];
    error?: string;
    signInHost?: string;
}

/** CI detail as the webview receives it: data plus values attached at read time. */
export interface CommitCiDetail extends CommitCiDetailData {
    /** From the installed provider, never from a cache. */
    capabilities: ProviderCiCapabilities;
    repoKey: string;
    actionFence?: {
        targetId: string;
        action: "rerunFailed" | "rerunJob" | "cancel";
        notSeen: boolean;
    };
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
 * path is staged. Ignored files use status `!` and are never considered staged.
 */
export interface WorkingFile {
    path: string;
    /** Original path paired with a rename or copy destination in porcelain status. */
    sourcePath?: string;
    status: "M" | "A" | "D" | "U" | "?" | "!" | "R" | "C";
    staged: boolean;
    additions: number;
    deletions: number;
    /** Large working trees resolve line counts only for rows requested by the viewport. */
    statsState?: "pending" | "ready" | "unavailable";
    /** Host-owned refresh identity; replies cannot decorate a later status snapshot. */
    statsRevision?: string;
    icon?: ThemeTreeIcon;
}

/** One line of history shown when amending a commit (JetBrains-style context). */
export interface AmendBranchCommitSummary {
    /** Stable commit identity used for list reconciliation; never display in place of `shortHash`. */
    hash: string;
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

/** File state labels provided for each side of a merge-conflict entry. */
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
