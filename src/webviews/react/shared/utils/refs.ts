/** Branch and tag references split for badge rendering in commit rows and tooltips. */
export interface SplitCommitRefs {
    branches: string[];
    tags: string[];
}

/**
 * Splits Git decoration refs into branch names and tag names.
 *
 * The parser preserves branch strings as provided by the backend and only treats
 * refs prefixed with `tag:` as tags, trimming the tag label after the prefix.
 */
export function splitCommitRefs(refs: string[]): SplitCommitRefs {
    const branches: string[] = [];
    const tags: string[] = [];
    for (const ref of refs) {
        if (ref.startsWith("tag:")) {
            tags.push(ref.slice(4).trim());
        } else {
            branches.push(ref);
        }
    }
    return { branches, tags };
}
