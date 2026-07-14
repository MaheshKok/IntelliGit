import { GitExecutor } from "./executor";
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

type BranchRow = string[];

type DefaultBranchRefs = {
    defaultRemoteRefs: Set<string>;
    remotesWithDefault: Set<string>;
    defaultLocalNames: Set<string>;
};

/** Splits Git's tab-delimited branch output into non-empty rows for later validation. */
function parseBranchRows(result: string): BranchRow[] {
    return result
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => line.split("\t"));
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
        const format =
            "%(refname)\t%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(upstream:track,nobracket)\t%(HEAD)\t%(symref:short)\t%(committerdate:unix)";
        const result = await this.executor.run(["branch", "-a", `--format=${format}`]);
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

    /** Stages literal repository paths, skipping files already staged as deletions to avoid re-adding them. */
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
    /** Creates or amends a commit with the caller-provided message and returns Git output. */
    async commit(message: string, amend: boolean = false): Promise<string> {
        const args = ["commit", "-m", message];
        if (amend) args.push("--amend");
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
        try {
            await this.executor.run(["ls-remote", "--exit-code", remote]);
        } catch (err) {
            throw new Error(
                `Push remote "${remote}" is unavailable. Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(err)}`,
                { cause: err },
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
    /** Pops a validated stash index back into the working tree. */
    async stashPop(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "pop", `stash@{${index}}`]);
    }
    /** Applies a validated stash index without dropping it. */
    async stashApply(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "apply", `stash@{${index}}`]);
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
    /**
     * Loads changed files for a stash using best-effort name/status and numstat output.
     *
     * Individual stash inspection failures are logged and converted to partial file metadata.
     */
    async getStashFiles(index: number): Promise<WorkingFile[]> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        let nameStatus = "";
        let numstat = "";
        try {
            nameStatus = await this.executor.run(["stash", "show", "--name-status", ref]);
        } catch (err) {
            logGitOpsWarning(`Failed stash show --name-status for ${ref}`, err);
        }
        try {
            numstat = await this.executor.run(["stash", "show", "--numstat", ref]);
        } catch (err) {
            logGitOpsWarning(`Failed stash show --numstat for ${ref}`, err);
        }
        return parseStashFiles(nameStatus, numstat);
    }
    /** Returns the patch for a literal repository path inside a validated stash entry. */
    async getStashFilePatch(index: number, filePath: string): Promise<string> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        return this.executor.run(withLiteralPathspecs(["diff", `${ref}^`, ref, "--", filePath]));
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
    /** Aborts the active merge-like operation, including stash-apply index conflicts. */
    async abortMerge(): Promise<void> {
        const hasRef = async (ref: string): Promise<boolean> => {
            try {
                await this.executor.run(["rev-parse", "--verify", "--quiet", ref]);
                return true;
            } catch {
                return false;
            }
        };
        if (await hasRef("MERGE_HEAD")) {
            await this.executor.run(["merge", "--abort"]);
            return;
        }
        if (await hasRef("REBASE_HEAD")) {
            await this.executor.run(["rebase", "--abort"]);
            return;
        }
        if (await hasRef("CHERRY_PICK_HEAD")) {
            await this.executor.run(["cherry-pick", "--abort"]);
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
