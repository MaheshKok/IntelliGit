// Typed message protocol for the read-only two-pane diff viewer webview.

/** Newline metadata for one side of a diff payload. */
export interface DiffSideMeta {
    /** EOL style observed in the side's source text. */
    eol: "lf" | "crlf" | "cr" | "mixed" | "none";
    /** Whether the source text ends with an EOL delimiter. */
    terminalNewline: boolean;
}

/** One aligned unchanged or changed range in a two-pane diff. */
export type DiffSegment =
    | {
          /** Unchanged lines, aligned one-to-one on both sides. */
          type: "common";
          left: string[];
          right: string[];
      }
    | {
          /** Changed lines; an empty side represents an insertion or deletion. */
          type: "changed";
          left: string[];
          right: string[];
      };

/** Complete extension-host payload rendered by the diff viewer. */
export interface DiffViewerData {
    /** Repository-relative path displayed in the viewer header. */
    path: string;
    /** Human-readable label for the left side. */
    leftLabel: string;
    /** Human-readable label for the right side. */
    rightLabel: string;
    /** Alignment-and-newline-aware segment model. */
    segments: DiffSegment[];
    /** Language identifier used by syntax highlighting. */
    languageId: string;
    /** EOL and terminal-newline metadata for the left side. */
    left: DiffSideMeta;
    /** EOL and terminal-newline metadata for the right side. */
    right: DiffSideMeta;
    /** Explicit marker state when only newline representation differs. */
    newlineDifference: boolean;
    /** Authoritative ignore-whitespace mode for the segments in this payload. */
    ignoreWhitespace: boolean;
    /** Active refresh failure while the displayed snapshots remain valid. */
    loadError?: string;
    /** Pane bound to the live VS Code document in a custom text editor. */
    editablePane?: "left" | "right";
    /** Current document text; only supplied when `editablePane` is present. */
    editableText?: string;
    /** Version of the VS Code document that produced `editableText`. */
    documentVersion?: number;
    /**
     * Advances only when `editableText` changed for a reason the webview did not cause.
     * The webview reseeds its local draft on a new token and otherwise keeps typing,
     * because a version comparison cannot tell "the host is echoing my own in-flight
     * edits" apart from "someone else changed the file".
     */
    editableReseedToken?: number;
}

/** A UTF-16 text replacement sent from the webview to the VS Code-owned document. */
export interface TextEditDelta {
    /** Version of the document text used to measure this replacement. */
    readonly baseVersion: number;
    /**
     * Reseed token the measured draft was anchored to. `baseVersion` alone cannot decide
     * staleness, because the webview mints optimistic versions in the document's own numeric
     * space: one foreign write advances the document, one rejected delta advances the draft,
     * and the two counters meet again over texts that no longer match. The token only moves
     * when the host itself declares the draft void, so a delta measured before that
     * declaration can never be mistaken for one measured after it.
     */
    readonly baseReseedToken: number;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly text: string;
}

/** Commands posted by the diff viewer to the extension host. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "setIgnoreMode"; mode: "none" | "whitespace" }
    | { type: "editText"; delta: TextEditDelta };

/** Messages sent by the extension host to initialize or report the viewer state. */
export type InboundMessage = { type: "setDiffData"; data: DiffViewerData };
