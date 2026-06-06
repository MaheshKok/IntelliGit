export function normalizeGitNumstatPath(path: string): string {
    const trimmed = path.trim();
    const bracedRename = trimmed.match(/^(.*)\{([^{}]*?)\s*=>\s*([^{}]*?)\}(.*)$/);
    if (bracedRename) {
        const [, prefix, , destination, suffix] = bracedRename;
        return `${prefix}${destination.trim()}${suffix}`.trim();
    }

    const arrowIndex = trimmed.lastIndexOf("=>");
    if (arrowIndex >= 0) {
        return trimmed.slice(arrowIndex + 2).trim();
    }

    return trimmed;
}
