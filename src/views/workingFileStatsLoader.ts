import { randomUUID } from "node:crypto";
import type { GitOps } from "../git/operations";
import { MAX_WORKING_STATS_PATHS } from "../git/workingFileStats";
import type { WorkingFile } from "../types";
import type { WorkingFileStatsReply } from "../webviews/protocol/workingFileStats";

/** One bounded read queue per displayed repository; refresh invalidates every queued continuation. */
export class WorkingFileStatsLoader {
    private revision = "";
    private rows = new Map<string, WorkingFile[]>();
    private pending = new Set<string>();
    private loaded = new Set<string>();
    private controller = new AbortController();
    private queue: Promise<void> = Promise.resolve();

    /** Invalidates pending read-only Git work without touching repository state. */
    dispose(): void {
        this.controller.abort();
        this.revision = "";
        this.rows.clear();
        this.pending.clear();
        this.loaded.clear();
    }

    /** Gives pending rows a fresh identity while preserving the ordinary small-tree payload. */
    reset(files: readonly WorkingFile[]): WorkingFile[] {
        this.controller.abort();
        this.controller = new AbortController();
        this.revision = randomUUID();
        this.pending = new Set();
        this.loaded = new Set();
        this.rows = new Map();
        this.queue = Promise.resolve();
        return files.map((file) => {
            const row =
                file.statsState === "pending" ? { ...file, statsRevision: this.revision } : file;
            const rows = this.rows.get(file.path) ?? [];
            rows.push(row);
            this.rows.set(file.path, rows);
            return row;
        });
    }

    /** Deduplicates concurrent panes and bounds both queued paths and Git subprocess fan-out. */
    request(
        revision: unknown,
        paths: unknown,
        root: string,
        gitOps: Pick<GitOps, "getWorkingFileStats">,
        deliver: (reply: WorkingFileStatsReply) => void,
    ): Promise<void> {
        if (revision !== this.revision) return Promise.resolve();
        if (
            !Array.isArray(paths) ||
            paths.length > MAX_WORKING_STATS_PATHS ||
            paths.some((file) => typeof file !== "string" || !this.rows.has(file))
        )
            return Promise.reject(new Error("Invalid working-file statistics request."));
        const pending = this.pending;
        const loaded = this.loaded;
        const selected = [...new Set(paths as string[])]
            .filter(
                (file) =>
                    !pending.has(file) &&
                    !loaded.has(file) &&
                    this.rows.get(file)?.some((row) => row.statsState === "pending"),
            )
            .slice(0, Math.max(0, 512 - pending.size));
        if (!selected.length) return Promise.resolve();
        selected.forEach((file) => pending.add(file));
        const rows = selected.flatMap((file) => this.rows.get(file) ?? []);
        const signal = this.controller.signal;
        const current = () => !signal.aborted && revision === this.revision;
        const operation = async (): Promise<void> => {
            try {
                if (!current()) return;
                let files: WorkingFile[];
                try {
                    files = await gitOps.getWorkingFileStats(rows, selected, signal);
                } catch (error) {
                    if (!current()) return;
                    console.warn("[IntelliGit] Viewport statistics unavailable:", error);
                    files = rows.map((file) => ({ ...file, statsState: "unavailable" }));
                }
                if (!current()) return;
                selected.forEach((file) => loaded.add(file));
                deliver({
                    type: "workingFileStats",
                    repositoryRoot: root,
                    revision: this.revision,
                    files: files.map(({ path, staged, additions, deletions, statsState }) => ({
                        path,
                        staged,
                        additions,
                        deletions,
                        statsState,
                    })),
                });
            } finally {
                selected.forEach((file) => pending.delete(file));
            }
        };
        this.queue = this.queue.catch(() => undefined).then(operation);
        return this.queue;
    }
}
