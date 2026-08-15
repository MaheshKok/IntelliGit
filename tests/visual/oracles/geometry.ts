export interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** CSS px. Layout produces fractional values; losses below this are not real. */
export const CLIP_EPSILON_PX = 0.5;

export type ClipAxis = "horizontal" | "vertical" | "both";

export interface ClippingLoss {
    /** Index into `clipBoxes`, or -1 when the viewport is the clipper. */
    readonly clipIndex: number;
    readonly rectIndex: number;
    readonly axis: ClipAxis;
    readonly lostPx: number;
}

export interface ClippingInput {
    /** Bounding rects of the rendered text range. */
    readonly textRects: readonly Box[];
    /** Content box of every clipping ancestor. */
    readonly clipBoxes: readonly Box[];
    readonly viewport: Box;
}

function axisLength(start: number, end: number): number {
    return end - start;
}

function intersectionLength(
    rectStart: number,
    rectEnd: number,
    clipStart: number,
    clipEnd: number,
): number {
    return Math.max(0, Math.min(rectEnd, clipEnd) - Math.max(rectStart, clipStart));
}

function clippingLoss(
    rect: Box,
    clipper: Box,
): { readonly horizontal: number; readonly vertical: number } {
    const rectWidth = axisLength(rect.left, rect.right);
    const rectHeight = axisLength(rect.top, rect.bottom);
    return {
        horizontal:
            rectWidth - intersectionLength(rect.left, rect.right, clipper.left, clipper.right),
        vertical:
            rectHeight - intersectionLength(rect.top, rect.bottom, clipper.top, clipper.bottom),
    };
}

function lossAxis(horizontal: number, vertical: number): ClipAxis {
    if (horizontal > CLIP_EPSILON_PX && vertical > CLIP_EPSILON_PX) {
        return "both";
    }
    return horizontal > CLIP_EPSILON_PX ? "horizontal" : "vertical";
}

/**
 * Finds text-range pixels lost at each ancestor clipper and at the viewport.
 *
 * Rectangles with no area are ignored because they contain no rendered text to clip. Every
 * positive-area rectangle is compared with every supplied clip box in input order, followed by
 * the viewport, so a further ancestor cannot be hidden by a successful nearest-ancestor check.
 */
export function findClippingLosses(input: ClippingInput): readonly ClippingLoss[] {
    const losses: ClippingLoss[] = [];
    const clippers = [...input.clipBoxes, input.viewport];

    input.textRects.forEach((rect, rectIndex) => {
        if (axisLength(rect.left, rect.right) <= 0 || axisLength(rect.top, rect.bottom) <= 0) {
            return;
        }

        clippers.forEach((clipper, clipPosition) => {
            const loss = clippingLoss(rect, clipper);
            const hasHorizontalLoss = loss.horizontal > CLIP_EPSILON_PX;
            const hasVerticalLoss = loss.vertical > CLIP_EPSILON_PX;
            if (!hasHorizontalLoss && !hasVerticalLoss) {
                return;
            }

            losses.push({
                clipIndex: clipPosition === input.clipBoxes.length ? -1 : clipPosition,
                rectIndex,
                axis: lossAxis(loss.horizontal, loss.vertical),
                lostPx: Math.max(loss.horizontal, loss.vertical),
            });
        });
    });

    return losses;
}

export interface SizedTarget {
    readonly id: string;
    readonly box: Box;
}

/** Returns target ids whose rendered width or height is no larger than the clipping tolerance. */
export function findZeroSizeTargets(targets: readonly SizedTarget[]): readonly string[] {
    return targets
        .filter(
            (target) =>
                axisLength(target.box.left, target.box.right) <= CLIP_EPSILON_PX ||
                axisLength(target.box.top, target.box.bottom) <= CLIP_EPSILON_PX,
        )
        .map((target) => target.id);
}
