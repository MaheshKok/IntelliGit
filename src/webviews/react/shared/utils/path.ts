export function getLeafName(path: string): string {
    const leaf = path.split("/").pop();
    if (leaf && leaf.length > 0) return leaf;
    return path;
}

export function getParentPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
}
