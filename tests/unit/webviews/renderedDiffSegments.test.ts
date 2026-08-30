import { describe, expect, it } from "vitest";
import { alignCompareLinesForWordDiff } from "../../../src/diff/wordDiff";
import type { DiffSegment } from "../../../src/webviews/protocol/diffViewerTypes";

function segment(left: string[], right: string[]): DiffSegment {
    return { type: "common", left, right };
}

async function loadBuilder() {
    return import("../../../src/webviews/react/diff-viewer/renderedDiffSegments");
}

describe("buildRenderedSegments", () => {
    it("returns the same model and render key for unchanged segment coordinates", async () => {
        const { buildRenderedSegments, createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();
        const unchanged = segment(["left"], ["right"]);

        const first = buildRenderedSegments([unchanged], cache);
        const second = buildRenderedSegments([unchanged], cache);

        expect(second[0]).toBe(first[0]);
        expect(second[0].renderKey).toBe(first[0].renderKey);
        expect(second[0].sourceStartLine).toEqual({ left: 1, right: 1 });
    });

    it("creates exactly one model when one unshifted segment is replaced", async () => {
        const { buildRenderedSegments, createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();
        const prefix = segment(["prefix"], ["prefix"]);
        const removed = segment(["before"], ["before"]);
        const suffix = segment(["suffix"], ["suffix"]);
        const first = buildRenderedSegments([prefix, removed, suffix], cache);
        const replacement = segment(["after"], ["after"]);

        const next = buildRenderedSegments([prefix, replacement, suffix], cache);

        expect(next[0]).toBe(first[0]);
        expect(next[1]).not.toBe(first[1]);
        expect(next[2]).toBe(first[2]);
        expect(cache.nextKey).toBe(4);
    });

    it("rebuilds shifted suffix line numbers without changing renderKey", async () => {
        const { buildRenderedSegments, createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();
        const prefix = segment(["prefix"], ["prefix"]);
        const suffix = segment(["suffix"], ["suffix"]);
        const first = buildRenderedSegments([prefix, suffix], cache);
        const inserted = segment(["inserted"], ["inserted"]);

        const next = buildRenderedSegments([prefix, inserted, suffix], cache);

        expect(next[2].lineNumbers.left.primary).toEqual([3]);
        expect(next[2].lineNumbers.right.primary).toEqual([3]);
        expect(next[2]).not.toBe(first[1]);
        expect(next[2].renderKey).toBe(first[1].renderKey);
    });

    it("reuses aligned comparison arrays when only source coordinates shift", async () => {
        const { buildRenderedSegments, createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();
        const changed = segment(
            ["alpha left", "beta left"],
            ["alpha right", "inserted right", "beta right"],
        );
        const first = buildRenderedSegments([changed], cache)[0];

        const shifted = buildRenderedSegments([segment(["prefix"], ["prefix"]), changed], cache)[1];

        expect(shifted).not.toBe(first);
        expect(shifted.alignedCompareLines.left).toBe(first.alignedCompareLines.left);
        expect(shifted.alignedCompareLines.right).toBe(first.alignedCompareLines.right);
        expect(shifted.alignedCompareLines.left).toEqual(
            alignCompareLinesForWordDiff(changed.left, changed.right),
        );
        expect(shifted.alignedCompareLines.right).toEqual(
            alignCompareLinesForWordDiff(changed.right, changed.left),
        );
    });

    it("assigns distinct render keys to distinct equal segment objects", async () => {
        const { buildRenderedSegments, createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();
        const firstSegment = segment(["same"], ["same"]);
        const secondSegment = segment(["same"], ["same"]);

        const rendered = buildRenderedSegments([firstSegment, secondSegment], cache);

        expect(rendered[0].renderKey).not.toBe(rendered[1].renderKey);
    });

    it("keeps segment models only in a WeakMap cache", async () => {
        const { createRenderedSegmentCache } = await loadBuilder();
        const cache = createRenderedSegmentCache();

        expect(cache.bySegment).toBeInstanceOf(WeakMap);
        expect(Object.getOwnPropertyNames(cache)).toEqual(["bySegment", "nextKey"]);
        expect(Object.values(cache).some((value) => value instanceof Map)).toBe(false);
    });
});
