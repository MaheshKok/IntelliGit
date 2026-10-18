import { randomUUID } from "node:crypto";
import type { GitOps } from "../git/operations";
import {
    MAX_WORKING_STATS_PATH_BYTES,
    MAX_WORKING_STATS_PATHS,
    workingFileStatsPathBytes,
} from "../git/workingFileStats";
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
    private generation = 0;

    /** Invalidates pending read-only Git work without touching repository state. */
    dispose(): void {
        this.controller.abort();
        this.generation++;
        this.revision = "";
        this.rows.clear();
        this.pending.clear();
        this.loaded.clear();
    }

    /** Gives pending rows a fresh identity while preserving the ordinary small-tree payload. */
    reset(files: readonly WorkingFile[]): WorkingFile[] {
        this.controller.abort();
        this.generation++;
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
        const selected = [...new Set(paths as string[])].filter(
            (file) =>
                !pending.has(file) &&
                !loaded.has(file) &&
                this.rows.get(file)?.some((row) => row.statsState === "pending"),
        );
        if (!selected.length) return Promise.resolve();
        selected.forEach((file) => pending.add(file));
        const batches: string[][] = [];
        const oversized: string[] = [];
        let batch: string[] = [];
        for (const file of selected) {
            const fileRows = this.rows.get(file) ?? [];
            if (workingFileStatsPathBytes(fileRows) > MAX_WORKING_STATS_PATH_BYTES) {
                oversized.push(file);
                continue;
            }
            const candidate = [...batch, file];
            const candidateRows = candidate.flatMap((path) => this.rows.get(path) ?? []);
            if (
                batch.length >= MAX_WORKING_STATS_PATHS ||
                workingFileStatsPathBytes(candidateRows) > MAX_WORKING_STATS_PATH_BYTES
            ) {
                batches.push(batch);
                batch = [file];
            } else {
                batch = candidate;
            }
        }
        if (batch.length) batches.push(batch);
        const signal = this.controller.signal;
        const generation = this.generation;
        const current = () => generation === this.generation;
        const postTerminal = (files: WorkingFile[]): void => {
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
        };
        const operation = async (): Promise<void> => {
            try {
                if (!current()) return;
                if (oversized.length) {
                    oversized.forEach((file) => loaded.add(file));
                    postTerminal(
                        oversized.flatMap((file) =>
                            (this.rows.get(file) ?? []).map((row) => ({
                                ...row,
                                statsState: "unavailable" as const,
                            })),
                        ),
                    );
                }
                for (const paths of batches) {
                    if (!current()) return;
                    const rows = paths.flatMap((file) => this.rows.get(file) ?? []);
                    let files: WorkingFile[];
                    try {
                        files = await gitOps.getWorkingFileStats(rows, paths, signal);
                    } catch (error) {
                        if (!current()) return;
                        console.warn("[IntelliGit] Viewport statistics unavailable:", error);
                        files = rows.map((file) => ({
                            ...file,
                            statsState: "unavailable" as const,
                        }));
                    }
                    if (!current()) return;
                    paths.forEach((file) => loaded.add(file));
                    postTerminal(files);
                }
            } finally {
                selected.forEach((file) => pending.delete(file));
            }
        };
        this.queue = this.queue.catch(() => undefined).then(operation);
        return this.queue;
    }
}
