/**
 * Derives the local directory name IntelliGit should use for a clone URL.
 *
 * The returned value is sanitized for a single path segment and falls back to
 * `repo` when the URL does not contain a usable repository name. This helper
 * accepts HTTPS and SSH-style clone URLs but does not validate host ownership.
 */
export function extractRepoName(cloneUrl: string): string {
    const cleaned = cloneUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const match = cleaned.match(/\/([^/]+)$/);
    if (match) return sanitizeRepoDirectoryName(match[1]);
    const segments = cleaned.split(/[:/]/);
    return sanitizeRepoDirectoryName(segments[segments.length - 1]);
}

/**
 * Normalizes a repository name candidate into the conservative path segment used for clone targets.
 *
 * Slash separators, control characters, and shell-hostile punctuation are removed
 * instead of escaped because callers pass the result to `path.join` as a new
 * directory name, not as a display label.
 */
function sanitizeRepoDirectoryName(value: string | undefined): string {
    const sanitized = (value ?? "")
        .replace(/[\\/]/g, "")
        .split("")
        .filter((char) => {
            const code = char.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .trim();
    if (!sanitized || sanitized === "." || sanitized === "..") return "repo";
    return sanitized;
}
