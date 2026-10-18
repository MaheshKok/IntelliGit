import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitOps } from "../git/operations";
import {
    MAX_WORKING_STATS_PATH_BYTES,
    MAX_WORKING_STATS_PATHS,
    workingFileStatsPathBytes,
} from "../git/workingFileStats";
import type { WorkingFile } from "../types";
import type { WorkingFileStatsReply } from "../webviews/protocol/workingFileStats";

/** The index, HEAD and on-disk file state one refresh saw. */
export interface WorkingFileStatsBasis {
    repository: string;
    files: Map<string, string>;
}

interface CachedCount {
    fingerprint: string;
    additions: number;
    deletions: number;
}

const rowKey = (file: WorkingFile): string => `${file.path}\0${file.staged}`;

// shortcut: a same-size edit inside one timestamp tick keeps the old count on coarse-clock file
// systems (FAT, HFS+); upgrade to comparing content hashes if that ever shows up.
const diskState = (root: string, file: string): Promise<string> =>
    stat(join(root, file), { bigint: true }).then(
        (entry) => `${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`,
        () => "missing",
    );

/**
 * One bounded read queue per displayed repository. A refresh drops queued batches, but a running
 * read finishes and its counts are kept while the row's status, file, index and HEAD are unchanged.
 */
export class WorkingFileStatsLoader {
    private revision = "";
    private rows = new Map<string, WorkingFile[]>();
    private pending = new Set<string>();
    private loaded = new Set<string>();
    private controller = new AbortController();
    private queue: Promise<void> = Promise.resolve();
    private generation = 0;
    private repository: string | undefined;
    private disk = new Map<string, string>();
    private cache = new Map<string, CachedCount>();
    private reading = new Set<string>();

    /** Invalidates pending read-only Git work without touching repository state. */
    dispose(): void {
        this.controller.abort();
        this.controller = new AbortController();
        this.generation++;
        this.revision = "";
        this.rows.clear();
        this.pending.clear();
        this.loaded.clear();
        this.repository = undefined;
        this.disk.clear();
        this.cache.clear();
    }

    /** Reads what decides whether finished counts still hold; undefined means recount everything. */
    async capture(
        files: readonly WorkingFile[],
        gitOps: Pick<GitOps, "getWorkingFileStatsBasis">,
        root: string,
    ): Promise<WorkingFileStatsBasis | undefined> {
        if (!files.some((file) => file.statsState === "pending")) return undefined;
        try {
            const { indexPath, head } = await gitOps.getWorkingFileStatsBasis();
            const index = await stat(resolve(root, indexPath), { bigint: true });
            const known = new Set(
                files
                    .filter(
                        (file) =>
                            file.statsState === "pending" &&
                            (this.reading.has(file.path) || this.cache.has(rowKey(file))),
                    )
                    .map((file) => file.path),
            );
            return {
                repository: `${head}\0${index.ino}:${index.size}:${index.mtimeNs}:${index.ctimeNs}`,
                files: new Map(
                    await Promise.all(
                        [...known].map(
                            async (file) => [file, await diskState(root, file)] as const,
                        ),
                    ),
                ),
            };
        } catch {
            return undefined;
        }
    }

    /** Gives pending rows a fresh identity and fills in counts that provably still hold. */
    reset(files: readonly WorkingFile[], basis?: WorkingFileStatsBasis): WorkingFile[] {
        this.generation++;
        this.revision = randomUUID();
        this.pending = new Set();
        this.loaded = new Set();
        this.rows = new Map();
        this.repository = basis?.repository;
        this.disk = basis?.files ?? new Map<string, string>();
        const kept = new Map<string, CachedCount>();
        const result = files.map((file) => {
            let row = file;
            if (file.statsState === "pending") {
                const cached = this.cache.get(rowKey(file));
                const fingerprint = this.fingerprint(file, this.repository, this.disk);
                if (cached && cached.fingerprint === fingerprint) {
                    kept.set(rowKey(file), cached);
                    row = {
                        ...file,
                        additions: cached.additions,
                        deletions: cached.deletions,
                        statsState: "ready",
                    };
                } else {
                    row = { ...file, statsRevision: this.revision };
                }
            }
            const rows = this.rows.get(file.path) ?? [];
            rows.push(row);
            this.rows.set(file.path, rows);
            return row;
        });
        this.cache = kept;
        return result;
    }

    /** Keeps finished counts under the state read before Git ran. */
    private remember(
        ready: readonly WorkingFile[],
        repository: string | undefined,
        disk: ReadonlyMap<string, string>,
    ): void {
        for (const file of ready) {
            const fingerprint = this.fingerprint(file, repository, disk);
            if (fingerprint !== undefined)
                this.cache.set(rowKey(file), {
                    fingerprint,
                    additions: file.additions,
                    deletions: file.deletions,
                });
        }
    }

    /** A refresh ran during the read: answers every pending path whose rows it saw unchanged. */
    private carry(
        paths: readonly string[],
        ready: readonly WorkingFile[],
        repository: string | undefined,
        disk: ReadonlyMap<string, string>,
    ): WorkingFile[] {
        const answers = new Map(ready.map((file) => [rowKey(file), file]));
        return paths.flatMap((file) => {
            const now = (this.rows.get(file) ?? []).filter((row) => row.statsState === "pending");
            const answered = now.flatMap((row) => {
                const answer = answers.get(rowKey(row));
                if (!answer) return [];
                const before = this.fingerprint(answer, repository, disk);
                return before !== undefined &&
                    before === this.fingerprint(row, this.repository, this.disk)
                    ? [answer]
                    : [];
            });
            if (!now.length || answered.length !== now.length) return [];
            this.loaded.add(file);
            return answered;
        });
    }

    private fingerprint(
        file: WorkingFile,
        repository: string | undefined,
        disk: ReadonlyMap<string, string>,
    ): string | undefined {
        const state = disk.get(file.path);
        if (repository === undefined || state === undefined) return undefined;
        return `${repository}\0${file.status}\0${file.sourcePath ?? ""}\0${state}`;
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
        const repository = this.repository;
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
                for (const batchPaths of batches) {
                    if (!current()) return;
                    // An earlier refresh's read may already have answered these.
                    const paths = batchPaths.filter((file) => !loaded.has(file));
                    if (!paths.length) continue;
                    const rows = paths.flatMap((file) => this.rows.get(file) ?? []);
                    // Read the file state before Git, so a later edit can only invalidate the count.
                    const disk =
                        repository === undefined
                            ? new Map<string, string>()
                            : new Map(
                                  await Promise.all(
                                      paths.map(
                                          async (file) =>
                                              [file, await diskState(root, file)] as const,
                                      ),
                                  ),
                              );
                    if (!current()) return;
                    let files: WorkingFile[];
                    paths.forEach((file) => this.reading.add(file));
                    try {
                        files = await gitOps.getWorkingFileStats(rows, paths, signal);
                    } catch (error) {
                        if (!current()) return;
                        console.warn("[IntelliGit] Viewport statistics unavailable:", error);
                        files = rows.map((file) => ({
                            ...file,
                            statsState: "unavailable" as const,
                        }));
                    } finally {
                        paths.forEach((file) => this.reading.delete(file));
                    }
                    const ready = files.filter((file) => file.statsState === "ready");
                    this.remember(ready, repository, disk);
                    if (!current()) {
                        const carried = this.carry(paths, ready, repository, disk);
                        if (carried.length) postTerminal(carried);
                        return;
                    }
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
