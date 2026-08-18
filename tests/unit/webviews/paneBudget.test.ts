import { describe, expect, it } from "vitest";
import { resolvePaneBudget, type PaneSpec } from "../../../src/webviews/react/shared/paneBudget";

const pane = (key: string, min: number, preferred: number): PaneSpec => ({
    key,
    min,
    preferred,
});

const visibleTotal = (widths: Readonly<Record<string, number>>, dividerWidth: number): number =>
    Object.values(widths).reduce((total, width) => total + width, 0) +
    Math.max(0, Object.keys(widths).length - 1) * dividerWidth;

describe("resolvePaneBudget", () => {
    it("scales preferred widths proportionally when everything fits", () => {
        const result = resolvePaneBudget(1_000, [pane("a", 100, 200), pane("b", 100, 300)], [], 10);

        expect(result.hidden).toEqual([]);
        expect(result.widths.a).toBeCloseTo(396);
        expect(result.widths.b).toBeCloseTo(594);
        expect(visibleTotal(result.widths, 10)).toBeCloseTo(1_000);
    });

    it("squeezes panes proportionally without crossing their minima", () => {
        const result = resolvePaneBudget(410, [pane("a", 200, 300), pane("b", 100, 300)], [], 10);

        expect(result.hidden).toEqual([]);
        expect(result.widths.a).toBeGreaterThanOrEqual(200);
        expect(result.widths.b).toBeGreaterThanOrEqual(100);
        expect(visibleTotal(result.widths, 10)).toBeCloseTo(410);
    });

    it("drops the lowest-priority pane until the true minima fit", () => {
        const result = resolvePaneBudget(
            250,
            [pane("list", 100, 150), pane("branch", 100, 150), pane("info", 100, 150)],
            ["info", "branch"],
            4,
        );

        expect(result.hidden).toEqual(["info"]);
        expect(Object.keys(result.widths)).toEqual(["list", "branch"]);
        expect(visibleTotal(result.widths, 4)).toBeCloseTo(250);
    });

    it("keeps exactly the highest-priority pane when no pane minimum can fit", () => {
        const result = resolvePaneBudget(
            100,
            [pane("branch", 80, 260), pane("list", 200, 200), pane("info", 250, 330)],
            ["info", "branch"],
            4,
        );

        expect(result).toEqual({ widths: { list: 100 }, hidden: ["info", "branch"] });
    });

    it("fills the available budget without negative or below-minimum visible widths", () => {
        const result = resolvePaneBudget(
            320,
            [pane("a", 80, 10), pane("b", 120, 10), pane("c", 60, 10)],
            ["c"],
            4,
        );

        expect(Object.values(result.widths).every((width) => width >= 0)).toBe(true);
        expect(
            Object.entries(result.widths).every(
                ([key, width]) => width >= ({ a: 80, b: 120, c: 60 }[key] ?? 0),
            ),
        ).toBe(true);
        expect(visibleTotal(result.widths, 4)).toBeCloseTo(320);
    });

    it("is pure and handles degenerate inputs without NaN", () => {
        const panes = [pane("a", 120, 60), pane("a", 40, 40), pane("b", Number.NaN, Number.NaN)];
        const dropOrder = ["b", "a", "a"];
        const beforePanes = panes.map((item) => ({ ...item }));
        const beforeDropOrder = [...dropOrder];

        const first = resolvePaneBudget(0, panes, dropOrder, -4);
        const second = resolvePaneBudget(0, panes, dropOrder, -4);

        expect(first).toEqual(second);
        expect(
            Object.values(first.widths).every((width) => Number.isFinite(width) && width >= 0),
        ).toBe(true);
        expect(panes).toEqual(beforePanes);
        expect(dropOrder).toEqual(beforeDropOrder);
    });

    // The purity case above drops its non-finite pane before it can receive a width, so it
    // passes even with every input guard deleted. These two keep a poisoned pane visible and
    // hand the resolver a negative viewport, which is where unsanitized input actually escapes.
    it("keeps visible widths finite when a surviving pane carries non-finite bounds", () => {
        const result = resolvePaneBudget(
            600,
            [pane("bad", Number.NaN, Number.NaN), pane("good", 100, 200)],
            [],
            4,
        );

        expect(Object.values(result.widths).every((width) => Number.isFinite(width))).toBe(true);
        expect(result.widths.good).toBeGreaterThanOrEqual(100);
        expect(visibleTotal(result.widths, 4)).toBeCloseTo(600);
    });

    it("never emits a negative width for a negative viewport", () => {
        const result = resolvePaneBudget(
            -500,
            [pane("a", 100, 200), pane("b", 100, 200)],
            ["b"],
            4,
        );

        expect(
            Object.values(result.widths).every((width) => Number.isFinite(width) && width >= 0),
        ).toBe(true);
    });

    it("keeps the commit list visible at the measured 320px graph width", () => {
        const result = resolvePaneBudget(
            320,
            [pane("branch", 80, 260), pane("list", 200, 200), pane("info", 250, 330)],
            ["info", "branch"],
            4,
        );

        expect(result.hidden).toEqual(["info"]);
        expect(result.widths.branch).toBeGreaterThanOrEqual(80);
        expect(result.widths.list).toBeGreaterThanOrEqual(200);
        expect(visibleTotal(result.widths, 4)).toBeCloseTo(320);
    });

    it("scales all measured panes at 1200px without hiding any", () => {
        const result = resolvePaneBudget(
            1_200,
            [pane("branch", 80, 260), pane("list", 200, 200), pane("info", 250, 330)],
            ["info", "branch"],
            4,
        );

        expect(result.hidden).toEqual([]);
        expect(result.widths.branch).toBeGreaterThanOrEqual(260);
        expect(result.widths.list).toBeGreaterThanOrEqual(200);
        expect(result.widths.info).toBeGreaterThanOrEqual(330);
        expect(visibleTotal(result.widths, 4)).toBeCloseTo(1_200);
    });

    it("records one-pane and two-pane drops in the declared order", () => {
        const oneDrop = resolvePaneBudget(
            250,
            [pane("graph", 100, 150), pane("info", 100, 150), pane("branch", 100, 150)],
            ["info", "branch"],
            4,
        );
        const twoDrops = resolvePaneBudget(
            150,
            [pane("graph", 100, 150), pane("info", 100, 150), pane("branch", 100, 150)],
            ["info", "branch"],
            4,
        );

        expect(oneDrop.hidden).toEqual(["info"]);
        expect(twoDrops.hidden).toEqual(["info", "branch"]);
    });
});
