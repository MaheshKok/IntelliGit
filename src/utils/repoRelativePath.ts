import * as path from "node:path";

/** Validates a repository-relative filename and returns Git's portable slash representation. */
export function assertRepoRelativePath(filePath: string): string {
    return validateRepoRelativePath(filePath, false);
}

/**
 * Same checks for a name Git itself listed: Git allows a newline in a filename, so a line break
 * is not a control character here (a NUL still is).
 */
export function assertListedRepoRelativePath(filePath: string): string {
    return validateRepoRelativePath(filePath, true);
}

function validateRepoRelativePath(filePath: string, allowLineBreaks: boolean): string {
    if (!filePath || path.isAbsolute(filePath)) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (filePath.includes("\0") || (!allowLineBreaks && /[\r\n]/.test(filePath))) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = path.normalize(filePath);
    if (normalized === ".") throw new Error(`Rejected repo root path: ${filePath}`);
    if (normalized.split(path.sep).some((segment) => segment === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    return normalized.split(path.sep).join("/");
}
