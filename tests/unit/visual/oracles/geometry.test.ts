import { describe, expect, it } from "vitest";

import {
    CLIP_EPSILON_PX,
    findClippingLosses,
    findZeroSizeTargets,
    type Box,
    type ClipAxis,
} from "../../../visual/oracles/geometry";

function box(left: number, top: number, right: number, bottom: number): Box {
    return { left, top, right, bottom };
}

describe("findClippingLosses", () => {
    it("returns no findings for text fully contained by every clipper", () => {
        expect(
            findClippingLosses({
                textRects: [box(20, 20, 80, 80)],
                clipBoxes: [box(0, 0, 100, 100), box(10, 10, 90, 90)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([]);
    });

    it("can fail: reports horizontal clipping", () => {
        const axis: ClipAxis = "horizontal";

        expect(
            findClippingLosses({
                textRects: [box(0, 0, 100, 20)],
                clipBoxes: [box(0, 0, 99, 20)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([{ clipIndex: 0, rectIndex: 0, axis, lostPx: 1 }]);
    });

    it("can fail: reports vertical clipping", () => {
        expect(
            findClippingLosses({
                textRects: [box(0, 0, 20, 100)],
                clipBoxes: [box(0, 0, 20, 99)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([{ clipIndex: 0, rectIndex: 0, axis: "vertical", lostPx: 1 }]);
    });

    it("can fail: reports clipping on both axes", () => {
        expect(
            findClippingLosses({
                textRects: [box(0, 0, 100, 100)],
                clipBoxes: [box(0, 0, 99, 98)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([{ clipIndex: 0, rectIndex: 0, axis: "both", lostPx: 2 }]);
    });

    it("can fail: catches a further ancestor after the nearest clipper", () => {
        expect(
            findClippingLosses({
                textRects: [box(10, 10, 95, 40)],
                clipBoxes: [box(0, 0, 100, 100), box(0, 0, 80, 100)],
                viewport: box(0, 0, 200, 200),
            }),
        ).toEqual([{ clipIndex: 1, rectIndex: 0, axis: "horizontal", lostPx: 15 }]);
    });

    it("can fail: catches clipping caused only by the viewport", () => {
        expect(
            findClippingLosses({
                textRects: [box(80, 10, 100, 40)],
                clipBoxes: [box(0, 0, 120, 100)],
                viewport: box(0, 0, 90, 100),
            }),
        ).toEqual([{ clipIndex: -1, rectIndex: 0, axis: "horizontal", lostPx: 10 }]);
    });

    it("can fail: treats a rect outside a clipper as a full loss", () => {
        expect(
            findClippingLosses({
                textRects: [box(100, 10, 110, 20)],
                clipBoxes: [box(0, 0, 50, 50)],
                viewport: box(0, 0, 200, 200),
            }),
        ).toEqual([{ clipIndex: 0, rectIndex: 0, axis: "horizontal", lostPx: 10 }]);
    });

    it("does not report losses for zero-area text rects or empty input", () => {
        expect(
            findClippingLosses({
                textRects: [box(20, 20, 20, 80), box(20, 20, 80, 20)],
                clipBoxes: [box(0, 0, 1, 1)],
                viewport: box(0, 0, 1, 1),
            }),
        ).toEqual([]);
        expect(
            findClippingLosses({
                textRects: [],
                clipBoxes: [box(0, 0, 1, 1)],
                viewport: box(0, 0, 1, 1),
            }),
        ).toEqual([]);
    });

    it("does not report a shortfall at or below the epsilon", () => {
        expect(
            findClippingLosses({
                textRects: [box(0, 0, 100, 20)],
                clipBoxes: [box(0, 0, 100 - CLIP_EPSILON_PX, 20)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([]);
        expect(
            findClippingLosses({
                textRects: [box(0, 0, 100, 20)],
                clipBoxes: [box(0, 0, 99.6, 20)],
                viewport: box(0, 0, 120, 120),
            }),
        ).toEqual([]);
    });

    it("can fail: reports a shortfall above the epsilon", () => {
        const losses = findClippingLosses({
            textRects: [box(0, 0, 100, 20)],
            clipBoxes: [box(0, 0, 99.4, 20)],
            viewport: box(0, 0, 120, 120),
        });

        expect(losses).toHaveLength(1);
        expect(losses[0]).toMatchObject({ clipIndex: 0, rectIndex: 0, axis: "horizontal" });
        expect(losses[0].lostPx).toBeCloseTo(0.6, 10);
    });

    it("orders findings by rect, clipper, then viewport", () => {
        expect(
            findClippingLosses({
                textRects: [box(0, 0, 100, 20), box(0, 0, 20, 100)],
                clipBoxes: [box(0, 0, 99, 20), box(0, 0, 20, 99)],
                viewport: box(0, 0, 10, 10),
            }),
        ).toEqual([
            { clipIndex: 0, rectIndex: 0, axis: "horizontal", lostPx: 1 },
            { clipIndex: 1, rectIndex: 0, axis: "horizontal", lostPx: 80 },
            { clipIndex: -1, rectIndex: 0, axis: "both", lostPx: 90 },
            { clipIndex: 0, rectIndex: 1, axis: "vertical", lostPx: 80 },
            { clipIndex: 1, rectIndex: 1, axis: "vertical", lostPx: 1 },
            { clipIndex: -1, rectIndex: 1, axis: "both", lostPx: 90 },
        ]);
    });

    it("is deterministic and does not mutate its input", () => {
        const input = {
            textRects: [box(0, 0, 100, 20)],
            clipBoxes: [box(0, 0, 99, 20)],
            viewport: box(0, 0, 120, 120),
        } as const;
        const before = structuredClone(input);

        const first = findClippingLosses(input);
        const second = findClippingLosses(input);

        expect(first).toEqual(second);
        expect(input).toEqual(before);
    });
});

describe("findZeroSizeTargets", () => {
    it("returns no findings for targets larger than the epsilon", () => {
        expect(
            findZeroSizeTargets([
                { id: "button", box: box(0, 0, 10, 10) },
                { id: "label", box: box(0, 0, 0.6, 0.6) },
            ]),
        ).toEqual([]);
    });

    it("can fail: returns zero-width and zero-height target ids in input order", () => {
        expect(
            findZeroSizeTargets([
                { id: "first", box: box(0, 0, 0.4, 20) },
                { id: "healthy", box: box(0, 0, 20, 20) },
                { id: "second", box: box(0, 0, 20, 0.5) },
                { id: "negative", box: box(0, 0, -1, 20) },
            ]),
        ).toEqual(["first", "second", "negative"]);
    });

    it("is deterministic and does not mutate its input", () => {
        const targets = [
            { id: "tiny", box: box(0, 0, 0.4, 10) },
            { id: "large", box: box(0, 0, 10, 10) },
        ] as const;
        const before = structuredClone(targets);

        const first = findZeroSizeTargets(targets);
        const second = findZeroSizeTargets(targets);

        expect(first).toEqual(second);
        expect(targets).toEqual(before);
    });
});
