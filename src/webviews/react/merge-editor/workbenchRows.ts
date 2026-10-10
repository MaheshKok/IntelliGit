import type { Line, Text } from "@codemirror/state";
import { deriveConflictView, type ConflictView } from "./segments";
import type { ConflictSegment, HunkResolution } from "./types";
import type { WorkbenchHunk } from "./workbenchModel";

/** A pane that paints hunk rows. */
export type WorkbenchPane = "ours" | "result" | "theirs";

/** Identifies the empty editing position after the final line break. */
export function isPhantomLine(doc: Text, line: Line): boolean {
    return line.from === doc.length;
}

/** Counts physical line starts owned by a half-open document range. */
export function rowsInRange(doc: Text, from: number, to: number): number {
    if (from === to) return 0;
    const line = doc.lineAt(from);
    const firstOwned = line.number + Number(line.from !== from);
    return Math.max(0, doc.lineAt(to - 1).number - firstOwned + 1);
}

/** Lists physical line numbers owned by a half-open document range. */
export function ownedLines(doc: Text, from: number, to: number): number[] {
    const line = doc.lineAt(from);
    const firstOwned = line.number + Number(line.from !== from);
    return Array.from({ length: rowsInRange(doc, from, to) }, (_, index) => firstOwned + index);
}

/** Maps the workbench's keep-base choice onto main's discarded-side rendering. */
export function resolutionOf(hunk: WorkbenchHunk): HunkResolution | undefined {
    return hunk.decision === "base" ? "none" : hunk.decision;
}

/** Reuses main's rendering flags without changing workbench confirmation semantics. */
export function hunkView(hunk: WorkbenchHunk): ConflictView {
    return deriveConflictView(
        hunk.segment,
        resolutionOf(hunk),
        hunk.edited ? [] : undefined,
        hunk.dismissed,
    );
}

/** Maps main's change kinds to the flat row vocabulary. */
export function variantClass(segment: ConflictSegment): string {
    if (segment.changeKind === "conflict") return "mrow-conflict";
    if (segment.baseLines.length === 0) return "mrow-insertion";
    const changed = segment.changeKind === "ours-only" ? segment.oursLines : segment.theirsLines;
    return changed.length === 0 ? "mrow-deletion" : "mrow-modification";
}

/** Chooses the pane's fill independently of the hunk's confirmation flag. */
export function rowState(hunk: WorkbenchHunk, pane: WorkbenchPane): string {
    const view = hunkView(hunk);
    if (pane === "ours") {
        if (view.oursInResult) return "accepted";
        return view.oursDismissed ? "dismissed" : "pending";
    }
    if (pane === "theirs") {
        if (view.theirsInResult) return "accepted";
        return view.theirsDismissed ? "dismissed" : "pending";
    }
    // Like PyCharm, hand edits keep an unresolved conflict red until a side is accepted.
    if (hunk.edited) return hunk.conflict && !hunk.resolved ? "pending" : "edited";
    if (view.resultIsUnresolved || !view.isResolved) return "pending";
    if (view.resultSettled) return "settled";
    return hunk.segment.changeKind !== "conflict" ? "variant" : "plain";
}

/** Orders the shared code and gutter classes for one owned row. */
export function rowClasses(
    hunk: WorkbenchHunk,
    pane: WorkbenchPane,
    position: "first" | "middle" | "last" | "only",
    active: boolean,
): string {
    const unchanged =
        (pane === "ours" && hunk.segment.changeKind === "theirs-only") ||
        (pane === "theirs" && hunk.segment.changeKind === "ours-only");
    return [
        "mrow",
        unchanged ? "" : variantClass(hunk.segment),
        `mrow-${rowState(hunk, pane)}`,
        position === "first" || position === "only" ? "mrow-first" : "",
        position === "last" || position === "only" ? "mrow-last" : "",
        active ? "mrow-active" : "",
    ]
        .filter(Boolean)
        .join(" ");
}

/** Selects the same word comparison baseline as main for each pane. */
export function compareLinesFor(hunk: WorkbenchHunk, pane: WorkbenchPane): string[] | undefined {
    const view = hunkView(hunk);
    if (pane === "ours") return view.oursInResult ? undefined : hunk.segment.baseLines;
    if (pane === "theirs") return view.theirsInResult ? undefined : hunk.segment.baseLines;
    return hunk.edited ? hunk.segment.baseLines : view.resultCompareLines;
}
