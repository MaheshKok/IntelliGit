/**
 * Returns the last non-empty segment of a slash-separated path.
 *
 * Trailing slashes are ignored so `src/` yields `src`, while empty or root-like
 * inputs fall back to the original value.
 */
export function getLeafName(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const leaf = trimmed.split("/").pop();
    if (leaf && leaf.length > 0) return leaf;
    return path;
}

/** Returns the slash-separated parent path, or an empty string for root-level paths. */
export function getParentPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
}
