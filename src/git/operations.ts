import { GitExecutor } from "./executor";
import type { Branch, Commit, CommitDetail, CommitFile, WorkingFile, StashEntry } from "../types";

const FIELD_SEP = "<<|>>";
const RECORD_SEP = "<<||>>";

export class GitOps {
    constructor(private readonly executor: GitExecutor) {}

    async isRepository(): Promise<boolean> {
        try {
            await this.executor.run(["rev-parse", "--is-inside-work-tree"]);
            return true;
        } catch {
            return false;
        }
    }

    async getBranches(): Promise<Branch[]> {
        const format =
            "%(refname)\t%(refname:short)\t%(objectname:short)\t%(upstream:track,nobracket)\t%(HEAD)";
        const result = await this.executor.run(["branch", "-a", `--format=${format}`]);

        const branches: Branch[] = [];
        for (const line of result.trim().split("\n")) {
            if (!line.trim()) continue;
            const [refname, name, hash, track, head] = line.split("\t");

            const isRemote = refname.startsWith("refs/remotes/");

            // Skip symbolic refs like origin/HEAD (refname:short resolves to just "origin")
            if (refname.endsWith("/HEAD")) continue;

            let remote: string | undefined;
            if (isRemote) {
                // refname:short for remote is "origin/main", first segment is the remote name
                remote = name.split("/")[0];
            }

            let ahead = 0,
                behind = 0;
            if (track) {
                const a = track.match(/ahead (\d+)/);
                const b = track.match(/behind (\d+)/);
                if (a) ahead = parseInt(a[1]);
                if (b) behind = parseInt(b[1]);
            }

            branches.push({ name, hash, isRemote, isCurrent: head === "*", remote, ahead, behind });
        }
        return branches;
    }

    async getLog(maxCount: number = 500, branch?: string, filterText?: string): Promise<Commit[]> {
        const format =
            ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(FIELD_SEP) + RECORD_SEP;

        const args = ["log", `--max-count=${maxCount}`, `--pretty=format:${format}`];

        if (branch) {
            args.push(branch);
        } else {
            args.push("--all");
        }

        if (filterText) {
            args.push(`--grep=${filterText}`, "-i");
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

    async getCommitDetail(hash: string): Promise<CommitDetail> {
        const format = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(FIELD_SEP);

        const info = await this.executor.run(["show", `--format=${format}`, "--no-patch", hash]);
        const parts = info.trim().split(FIELD_SEP);

        const nameStatus = await this.executor.run([
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--name-status",
            hash,
        ]);

        const files: CommitFile[] = [];
        for (const line of nameStatus.trim().split("\n")) {
            if (!line.trim()) continue;
            const cols = line.split("\t");
            if (cols.length >= 2) {
                files.push({
                    path: cols[cols.length - 1],
                    status: cols[0].charAt(0) as CommitFile["status"],
                    additions: 0,
                    deletions: 0,
                });
            }
        }

        try {
            const numstat = await this.executor.run([
                "diff-tree",
                "--no-commit-id",
                "-r",
                "--numstat",
                hash,
            ]);
            for (const line of numstat.trim().split("\n")) {
                if (!line.trim()) continue;
                const [add, del, filePath] = line.split("\t");
                const file = files.find((f) => f.path === filePath);
                if (file) {
                    file.additions = add === "-" ? 0 : parseInt(add);
                    file.deletions = del === "-" ? 0 : parseInt(del);
                }
            }
        } catch {
            /* numstat may fail for binary files */
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
            files,
        };
    }

    // --- Working tree operations ---

    async getStatus(): Promise<WorkingFile[]> {
        const result = await this.executor.run(["status", "--porcelain=v1", "-uall"]);
        const files: WorkingFile[] = [];

        for (const line of result.split("\n")) {
            if (!line) continue;
            const index = line.charAt(0);
            const worktree = line.charAt(1);
            const path = line.slice(3).trim();
            if (!path) continue;

            // Determine status and staged state
            const staged = index !== " " && index !== "?";
            let status: WorkingFile["status"];
            const code = staged ? index : worktree;
            switch (code) {
                case "M":
                    status = "M";
                    break;
                case "A":
                    status = "A";
                    break;
                case "D":
                    status = "D";
                    break;
                case "R":
                    status = "R";
                    break;
                case "C":
                    status = "C";
                    break;
                case "?":
                    status = "?";
                    break;
                case "U":
                    status = "U";
                    break;
                default:
                    status = "M";
                    break;
            }

            // If both index and worktree have changes, emit two entries
            if (index !== " " && index !== "?" && worktree !== " ") {
                files.push({ path, status, staged: true, additions: 0, deletions: 0 });
                files.push({ path, status, staged: false, additions: 0, deletions: 0 });
            } else {
                files.push({ path, status, staged, additions: 0, deletions: 0 });
            }
        }

        // Get numstat for unstaged changes
        try {
            const diffStat = await this.executor.run(["diff", "--numstat"]);
            for (const line of diffStat.trim().split("\n")) {
                if (!line.trim()) continue;
                const [add, del, filePath] = line.split("\t");
                const file = files.find((f) => f.path === filePath && !f.staged);
                if (file) {
                    file.additions = add === "-" ? 0 : parseInt(add);
                    file.deletions = del === "-" ? 0 : parseInt(del);
                }
            }
        } catch {
            /* ignore */
        }

        // Get numstat for staged changes
        try {
            const stagedStat = await this.executor.run(["diff", "--cached", "--numstat"]);
            for (const line of stagedStat.trim().split("\n")) {
                if (!line.trim()) continue;
                const [add, del, filePath] = line.split("\t");
                const file = files.find((f) => f.path === filePath && f.staged);
                if (file) {
                    file.additions = add === "-" ? 0 : parseInt(add);
                    file.deletions = del === "-" ? 0 : parseInt(del);
                }
            }
        } catch {
            /* ignore */
        }

        return files;
    }

    async stageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.executor.run(["add", "--", ...paths]);
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
        return this.executor.run(["push"]);
    }

    async commitAndPush(message: string, amend: boolean = false): Promise<string> {
        await this.commit(message, amend);
        return this.push();
    }

    async getLastCommitMessage(): Promise<string> {
        try {
            return (await this.executor.run(["log", "-1", "--format=%B"])).trim();
        } catch {
            return "";
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

    // --- Stash (Shelf) operations ---

    async stashSave(message: string, paths?: string[]): Promise<string> {
        const args = ["stash", "push", "-m", message];
        if (paths && paths.length > 0) {
            args.push("--", ...paths);
        }
        return this.executor.run(args);
    }

    async stashPop(index: number = 0): Promise<string> {
        return this.executor.run(["stash", "pop", `stash@{${index}}`]);
    }

    async stashApply(index: number = 0): Promise<string> {
        return this.executor.run(["stash", "apply", `stash@{${index}}`]);
    }

    async stashList(): Promise<StashEntry[]> {
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

    async stashDrop(index: number): Promise<string> {
        return this.executor.run(["stash", "drop", `stash@{${index}}`]);
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

    async deleteFile(filePath: string): Promise<void> {
        await this.executor.run(["rm", "-f", "--", filePath]);
    }
}
