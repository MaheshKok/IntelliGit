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
}

/** Commands posted by the diff viewer to the extension host. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "setIgnoreMode"; mode: "none" | "whitespace" };

/** Messages sent by the extension host to initialize or report the viewer state. */
export type InboundMessage = { type: "setDiffData"; data: DiffViewerData };
