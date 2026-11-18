import * as path from "node:path";

/** Validates a repository-relative filename and returns Git's portable slash representation. */
export function assertRepoRelativePath(filePath: string): string {
    if (!filePath || path.isAbsolute(filePath)) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (/[\0\r\n]/.test(filePath)) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = path.normalize(filePath);
    if (normalized === ".") throw new Error(`Rejected repo root path: ${filePath}`);
    if (normalized.split(path.sep).some((segment) => segment === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    return normalized.split(path.sep).join("/");
}

/**
 * Checks a name Git itself listed by Git's own rules and returns it unchanged: `/` separates its
 * segments on every platform and a backslash is part of a name, so it is never normalized by the
 * host's path rules. Git allows a newline in a filename, so a line break is accepted (a NUL is not).
 */
export function assertListedRepoRelativePath(filePath: string): string {
    if (!filePath || filePath.startsWith("/")) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (filePath.includes("\0")) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const segments = filePath.split("/");
    if (segments.includes("..")) throw new Error(`Rejected path escaping repo root: ${filePath}`);
    if (segments.some((segment) => segment === "" || segment === ".")) {
        throw new Error(`Rejected path Git never lists: ${filePath}`);
    }
    return filePath;
}
