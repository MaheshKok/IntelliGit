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

declare const require: (id: string) => unknown;

const FIELD_SEP = "<<|>>";
const RECORD_SEP = "<<||>>";
const OUTPUT_CHANNEL_NAME = "IntelliGit";

type VsCodeApi = typeof import("vscode");
type OutputChannelLike = { appendLine: (value: string) => void };
type ConfirmSetUpstreamPush = (remote: string, branch: string) => Promise<boolean>;

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

function logGitOpsWarning(context: string, err: unknown, options?: { notifyUser?: boolean }): void {
    const channel = getOutputChannel();
    const message = getErrorMessage(err);
    channel.appendLine(`[GitOps] ${context}: ${message}`);
    if (err instanceof Error && err.stack) {
        channel.appendLine(sanitizeErrorMessage(err.stack));
    }
    if (options?.notifyUser) {
        const vscode = getVsCodeApi();
        if (vscode) {
            void vscode.window.showWarningMessage(
                `${context}. Some change stats may be unavailable.`,
            );
        }
    }
}

function assertStashIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid stash index: ${index}`);
    }
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

    async isRepository(): Promise<boolean> {
        try {
            await this.executor.run(["rev-parse", "--is-inside-work-tree"]);
            return true;
        } catch {
            return false;
        }
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
        const format =
            ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(FIELD_SEP) + RECORD_SEP;

        const args = ["log", `--max-count=${maxCount}`, `--pretty=format:${format}`];
        if (skip > 0) {
            args.push(`--skip=${skip}`);
        }

        if (branch) {
            args.push(branch);
        } else {
            args.push("--all");
        }

        if (filterText) {
            // Use --fixed-strings to treat the filter as a literal string,
            // preventing ReDoS via git's regex engine on user input.
            args.push(`--grep=${filterText}`, "-i", "--fixed-strings");
        }

        const result = await this.executor.run(args);
        const commits: Commit[] = [];

        for (const record of result.split(RECORD_SEP)) {
            const trimmed = record.trim();
            if (!trimmed) continue;

            const parts = trimmed.split(FIELD_SEP);
            if (parts.length < 7) continue;

            commits.push({
                hash: parts[0],
                shortHash: parts[1],
                message: parts[2],
                author: parts[3],
                email: parts[4],
                date: parts[5],
                parentHashes: parts[6] ? parts[6].split(" ").filter(Boolean) : [],
                refs: parts[7]
                    ? parts[7]
                          .split(",")
                          .map((r) => r.trim())
                          .filter(Boolean)
                    : [],
            });
        }
        return commits;
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
        const format = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(FIELD_SEP);

        const info = await this.executor.run(["show", `--format=${format}`, "--no-patch", hash]);
        const parts = info.trim().split(FIELD_SEP);

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
            logGitOpsWarning("Failed to get commit numstat", err, { notifyUser: true });
        }

        return {
            hash: parts[0] || hash,
            shortHash: parts[1] || hash.slice(0, 7),
            message: parts[2] || "",
            body: parts[3] || "",
            author: parts[4] || "",
            email: parts[5] || "",
            date: parts[6] || "",
            parentHashes: parts[7] ? parts[7].split(" ").filter(Boolean) : [],
            refs: parts[8]
                ? parts[8]
                      .split(",")
                      .map((r) => r.trim())
                      .filter(Boolean)
                : [],
            files: Array.from(filesByPath.values()),
        };
    }

    // --- Working tree operations ---

    async getStatus(): Promise<WorkingFile[]> {
        const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
        const files: WorkingFile[] = [];
        const entries = result.split("\0");
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry) continue;
            if (entry.length < 4) continue;

            const index = entry.charAt(0);
            const worktree = entry.charAt(1);
            const hasStaged = index !== " " && index !== "?";
            const hasUnstaged = worktree !== " ";

            const stagedStatus = mapStatusCode(index);
            const unstagedStatus = mapStatusCode(worktree);

            const path = entry.slice(3);
            if (!path) continue;

            const isRenameOrCopy =
                index === "R" || index === "C" || worktree === "R" || worktree === "C";
            if (isRenameOrCopy && i + 1 < entries.length) {
                // In porcelain -z output, rename/copy emits an extra NUL-terminated source path.
                i += 1;
            }

            if (hasStaged && hasUnstaged) {
                if (stagedStatus) {
                    files.push({
                        path,
                        status: stagedStatus,
                        staged: true,
                        additions: 0,
                        deletions: 0,
                    });
                }
                // Skip only unstaged "M" for newly added files (index === 'A').
                // A new file edited after staging is still just a new file —
                // the duplicate "M" row is misleading. Other unstaged statuses
                // (e.g. "D" for a staged-add then deleted) must still be shown.
                if (unstagedStatus && !(index === "A" && unstagedStatus === "M")) {
                    files.push({
                        path,
                        status: unstagedStatus,
                        staged: false,
                        additions: 0,
                        deletions: 0,
                    });
                }
            } else if (hasStaged && stagedStatus) {
                files.push({
                    path,
                    status: stagedStatus,
                    staged: true,
                    additions: 0,
                    deletions: 0,
                });
            } else if (hasUnstaged && unstagedStatus) {
                files.push({
                    path,
                    status: unstagedStatus,
                    staged: false,
                    additions: 0,
                    deletions: 0,
                });
            }
        }

        // Build keyed lookups for O(1) numstat matching (both value and index)
        const filesByKey = new Map<string, WorkingFile>();
        const filesIndexByKey = new Map<string, number>();
        for (let i = 0; i < files.length; i++) {
            const key = `${files[i].path}:${files[i].staged}`;
            filesByKey.set(key, files[i]);
            filesIndexByKey.set(key, i);
        }

        const applyNumstat = (output: string, staged: boolean, label: string): void => {
            try {
                for (const line of output.trim().split("\n")) {
                    if (!line.trim()) continue;
                    const cols = line.split("\t");
                    if (cols.length < 3) continue;
                    const add = cols[0];
                    const del = cols[1];
                    const filePath = cols[cols.length - 1];
                    const parsedAdd = add === "-" ? 0 : parseInt(add);
                    const parsedDel = del === "-" ? 0 : parseInt(del);
                    const key = `${filePath}:${staged}`;
                    const file = filesByKey.get(key);
                    if (file) {
                        const updated = {
                            ...file,
                            additions: Number.isNaN(parsedAdd) ? 0 : parsedAdd,
                            deletions: Number.isNaN(parsedDel) ? 0 : parsedDel,
                        };
                        filesByKey.set(key, updated);
                        const idx = filesIndexByKey.get(key);
                        if (idx !== undefined) files[idx] = updated;
                    }
                }
            } catch (err) {
                logGitOpsWarning(`Failed to get ${label} numstat`, err, { notifyUser: true });
            }
        };

        // Fetch unstaged and staged numstat in parallel
        const [unstagedStat, stagedStat] = await Promise.all([
            this.executor.run(["diff", "--numstat"]).catch((err) => {
                logGitOpsWarning("Failed to get unstaged numstat", err, { notifyUser: true });
                return "";
            }),
            this.executor.run(["diff", "--cached", "--numstat"]).catch((err) => {
                logGitOpsWarning("Failed to get staged numstat", err, { notifyUser: true });
                return "";
            }),
        ]);

        applyNumstat(unstagedStat, false, "unstaged");
        applyNumstat(stagedStat, true, "staged");

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

        const alreadyStagedDeleted = new Set<string>();
        const entries = status.split("\0");
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || entry.length < 4) continue;

            const index = entry.charAt(0);
            const worktree = entry.charAt(1);
            const path = entry.slice(3);
            if (!path) continue;

            const isRenameOrCopy =
                index === "R" || index === "C" || worktree === "R" || worktree === "C";
            if (isRenameOrCopy && i + 1 < entries.length) {
                i += 1;
            }

            if (index === "D" && worktree === " ") {
                alreadyStagedDeleted.add(path);
            }
        }

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
        await this.commit(message, amend);
        return this.push();
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

        const confirmLabel = "Set Upstream and Push";
        const selection = await vscode.window.showWarningMessage(
            `Branch '${branch}' has no upstream. Set upstream to '${remote}/${branch}' and push?`,
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
        const FIELD_SEP = "\x1f";
        const RECORD_SEP = "\x1e";
        const fmt = `%h%x1f%s%x1f%cI%x1e`;
        const parse = (output: string): AmendBranchCommitSummary[] => {
            const rows: AmendBranchCommitSummary[] = [];
            for (const record of output.split(RECORD_SEP)) {
                const trimmed = record.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(FIELD_SEP);
                if (parts.length < 3) continue;
                const shortHash = parts[0]?.trim() ?? "";
                const date = parts[parts.length - 1]?.trim() ?? "";
                const subject = parts.slice(1, -1).join(FIELD_SEP);
                if (shortHash) {
                    rows.push({ shortHash, subject, date });
                }
            }
            return rows;
        };

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
                        `--format=${fmt}`,
                    ]);
                    const parsed = parse(out);
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
                `--format=${fmt}`,
            ]);
            return parse(out);
        } catch {
            return [];
        }
    }

    async rollbackFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        // Restore working tree changes
        await this.executor.run(["checkout", "--", ...paths]);
    }

    async rollbackAll(): Promise<void> {
        await this.executor.run(["checkout", "."]);
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
            const entries: StashEntry[] = [];
            for (const line of result.trim().split("\n")) {
                if (!line.trim()) continue;
                const [hash, ref, message, date] = line.split("\t");
                const indexMatch = ref.match(/\{(\d+)\}/);
                entries.push({
                    index: indexMatch ? parseInt(indexMatch[1]) : entries.length,
                    message: message || "",
                    date: date || "",
                    hash: hash || "",
                });
            }
            return entries;
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

        return raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const [hash = "", shortHash = "", author = "", date = "", ...subjectParts] =
                    line.split("\t");
                return {
                    hash,
                    shortHash,
                    author,
                    date,
                    subject: subjectParts.join("\t"),
                };
            })
            .filter((entry) => entry.hash && entry.shortHash);
    }

    async getFileContentAtRef(filePath: string, ref: string): Promise<string> {
        const trimmedRef = ref.trim();
        const trimmedFilePath = filePath.trim();
        if (!trimmedRef) throw new Error("Git ref is empty.");
        if (!trimmedFilePath) throw new Error("File path is empty.");
        if (trimmedRef.startsWith("-")) {
            throw new Error("Git ref must not start with '-'.");
        }
        if (trimmedFilePath.startsWith("-")) {
            throw new Error("File path must not start with '-'.");
        }
        if (/[\0\r\n]/.test(trimmedRef)) {
            throw new Error("Git ref contains invalid control characters.");
        }
        if (/[\0\r\n]/.test(trimmedFilePath)) {
            throw new Error("File path contains invalid control characters.");
        }
        return this.executor.run(["show", `${trimmedRef}:${trimmedFilePath}`]);
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

const VALID_COMMIT_FILE_STATUSES = new Set<CommitFile["status"]>(["A", "M", "D", "R", "C", "T"]);

function mapCommitFileStatus(code: string): CommitFile["status"] {
    if (VALID_COMMIT_FILE_STATUSES.has(code as CommitFile["status"])) {
        return code as CommitFile["status"];
    }
    return "M";
}

function mapStatusCode(code: string): WorkingFile["status"] | null {
    switch (code) {
        case "M":
            return "M";
        case "A":
            return "A";
        case "D":
            return "D";
        case "R":
            return "R";
        case "C":
            return "C";
        case "?":
            return "?";
        case "U":
            return "U";
        case " ":
            return null;
        default:
            return "M";
    }
}

const UNMERGED_CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function isUnmergedConflictCode(code: string): boolean {
    return UNMERGED_CONFLICT_CODES.has(code);
}

function mapConflictSideState(code: string): MergeConflictFile["ours"] {
    if (code === "A") return "Added";
    if (code === "D") return "Deleted";
    return "Modified";
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
