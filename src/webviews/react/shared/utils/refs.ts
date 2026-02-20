export interface SplitCommitRefs {
    branches: string[];
    tags: string[];
}

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

export function stripTagPrefix(ref: string): string {
    return ref.startsWith("tag:") ? ref.slice(4).trim() : ref;
}

export function withTagPrefix(tag: string): string {
    if (tag.startsWith("tag:")) return tag;
    return `tag:${tag}`;
}
