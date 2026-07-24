import type { WorkingFile } from "../types";
import { mapStatusCode } from "./parsers";

function upsertStashFile(
    files: Map<string, WorkingFile>,
    path: string,
    status: WorkingFile["status"] = "M",
): WorkingFile {
    const existing = files.get(path);
    if (existing) return existing;
    const created: WorkingFile = { path, status, staged: false, additions: 0, deletions: 0 };
    files.set(path, created);
    return created;
}

/**
 * Applies NUL-separated name-status fields, using the destination path for rename/copy rows.
 *
 * Git emits status and paths as separate fields under `-z`, so path whitespace and newlines remain
 * literal. Truncated rows are ignored, preserving any metadata parsed from the other stash probes.
 */
function applyNameStatus(files: Map<string, WorkingFile>, output: string): void {
    const fields = output.split("\0");
    for (let index = 0; index < fields.length; ) {
        const code = fields[index++];
        if (!code) continue;
        const sourcePath = fields[index++];
        if (sourcePath === undefined) break;
        const path = code.startsWith("R") || code.startsWith("C") ? fields[index++] : sourcePath;
        if (!path) continue;
        upsertStashFile(files, path, mapStatusCode(code[0]) ?? "M");
    }
}

/**
 * Applies NUL-separated numstat records without decoding or trimming literal path bytes.
 *
 * Normal rows contain the path after two tab-separated counts. Rename/copy rows leave that path
 * empty and append source/destination NUL fields; stats attach to the destination path.
 */
function applyNumstat(files: Map<string, WorkingFile>, output: string): void {
    const records = output.split("\0");
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        // These are string delimiter lookups, not repeated array scans.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        const firstTab = record.indexOf("\t");
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        const secondTab = record.indexOf("\t", firstTab + 1);
        if (firstTab < 0 || secondTab < 0) continue;
        let path = record.slice(secondTab + 1);
        if (!path) {
            index += 2;
            path = records[index];
        }
        if (!path) continue;
        const entry = upsertStashFile(files, path);
        files.set(path, {
            ...entry,
            additions:
                record.slice(0, firstTab) === "-" ? 0 : Number(record.slice(0, firstTab)) || 0,
            deletions:
                record.slice(firstTab + 1, secondTab) === "-"
                    ? 0
                    : Number(record.slice(firstTab + 1, secondTab)) || 0,
        });
    }
}

/**
 * Applies Git's NUL-separated `--only-untracked --name-only` output without normalizing paths.
 *
 * The listing is authoritative for untracked classification: matching metadata rows become `?`,
 * while entries absent from name-status and numstat are added with zero change counts.
 */
function applyUntrackedPaths(files: Map<string, WorkingFile>, output: string): void {
    for (const path of output.split("\0")) {
        if (!path) continue;
        const entry = upsertStashFile(files, path, "?");
        files.set(path, { ...entry, status: "?" });
    }
}

/**
 * Combines `git stash show` metadata and optional untracked-path output into stashed files.
 *
 * NUL-separated name-status supplies the file set and status codes, while NUL-separated numstat
 * fills additions and deletions. When available, `--only-untracked --name-only -z` paths override
 * status classification. No path source is trimmed, so whitespace and newlines remain literal.
 * Missing or partial output is tolerated so callers can display metadata from successful probes.
 */
export function parseStashFiles(
    nameStatus: string,
    numstat: string,
    untrackedPaths: string = "",
): WorkingFile[] {
    const files = new Map<string, WorkingFile>();
    applyNameStatus(files, nameStatus);
    applyNumstat(files, numstat);
    applyUntrackedPaths(files, untrackedPaths);
    return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}
