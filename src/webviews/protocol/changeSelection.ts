/** One host-parsed line in an immutable ordinary-text diff. */
export interface ChangeLine {
    id: string;
    fingerprint: string;
    kind: "context" | "add" | "remove";
    text: string;
    oldLine: number | null;
    newLine: number | null;
}

/** A selectable diff block; context lines are never selectable. */
export interface ChangeBlock {
    id: string;
    fingerprint: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: ChangeLine[];
}

/** Browser-safe snapshot; filesystem and index identities remain in the host. */
export interface ChangeFileView {
    snapshotId: string;
    path: string;
    side: "working" | "index";
    base: string;
    blocks: ChangeBlock[];
}

/** Named worktree metadata, independent of Git's index. */
interface Changelist {
    id: string;
    name: string;
    /** User documentation, independent of the commit message. */
    description?: string;
    /** Persisted composer text for this list only. */
    draft?: string;
}

/** Only fingerprints, not complete file contents, are persisted for block ownership. */
export interface ChangeOwnership {
    contentId: string;
    lines: Record<string, string>;
    stale?: boolean;
    totalChanges?: number;
    /** Host-only hashed evidence; omitted from browser projections. */
    tracking?: RangeSnapshot;
    /** Bounded exact-content history restores ownership on undo/redo, never inclusion. */
    history?: { snapshot: RangeSnapshot; lines: Record<string, string> }[];
    selections?: Record<
        string,
        {
            contentId: string;
            lineIds: string[];
            total: number;
            /** A lifecycle merge could not prove equivalent inclusion; explicit review is required. */
            reviewRequired?: boolean;
        }
    >;
}

/** Immutable evidence for mapping logical changes; no source text is persisted. */
export interface RangeSnapshot {
    contentId: string;
    baseHash: string;
    workingHash: string;
    head: string;
    indexHash: string;
    baseLines: string[];
    workingLines: string[];
    anchors: {
        id: string;
        fingerprint: string;
        kind: "add" | "remove";
        line: number;
        hash: string;
        context: string[];
    }[];
}

/** Revisioned host-owned lists for one captured repository. */
export interface ChangelistState {
    revision: number;
    activeId: string;
    lists: Changelist[];
    files: Record<string, string>;
    changes: Record<string, ChangeOwnership>;
    /** All is an aggregate commit scope, never an ownership identifier. */
    allDraft?: string;
    /** Bounded deletion redirects restore saved view scopes without reviving removed IDs. */
    removedScopes?: Record<string, string>;
}

/** One correlated selection; the host resolves every identifier from its own snapshot. */
export interface SelectedFileChanges {
    snapshotId: string;
    lineIds: string[];
}
