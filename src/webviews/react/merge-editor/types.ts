// Typed message protocol for the 3-way merge editor webview.

import type { MergeEditorData, MergeSegment } from "../../../mergeEditor/conflictParser";

export type { MergeEditorData, MergeSegment };
export type { CommonSegment, ConflictSegment } from "../../../mergeEditor/conflictParser";

/** Commands the merge editor posts to the extension host for loading, saving, and file-wide actions. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "setIgnoreMode"; mode: "none" | "whitespace" }
    | { type: "applyResolution"; content: string }
    | { type: "acceptYours" }
    | { type: "acceptTheirs" }
    | { type: "openConflictSession" }
    | { type: "abortMerge" }
    | { type: "close" };

/** Messages the extension host sends to initialize conflict data or report load failures. */
export type InboundMessage =
    | { type: "setConflictData"; data: MergeEditorData }
    | { type: "loadError"; message: string };

/** Resolution choice for a single conflict hunk. */
export type HunkResolution = "ours" | "theirs" | "both" | "none";
