// Typed message protocol for the 3-way merge editor webview.

import type { MergeEditorData, MergeSegment } from "../../../mergeEditor/conflictParser";

export type { MergeEditorData, MergeSegment };
export type { CommonSegment, ConflictSegment } from "../../../mergeEditor/conflictParser";

export type OutboundMessage =
    | { type: "ready" }
    | { type: "applyResolution"; content: string }
    | { type: "acceptYours" }
    | { type: "acceptTheirs" }
    | { type: "close" };

export type InboundMessage =
    | { type: "setConflictData"; data: MergeEditorData }
    | { type: "loadError"; message: string };

/** Resolution choice for a single conflict hunk. */
export type HunkResolution = "ours" | "theirs" | "both" | "none";

export interface MergeEditorState {
    data: MergeEditorData | null;
    resolutions: Map<number, HunkResolution>;
}
