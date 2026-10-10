import * as path from "node:path";

/** Validates a repository-relative filename and returns Git's portable slash representation. */
export function assertRepoRelativePath(filePath: string): string {
    if (!filePath || path.isAbsolute(filePath)) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (filePath.includes("\0") || filePath.includes("\r") || filePath.includes("\n")) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = path.normalize(filePath);
    if (normalized === ".") throw new Error(`Rejected repo root path: ${filePath}`);
    if (normalized.split(path.sep).some((segment) => segment === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    return normalized.split(path.sep).join("/");
}
