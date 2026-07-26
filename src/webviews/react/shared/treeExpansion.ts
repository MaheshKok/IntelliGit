/** Composite key so independent file subtrees cannot share collapse state. */
export function directoryKey(id: string, dirPath: string): string {
    return `${id}\n${dirPath}`;
}

/** Returns a copy of the set with `key` added when absent and removed when present. */
export function toggleMember(current: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
}
