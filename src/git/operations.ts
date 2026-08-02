import {
    access,
    copyFile,
    lstat,
    mkdtemp,
    readFile,
    readlink,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEmptyTreeOid } from "./emptyTree";
import { GitExecutor } from "./executor";
import { resolveGitDir } from "./gitDirectory";
import {
    WHOLE_INDEX_OPERATION_MARKERS,
    type WholeIndexOperationMarker,
} from "./wholeIndexOperationWatcher";
import type {
    Branch,
    Commit,
    CommitDetail,
    CommitFile,
    WorkingFile,
    StashEntry,
    MergeConflictFile,
    AmendBranchCommitSummary,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import {
    assertValidBranchName,
    assertValidRemoteName,
    isValidBranchName,
    isValidRemoteName,
} from "../utils/gitRefs";
import {
    assertRepoRelativeGitPath,
    assertStashIndex,
    commitStatsUnavailableMessage,
    getVsCodeApi,
    logGitOpsWarning,
    stagedStatsUnavailableMessage,
    unstagedStatsUnavailableMessage,
} from "./operationSupport";
import {
    AMEND_BRANCH_COMMIT_FORMAT,
    COMMIT_DETAIL_FORMAT,
    COMMIT_LOG_FORMAT,
    isUnmergedConflictCode,
    mapCommitFileStatus,
    mapConflictSideState,
    parseAmendBranchCommitSummaries,
    parseCommitDetail,
    parseCommitLog,
    parseFileHistoryEntries,
    parseStashEntries,
} from "./parsers";
import {
    applyNumstatToWorkingFiles,
    parseAlreadyStagedDeletedPaths,
    parseWorkingTreeStatus,
    planRollbackFiles,
} from "./workingTree";
import { parseStashFiles } from "./stashFiles";
import { normalizeGitNumstatPath } from "./numstat";
import { applyPatchTextToRepo } from "./patchApplication";
import { EMPTY_TREE_HASH } from "../utils/constants";

type BranchRow = [
    refname: string,
    name: string,
    hash: string,
    upstream: string,
    track: string,
    head: string,
    symref: string,
    committerDateRaw: string,
];

type BranchRowFormat = [
    refname: "%(refname)",
    name: "%(refname:short)",
    hash: "%(objectname:short)",
    upstream: "%(upstream:short)",
    track: "%(upstream:track,nobracket)",
    head: "%(HEAD)",
    symref: "%(symref:short)",
    committerDateRaw: "%(committerdate:unix)",
];

/** The whole-index Git operation currently controlling continue and abort behavior. */
export type ActiveOperationKind = "none" | "merge" | "cherry-pick" | "revert" | "rebase";

const BRANCH_ROW_FORMAT: BranchRowFormat = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname:short)",
    "%(upstream:short)",
    "%(upstream:track,nobracket)",
    "%(HEAD)",
    "%(symref:short)",
    "%(committerdate:unix)",
];

type DefaultBranchRefs = {
    defaultRemoteRefs: Set<string>;
    remotesWithDefault: Set<string>;
    defaultLocalNames: Set<string>;
};

/** Maximum patch bytes retained for one tracked file or the HEAD amend patch. */
const DIFF_PER_FILE_BYTE_LIMIT = 64 * 1024;
/** Maximum patch bytes retained across tracked, untracked, and amend sources. */
const DIFF_CUMULATIVE_BYTE_LIMIT = 256 * 1024;
/** Maximum bytes read from an untracked file before it is summarized. */
const UNTRACKED_READ_BYTE_LIMIT = 64 * 1024;
/** Limits literal pathspec batches so the numstat pre-pass cannot exceed the OS argument limit. */
const DIFF_NUMSTAT_PATH_BATCH_SIZE = 200;
/**
 * Upper bound on a Git object ID's hex length across both formats Git supports today (`sha1`
 * defaults to 40 hex chars, `sha256` to 64). A same-length placeholder objectId of this length
 * lets a synthesized symlink-add diff be sized *before* spawning `hash-object`: if it fits the
 * remaining budget at this worst-case length, the real (equal-or-shorter) hash is guaranteed to
 * fit too, so the subprocess is only ever spawned when its result will actually be used.
 */
const SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH = 64;

type DiffNumstat = {
    added: number;
    deleted: number;
    binary: boolean;
};

/** Structural information accompanying the bounded patch text supplied to a later prompt builder. */
export interface DiffForPathsResult {
    diff: string;
    summarizedPaths: string[];
    truncated: boolean;
}

/** Controls optional patch sources for selected-path diff assembly. */
export interface GetDiffForPathsOptions {
    includeHead?: boolean;
    /**
     * Immutable, already-validated status for this request's selection boundary.
     *
     * When supplied, this snapshot is authoritative for rename expansion and untracked-file
     * classification, so `getDiffForPaths` does not perform a later status read that could observe
     * a different working-tree state.
     */
    readonly validatedStatusSnapshot?: readonly WorkingFile[];
}

/**
 * Raised when an amend request has no available HEAD patch source.
 *
 * @public consumed by later host wiring that maps typed diff-assembly failures to user-facing messages.
 */
export class UnbornHeadDiffError extends Error {
    /** Creates the typed refusal used when no amend patch source exists. */
    constructor() {
        super("Cannot assemble an amend diff for an unborn HEAD.");
        this.name = "UnbornHeadDiffError";
    }
}

/** Splits Git's tab-delimited branch output into non-empty rows for later validation. */
function parseBranchRows(result: string): BranchRow[] {
    return result
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line): BranchRow => {
            const [
                refname = "",
                name = "",
                hash = "",
                upstream = "",
                track = "",
                head = "",
                symref = "",
                committerDateRaw = "",
            ] = line.split("\t");
            return [refname, name, hash, upstream, track, head, symref, committerDateRaw];
        });
}

/** Returns a valid remote/default-branch pair only when a symbolic HEAD targets its own remote. */
function getSymbolicRemoteDefault(refname: string, symref: string | undefined) {
    const headMatch = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(refname);
    const targetMatch = symref && isValidBranchName(symref) ? /^([^/]+)\/(.+)$/.exec(symref) : null;
    if (!headMatch || !targetMatch) return undefined;

    const [, headRemote] = headMatch;
    const [, targetRemote, localName] = targetMatch;
    if (
        headRemote !== targetRemote ||
        !isValidRemoteName(headRemote) ||
        !isValidBranchName(localName)
    ) {
        return undefined;
    }

    return { remote: headRemote, localName, remoteRef: targetMatch[0] };
}

/** Collects validated remote HEAD targets used to mark local and remote default branches. */
function collectDefaultBranchRefs(rows: BranchRow[]): DefaultBranchRefs {
    const defaultRemoteRefs = new Set<string>();
    const remotesWithDefault = new Set<string>();
    const defaultLocalNames = new Set<string>();

    for (const [refname, , , , , , symref] of rows) {
        const target = getSymbolicRemoteDefault(refname, symref);
        if (!target) continue;

        defaultRemoteRefs.add(target.remoteRef);
        remotesWithDefault.add(target.remote);
        defaultLocalNames.add(target.localName);
    }

    return { defaultRemoteRefs, remotesWithDefault, defaultLocalNames };
}

/** Extracts a valid remote name from a remote branch name or local branch upstream. */
function getRemoteName(ref: string | undefined): string | undefined {
    const remote = ref?.split("/")[0];
    return remote && isValidRemoteName(remote) ? remote : undefined;
}

/** Applies Git's conventional main/master fallback only when a remote has no symbolic default. */
function isRemoteDefaultBranch(
    name: string,
    remote: string | undefined,
    defaults: DefaultBranchRefs,
): boolean {
    return (
        defaults.defaultRemoteRefs.has(name) ||
        (remote !== undefined &&
            !defaults.remotesWithDefault.has(remote) &&
            (name === `${remote}/main` || name === `${remote}/master`))
    );
}

/** Applies the local main/master fallback only when no symbolic remote default was reported. */
function isLocalDefaultBranch(name: string, defaults: DefaultBranchRefs): boolean {
    return (
        defaults.defaultLocalNames.has(name) ||
        (defaults.defaultLocalNames.size === 0 && (name === "main" || name === "master"))
    );
}

/** Parses optional Git upstream tracking text into zero-based ahead and behind counts. */
function parseTrackingCounts(track: string | undefined): { ahead: number; behind: number } {
    return {
        ahead: Number(track?.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(track?.match(/behind (\d+)/)?.[1] ?? 0),
    };
}

/** Builds one public branch record or discards symbolic and invalid branch rows. */
function toBranch(row: BranchRow, defaults: DefaultBranchRefs): Branch | undefined {
    const [refname, name, hash, upstream, track, head, , committerDateRaw] = row;
    if (refname.endsWith("/HEAD") || !isValidBranchName(name)) return undefined;

    const isRemote = refname.startsWith("refs/remotes/");
    const remote = getRemoteName(isRemote ? name : upstream);
    if (isRemote && !remote) return undefined;

    const trimmedCommitterDate = committerDateRaw?.trim();
    const committerDate = trimmedCommitterDate ? Number(trimmedCommitterDate) : undefined;
    const { ahead, behind } = parseTrackingCounts(track);
    const isDefault = isRemote
        ? isRemoteDefaultBranch(name, remote, defaults)
        : isLocalDefaultBranch(name, defaults);

    return {
        name,
        hash,
        isRemote,
        isCurrent: head === "*",
        isDefault: isDefault || undefined,
        committerDate:
            committerDate !== undefined && Number.isFinite(committerDate)
                ? committerDate
                : undefined,
        upstream: upstream || undefined,
        remote,
        ahead,
        behind,
    };
}

type ConfirmSetUpstreamPush = (remote: string, branch: string) => Promise<boolean>;
/**
 * Signals that the user declined IntelliGit's prompt to create upstream tracking before push.
 */
export class UpstreamPushDeclinedError extends Error {
    /** Creates the user-declined push error with a stable error name for callers. */
    constructor() {
        super("Upstream push declined by user");
        this.name = "UpstreamPushDeclinedError";
    }
}
/**
 * High-level Git facade used by commands, providers, and webview refresh flows.
 *
 * Methods delegate to GitExecutor, validate branch/remote/path inputs before shelling out where
 * needed, and convert selected Git failures into fallback values or user-facing warnings.
 */
export class GitOps {
    /**
     * Creates a Git operation facade around an executor rooted at the active repository.
     *
     * The optional upstream confirmation callback lets UI callers decide whether push may mutate
     * branch tracking with `git push --set-upstream`.
     */
    constructor(
        private readonly executor: GitExecutor,
        private readonly confirmSetUpstreamPush?: ConfirmSetUpstreamPush,
    ) {}
    /**
     * Creates a facade for another repository root whose executor shares this
     * facade's mutation gate, keeping multi-repository mutations serialized.
     */
    deriveFor(repoRoot: string): GitOps {
        return new GitOps(this.executor.deriveFor(repoRoot), this.confirmSetUpstreamPush);
    }
    /** Resolves Git-reported root, worktree Git directory, and shared common Git directory. */
    async getGitDirectories(): Promise<{ root: string; gitDir: string; commonDir: string }> {
        const [gitDir, commonDir, repoRoot] = await Promise.all([
            this.executor.run(["rev-parse", "--git-dir"]),
            this.executor.run(["rev-parse", "--git-common-dir"]),
            this.executor.run(["rev-parse", "--show-toplevel"]),
        ]);
        const root = path.resolve(repoRoot.trim());
        return {
            root,
            gitDir: path.resolve(root, gitDir.trim()),
            commonDir: path.resolve(root, commonDir.trim()),
        };
    }
    /** Initializes a Git repository at the supplied filesystem path and returns Git output. */
    async init(repoPath: string): Promise<string> {
        const executor = new GitExecutor(repoPath);
        return executor.run(["init"]);
    }
    /** Returns whether the executor root is inside a Git work tree, swallowing probe failures. */
    async isRepository(): Promise<boolean> {
        try {
            const out = await this.executor.run(["rev-parse", "--is-inside-work-tree"]);
            return out.trim() === "true";
        } catch {
            return false;
        }
    }
    /** Returns whether HEAD has at least one reachable commit, treating empty repositories as false. */
    async hasAnyCommits(): Promise<boolean> {
        try {
            const out = await this.executor.run(["rev-list", "--count", "HEAD"]);
            return parseInt(out.trim(), 10) > 0;
        } catch {
            return false;
        }
    }
    /**
     * Reads up to ten subject lines reachable from the current HEAD for commit-message style context.
     *
     * Unlike getLog, this deliberately excludes unrelated refs and avoids spawning Git for an unborn HEAD.
     */
    async getRecentCommitSubjects(): Promise<string[]> {
        if (!(await this.hasAnyCommits())) return [];
        const output = await this.executor.run(["log", "--format=%s", "-n", "10"]);
        const subjects = output.split(/\r?\n/);
        if (subjects.at(-1) === "") subjects.pop();
        return subjects.slice(0, 10);
    }
    /** Lists configured remotes after filtering invalid remote names and falling back to an empty list. */
    async getRemotes(): Promise<string[]> {
        try {
            const out = await this.executor.run(["remote"]);
            return out
                .trim()
                .split("\n")
                .map((r) => r.trim())
                .filter(isValidRemoteName);
        } catch {
            return [];
        }
    }

    /** Reads a validated remote URL so host services can inspect provider metadata. */
    async getRemoteUrl(remote: string): Promise<string | null> {
        assertValidRemoteName(remote);
        try {
            const out = await this.executor.run(["remote", "get-url", remote]);
            return out.trim() || null;
        } catch {
            return null;
        }
    }

    /** Checks whether a validated local branch resolves to a distinct upstream tracking ref. */
    async branchHasUpstream(branch: string): Promise<boolean> {
        try {
            assertValidBranchName(branch);
            const out = await this.executor.run([
                "rev-parse",
                "--abbrev-ref",
                `${branch}@{upstream}`,
            ]);
            return out.trim().length > 0 && out.trim() !== branch;
        } catch {
            return false;
        }
    }
    /** Adds a validated remote name using the caller-provided URL without transforming credentials. */
    async addRemote(name: string, url: string): Promise<void> {
        assertValidRemoteName(name);
        await this.executor.run(["remote", "add", name, url]);
    }
    /** Removes a validated remote name from repository configuration. */
    async removeRemote(name: string): Promise<void> {
        assertValidRemoteName(name);
        await this.executor.run(["remote", "remove", name]);
    }
    /** Pushes a validated branch to a validated remote branch while creating upstream tracking. */
    async pushWithUpstream(remote: string, branch: string, remoteBranch = branch): Promise<string> {
        assertValidRemoteName(remote);
        assertValidBranchName(branch);
        assertValidBranchName(remoteBranch, "remote branch name");
        const ref = remoteBranch === branch ? branch : `${branch}:${remoteBranch}`;
        return this.executor.run(["push", "-u", remote, ref]);
    }
    /** Resolves the absolute repository root reported by Git for the executor's current work tree. */
    async getRepositoryRoot(): Promise<string> {
        const root = await this.executor.run(["rev-parse", "--show-toplevel"]);
        return root.trim();
    }
    /**
     * Reads local and remote branch metadata from Git's formatted branch output.
     *
     * Symbolic remote HEAD refs and invalid branch or remote names are discarded; ahead/behind counts
     * come from Git's upstream tracking text when available.
     */
    async getBranches(): Promise<Branch[]> {
        const result = await this.executor.run([
            "branch",
            "-a",
            `--format=${BRANCH_ROW_FORMAT.join("\t")}`,
        ]);
        const rows = parseBranchRows(result);
        const defaults = collectDefaultBranchRefs(rows);
        return rows
            .map((row) => toBranch(row, defaults))
            .filter((branch): branch is Branch => !!branch);
    }
    /**
     * Loads commit summaries from all refs or a validated branch, optionally using a literal grep filter.
     *
     * Branch names are passed after `--end-of-options`; filter text uses fixed-string grep to avoid
     * treating user input as a regular expression.
     */
    async getLog(
        maxCount: number = 500,
        branch?: string,
        filterText?: string,
        skip: number = 0,
    ): Promise<Commit[]> {
        const args = [
            "log",
            "-z",
            `--max-count=${maxCount}`,
            `--pretty=format:${COMMIT_LOG_FORMAT}`,
        ];
        if (skip > 0) {
            args.push(`--skip=${skip}`);
        }
        if (filterText) {
            // Use --fixed-strings to treat the filter as a literal string,
            // preventing ReDoS via git's regex engine on user input.
            args.push(`--grep=${filterText}`, "-i", "--fixed-strings");
        }
        if (branch) {
            if (!isValidBranchName(branch)) {
                throw new Error("Invalid branch filter received for git log.");
            }
            args.push("--end-of-options", branch);
        } else {
            args.push("--all");
        }
        const result = await this.executor.run(args);
        return parseCommitLog(result);
    }
    /** Lists commits reachable from local branches but not from any remote-tracking ref. */
    async getUnpushedCommitHashes(): Promise<string[]> {
        try {
            // Commits reachable from local branches but not from any remote-tracking ref.
            // This works even when the current branch has no upstream configured.
            const out = await this.executor.run(["rev-list", "--branches", "--not", "--remotes"]);
            // Git output parsing is small and clearer as trim/split/map/filter.
            // react-doctor-disable-next-line react-doctor/js-flatmap-filter
            return out
                .trim()
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }
    /**
     * Loads commit metadata and changed-file stats for a commit hash.
     *
     * Name/status output is authoritative for file presence, while numstat augments additions and
     * deletions; numstat failures are downgraded to warnings so details still render.
     */
    async getCommitDetail(hash: string): Promise<CommitDetail> {
        const info = await this.executor.run([
            "show",
            `--format=${COMMIT_DETAIL_FORMAT}`,
            "--no-patch",
            hash,
        ]);
        const filesByPath = new Map<string, CommitFile>();
        const upsertFile = (path: string, status: CommitFile["status"]): CommitFile => {
            const existing = filesByPath.get(path);
            if (existing) {
                // Prefer more specific status if we already inserted a fallback.
                if (existing.status === "M" && status !== "M") {
                    const updated = { ...existing, status };
                    filesByPath.set(path, updated);
                    return updated;
                }
                return existing;
            }
            const created: CommitFile = {
                path,
                status,
                additions: 0,
                deletions: 0,
            };
            filesByPath.set(path, created);
            return created;
        };
        const nameStatus = await this.executor.run([
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-m",
            "--name-status",
            hash,
        ]);
        for (const line of nameStatus.trim().split("\n")) {
            if (!line.trim()) continue;
            const cols = line.split("\t");
            if (cols.length >= 2) {
                const rawCode = cols[0].charAt(0);
                const status: CommitFile["status"] = mapCommitFileStatus(rawCode);
                const isRenameOrCopy = status === "R" || status === "C";
                const path = isRenameOrCopy && cols.length >= 3 ? cols[2] : cols[cols.length - 1];
                upsertFile(path, status);
            }
        }
        try {
            const numstat = await this.executor.run([
                "diff-tree",
                "--no-commit-id",
                "-r",
                "-m",
                "--numstat",
                hash,
            ]);
            for (const line of numstat.trim().split("\n")) {
                if (!line.trim()) continue;
                const cols = line.split("\t");
                if (cols.length < 3) continue;
                const add = cols[0];
                const del = cols[1];
                const filePath = normalizeGitNumstatPath(cols[cols.length - 1]);
                const file = upsertFile(filePath, "M");
                const parsedAdd = add === "-" ? 0 : parseInt(add);
                const parsedDel = del === "-" ? 0 : parseInt(del);
                const newAdd = Math.max(file.additions, Number.isNaN(parsedAdd) ? 0 : parsedAdd);
                const newDel = Math.max(file.deletions, Number.isNaN(parsedDel) ? 0 : parsedDel);
                if (newAdd !== file.additions || newDel !== file.deletions) {
                    const updated = { ...file, additions: newAdd, deletions: newDel };
                    filesByPath.set(filePath, updated);
                }
            }
        } catch (err) {
            logGitOpsWarning("Failed to get commit numstat", err, {
                userWarningMessage: commitStatsUnavailableMessage(),
            });
        }
        return parseCommitDetail(info, hash, Array.from(filesByPath.values()));
    }
    // --- Working tree operations ---
    /**
     * Reads porcelain working-tree status and augments staged and unstaged entries with numstat data.
     *
     * Status parsing uses NUL-delimited output for paths, and numstat failures produce warnings rather
     * than blocking the status view. Ignored files are included only when callers opt in because Git
     * can return large ignored directories.
     */
    async getStatus(
        options: { includeIgnored?: boolean; withStats?: boolean } = {},
    ): Promise<WorkingFile[]> {
        const statusArgs = ["status", "--porcelain=v1", "-z", "-uall"];
        if (options.includeIgnored) statusArgs.push("--ignored");
        const result = await this.executor.run(statusArgs);
        const files = parseWorkingTreeStatus(result);
        // Callers that only need the changed-file set (e.g. collapsed multi-repository
        // row counts) pass `withStats: false` to skip the two numstat subprocesses,
        // turning a three-process status into a single one per repository.
        if (options.withStats === false) return files;
        const applyNumstat = (
            output: string,
            staged: boolean,
            label: string,
            userWarningMessage: string,
        ): void => {
            try {
                applyNumstatToWorkingFiles(files, output, staged);
            } catch (err) {
                logGitOpsWarning(`Failed to get ${label} numstat`, err, { userWarningMessage });
            }
        };
        // Fetch unstaged and staged numstat in parallel
        const [unstagedStat, stagedStat] = await Promise.all([
            this.executor.run(["diff", "--numstat"]).catch((err) => {
                logGitOpsWarning("Failed to get unstaged numstat", err, {
                    userWarningMessage: unstagedStatsUnavailableMessage(),
                });
                return "";
            }),
            this.executor.run(["diff", "--cached", "--numstat"]).catch((err) => {
                logGitOpsWarning("Failed to get staged numstat", err, {
                    userWarningMessage: stagedStatsUnavailableMessage(),
                });
                return "";
            }),
        ]);
        applyNumstat(unstagedStat, false, "unstaged", unstagedStatsUnavailableMessage());
        applyNumstat(stagedStat, true, "staged", stagedStatsUnavailableMessage());
        return files;
    }

    /** Returns whether porcelain status reports any working-tree entry without loading numstat. */
    async hasUncommittedChanges(): Promise<boolean> {
        const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        return result.length > 0;
    }

    /**
     * Returns whether Git requires the current repository index to be committed as a whole.
     *
     * The marker probe resolves linked-worktree `gitdir:` files before checking merge, sequencer,
     * and rebase state. It reads the filesystem on every call so callers never act on stale state.
     */
    async hasWholeIndexOperationInProgress(): Promise<boolean> {
        return (await this.presentOperationMarkers()).size > 0;
    }

    /**
     * Returns the controlling whole-index operation from the watcher marker set without caching.
     *
     * Rebase wins over merge, then cherry-pick, then revert because the controlling operation is
     * the one whose continue or abort command the user must run: a rebase replaying a merge-like
     * step remains a rebase. `abortMerge` dispatches in this same order for that reason.
     */
    async getActiveOperation(): Promise<ActiveOperationKind> {
        const present = await this.presentOperationMarkers();
        if (present.has("rebase-merge") || present.has("rebase-apply")) return "rebase";
        if (present.has("MERGE_HEAD")) return "merge";
        if (present.has("CHERRY_PICK_HEAD")) return "cherry-pick";
        if (present.has("REVERT_HEAD")) return "revert";
        return "none";
    }

    /**
     * Probes every whole-index marker once, resolving linked-worktree `gitdir:` files first.
     *
     * Membership is returned by name rather than by position so the shared marker list can gain or
     * reorder entries without silently rebinding a caller's reading of the result.
     */
    private async presentOperationMarkers(): Promise<Set<WholeIndexOperationMarker>> {
        const gitDir = resolveGitDir(await this.getRepositoryRoot());
        const probed = await Promise.all(
            WHOLE_INDEX_OPERATION_MARKERS.map(async (marker) =>
                (await pathExists(path.join(gitDir, marker))) ? marker : undefined,
            ),
        );
        return new Set(probed.filter((marker) => marker !== undefined));
    }

    /**
     * Assembles the selected working-tree and optional amend patches under strict byte budgets.
     *
     * Rename sources come from the caller's validated snapshot or one fresh porcelain snapshot,
     * and every Git command that receives selected paths enables literal pathspecs before
     * acquiring bounded output.
     */
    async getDiffForPaths(
        paths: string[],
        options: GetDiffForPathsOptions = {},
    ): Promise<DiffForPathsResult> {
        const selectedPaths = new Set(paths);
        const statusSnapshot =
            options.validatedStatusSnapshot ?? (await this.getStatus({ withStats: false }));
        const renameSources = new Map<string, string>();
        const untrackedPaths = new Set<string>();
        for (const file of statusSnapshot) {
            if (!selectedPaths.has(file.path)) continue;
            if (file.status === "R" && file.sourcePath)
                renameSources.set(file.path, file.sourcePath);
            if (file.status === "?") untrackedPaths.add(file.path);
        }
        const expandedPaths = Array.from(new Set([...paths, ...renameSources.values()]));
        const trackedPaths = expandedPaths.filter((filePath) => !untrackedPaths.has(filePath));
        const hasHead = await this.hasAnyCommits();
        if (options.includeHead && !hasHead && paths.length === 0) throw new UnbornHeadDiffError();

        const baseRef = hasHead ? "HEAD" : await this.getEmptyTreeId();
        const numstatByPath = new Map<string, DiffNumstat>();
        for (let start = 0; start < trackedPaths.length; start += DIFF_NUMSTAT_PATH_BATCH_SIZE) {
            const pathBatch = trackedPaths.slice(start, start + DIFF_NUMSTAT_PATH_BATCH_SIZE);
            // Sequential batches preserve Git-process bounds and the cumulative output budget.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const result = await this.executor.runBinary(
                withLiteralPathspecs(["diff", "--numstat", baseRef, "--", ...pathBatch]),
                { maxOutputBytes: DIFF_CUMULATIVE_BYTE_LIMIT },
            );
            for (const [filePath, numstat] of parseDiffNumstat(result.stdout)) {
                numstatByPath.set(filePath, numstat);
            }
        }

        const diffParts: string[] = [];
        const summarizedPaths: string[] = [];
        let usedBytes = 0;
        const addPart = (part: string): void => {
            diffParts.push(part);
            usedBytes += Buffer.byteLength(part);
        };
        const summaryPart = (filePath: string, reason: string, numstat?: DiffNumstat): string => {
            const change = numstat
                ? numstat.binary
                    ? "binary file, "
                    : `+${numstat.added}/-${numstat.deleted} lines, `
                : "";
            return `[Diff omitted for ${filePath}: ${change}${reason}.]\n`;
        };
        const summarize = (filePath: string, reason: string, numstat?: DiffNumstat): void => {
            if (!summarizedPaths.includes(filePath)) summarizedPaths.push(filePath);
            addPart(summaryPart(filePath, reason, numstat));
        };
        const summarizeRemoval = (filePath: string): void => {
            if (!summarizedPaths.includes(filePath)) summarizedPaths.push(filePath);
            addPart(`[${filePath} was removed while assembling the diff.]\n`);
        };
        const acquire = async (
            filePath: string,
            args: string[],
            perSourceLimit: number,
            expectedExitCodes?: readonly number[],
            numstat?: DiffNumstat,
            allowMissingPath: boolean = false,
        ): Promise<void> => {
            const remainingBytes = DIFF_CUMULATIVE_BYTE_LIMIT - usedBytes;
            if (remainingBytes <= 0) {
                summarize(filePath, "cumulative byte budget reached", numstat);
                return;
            }
            const perFileBudgetReason = "per-file byte budget reached";
            const cumulativeBudgetReason = "cumulative byte budget reached";
            const perFileSummaryBytes = Buffer.byteLength(
                summaryPart(filePath, perFileBudgetReason, numstat),
            );
            const budgetReason =
                perSourceLimit <= remainingBytes - perFileSummaryBytes
                    ? perFileBudgetReason
                    : cumulativeBudgetReason;
            const summaryBytes = Buffer.byteLength(summaryPart(filePath, budgetReason, numstat));
            const maxOutputBytes = Math.min(perSourceLimit, remainingBytes - summaryBytes);
            if (maxOutputBytes <= 0) {
                summarize(filePath, "cumulative byte budget reached", numstat);
                return;
            }
            if (!numstat?.binary && numstat && numstat.added + numstat.deleted > maxOutputBytes) {
                summarize(filePath, budgetReason, numstat);
                return;
            }
            let result;
            try {
                result = await this.executor.runBinary(args, {
                    expectedExitCodes,
                    maxOutputBytes,
                });
            } catch (error) {
                if (allowMissingPath && isMissingUntrackedPathError(error)) {
                    summarizeRemoval(filePath);
                    return;
                }
                throw error;
            }
            if (result.truncated) {
                summarize(filePath, budgetReason, numstat);
                return;
            }
            addPart(result.stdout.toString("utf8"));
        };

        for (const filePath of trackedPaths) {
            // Preserve diff ordering and cumulative-byte accounting between paths.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await acquire(
                filePath,
                withLiteralPathspecs([
                    "diff",
                    "--full-index",
                    "--no-color",
                    baseRef,
                    "--",
                    filePath,
                ]),
                DIFF_PER_FILE_BYTE_LIMIT,
                undefined,
                numstatByPath.get(filePath),
            );
        }
        let repoRoot: string | undefined;
        /** Adds an untracked path without allowing Git to follow a symlink target. */
        const acquireUntrackedPath = async (filePath: string): Promise<void> => {
            repoRoot ??= await this.getRepositoryRoot();
            let untrackedStat;
            try {
                untrackedStat = await lstat(path.resolve(repoRoot, filePath));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    summarizeRemoval(filePath);
                    return;
                }
                throw error;
            }
            if (untrackedStat.isSymbolicLink()) {
                let linkTarget: string;
                try {
                    linkTarget = await readlink(path.resolve(repoRoot, filePath));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        summarizeRemoval(filePath);
                        return;
                    }
                    throw error;
                }
                const remainingBytes = DIFF_CUMULATIVE_BYTE_LIMIT - usedBytes;
                const summaryBytes = Buffer.byteLength(
                    summaryPart(filePath, "cumulative byte budget reached"),
                );
                // Size the diff with a worst-case (longest-possible) object ID first so a
                // symlink met once the budget is already spent never pays for a `hash-object`
                // spawn whose output would only be discarded (see SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH).
                const worstCaseDiff = buildSymlinkAddDiff(
                    filePath,
                    linkTarget,
                    "0".repeat(SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH),
                );
                if (Buffer.byteLength(worstCaseDiff) > remainingBytes - summaryBytes) {
                    summarize(filePath, "cumulative byte budget reached");
                    return;
                }
                const objectId = (
                    await this.executor.runBinary(["hash-object", "--stdin"], {
                        input: Buffer.from(linkTarget),
                    })
                ).stdout
                    .toString("utf8")
                    .trim();
                addPart(buildSymlinkAddDiff(filePath, linkTarget, objectId));
                return;
            }
            if (!untrackedStat.isFile()) {
                summarize(filePath, "not a regular file; diff omitted");
                return;
            }
            if (untrackedStat.size > UNTRACKED_READ_BYTE_LIMIT) {
                summarize(
                    filePath,
                    `untracked file is ${untrackedStat.size} bytes, per-file byte budget reached`,
                );
                return;
            }
            await acquire(
                filePath,
                withLiteralPathspecs([
                    "diff",
                    "--no-index",
                    "--full-index",
                    "--no-color",
                    "--",
                    "/dev/null",
                    filePath,
                ]),
                Math.min(DIFF_PER_FILE_BYTE_LIMIT, UNTRACKED_READ_BYTE_LIMIT),
                [0, 1],
                undefined,
                true,
            );
        };
        for (const filePath of untrackedPaths) {
            // Preserve diff ordering and cumulative-byte accounting between paths.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await acquireUntrackedPath(filePath);
        }
        if (options.includeHead && hasHead) {
            await acquire(
                "HEAD",
                withLiteralPathspecs(["show", "--format=", "--no-color", "HEAD"]),
                DIFF_PER_FILE_BYTE_LIMIT,
            );
        }

        return {
            diff: diffParts.join(""),
            summarizedPaths,
            truncated: summarizedPaths.length > 0,
        };
    }

    /** Derives the repository's empty-tree object ID without assuming a SHA-1 object format. */
    private async getEmptyTreeId(): Promise<string> {
        return readEmptyTreeOid(this.executor);
    }

    /** Stages literal repository paths, including selected deletions and rename sources. */
    async stageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const pathsToStage = await this.excludeAlreadyStagedDeletedPaths(paths);
        if (pathsToStage.length === 0) return;
        await this.executor.run(withLiteralPathspecs(["add", "--", ...pathsToStage]));
    }
    /**
     * Marks unversioned literal paths as intent-to-add without staging their content.
     *
     * Git reports these files as unstaged additions (` A`) so the commit panel can move them
     * from Unversioned Files into Changes while preserving the user's ability to review or stage
     * their contents explicitly.
     */
    async intentToAddFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.executor.run(withLiteralPathspecs(["add", "--intent-to-add", "--", ...paths]));
    }
    /** Returns the subset of selected paths that should still be passed to `git add`. */
    private async excludeAlreadyStagedDeletedPaths(paths: string[]): Promise<string[]> {
        const status = await this.executor.run(
            withLiteralPathspecs(["status", "--porcelain=v1", "-z", "--", ...paths]),
        );
        if (!status.trim()) return paths;
        const alreadyStagedDeleted = parseAlreadyStagedDeletedPaths(status);
        return paths.filter((path) => !alreadyStagedDeleted.has(path));
    }
    /** Unstages literal repository paths by resetting them from HEAD. */
    async unstageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.executor.run(withLiteralPathspecs(["reset", "HEAD", "--", ...paths]));
    }
    /**
     * Runs an index-mutating operation while restoring the exact original index on success or failure.
     * The index path is Git-resolved so linked worktrees snapshot their own index rather than a guessed `.git` path.
     * A restore failure is surfaced as a distinct error rather than masking the operation's own
     * outcome: the operation's error (or success) always stays the primary signal.
     */
    async withIndexSnapshot<T>(operation: () => Promise<T>): Promise<T> {
        const repoRoot = await this.getRepositoryRoot();
        const reportedIndexPath = (
            await this.executor.run(["rev-parse", "--git-path", "index"])
        ).trim();
        const indexPath = path.isAbsolute(reportedIndexPath)
            ? reportedIndexPath
            : path.resolve(repoRoot, reportedIndexPath);
        const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "intelligit-index-"));

        try {
            const snapshotPath = path.join(snapshotDirectory, "index");
            await copyFile(indexPath, snapshotPath);

            const outcome = await operation().then(
                (value) => ({ succeeded: true as const, value }),
                (error: unknown) => ({ succeeded: false as const, error }),
            );

            try {
                await this.restoreIndexSnapshot(snapshotPath, indexPath);
            } catch (restoreError) {
                if (!outcome.succeeded) {
                    throw new Error(
                        `The Git operation failed (${getErrorMessage(outcome.error)}), and restoring the Git index snapshot also failed (${getErrorMessage(restoreError)}). The index may be left with the commit's temporary unstaging applied.`,
                        { cause: outcome.error },
                    );
                }
                throw new Error(
                    `The commit succeeded, but restoring the Git index snapshot failed (${getErrorMessage(restoreError)}). The index may be left with the commit's temporary unstaging applied.`,
                    { cause: restoreError },
                );
            }

            if (!outcome.succeeded) throw outcome.error;
            return outcome.value;
        } finally {
            await rm(snapshotDirectory, { recursive: true, force: true });
        }
    }

    /**
     * Restores a snapshotted index atomically: the snapshot is written to an exclusively created
     * `<index>.lock` file and then renamed onto the index, so a concurrent reader such as
     * `git status` never observes a partially written file.
     *
     * An existing `.lock` file means another Git process is currently writing the index; this is
     * retried briefly since that window is normally sub-second. If contention persists past the
     * retry budget, restoring the user's index takes priority over strict atomicity, so this
     * falls back to a direct, non-atomic copy rather than failing the restore outright.
     */
    private async restoreIndexSnapshot(snapshotPath: string, indexPath: string): Promise<void> {
        const lockPath = `${indexPath}.lock`;
        const maxAttempts = 3;
        const retryDelayMs = 50;
        const snapshotBytes = await readFile(snapshotPath);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // Lock creation retries must remain serialized.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                await writeFile(lockPath, snapshotBytes, { flag: "wx" });
            } catch (error) {
                if (!isLockAlreadyExistsError(error)) throw error;
                if (attempt < maxAttempts - 1) {
                    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
                    continue;
                }
                // Lock contention persisted past the retry window, so another Git process is
                // still writing the index. Restoring the user's index takes priority over strict
                // atomicity here, so fall back to a direct copy instead of failing the restore.
                await copyFile(snapshotPath, indexPath);
                return;
            }
            try {
                await rename(lockPath, indexPath);
                return;
            } catch (renameError) {
                await rm(lockPath, { force: true });
                throw renameError;
            }
        }
    }

    /**
     * Creates or amends a commit, limiting panel-owned path requests while preserving whole-index Git states.
     *
     * Omitting `paths` keeps existing callers' bare-commit behavior intact. Passing an empty array for an
     * amend request makes a message-only amend, and a whole-index operation always keeps Git's bare commit.
     */
    async commit(message: string, amend: boolean = false, paths?: string[]): Promise<string> {
        const args = ["commit", "-m", message];
        if (amend) args.push("--amend");
        if (paths === undefined) return this.executor.run(args);
        if (await this.hasWholeIndexOperationInProgress()) return this.executor.run(args);
        if (paths.length > 0) {
            return this.executor.run(withLiteralPathspecs([...args, "--only", "--", ...paths]));
        }
        if (amend) args.push("--only");
        return this.executor.run(args);
    }
    /**
     * Pushes the current branch and optionally prompts to create upstream tracking on no-upstream errors.
     *
     * Remote and branch names are validated before the fallback `--set-upstream` push mutates tracking.
     */
    async push(): Promise<string> {
        const upstreamTarget = await this.resolveCurrentPushTarget();
        if (upstreamTarget && upstreamTarget.remoteBranch !== upstreamTarget.localBranch) {
            return this.executor.run([
                "push",
                upstreamTarget.remote,
                `HEAD:${upstreamTarget.remoteBranch}`,
            ]);
        }
        try {
            return await this.executor.run(["push"]);
        } catch (err) {
            if (!isNoUpstreamPushError(err)) throw err;
            const branch = await this.resolveCurrentBranchNameForPush();
            const remote = await this.resolveDefaultRemoteNameForPush();
            if (!branch || !remote) throw err;
            assertValidBranchName(branch);
            assertValidRemoteName(remote);
            const allowSetUpstream = await this.requestSetUpstreamPush(remote, branch);
            if (!allowSetUpstream) {
                throw new UpstreamPushDeclinedError();
            }
            return this.executor.run(["push", "--set-upstream", remote, branch]);
        }
    }
    /** Pulls the current branch with rebase semantics and returns Git output. */
    async pullRebase(): Promise<string> {
        return this.executor.run(["pull", "--rebase"]);
    }

    /**
     * Fetches remote refs for the current repository without changing local checkout state.
     *
     * The command updates remote-tracking refs under `.git/refs/remotes/*` without modifying
     * the working tree, index, or local branches.
     *
     * @returns Git stdout from `git fetch`.
     * @throws Propagates `GitExecutor` failures when no remote is configured, network or
     * authentication fails, or Git exits with a non-zero status.
     */
    async fetch(): Promise<string> {
        return this.executor.run(["fetch"]);
    }
    /** Verifies the push remote, creates or amends a commit, then pushes the current branch. */
    async commitAndPush(message: string, amend: boolean = false): Promise<string> {
        await this.assertPushRemoteReachable();
        await this.commit(message, amend);
        return this.push();
    }
    /**
     * Checks the configured upstream remote before committing so orphaned provider remotes are surfaced early.
     */
    private async assertPushRemoteReachable(): Promise<void> {
        let upstream: string;
        try {
            upstream = (await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"]))
                .trim()
                .split("\n")[0];
        } catch {
            return;
        }
        if (!upstream || !upstream.includes("/")) return;
        const remote = upstream.split("/")[0];
        if (!remote) return;
        assertValidRemoteName(remote);
        let lsRemoteResult;
        try {
            lsRemoteResult = await this.executor.runBinary(["ls-remote", "--exit-code", remote], {
                expectedExitCodes: [0, 2],
            });
        } catch (err) {
            throw new Error(
                `Push remote "${remote}" is unavailable. Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(err)}`,
                { cause: err },
            );
        }
        if (lsRemoteResult.exitCode === 2) {
            const error = new Error(
                `git ls-remote --exit-code exited with 2: ${lsRemoteResult.stderr.toString("utf8").trim() || "(no stderr)"}`,
            );
            throw new Error(
                `Push remote "${remote}" reached but reported no refs; it may simply be empty (no branches yet). Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(error)}`,
                { cause: error },
            );
        }
    }
    /** Resolves and validates the current branch name for upstream-push fallback prompts. */
    private async resolveCurrentBranchNameForPush(): Promise<string | null> {
        try {
            const raw = await this.executor.run(["rev-parse", "--abbrev-ref", "HEAD"]);
            const branch = raw.trim();
            if (!branch || branch === "HEAD") return null;
            assertValidBranchName(branch);
            return branch;
        } catch {
            return null;
        }
    }
    /** Resolves the first configured remote name for upstream-push fallback prompts. */
    private async resolveDefaultRemoteNameForPush(): Promise<string | null> {
        try {
            const remotes = await this.executor.run(["remote"]);
            const firstRemote = remotes
                .split("\n")
                .map((r) => r.trim())
                .find(isValidRemoteName);
            return firstRemote ?? null;
        } catch {
            return null;
        }
    }
    /** Resolves validated upstream metadata for explicit pushes when local and remote names differ. */
    private async resolveCurrentPushTarget(): Promise<{
        localBranch: string;
        remote: string;
        remoteBranch: string;
    } | null> {
        const localBranch = await this.resolveCurrentBranchNameForPush();
        if (!localBranch) return null;
        try {
            const upstream = (await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"]))
                .trim()
                .split("\n")[0];
            const slashIndex = upstream.indexOf("/");
            if (slashIndex <= 0) return null;
            const remote = upstream.slice(0, slashIndex);
            const remoteBranch = upstream.slice(slashIndex + 1);
            assertValidRemoteName(remote);
            assertValidBranchName(remoteBranch, "remote branch name");
            return { localBranch, remote, remoteBranch };
        } catch {
            return null;
        }
    }
    /** Prompts or delegates confirmation before mutating upstream tracking during push fallback. */
    private async requestSetUpstreamPush(remote: string, branch: string): Promise<boolean> {
        if (this.confirmSetUpstreamPush) {
            return this.confirmSetUpstreamPush(remote, branch);
        }
        const vscode = getVsCodeApi();
        if (!vscode) return false;
        const confirmLabel = vscode.l10n.t("Set Upstream and Push");
        const selection = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Branch '{branch}' has no upstream. Set upstream to '{remote}/{remoteBranch}' and push?",
                { branch, remote, remoteBranch: branch },
            ),
            { modal: true },
            confirmLabel,
        );
        return selection === confirmLabel;
    }
    /** Returns the full message for the latest commit, falling back to an empty string on Git failure. */
    async getLastCommitMessage(): Promise<string> {
        try {
            return (await this.executor.run(["log", "-1", "--format=%B"])).trim();
        } catch {
            return "";
        }
    }
    /**
     * Commits on the current branch relevant when amending: ahead of the upstream
     * branch if set, otherwise the recent history on HEAD (same idea as IntelliJ
     * amend context). Uses NUL field separators in `git log --format` because `%s`
     * may contain tabs.
     */
    async getAmendBranchCommits(limit = 80): Promise<AmendBranchCommitSummary[]> {
        try {
            const upstream = (
                await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"])
            ).trim();
            if (upstream && upstream !== "HEAD") {
                const base = (
                    await this.executor.run(["merge-base", "HEAD", "@{upstream}"])
                ).trim();
                if (base) {
                    const range = `${base}..HEAD`;
                    const out = await this.executor.run([
                        "log",
                        range,
                        "-z",
                        `--max-count=${limit}`,
                        `--format=${AMEND_BRANCH_COMMIT_FORMAT}`,
                    ]);
                    const parsed = parseAmendBranchCommitSummaries(out);
                    if (parsed.length > 0) {
                        return parsed;
                    }
                }
            }
        } catch {
            // No upstream or ambiguous ref — fall through to local history.
        }
        try {
            const out = await this.executor.run([
                "log",
                "HEAD",
                "-z",
                `--max-count=${limit}`,
                `--format=${AMEND_BRANCH_COMMIT_FORMAT}`,
            ]);
            return parseAmendBranchCommitSummaries(out);
        } catch {
            return [];
        }
    }
    /**
     * Rolls back selected literal paths using a porcelain-derived reset, checkout, and cleanup plan.
     *
     * Renames, copies, staged adds, and untracked paths are handled separately so cleanup only removes
     * paths Git status identifies as safe for the requested rollback.
     */
    async rollbackFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const status = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        const { resetPaths, checkoutPaths, cleanupPaths } = planRollbackFiles(paths, status);
        if (resetPaths.length > 0) {
            await this.executor.run(withLiteralPathspecs(["reset", "HEAD", "--", ...resetPaths]));
        }
        if (checkoutPaths.length > 0) {
            await this.executor.run(withLiteralPathspecs(["checkout", "--", ...checkoutPaths]));
        }
        if (cleanupPaths.length > 0) {
            await this.executor.run(withLiteralPathspecs(["clean", "-fd", "--", ...cleanupPaths]));
        }
    }
    /** Resets the repository to HEAD and removes untracked files, discarding all working-tree changes. */
    async rollbackAll(): Promise<void> {
        await this.executor.run(["reset", "--hard", "HEAD"]);
        // Also clean untracked files
        await this.executor.run(["clean", "-fd"]);
    }
    // --- Stash operations ---
    /** Saves all changes or selected literal paths into a Git stash entry with untracked files included. */
    async stashSave(paths?: string[], message: string = "Stashed changes"): Promise<string> {
        const args = ["stash", "push", "--include-untracked", "-m", message];
        if (paths && paths.length > 0) {
            args.push("--", ...paths);
        }
        return this.executor.run(paths && paths.length > 0 ? withLiteralPathspecs(args) : args);
    }
    /** Pops a validated stash index back into the working tree, optionally restoring its staged state. */
    async stashPop(index: number = 0, reinstateIndex = false): Promise<string> {
        assertStashIndex(index);
        const args = ["stash", "pop"];
        if (reinstateIndex) args.push("--index");
        args.push(`stash@{${index}}`);
        return this.executor.run(args);
    }
    /** Applies a validated stash index without dropping it, optionally restoring its staged state. */
    async stashApply(index: number = 0, reinstateIndex = false): Promise<string> {
        assertStashIndex(index);
        const args = ["stash", "apply"];
        if (reinstateIndex) args.push("--index");
        args.push(`stash@{${index}}`);
        return this.executor.run(args);
    }
    /** Lists stash entries from formatted Git output, returning an empty list when stash inspection fails. */
    async listStashes(): Promise<StashEntry[]> {
        try {
            const result = await this.executor.run(["stash", "list", "--format=%H\t%gd\t%gs\t%aI"]);
            return parseStashEntries(result);
        } catch {
            return [];
        }
    }
    /** Drops a validated stash index and returns Git output. */
    async stashDelete(index: number): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "drop", `stash@{${index}}`]);
    }
    /** Restores a validated stash onto a validated new branch, letting Git restore the index and drop it on success. */
    async stashBranch(branchName: string, index: number = 0): Promise<string> {
        assertValidBranchName(branchName);
        assertStashIndex(index);
        return this.executor.run(["stash", "branch", branchName, `stash@{${index}}`]);
    }
    /** Permanently drops every stash entry in the current repository. */
    async stashClear(): Promise<string> {
        return this.executor.run(["stash", "clear"]);
    }
    /**
     * Loads changed files for a stash with best-effort metadata and untracked-path classification.
     *
     * Name-status and numstat supply partial details, while `--only-untracked --name-only -z`
     * authoritatively distinguishes unversioned stash entries. Individual probe failures are
     * logged without discarding successful metadata from the other probes.
     */
    async getStashFiles(index: number): Promise<WorkingFile[]> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        let nameStatus = "";
        let numstat = "";
        let untrackedPaths = "";
        try {
            nameStatus = await this.executor.run([
                "stash",
                "show",
                "--include-untracked",
                "--name-status",
                "-z",
                ref,
            ]);
        } catch (err) {
            logGitOpsWarning(`Failed stash show --name-status for ${ref}`, err);
        }
        try {
            numstat = await this.executor.run([
                "stash",
                "show",
                "--include-untracked",
                "--numstat",
                "-z",
                ref,
            ]);
        } catch (err) {
            logGitOpsWarning(`Failed stash show --numstat for ${ref}`, err);
        }
        try {
            untrackedPaths = await this.executor.run([
                "stash",
                "show",
                "--only-untracked",
                "--name-only",
                "-z",
                ref,
            ]);
        } catch (err) {
            logGitOpsWarning(`Failed stash show --only-untracked for ${ref}`, err);
        }
        return parseStashFiles(nameStatus, numstat, untrackedPaths);
    }
    /**
     * Builds one binary-safe file patch from a stable stash object ID.
     *
     * The normal stash tree is compared to its first parent for tracked additions, modifications,
     * and deletions. Only an empty tracked patch probes the optional third parent, where Git stores
     * untracked files; a genuinely absent third parent means no patch, while unrelated errors reject.
     */
    async getStashFilePatch(index: number, stashHash: string, filePath: string): Promise<string> {
        assertStashIndex(index);
        const stableHash = assertStableStashHash(stashHash);
        const safePath = assertRepoRelativeGitPath(filePath);
        const diffArgs = (base: string, target: string) =>
            withLiteralPathspecs([
                "diff",
                "--binary",
                "--full-index",
                "--no-color",
                base,
                target,
                "--",
                safePath,
            ]);
        const trackedPatch = await this.executor.run(diffArgs(`${stableHash}^1`, stableHash));
        if (trackedPatch.trim().length > 0) return trackedPatch;
        try {
            return await this.executor.run(diffArgs(EMPTY_TREE_HASH, `${stableHash}^3`));
        } catch (err) {
            if (isMissingStashUntrackedParentError(getErrorMessage(err).toLowerCase())) return "";
            throw err;
        }
    }

    /**
     * Applies and stages exactly one file from the stash entry still occupying a validated index.
     *
     * The movable `stash@{n}` ref is checked against the webview's full object ID before mutation;
     * patch generation then uses only that stable ID so later stash renumbering cannot retarget it.
     */
    async applyStashFile(index: number, stashHash: string, filePath: string): Promise<void> {
        assertStashIndex(index);
        const stableHash = assertStableStashHash(stashHash);
        const safePath = assertRepoRelativeGitPath(filePath);
        const currentHash = (
            await this.executor.run(["rev-parse", "--verify", `stash@{${index}}^{commit}`])
        ).trim();
        if (currentHash.toLowerCase() !== stableHash.toLowerCase()) {
            throw new Error(`Stash entry changed at index ${index}; refresh and try again.`);
        }
        const patch = await this.getStashFilePatch(index, stableHash, safePath);
        if (patch.trim().length === 0) {
            throw new Error(`No stashed changes found for path: ${safePath}`);
        }
        await applyPatchTextToRepo(patch, false, this.executor);
    }
    /**
     * Reads the before and after versions of one stash path for VS Code diff resources.
     *
     * The first parent supplies the pre-stash version, the stash tree supplies the normal after
     * version, and the third parent is consulted only when the stash tree lacks an untracked file.
     * Missing sides stay undefined; executor failures unrelated to absent Git paths still reject.
     */
    async getStashFileContents(
        index: number,
        filePath: string,
    ): Promise<{ before: string | undefined; after: string | undefined }> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        const [before, stashAfter] = await Promise.all([
            this.getOptionalStashFileContent(filePath, `${ref}^1`),
            this.getOptionalStashFileContent(filePath, ref),
        ]);
        let after = stashAfter;
        if (after === undefined) {
            after = await this.getOptionalStashFileContent(filePath, `${ref}^3`, true);
        }
        return { before, after };
    }

    /**
     * Reads one stash-side file while converting only Git's explicit missing-path diagnostics to an absent side.
     *
     * A missing third parent is expected for stashes without untracked files, but is accepted only after the
     * main stash tree was read successfully and lacked the requested path.
     */
    private async getOptionalStashFileContent(
        filePath: string,
        ref: string,
        allowMissingUntrackedParent = false,
    ): Promise<string | undefined> {
        try {
            return await this.getFileContentAtRef(filePath, ref);
        } catch (err) {
            const message = getErrorMessage(err).toLowerCase();
            if (isMissingGitPathError(message)) return undefined;
            if (allowMissingUntrackedParent && isMissingStashUntrackedParentError(message)) {
                return undefined;
            }
            throw err;
        }
    }
    /** Returns parsed file-history entries for a literal repository path, following renames. */
    async getFileHistoryEntries(
        filePath: string,
        maxCount: number = 30,
    ): Promise<
        Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>
    > {
        const raw = await this.executor.run(
            withLiteralPathspecs([
                "log",
                `--max-count=${maxCount}`,
                "--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s",
                "--follow",
                "--",
                filePath,
            ]),
        );
        return parseFileHistoryEntries(raw);
    }
    /**
     * Reads a repository-relative file at a validated Git ref.
     *
     * File paths are normalized as repository-relative Git paths, and refs with empty, option-like, or
     * control-character content are rejected before constructing the `git show` argument.
     */
    async getFileContentAtRef(filePath: string, ref: string): Promise<string> {
        const trimmedRef = ref.trim();
        const safeFilePath = assertRepoRelativeGitPath(filePath);
        if (!trimmedRef) throw new Error("Git ref is empty.");
        if (trimmedRef.startsWith("-")) {
            throw new Error("Git ref must not start with '-'.");
        }
        if (/[\0\r\n]/.test(trimmedRef)) {
            throw new Error("Git ref contains invalid control characters.");
        }
        return this.executor.run(["show", `${trimmedRef}:${safeFilePath}`]);
    }
    /** Lists unresolved conflict paths from Git diff's NUL-delimited unmerged output. */
    async getConflictedFiles(): Promise<string[]> {
        const out = await this.executor.run(["diff", "--name-only", "-z", "--diff-filter=U"]);
        return out.split("\0").filter(Boolean);
    }
    /**
     * Reads detailed merge-conflict states from porcelain status output and sorts them for display.
     *
     * Rename/copy source paths are skipped, and only unmerged status code pairs are returned.
     */
    async getConflictFilesDetailed(): Promise<MergeConflictFile[]> {
        const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        const files: MergeConflictFile[] = [];
        const entries = result.split("\0");
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || entry.length < 4) continue;
            const oursCode = entry.charAt(0);
            const theirsCode = entry.charAt(1);
            const code = `${oursCode}${theirsCode}`;
            const path = entry.slice(3);
            if (!path) continue;
            const isRenameOrCopy =
                oursCode === "R" || oursCode === "C" || theirsCode === "R" || theirsCode === "C";
            if (isRenameOrCopy && i + 1 < entries.length) {
                i += 1;
            }
            if (!isUnmergedConflictCode(code)) continue;
            files.push({
                path,
                code,
                ours: mapConflictSideState(oursCode),
                theirs: mapConflictSideState(theirsCode),
            });
        }
        return files.sort((a, b) => a.path.localeCompare(b.path));
    }
    /**
     * Reads base, ours, and theirs stages for a conflicted file with short per-stage timeouts.
     *
     * Missing stages are converted to empty strings so the merge UI can still open partial conflicts.
     */
    async getConflictFileVersions(
        filePath: string,
    ): Promise<{ base: string; ours: string; theirs: string }> {
        const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
            return Promise.race([
                promise,
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error(`Timed out reading ${label} for ${filePath}`)),
                        10_000,
                    ),
                ),
            ]);
        };
        const [base, ours, theirs] = await Promise.all([
            withTimeout(this.executor.run(["show", `:1:${filePath}`]), "base").catch(() => ""),
            withTimeout(this.executor.run(["show", `:2:${filePath}`]), "ours").catch(() => ""),
            withTimeout(this.executor.run(["show", `:3:${filePath}`]), "theirs").catch(() => ""),
        ]);
        return { base, ours, theirs };
    }
    /**
     * Resolves display labels for the two sides of an in-progress merge-like operation.
     *
     * "Ours" is the current branch name with a short-SHA fallback for detached HEAD.
     * "Theirs" prefers the first merge-like head that exists (MERGE_HEAD, REBASE_HEAD,
     * CHERRY_PICK_HEAD) resolved to a local branch name when possible, falling back to
     * a short SHA. Resolution failures degrade to generic side labels so the merge
     * editor can still open while Git state is unusual.
     */
    async getMergeSideLabels(): Promise<{ ours: string; theirs: string }> {
        const ours = await this.resolveRefLabel("HEAD");
        const theirs =
            (await this.resolveRefLabel("MERGE_HEAD")) ??
            (await this.resolveRefLabel("REBASE_HEAD")) ??
            (await this.resolveRefLabel("CHERRY_PICK_HEAD"));
        return { ours: ours ?? "Yours", theirs: theirs ?? "Theirs" };
    }
    /** Resolves a ref to a branch name or short SHA, returning null when the ref is absent. */
    private async resolveRefLabel(ref: string): Promise<string | null> {
        try {
            if (ref === "HEAD") {
                const symbolic = (
                    await this.executor.run(["rev-parse", "--abbrev-ref", "HEAD"])
                ).trim();
                if (symbolic && symbolic !== "HEAD") return symbolic;
            } else {
                const named = (
                    await this.executor.run(["name-rev", "--name-only", "--refs=refs/heads/*", ref])
                ).trim();
                // name-rev emits "undefined" for unnamed commits and suffixes like
                // "branch~2" when the ref is not exactly a branch tip; both are
                // worse labels than a short SHA.
                if (
                    named &&
                    named !== "undefined" &&
                    !named.includes("~") &&
                    !named.includes("^")
                ) {
                    return named;
                }
            }
            const short = (await this.executor.run(["rev-parse", "--short", ref])).trim();
            return short || null;
        } catch {
            return null;
        }
    }
    /** Stages one literal repository path, typically after conflict-side resolution. */
    async stageFile(filePath: string): Promise<void> {
        await this.executor.run(withLiteralPathspecs(["add", "--", filePath]));
    }
    /** Checks out the selected conflict side for a literal path and stages the resolved file. */
    async acceptConflictSide(filePath: string, side: "ours" | "theirs"): Promise<void> {
        const sideArg = side === "ours" ? "--ours" : "--theirs";
        await this.executor.run(withLiteralPathspecs(["checkout", sideArg, "--", filePath]));
        await this.executor.run(withLiteralPathspecs(["add", "--", filePath]));
    }
    /**
     * Aborts the active merge-like operation, including stash-apply index conflicts.
     *
     * The refs are tested in `getActiveOperation`'s precedence order so the command that runs is
     * always the one for the operation the panel reports. A rebase replaying a merge leaves both
     * `REBASE_HEAD` and `MERGE_HEAD`, and aborting only the merge step there would strand the user
     * inside a rebase they asked to leave.
     */
    async abortMerge(): Promise<void> {
        const hasRef = async (ref: string): Promise<boolean> => {
            try {
                await this.executor.run(["rev-parse", "--verify", "--quiet", ref]);
                return true;
            } catch {
                return false;
            }
        };
        if (await hasRef("REBASE_HEAD")) {
            await this.executor.run(["rebase", "--abort"]);
            return;
        }
        if (await hasRef("MERGE_HEAD")) {
            await this.executor.run(["merge", "--abort"]);
            return;
        }
        if (await hasRef("CHERRY_PICK_HEAD")) {
            await this.executor.run(["cherry-pick", "--abort"]);
            return;
        }
        if (await hasRef("REVERT_HEAD")) {
            await this.executor.run(["revert", "--abort"]);
            return;
        }
        const unmergedEntries = (await this.executor.run(["ls-files", "-u"])).trim();
        if (unmergedEntries) {
            await this.executor.run(["reset", "--merge"]);
            return;
        }
        throw new Error("No active merge, rebase, cherry-pick, or unmerged index state to abort.");
    }
    /** Removes a literal repository path through Git, optionally forcing removal of missing or staged files. */
    async deleteFile(filePath: string, force: boolean = false): Promise<void> {
        const args = force ? ["rm", "-f", "--", filePath] : ["rm", "--", filePath];
        await this.executor.run(withLiteralPathspecs(args));
    }
}
function isNoUpstreamPushError(err: unknown): boolean {
    const message = getErrorMessage(err).toLowerCase();
    return message.includes("has no upstream branch");
}

function withLiteralPathspecs(args: string[]): string[] {
    return ["--literal-pathspecs", ...args];
}

/** Parses Git's line-oriented numstat output into a path-keyed change summary. */
function parseDiffNumstat(output: Buffer): Map<string, DiffNumstat> {
    const stats = new Map<string, DiffNumstat>();
    for (const line of output.toString("utf8").split("\n")) {
        const [added, deleted, filePath] = line.split("\t", 3);
        if (!filePath || added === undefined || deleted === undefined) continue;
        const binary = added === "-" || deleted === "-";
        const addedLines = Number(added);
        const deletedLines = Number(deleted);
        if (
            (!binary &&
                (!Number.isSafeInteger(addedLines) || !Number.isSafeInteger(deletedLines))) ||
            addedLines < 0 ||
            deletedLines < 0
        )
            continue;
        stats.set(normalizeGitNumstatPath(filePath), {
            added: binary ? 0 : addedLines,
            deleted: binary ? 0 : deletedLines,
            binary,
        });
    }
    return stats;
}

/** Git's default (`core.quotePath=true`) short mnemonic escapes for individual path bytes. */
const GIT_PATH_SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
    [0x07, "\\a"],
    [0x08, "\\b"],
    [0x09, "\\t"],
    [0x0a, "\\n"],
    [0x0b, "\\v"],
    [0x0c, "\\f"],
    [0x0d, "\\r"],
    [0x22, '\\"'],
    [0x5c, "\\\\"],
]);

/** True when a byte forces Git's default C-style path quoting: control chars, DEL, non-ASCII, `"`, or `\`. */
function isGitPathQuoteByte(byte: number): boolean {
    return byte < 0x20 || byte > 0x7e || byte === 0x22 || byte === 0x5c;
}

/** Renders one path byte verbatim, or Git-escaped (short mnemonic, else zero-padded `\nnn` octal) when it is quote-worthy. */
function escapeGitPathByte(byte: number): string {
    if (!isGitPathQuoteByte(byte)) return String.fromCharCode(byte);
    return GIT_PATH_SHORT_ESCAPES.get(byte) ?? `\\${byte.toString(8).padStart(3, "0")}`;
}

/**
 * Quotes a `diff --git`/`+++` display path (e.g. `b/${filePath}`) the way Git quotes it by
 * default (`core.quotePath=true`): left bare when every byte is plain ASCII, otherwise wrapped in
 * double quotes with each quote-worthy byte C-escaped individually (UTF-8 bytes, not code points,
 * so one non-ASCII character can expand into several octal escapes).
 */
function quoteGitDiffPath(displayPath: string): { text: string; quoted: boolean } {
    const bytes = Buffer.from(displayPath, "utf8");
    if (!bytes.some(isGitPathQuoteByte)) {
        return { text: displayPath, quoted: false };
    }
    let escaped = "";
    for (const byte of bytes) escaped += escapeGitPathByte(byte);
    return { text: `"${escaped}"`, quoted: true };
}

/**
 * Builds the `@@ -0,0 +1[,N] @@` hunk for a brand-new file whose sole content is `content`,
 * matching Git's line splitting: every `\n`-terminated segment becomes its own `+` line, and the
 * trailing `\ No newline at end of file` marker is emitted only when `content` itself does not
 * end with a newline.
 */
function buildAddedContentHunk(content: string): string {
    const endsWithNewline = content.endsWith("\n");
    const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
    const header = lines.length === 1 ? "@@ -0,0 +1 @@" : `@@ -0,0 +1,${lines.length} @@`;
    const body = lines.map((line) => `+${line}`).join("\n");
    const noNewlineMarker = endsWithNewline ? "" : "\n\\ No newline at end of file";
    return `${header}\n${body}${noNewlineMarker}\n`;
}

/**
 * Assembles the full synthesized `git diff`-shaped text for adding a new symlink whose target is
 * `linkTarget`, without ever invoking Git. Paths are C-quoted the way `core.quotePath=true` quotes
 * them; `objectId` stands in for the new blob's hash so callers can pass a same-length placeholder
 * (see `SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH`) to size the diff before hashing anything.
 */
function buildSymlinkAddDiff(filePath: string, linkTarget: string, objectId: string): string {
    const aSide = quoteGitDiffPath(`a/${filePath}`);
    const bSide = quoteGitDiffPath(`b/${filePath}`);
    const bTrailer = !bSide.quoted && filePath.includes(" ") ? "\t" : "";
    return (
        `diff --git ${aSide.text} ${bSide.text}\n` +
        `new file mode 120000\n` +
        `index ${"0".repeat(objectId.length)}..${objectId}\n` +
        `--- /dev/null\n` +
        `+++ ${bSide.text}${bTrailer}\n` +
        buildAddedContentHunk(linkTarget)
    );
}

/** Identifies an untracked path that vanished between the porcelain snapshot and no-index diff. */
function isMissingUntrackedPathError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    return (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        isMissingGitPathError(message) ||
        message.includes("no such file or directory") ||
        message.includes("could not access")
    );
}

/** Returns whether a Git operation-state marker currently exists. */
async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Returns whether an `fs` error indicates the target path already exists (e.g. `EEXIST` from an exclusive create). */
function isLockAlreadyExistsError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}

/** Returns whether Git reported a path absent from an otherwise valid treeish. */
function isMissingGitPathError(message: string): boolean {
    return (
        message.includes("does not exist in") ||
        message.includes("exists on disk, but not in") ||
        (message.includes("pathspec") && message.includes("did not match"))
    );
}

/** Returns whether an untracked-file fallback found no third parent on an otherwise valid stash. */
function isMissingStashUntrackedParentError(message: string): boolean {
    return message.includes("invalid object name") || message.includes("bad revision");
}

/** Validates the full SHA-1 object ID emitted by the stash list before it reaches Git argv. */
function assertStableStashHash(value: string): string {
    const hash = value.trim();
    if (!/^[0-9a-fA-F]{40}$/.test(hash)) {
        throw new Error("Invalid stash hash received from webview.");
    }
    return hash;
}
