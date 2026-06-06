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
import { parseShelvedFiles } from "./stashFiles";
import { normalizeGitNumstatPath } from "./numstat";
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
    /** Pushes a validated branch to a validated remote while creating upstream tracking. */
    async pushWithUpstream(remote: string, branch: string): Promise<string> {
        assertValidRemoteName(remote);
        assertValidBranchName(branch);
        return this.executor.run(["push", "-u", remote, branch]);
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
            "%(refname)\t%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(upstream:track,nobracket)\t%(HEAD)";
        const result = await this.executor.run(["branch", "-a", `--format=${format}`]);
        const branches: Branch[] = [];
        for (const line of result.trim().split("\n")) {
            if (!line.trim()) continue;
            const [refname, name, hash, upstream, track, head] = line.split("\t");
            const isRemote = refname.startsWith("refs/remotes/");
            // Skip symbolic refs like origin/HEAD (refname:short resolves to just "origin")
            if (refname.endsWith("/HEAD")) continue;
            if (!isValidBranchName(name)) continue;
            let remote: string | undefined;
            if (isRemote) {
                // refname:short for remote is "origin/main", first segment is the remote name
                remote = name.split("/")[0];
                if (!isValidRemoteName(remote)) continue;
            } else if (upstream) {
                remote = upstream.split("/")[0];
                if (!isValidRemoteName(remote)) {
                    remote = undefined;
                }
            }
            let ahead = 0,
                behind = 0;
            if (track) {
                const a = track.match(/ahead (\d+)/);
                const b = track.match(/behind (\d+)/);
                if (a) ahead = parseInt(a[1]);
                if (b) behind = parseInt(b[1]);
            }
            branches.push({
                name,
                hash,
                isRemote,
                isCurrent: head === "*",
                upstream: upstream || undefined,
                remote,
                ahead,
                behind,
            });
        }
        return branches;
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
     * than blocking the status view.
     */
    async getStatus(): Promise<WorkingFile[]> {
        const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        const files = parseWorkingTreeStatus(result);
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
    /** Stages literal repository paths, skipping files already staged as deletions to avoid re-adding them. */
    async stageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const pathsToStage = await this.excludeAlreadyStagedDeletedPaths(paths);
        if (pathsToStage.length === 0) return;
        await this.executor.run(withLiteralPathspecs(["add", "--", ...pathsToStage]));
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
    // --- Shelf operations (implemented via git stash) ---
    /** Saves all changes or selected literal paths into a Git stash entry with untracked files included. */
    async shelveSave(paths?: string[], message: string = "Shelved changes"): Promise<string> {
        const args = ["stash", "push", "--include-untracked", "-m", message];
        if (paths && paths.length > 0) {
            args.push("--", ...paths);
        }
        return this.executor.run(paths && paths.length > 0 ? withLiteralPathspecs(args) : args);
    }
    /** Pops a validated stash index back into the working tree. */
    async shelvePop(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "pop", `stash@{${index}}`]);
    }
    /** Applies a validated stash index without dropping it. */
    async shelveApply(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "apply", `stash@{${index}}`]);
    }
    /** Lists stash entries from formatted Git output, returning an empty list when stash inspection fails. */
    async listShelved(): Promise<StashEntry[]> {
        try {
            const result = await this.executor.run(["stash", "list", "--format=%H\t%gd\t%gs\t%aI"]);
            return parseStashEntries(result);
        } catch {
            return [];
        }
    }
    /** Drops a validated stash index and returns Git output. */
    async shelveDelete(index: number): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "drop", `stash@{${index}}`]);
    }
    /**
     * Loads changed files for a stash using best-effort name/status and numstat output.
     *
     * Individual stash inspection failures are logged and converted to partial file metadata.
     */
    async getShelvedFiles(index: number): Promise<WorkingFile[]> {
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
        return parseShelvedFiles(nameStatus, numstat);
    }
    /** Returns the patch for a literal repository path inside a validated stash entry. */
    async getShelvedFilePatch(index: number, filePath: string): Promise<string> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        return this.executor.run(withLiteralPathspecs(["diff", `${ref}^`, ref, "--", filePath]));
    }
    /** Returns a formatted, follow-renames history listing for a literal repository path. */
    async getFileHistory(filePath: string, maxCount: number = 50): Promise<string> {
        return this.executor.run(
            withLiteralPathspecs([
                "log",
                `--max-count=${maxCount}`,
                "--pretty=format:%h  %<(12,trunc)%an  %<(20)%ai  %s",
                "--follow",
                "--",
                filePath,
            ]),
        );
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
