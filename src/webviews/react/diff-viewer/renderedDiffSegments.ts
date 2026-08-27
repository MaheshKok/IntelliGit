import type { DiffSegment } from "../../protocol/diffViewerTypes";
import { buildLineNumberValues } from "../diff-core/lineNumbers";
import type { LineNumberSpec } from "../diff-core/segments";

/** One segment's render inputs, including the source coordinates that produce its line numbers. */
export interface RenderedSegment {
    readonly segment: DiffSegment;
    readonly index: number;
    readonly paneLines: { readonly left: number; readonly right: number };
    readonly lineNumbers: { readonly left: LineNumberSpec; readonly right: LineNumberSpec };
    readonly canonicalLineCount: number;
    /** Stable identity for inactive React shells while this segment remains cached. */
    readonly renderKey: number;
    /** First source line rendered for each side, before this segment's lines are consumed. */
    readonly sourceStartLine: { readonly left: number; readonly right: number };
}

/** App-lifetime cache keyed weakly by the host-reconciled segment object. */
export interface RenderedSegmentCache {
    readonly bySegment: WeakMap<DiffSegment, RenderedSegment>;
    nextKey: number;
}

/** Creates an empty cache without retaining removed segment objects. */
export function createRenderedSegmentCache(): RenderedSegmentCache {
    return { bySegment: new WeakMap(), nextKey: 0 };
}

/**
 * Builds models for the current segment order, reusing only models whose source coordinates match.
 *
 * A shifted segment receives fresh line numbers while retaining its stable inactive-shell key.
 */
export function buildRenderedSegments(
    segments: readonly DiffSegment[],
    cache: RenderedSegmentCache,
): RenderedSegment[] {
    let leftStartLine = 1;
    let rightStartLine = 1;

    return segments.map((segment, index) => {
        const existing = cache.bySegment.get(segment);
        const sourceStartLine = { left: leftStartLine, right: rightStartLine };
        const leftCount = segment.left.length;
        const rightCount = segment.right.length;

        leftStartLine += leftCount;
        rightStartLine += rightCount;

        if (
            existing?.index === index &&
            existing.sourceStartLine.left === sourceStartLine.left &&
            existing.sourceStartLine.right === sourceStartLine.right
        ) {
            return existing;
        }

        const renderedSegment: RenderedSegment = {
            segment,
            index,
            paneLines: { left: leftCount, right: rightCount },
            lineNumbers: {
                left: {
                    primary: buildLineNumberValues(sourceStartLine.left, leftCount, leftCount),
                },
                right: {
                    primary: buildLineNumberValues(sourceStartLine.right, rightCount, rightCount),
                },
            },
            canonicalLineCount: Math.max(leftCount, rightCount, 1),
            renderKey: existing?.renderKey ?? cache.nextKey++,
            sourceStartLine,
        };
        cache.bySegment.set(segment, renderedSegment);
        return renderedSegment;
    });
}
