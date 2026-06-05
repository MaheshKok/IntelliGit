export function extractRepoName(cloneUrl: string): string {
    const cleaned = cloneUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const match = cleaned.match(/\/([^/]+)$/);
    if (match) return sanitizeRepoDirectoryName(match[1]);
    const segments = cleaned.split(/[:/]/);
    return sanitizeRepoDirectoryName(segments[segments.length - 1]);
}

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
