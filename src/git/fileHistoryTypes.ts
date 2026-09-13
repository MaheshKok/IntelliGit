/** A file change with the path belonging to that revision, including rename ancestry. */
export interface FileHistoryEntry {
    hash: string;
    parents: string[];
    /** Current local ref names pointing to this commit; annotated tags use their peeled target. */
    refs?: { name: string; kind: "tag" | "branch" | "remote" }[];
    subject: string;
    authorName: string;
    authorEmail: string;
    authoredAt: string;
    committerName: string;
    committerEmail: string;
    committedAt: string;
    pathAtRevision: string;
    previousPath?: string;
    status: "added" | "modified" | "deleted" | "renamed" | "type-changed";
}
