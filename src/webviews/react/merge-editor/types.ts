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

/**
 * Resolution choice for a single conflict hunk.
 *
 * `both` stacks ours above theirs; `both-reversed` stacks theirs above ours.
 * The two orders let the result reflect the order the user accepted the sides
 * in (PyCharm-style sequential accept).
 */
export type HunkResolution = "ours" | "theirs" | "both" | "both-reversed" | "none";

/**
 * Per-side dismissal flags for one conflict hunk.
 *
 * A dismissed side is one the user rejected with its discard (X) control without
 * accepting the opposite side. It is neither in the result nor still offered, so
 * its action buttons hide while the opposite side's suggestion stays available.
 * Accepting a side clears its hunk's dismissals, so acceptance always overrides.
 */
export interface HunkSideDismissal {
    ours?: boolean;
    theirs?: boolean;
}
