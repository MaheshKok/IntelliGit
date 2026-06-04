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
import { getErrorMessage, sanitizeErrorMessage } from "../utils/errors";
import { isValidBranchName } from "../utils/gitRefs";
import {
    AMEND_BRANCH_COMMIT_FORMAT,
    COMMIT_DETAIL_FORMAT,
    COMMIT_LOG_FORMAT,
    isUnmergedConflictCode,
    mapCommitFileStatus,
    mapConflictSideState,
    mapStatusCode,
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

declare const require: (id: string) => unknown;

const OUTPUT_CHANNEL_NAME = "IntelliGit";

type VsCodeApi = typeof import("vscode");
type OutputChannelLike = { appendLine: (value: string) => void };
type ConfirmSetUpstreamPush = (remote: string, branch: string) => Promise<boolean>;
type GitOpsWarningOptions = { userWarningMessage?: string };

let cachedVsCodeApi: VsCodeApi | null | undefined;
let outputChannel: OutputChannelLike | undefined;

function getVsCodeApi(): VsCodeApi | null {
    if (cachedVsCodeApi !== undefined) return cachedVsCodeApi;
    try {
        cachedVsCodeApi = require("vscode") as VsCodeApi;
    } catch {
        cachedVsCodeApi = null;
    }
    return cachedVsCodeApi;
}

function getOutputChannel(): OutputChannelLike {
    if (outputChannel) return outputChannel;
    const vscode = getVsCodeApi();
    outputChannel = vscode
        ? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
        : { appendLine: (value: string) => console.warn(value) };
    return outputChannel;
}

function logGitOpsWarning(context: string, err: unknown, options?: GitOpsWarningOptions): void {
    const channel = getOutputChannel();
    const message = getErrorMessage(err);
    channel.appendLine(`[GitOps] ${context}: ${message}`);
    if (err instanceof Error && err.stack) {
        channel.appendLine(sanitizeErrorMessage(err.stack));
    }
    if (options?.userWarningMessage) {
        const vscode = getVsCodeApi();
        if (vscode) {
            void vscode.window.showWarningMessage(options.userWarningMessage);
        }
    }
}

function commitStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some commit change stats may be unavailable.")
        : "Some commit change stats may be unavailable.";
}

function unstagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some unstaged change stats may be unavailable.")
        : "Some unstaged change stats may be unavailable.";
}

function stagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some staged change stats may be unavailable.")
        : "Some staged change stats may be unavailable.";
}

function assertStashIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid stash index: ${index}`);
    }
}

function assertRepoRelativeGitPath(filePath: string): string {
    const trimmed = filePath.trim();
    if (
        !trimmed ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("\\") ||
        /^[a-zA-Z]:[\\/]/.test(trimmed)
    ) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (/[\0\r\n]/.test(trimmed)) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = trimmed.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
    if (segments.length === 0) {
        throw new Error(`Rejected repo root path: ${filePath}`);
    }
    if (segments.some((segment) => segment === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    return segments.join("/");
}

export class UpstreamPushDeclinedError extends Error {
    constructor() {
        super("Upstream push declined by user");
        this.name = "UpstreamPushDeclinedError";
    }
}

export class GitOps {
    constructor(
        private readonly executor: GitExecutor,
        private readonly confirmSetUpstreamPush?: ConfirmSetUpstreamPush,
    ) {}

    async init(repoPath: string): Promise<string> {
        const executor = new GitExecutor(repoPath);
        return executor.run(["init"]);
    }

    async isRepository(): Promise<boolean> {
        try {
            await this.executor.run(["rev-parse", "--is-inside-work-tree"]);
            return true;
        } catch {
            return false;
        }
    }

    async hasAnyCommits(): Promise<boolean> {
        try {
            const out = await this.executor.run(["rev-list", "--count", "HEAD"]);
            return parseInt(out.trim(), 10) > 0;
        } catch {
            return false;
        }
    }

    async getRemotes(): Promise<string[]> {
        try {
            const out = await this.executor.run(["remote"]);
            return out
                .trim()
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    async branchHasUpstream(branch: string): Promise<boolean> {
        try {
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

    async addRemote(name: string, url: string): Promise<void> {
        await this.executor.run(["remote", "add", name, url]);
    }

    async removeRemote(name: string): Promise<void> {
        await this.executor.run(["remote", "remove", name]);
    }

    async pushWithUpstream(remote: string, branch: string): Promise<string> {
        return this.executor.run(["push", "-u", remote, branch]);
    }

    async getRepositoryRoot(): Promise<string> {
        const root = await this.executor.run(["rev-parse", "--show-toplevel"]);
        return root.trim();
    }

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

            let remote: string | undefined;
            if (isRemote) {
                // refname:short for remote is "origin/main", first segment is the remote name
                remote = name.split("/")[0];
            } else if (upstream) {
                remote = upstream.split("/")[0];
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

    async getLog(
        maxCount: number = 500,
        branch?: string,
        filterText?: string,
        skip: number = 0,
    ): Promise<Commit[]> {
        const args = ["log", `--max-count=${maxCount}`, `--pretty=format:${COMMIT_LOG_FORMAT}`];
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
                const filePath = cols[cols.length - 1];
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

    async stageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const pathsToStage = await this.excludeAlreadyStagedDeletedPaths(paths);
        if (pathsToStage.length === 0) return;
        await this.executor.run(["add", "--", ...pathsToStage]);
    }

    private async excludeAlreadyStagedDeletedPaths(paths: string[]): Promise<string[]> {
        const status = await this.executor.run(["status", "--porcelain=v1", "-z", "--", ...paths]);
        if (!status.trim()) return paths;

        const alreadyStagedDeleted = parseAlreadyStagedDeletedPaths(status);
        return paths.filter((path) => !alreadyStagedDeleted.has(path));
    }

    async unstageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.executor.run(["reset", "HEAD", "--", ...paths]);
    }

    async commit(message: string, amend: boolean = false): Promise<string> {
        const args = ["commit", "-m", message];
        if (amend) args.push("--amend");
        return this.executor.run(args);
    }

    async push(): Promise<string> {
        try {
            return await this.executor.run(["push"]);
        } catch (err) {
            if (!isNoUpstreamPushError(err)) throw err;

            const suggested = parseSetUpstreamPushSuggestion(err);
            const branch = suggested?.branch ?? (await this.resolveCurrentBranchNameForPush());
            const remote = suggested?.remote ?? (await this.resolveDefaultRemoteNameForPush());
            if (!branch || !remote) throw err;

            const allowSetUpstream = await this.requestSetUpstreamPush(remote, branch);
            if (!allowSetUpstream) {
                throw new UpstreamPushDeclinedError();
            }

            return this.executor.run(["push", "--set-upstream", remote, branch]);
        }
    }

    async pullRebase(): Promise<string> {
        return this.executor.run(["pull", "--rebase"]);
    }

    async commitAndPush(message: string, amend: boolean = false): Promise<string> {
        await this.assertPushRemoteReachable();
        await this.commit(message, amend);
        return this.push();
    }

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

        try {
            await this.executor.run(["ls-remote", "--exit-code", remote]);
        } catch (err) {
            throw new Error(
                `Push remote "${remote}" is unavailable. Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(err)}`,
                { cause: err },
            );
        }
    }

    private async resolveCurrentBranchNameForPush(): Promise<string | null> {
        try {
            const raw = await this.executor.run(["rev-parse", "--abbrev-ref", "HEAD"]);
            const branch = raw.trim();
            if (!branch || branch === "HEAD") return null;
            return branch;
        } catch {
            return null;
        }
    }

    private async resolveDefaultRemoteNameForPush(): Promise<string | null> {
        try {
            const remotes = await this.executor.run(["remote"]);
            const firstRemote = remotes
                .split("\n")
                .map((r) => r.trim())
                .find((r) => r.length > 0);
            return firstRemote ?? null;
        } catch {
            return null;
        }
    }

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

    async getLastCommitMessage(): Promise<string> {
        try {
            return (await this.executor.run(["log", "-1", "--format=%B"])).trim();
        } catch {
            return "";
        }
    }

    /**
     * Commits on the current branch relevant when amending: ahead of @{upstream}
     * if set, otherwise the recent history on HEAD (same idea as IntelliJ amend context).
     * Uses US/RS field separators in `git log --format` because `%s` may contain tabs.
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
                `--max-count=${limit}`,
                `--format=${AMEND_BRANCH_COMMIT_FORMAT}`,
            ]);
            return parseAmendBranchCommitSummaries(out);
        } catch {
            return [];
        }
    }

    async rollbackFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const status = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        const { resetPaths, checkoutPaths, cleanupPaths } = planRollbackFiles(paths, status);

        if (resetPaths.length > 0) {
            await this.executor.run(["reset", "HEAD", "--", ...resetPaths]);
        }
        if (checkoutPaths.length > 0) {
            await this.executor.run(["checkout", "--", ...checkoutPaths]);
        }
        if (cleanupPaths.length > 0) {
            await this.executor.run(["clean", "-fd", "--", ...cleanupPaths]);
        }
    }

    async rollbackAll(): Promise<void> {
        await this.executor.run(["reset", "--hard", "HEAD"]);
        // Also clean untracked files
        await this.executor.run(["clean", "-fd"]);
    }

    // --- Shelf operations (implemented via git stash) ---

    async shelveSave(paths?: string[], message: string = "Shelved changes"): Promise<string> {
        const args = ["stash", "push", "--include-untracked", "-m", message];
        if (paths && paths.length > 0) {
            args.push("--", ...paths);
        }
        return this.executor.run(args);
    }

    async shelvePop(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "pop", `stash@{${index}}`]);
    }

    async shelveApply(index: number = 0): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "apply", `stash@{${index}}`]);
    }

    async listShelved(): Promise<StashEntry[]> {
        try {
            const result = await this.executor.run(["stash", "list", "--format=%H\t%gd\t%gs\t%aI"]);
            return parseStashEntries(result);
        } catch {
            return [];
        }
    }

    async shelveDelete(index: number): Promise<string> {
        assertStashIndex(index);
        return this.executor.run(["stash", "drop", `stash@{${index}}`]);
    }

    async getShelvedFiles(index: number): Promise<WorkingFile[]> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        const files = new Map<string, WorkingFile>();

        const upsert = (path: string, status: WorkingFile["status"] = "M"): WorkingFile => {
            const existing = files.get(path);
            if (existing) return existing;
            const created: WorkingFile = {
                path,
                status,
                staged: false,
                additions: 0,
                deletions: 0,
            };
            files.set(path, created);
            return created;
        };

        try {
            const nameStatus = await this.executor.run(["stash", "show", "--name-status", ref]);
            for (const line of nameStatus.trim().split("\n")) {
                if (!line.trim()) continue;
                const parts = line.split("\t");
                if (parts.length < 2) continue;
                const code = parts[0].trim();
                const status = mapStatusCode(code[0]) ?? "M";
                const path =
                    code.startsWith("R") || code.startsWith("C")
                        ? (parts[2]?.trim() ?? parts[1]?.trim())
                        : parts[1]?.trim();
                if (!path) continue;
                upsert(path, status);
            }
        } catch (err) {
            logGitOpsWarning(`Failed stash show --name-status for ${ref}`, err);
        }

        try {
            const numstat = await this.executor.run(["stash", "show", "--numstat", ref]);
            for (const line of numstat.trim().split("\n")) {
                if (!line.trim()) continue;
                const parts = line.split("\t");
                if (parts.length < 3) continue;
                const adds = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
                const dels = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
                const path = parts[2].trim();
                if (!path) continue;
                const entry = upsert(path);
                const updated = { ...entry, additions: adds, deletions: dels };
                files.set(path, updated);
            }
        } catch (err) {
            logGitOpsWarning(`Failed stash show --numstat for ${ref}`, err);
        }

        return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
    }

    async getShelvedFilePatch(index: number, filePath: string): Promise<string> {
        assertStashIndex(index);
        const ref = `stash@{${index}}`;
        return this.executor.run(["diff", `${ref}^`, ref, "--", filePath]);
    }

    async getFileHistory(filePath: string, maxCount: number = 50): Promise<string> {
        return this.executor.run([
            "log",
            `--max-count=${maxCount}`,
            "--pretty=format:%h  %<(12,trunc)%an  %<(20)%ai  %s",
            "--follow",
            "--",
            filePath,
        ]);
    }

    async getFileHistoryEntries(
        filePath: string,
        maxCount: number = 30,
    ): Promise<
        Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>
    > {
        const raw = await this.executor.run([
            "log",
            `--max-count=${maxCount}`,
            "--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s",
            "--follow",
            "--",
            filePath,
        ]);

        return parseFileHistoryEntries(raw);
    }

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

    async getConflictedFiles(): Promise<string[]> {
        const out = await this.executor.run(["diff", "--name-only", "--diff-filter=U"]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    }

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

    async stageFile(filePath: string): Promise<void> {
        await this.executor.run(["add", "--", filePath]);
    }

    async acceptConflictSide(filePath: string, side: "ours" | "theirs"): Promise<void> {
        const sideArg = side === "ours" ? "--ours" : "--theirs";
        await this.executor.run(["checkout", sideArg, "--", filePath]);
        await this.executor.run(["add", "--", filePath]);
    }

    async deleteFile(filePath: string, force: boolean = false): Promise<void> {
        const args = force ? ["rm", "-f", "--", filePath] : ["rm", "--", filePath];
        await this.executor.run(args);
    }
}

function isNoUpstreamPushError(err: unknown): boolean {
    const message = getErrorMessage(err).toLowerCase();
    return message.includes("has no upstream branch");
}

function parseSetUpstreamPushSuggestion(err: unknown): { remote: string; branch: string } | null {
    const message = getErrorMessage(err);
    const match = message.match(/git push\s+(?:--set-upstream(?:\s*=\s*|\s+)|-u\s+)(\S+)\s+(\S+)/);
    if (!match) return null;
    const remote = match[1]?.trim();
    const branch = match[2]?.trim();
    if (!remote || !branch) return null;
    return { remote, branch };
}
