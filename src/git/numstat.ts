/**
 * Normalizes the path column emitted by Git `--numstat` into the destination path.
 *
 * Git formats renames either as braced ranges such as `src/{old => new}.ts` or
 * as an arrow suffix. The returned path keeps the post-change side so stats can
 * be merged with name-status rows that also address the destination path.
 */
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
