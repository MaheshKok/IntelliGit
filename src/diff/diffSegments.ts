import { diffLinesFair } from "../mergeEditor/lineDiff";
import type { DiffSegment, DiffSideMeta } from "../webviews/protocol/diffViewerTypes";

interface SplitText {
    lines: string[];
    meta: DiffSideMeta;
}

/** Splits source text into display lines while retaining its EOL metadata. */
function splitText(text: string): SplitText {
    const lines: string[] = [];
    const eols = new Set<"lf" | "crlf" | "cr">();
    let start = 0;
    let terminalNewline = false;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code !== 10 && code !== 13) continue;

        lines.push(text.slice(start, i));
        if (code === 13 && text.charCodeAt(i + 1) === 10) {
            eols.add("crlf");
            i++;
        } else if (code === 13) {
            // A carriage return with no line feed is a classic-Mac EOL, not an LF.
            // Folding it into "lf" made two byte-different files compare equal.
            eols.add("cr");
        } else {
            eols.add("lf");
        }
        start = i + 1;
        terminalNewline = start === text.length;
    }

    if (start < text.length) {
        lines.push(text.slice(start));
        terminalNewline = false;
    }

    const eol: DiffSideMeta["eol"] =
        eols.size === 0
            ? "none"
            : eols.size > 1
              ? "mixed"
              : eols.has("crlf")
                ? "crlf"
                : eols.has("cr")
                  ? "cr"
                  : "lf";
    return { lines, meta: { eol, terminalNewline } };
}

/** Returns true when two texts contain the same lines but differ in newline representation. */
function hasNewlineDifference(left: SplitText, right: SplitText): boolean {
    if (left.lines.length !== right.lines.length) return false;
    // The length guard the rule asks for is the line above; it reads the two statements
    // separately and cannot see it.
    // react-doctor-disable-next-line react-doctor/js-length-check-first
    if (!left.lines.every((line, index) => line === right.lines[index])) return false;
    return (
        left.meta.eol !== right.meta.eol || left.meta.terminalNewline !== right.meta.terminalNewline
    );
}

/** Appends a changed range unless both sides are empty. */
function appendChanged(segments: DiffSegment[], left: string[], right: string[]): void {
    if (left.length === 0 && right.length === 0) return;
    segments.push({ type: "changed", left, right });
}

/**
 * Computes a pure, two-pane diff segment model from source text.
 *
 * Line alignment delegates to the existing IntelliJ-shaped `diffLinesFair`
 * implementation; displayed lines remain unnormalized so whitespace and EOL
 * differences can be rendered explicitly by the webview.
 */
export function computeDiffSegments(
    leftText: string,
    rightText: string,
    options: { ignoreWhitespace?: boolean } = {},
): {
    segments: DiffSegment[];
    left: DiffSideMeta;
    right: DiffSideMeta;
    newlineDifference: boolean;
} {
    const left = splitText(leftText);
    const right = splitText(rightText);
    const equalRanges = diffLinesFair(left.lines, right.lines, {
        ignoreWhitespace: options.ignoreWhitespace,
    });
    const segments: DiffSegment[] = [];
    let leftCursor = 0;
    let rightCursor = 0;

    for (const range of equalRanges) {
        appendChanged(
            segments,
            left.lines.slice(leftCursor, range.start1),
            right.lines.slice(rightCursor, range.start2),
        );
        if (range.end1 > range.start1 || range.end2 > range.start2) {
            segments.push({
                type: "common",
                left: left.lines.slice(range.start1, range.end1),
                right: right.lines.slice(range.start2, range.end2),
            });
        }
        leftCursor = range.end1;
        rightCursor = range.end2;
    }

    appendChanged(segments, left.lines.slice(leftCursor), right.lines.slice(rightCursor));

    return {
        segments,
        left: left.meta,
        right: right.meta,
        newlineDifference: hasNewlineDifference(left, right),
    };
}
