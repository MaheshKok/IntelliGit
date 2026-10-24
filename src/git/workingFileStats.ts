import type { GitExecutor } from "./executor";
import type { WorkingFile } from "../types";

/** Small trees retain their eager counts and unchanged layout. */
export const LAZY_WORKING_FILE_THRESHOLD = 200;
/** Bounds one viewport request before path expansion or a Git subprocess. */
export const MAX_WORKING_STATS_PATHS = 128;
/** Bounds the literal pathspec bytes sent to one Git statistics request. */
export const MAX_WORKING_STATS_PATH_BYTES = 64 * 1024;

/** Returns the deduplicated literal pathspec byte cost, including rename sources. */
export function workingFileStatsPathBytes(files: readonly WorkingFile[]): number {
    return [...workingFileStatsLiteralPaths(files)].reduce(
        (sum, file) => sum + Buffer.byteLength(file) + 1,
        0,
    );
}

/** Reads the index path and HEAD object; a repository without commits reports HEAD as "unborn". */
export async function readWorkingFileStatsBasis(
    executor: GitExecutor,
): Promise<{ indexPath: string; head: string }> {
    const lines = (args: string[]) =>
        executor
            .run(["rev-parse", "--git-path", "index", ...args])
            .then((output) => output.trim().split(/\r?\n/));
    // `--verify --quiet HEAD` exits non-zero only when HEAD names no commit yet.
    const [indexPath, head] = await lines(["--verify", "--quiet", "HEAD"]).catch(async () => [
        ...(await lines([])),
        "unborn",
    ]);
    if (!indexPath || !head) throw new Error("Working-file statistics basis is unavailable.");
    return { indexPath, head };
}

/** Reads bounded, literal path batches from a trusted status snapshot, never another status scan. */
export async function readWorkingFileStats(
    executor: GitExecutor,
    files: readonly WorkingFile[],
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingFile[]> {
    if (paths.length > MAX_WORKING_STATS_PATHS)
        throw new Error("Too many paths in a working-file statistics request.");
    if (!paths.length) return [];
    const known = new Set(files.map((file) => file.path));
    if (paths.some((file) => typeof file !== "string" || !known.has(file)))
        throw new Error("Working-file statistics require a known status path.");
    const requested = new Set(paths);
    const selected = files
        .filter((file) => requested.has(file.path))
        .map((file) => ({ ...file, additions: 0, deletions: 0, statsState: "ready" as const }));
    const tracked = selected.filter((file) => file.status !== "?" && file.status !== "!");
    if (!tracked.length) return selected;
    const literals = workingFileStatsLiteralPaths(tracked);
    if (workingFileStatsPathBytes(tracked) > MAX_WORKING_STATS_PATH_BYTES)
        throw new Error("Working-file statistics exceed the path byte budget.");
    const deadline = AbortSignal.timeout(10_000);
    const settled = await Promise.allSettled(
        [false, true].map(async (staged) => {
            const result = await executor.runBinary(
                [
                    // Else a stat-dirty path makes Git rewrite the whole index under index.lock.
                    "-c",
                    "diff.autoRefreshIndex=false",
                    "--literal-pathspecs",
                    "diff",
                    ...(staged ? ["--cached"] : []),
                    "--numstat",
                    "-z",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--",
                    ...literals,
                ],
                {
                    maxOutputBytes: 1024 * 1024,
                    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
                },
            );
            if (result.truncated)
                throw new Error("Working-file statistics exceeded their output budget.");
            return { staged, values: parseNulNumstat(result.stdout.toString("utf8")) };
        }),
    );
    const results = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
    });
    return selected.map((file) => {
        const counts = results
            .find((result) => result.staged === file.staged)
            ?.values.get(file.path);
        return counts ? { ...file, ...counts } : file;
    });
}

/** Collects the exact literal pathspecs Git receives for tracked status rows. */
function workingFileStatsLiteralPaths(files: readonly WorkingFile[]): Set<string> {
    return new Set(
        files
            .filter((file) => file.status !== "?" && file.status !== "!")
            .flatMap((file) => [file.path, ...(file.sourcePath ? [file.sourcePath] : [])]),
    );
}

/** Parses literal NUL numstat output, including rename source and destination fields. */
function parseNulNumstat(output: string): Map<string, { additions: number; deletions: number }> {
    const values = new Map<string, { additions: number; deletions: number }>();
    const fields = output.split("\0");
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (!field) continue;
        const first = field.indexOf("\t");
        const second = field.indexOf("\t", first + 1);
        if (first < 0 || second < 0) throw new Error("Invalid NUL-delimited Git statistics.");
        const added = field.slice(0, first);
        const removed = field.slice(first + 1, second);
        if (![added, removed].every((count) => count === "-" || /^\d+$/.test(count)))
            throw new Error("Invalid Git line counts.");
        let file = field.slice(second + 1);
        if (!file) {
            if (!fields[index + 1] || !fields[index + 2])
                throw new Error("Incomplete Git rename statistics.");
            file = fields[index + 2];
            index += 2;
        }
        values.set(file, {
            additions: added === "-" ? 0 : Number(added),
            deletions: removed === "-" ? 0 : Number(removed),
        });
    }
    return values;
}
