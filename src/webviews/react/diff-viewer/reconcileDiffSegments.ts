import type { DiffSegment, DiffViewerData } from "../../protocol/diffViewerTypes";

/** Returns whether two line arrays contain the same strings in the same order. */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

/** Returns whether two segments carry the exact same type and line content. */
function sameSegment(left: DiffSegment, right: DiffSegment): boolean {
    return (
        left.type === right.type &&
        sameLines(left.left, right.left) &&
        sameLines(left.right, right.right)
    );
}

/**
 * Reuses only the unchanged prefix and suffix segment objects from the preceding payload.
 *
 * Changed or shifted middle segments retain the objects emitted by the new host payload, so
 * React can preserve stable rows without treating a nearby edit as unchanged content.
 */
export function reconcileDiffSegments(
    previous: readonly DiffSegment[],
    next: readonly DiffSegment[],
): DiffSegment[] {
    const reconciled = [...next];
    let prefixLength = 0;

    while (
        prefixLength < previous.length &&
        prefixLength < next.length &&
        sameSegment(previous[prefixLength], next[prefixLength])
    ) {
        reconciled[prefixLength] = previous[prefixLength];
        prefixLength += 1;
    }

    let previousIndex = previous.length - 1;
    let nextIndex = next.length - 1;
    while (
        previousIndex >= prefixLength &&
        nextIndex >= prefixLength &&
        sameSegment(previous[previousIndex], next[nextIndex])
    ) {
        reconciled[nextIndex] = previous[previousIndex];
        previousIndex -= 1;
        nextIndex -= 1;
    }

    return reconciled;
}

/**
 * Returns a fresh viewer payload that keeps only exact segment identities from its predecessor.
 *
 * Every non-segment field comes from `next`, including optional editing and failure metadata.
 */
export function reconcileDiffViewerData(
    previous: DiffViewerData | null,
    next: DiffViewerData,
): DiffViewerData {
    return {
        ...next,
        segments:
            previous === null
                ? [...next.segments]
                : reconcileDiffSegments(previous.segments, next.segments),
    };
}
