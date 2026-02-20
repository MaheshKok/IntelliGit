// Returns the last non-empty segment of a path.
// Handles trailing slashes so "src/" yields "src".
export function getLeafName(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const leaf = trimmed.split("/").pop();
    if (leaf && leaf.length > 0) return leaf;
    return path;
}

export function getParentPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
}
