import type { WorkingFile } from "../types";
import { normalizeGitNumstatPath } from "./numstat";
import { mapStatusCode } from "./parsers";

function upsertShelvedFile(
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

function applyNameStatus(files: Map<string, WorkingFile>, output: string): void {
    for (const line of output.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const code = parts[0].trim();
        const path =
            code.startsWith("R") || code.startsWith("C")
                ? (parts[2]?.trim() ?? parts[1]?.trim())
                : parts[1]?.trim();
        if (!path) continue;
        upsertShelvedFile(files, path, mapStatusCode(code[0]) ?? "M");
    }
}

function applyNumstat(files: Map<string, WorkingFile>, output: string): void {
    for (const line of output.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const path = normalizeGitNumstatPath(parts[2]);
        if (!path) continue;
        const entry = upsertShelvedFile(files, path);
        files.set(path, {
            ...entry,
            additions: parts[0] === "-" ? 0 : Number(parts[0]) || 0,
            deletions: parts[1] === "-" ? 0 : Number(parts[1]) || 0,
        });
    }
}

/**
 * Combines `git stash show --name-status` and `--numstat` output into shelved files.
 *
 * Name-status supplies the file set and status codes, while numstat fills additions
 * and deletions. Missing or partial output is tolerated so callers can display the
 * data Git returned after logging warning-worthy failures.
 */
export function parseShelvedFiles(nameStatus: string, numstat: string): WorkingFile[] {
    const files = new Map<string, WorkingFile>();
    applyNameStatus(files, nameStatus);
    applyNumstat(files, numstat);
    return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}
