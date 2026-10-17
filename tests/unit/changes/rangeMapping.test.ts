import { describe, expect, it } from "vitest";
import { changeFingerprint as hash } from "../../../src/changes/parseDiff";
import {
    mapLines,
    reconcileRanges,
    type HydratedChangeOwnership,
} from "../../../src/changes/rangeMapping";
import type { RangeSnapshot } from "../../../src/webviews/protocol/changeSelection";

function snapshot(
    base: string[],
    working: string[],
    additions: number[],
    removals: number[] = [],
): RangeSnapshot {
    const baseLines = base.map(hash);
    const workingLines = working.map(hash);
    const anchors = [
        ...removals.map((line) => ({ kind: "remove" as const, line })),
        ...additions.map((line) => ({ kind: "add" as const, line })),
    ].map((anchor, index) => {
        const source = anchor.kind === "add" ? workingLines : baseLines;
        return {
            ...anchor,
            id: `0:${index}`,
            fingerprint: hash(JSON.stringify([anchor.kind, anchor.line, source[anchor.line]])),
            hash: source[anchor.line],
            context: source.slice(Math.max(0, anchor.line - 2), anchor.line + 3),
        };
    });
    return {
        contentId: hash(JSON.stringify([base, working])),
        baseHash: hash(base.join("\n")),
        workingHash: hash(working.join("\n")),
        head: "a".repeat(40),
        indexHash: hash("index"),
        baseLines,
        workingLines,
        anchors,
    };
}

function owner(
    state: HydratedChangeOwnership,
    current: RangeSnapshot,
    line: number,
): string | undefined {
    const anchor = current.anchors.find((entry) => entry.kind === "add" && entry.line === line);
    return anchor ? (state.lines[anchor.fingerprint] ?? "A") : undefined;
}

describe("range ownership based on content and context", () => {
    const base = Array.from({ length: 30 }, (_, i) => `base ${i}`);

    it("keeps A through a line shift, assigns the new independent block to B, and maps explicit inclusion", () => {
        const working = [...base];
        working[20] = "calculation";
        const first = snapshot(base, working, [20], [20]);
        const original = reconcileRanges(undefined, first, "A", "A");
        original.selections = {
            A: { contentId: first.contentId, lineIds: first.anchors.map((a) => a.id), total: 2 },
            all: { contentId: first.contentId, lineIds: [], total: 2 },
        };
        const shifted = ["new independent", ...working];
        const next = snapshot(base, shifted, [0, 21], [20]);
        const mapped = reconcileRanges(original, next, "A", "B");
        expect(mapped.stale).toBe(false);
        expect(owner(mapped, next, 21)).toBe("A");
        expect(owner(mapped, next, 0)).toBe("B");
        expect(mapped.selections?.A.lineIds).toEqual(["0:0", "0:2"]);
        expect(mapped.selections?.all).toEqual({
            contentId: next.contentId,
            lineIds: [],
            total: 3,
        });
    });

    it("keeps edits inside a single owned insertion but requires renewed inclusion review", () => {
        const first = snapshot(base, [...base.slice(0, 10), "inserted", ...base.slice(10)], [10]);
        const previous = reconcileRanges(undefined, first, "A", "A");
        previous.lines[first.anchors[0].fingerprint] = "B";
        previous.selections = { B: { contentId: first.contentId, lineIds: ["0:0"], total: 1 } };
        const next = snapshot(
            base,
            [...base.slice(0, 10), "edited insertion", ...base.slice(10)],
            [10],
        );
        const mapped = reconcileRanges(previous, next, "A", "C");
        expect(mapped.stale).toBe(false);
        expect(owner(mapped, next, 10)).toBe("B");
        expect(mapped.selections?.B.reviewRequired).toBe(true);
        expect(mapped.selections?.B.contentId).toBe(first.contentId);
    });

    it("refuses a replacement spanning two owners and retains recovery evidence", () => {
        const first = snapshot(base, ["one", "two", ...base], [0, 1]);
        const previous = reconcileRanges(undefined, first, "A", "A");
        previous.lines[first.anchors[1].fingerprint] = "B";
        const next = snapshot(base, ["combined", ...base], [0]);
        const mapped = reconcileRanges(previous, next, "A", "C");
        expect(mapped.stale).toBe(true);
        expect(mapped.lines).toEqual(previous.lines);
        expect(mapped.history?.[0].snapshot).toEqual(first);
        expect(reconcileRanges(mapped, next, "A", "C")).toBe(mapped);
    });

    it("restores exact ownership on undo/redo without reviving an old included selection", () => {
        const first = snapshot(base, ["owned", ...base], [0]);
        const previous = reconcileRanges(undefined, first, "A", "A");
        previous.lines[first.anchors[0].fingerprint] = "B";
        previous.selections = { all: { contentId: first.contentId, lineIds: [], total: 1 } };
        const undo = reconcileRanges(previous, snapshot(base, base, []), "A", "C");
        const redo = reconcileRanges(undo, first, "A", "C");
        expect(owner(redo, first, 0)).toBe("B");
        expect(redo.selections?.all.lineIds).toEqual([]);
    });

    it("consumes a verified external commit and retains the other list's ownership", () => {
        const working = [...base];
        working[5] = "committed";
        working[20] = "remaining";
        const first = snapshot(base, working, [5, 20], [5, 20]);
        const previous = reconcileRanges(undefined, first, "A", "A");
        for (const anchor of first.anchors.filter((a) => a.line === 20))
            previous.lines[anchor.fingerprint] = "B";
        const newBase = [...base];
        newBase[5] = "committed";
        const next = snapshot(newBase, working, [20], [20]);
        const mapped = reconcileRanges(previous, next, "A", "C");
        expect(mapped.stale).toBe(false);
        expect(Object.values(mapped.lines)).toEqual(["B", "B"]);
        expect(mapped.totalChanges).toBe(2);
    });

    it("requires review when both the base and local result change externally", () => {
        const first = snapshot(base, ["local", ...base], [0]);
        const next = snapshot(["new base", ...base], ["different", ...base], [0], [0]);
        expect(
            reconcileRanges(reconcileRanges(undefined, first, "A", "A"), next, "A", "B").stale,
        ).toBe(true);
    });

    it("does not migrate stale legacy inclusion or ownership onto a different snapshot", () => {
        const current = snapshot(base, ["new", ...base], [0]);
        const previous = {
            contentId: "old",
            lines: { [hash("old")]: "B" },
            selections: { all: { contentId: "old", lineIds: [], total: 1 } },
        };
        const mapped = reconcileRanges(previous, current, "A", "B");
        expect(mapped.stale).toBe(true);
        expect(mapped.selections).toEqual(previous.selections);
    });

    it("does not choose between crossing or repeated line candidates", () => {
        expect(mapLines(["a", "b"], ["b", "a"]).size).toBe(0);
        expect(mapLines(["x", "x"], ["x", "x", "x"]).size).toBe(0);
    });

    it("preserves ownership and empty inclusion across 200 reproducible independent shifts", () => {
        for (let seed = 1; seed <= 200; seed++) {
            const count = (seed % 13) + 1;
            const working = [...base];
            working[20] = `owned ${seed}`;
            const first = snapshot(base, working, [20], [20]);
            const previous = reconcileRanges(undefined, first, "A", "A");
            previous.lines[first.anchors[1].fingerprint] = "B";
            previous.selections = { all: { contentId: first.contentId, lineIds: [], total: 2 } };
            const next = snapshot(
                base,
                [...Array.from({ length: count }, (_, i) => `new ${seed}:${i}`), ...working],
                [...Array.from({ length: count }, (_, i) => i), 20 + count],
                [20],
            );
            const mapped = reconcileRanges(previous, next, "A", "C");
            expect(mapped.stale, `seed ${seed}`).toBe(false);
            expect(owner(mapped, next, 20 + count), `seed ${seed}`).toBe("B");
            for (let i = 0; i < count; i++) expect(owner(mapped, next, i)).toBe("C");
            expect(mapped.selections?.all.lineIds).toEqual([]);
        }
    });
});
