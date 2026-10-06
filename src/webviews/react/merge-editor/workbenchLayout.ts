import type { Text } from "@codemirror/state";
import type { DiffVerticalLayout, SegmentPaneLines } from "../diff-core/mergeScrollLayout";
import { connectorSideSpecs, type ConnectorRenderSpec, type MergePaneId } from "./mergeRibbons";
import type { OverviewMarker } from "./segments";
import type { Grouping, WorkbenchHunk } from "./workbenchModel";
import { resolutionOf, rowsInRange } from "./workbenchRows";

/** Derives visible ribbon sides against the current grouping's layout indices. */
export function workbenchConnectors(
    hunks: readonly WorkbenchHunk[],
    segments: Grouping["segments"],
): ConnectorRenderSpec[] {
    return hunks
        .filter(
            (hunk) =>
                !hunk.edited &&
                !(hunk.segment.autoResolvedLines !== undefined && hunk.decision === undefined),
        )
        .map((hunk) => {
            const index = segments.indexOf(hunk.segment);
            if (index === -1)
                throw new Error("merge-editor: ribbon hunk is missing from the current segments");
            return {
                id: hunk.id,
                index,
                ...connectorSideSpecs(hunk.segment, resolutionOf(hunk), {
                    ours: hunk.dismissed.ours,
                    theirs: hunk.dismissed.theirs,
                }),
            };
        });
}

/** Counts the current document's rows in segment order. */
export function layoutSegments(
    segments: Grouping["segments"],
    hunks: readonly WorkbenchHunk[],
    resultDoc: Text,
) {
    let hunkIndex = 0;
    let previousTo = 0;
    let line = 1;
    const startLine: number[] = [];
    const canonicalLineCount: number[] = [];
    const paneLines: SegmentPaneLines<MergePaneId>[] = segments.map((segment) => {
        let item: SegmentPaneLines<MergePaneId>;
        if (segment.type === "common") {
            item = {
                paneLines: {
                    left: segment.lines.length,
                    middle: rowsInRange(
                        resultDoc,
                        previousTo,
                        hunks[hunkIndex]?.from ?? resultDoc.length,
                    ),
                    right: segment.lines.length,
                },
                conflict: false,
            };
        } else {
            const hunk = hunks[hunkIndex++];
            if (!hunk || hunk.segment !== segment)
                throw new Error("merge-editor: layout segment does not match its current hunk");
            item = {
                paneLines: {
                    left: segment.oursLines.length,
                    middle: rowsInRange(resultDoc, hunk.from, hunk.to),
                    right: segment.theirsLines.length,
                },
                conflict: true,
                id: segment.id,
            };
            previousTo = hunk.to;
        }
        const count = Math.max(...Object.values(item.paneLines), 1);
        startLine.push(line);
        canonicalLineCount.push(count);
        line += count;
        return item;
    });
    if (hunkIndex !== hunks.length)
        throw new Error("merge-editor: current hunks are missing layout segments");
    return { paneLines, canonicalLineCount, startLine };
}
/** Maps a pane position back into the canonical space. */
export function canonicalForPaneY(
    layout: DiffVerticalLayout<MergePaneId>,
    pane: MergePaneId,
    y: number,
): number {
    const tops = layout.paneTopPx[pane];
    const heights = layout.paneHPx[pane];
    const index = tops.findIndex((top, i) => top === y || (top < y && y < top + heights[i]));
    if (index === -1) return y <= 0 ? 0 : layout.canonicalTotalPx;
    const fraction = heights[index] > 0 ? (y - tops[index]) / heights[index] : 0;
    return layout.canonicalTopPx[index] + fraction * layout.canonicalHPx[index];
}
/** Describes overview markers in canonical line space. */
export function overviewMarkers(
    hunks: readonly WorkbenchHunk[],
    layoutInfo: ReturnType<typeof layoutSegments>,
    _activeIndex: number | null,
): OverviewMarker[] {
    const total = Math.max(
        layoutInfo.canonicalLineCount.reduce((sum, count) => sum + count, 0),
        1,
    );
    const indices = new Map(layoutInfo.paneLines.map((item, index) => [item.id, index]));
    return hunks.map((hunk, index) => {
        const segmentIndex = indices.get(hunk.id);
        if (segmentIndex === undefined)
            throw new Error("merge-editor: overview hunk is missing from the layout");
        return {
            id: hunk.id,
            ordinal: index + 1,
            topPct: ((layoutInfo.startLine[segmentIndex] - 1) / total) * 100,
            heightPct: Math.min(
                Math.max((layoutInfo.canonicalLineCount[segmentIndex] / total) * 100, 1),
                30,
            ),
            changeKind: hunk.segment.changeKind,
            resolved: !hunk.conflict || hunk.resolved,
        };
    });
}
/** Counts confirmed true conflicts and automatic changes. */
export function workbenchCounts(hunks: readonly WorkbenchHunk[]) {
    const conflicts = hunks.filter((hunk) => hunk.conflict);
    const resolved = conflicts.filter((hunk) => hunk.resolved).length;
    return {
        total: conflicts.length,
        resolved,
        unresolved: conflicts.length - resolved,
        autoResolvedCount: hunks.filter(
            (hunk) => hunk.segment.changeKind !== "conflict" && !hunk.decision,
        ).length,
        nextUnresolvedIndex: hunks.findIndex((hunk) => hunk.conflict && !hunk.resolved),
    };
}
/** Sizes a shared track from the greatest pane overflow. */
export function horizontalInnerWidth(
    barClientWidth: number,
    views: readonly { scrollWidth: number; clientWidth: number }[],
): number {
    return (
        barClientWidth + Math.max(0, ...views.map((view) => view.scrollWidth - view.clientWidth))
    );
}
