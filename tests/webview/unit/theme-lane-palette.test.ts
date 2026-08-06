import { describe, expect, it } from "vitest";
import { isLightBackground, resolveLanePalette } from "../../../src/webviews/react/shared/theme";
import { computeGraph } from "../../../src/webviews/react/graph";
import {
    GRAPH_LANE_COLORS,
    GRAPH_LANE_COLORS_LIGHT,
} from "../../../src/webviews/react/shared/tokens";

/** WCAG 2.1 relative luminance for an `#rrggbb` string. */
function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe("isLightBackground", () => {
    it("reads the syntaxes getComputedStyle returns for a resolved custom property", () => {
        expect(isLightBackground("#fff")).toBe(true);
        expect(isLightBackground("#ffffff")).toBe(true);
        expect(isLightBackground("#f3f3f3ff")).toBe(true);
        expect(isLightBackground("rgb(255, 255, 255)")).toBe(true);
        expect(isLightBackground("rgba(243, 243, 243, 1)")).toBe(true);
        expect(isLightBackground("#1e1e1e")).toBe(false);
        expect(isLightBackground("rgb(30 30 30 / 100%)")).toBe(false);
    });

    it("falls back to dark for anything it cannot parse", () => {
        // A theme that resolves to a named color or an unsupported function must not
        // flip the graph to the light palette on a guess.
        expect(isLightBackground("")).toBe(false);
        expect(isLightBackground("   ")).toBe(false);
        expect(isLightBackground("white")).toBe(false);
        expect(isLightBackground("color(display-p3 1 1 1)")).toBe(false);
        expect(isLightBackground("#12345")).toBe(false);
        expect(isLightBackground("rgb(1, 2)")).toBe(false);
        expect(isLightBackground("rgb(a, b, c)")).toBe(false);
    });

    it("puts the boundary between the darkest light theme and the lightest dark one", () => {
        expect(isLightBackground("#f3f3f3")).toBe(true); // Light+ editor background
        expect(isLightBackground("#fffffe")).toBe(true); // Quiet Light
        expect(isLightBackground("#282c34")).toBe(false); // One Dark Pro
        expect(isLightBackground("#2b2b2b")).toBe(false); // Darcula
    });
});

describe("lane palettes", () => {
    it("hands the graph a palette matching the theme", () => {
        expect(resolveLanePalette(true)).toBe(GRAPH_LANE_COLORS_LIGHT);
        expect(resolveLanePalette(false)).toBe(GRAPH_LANE_COLORS);
    });

    it("clears 3:1 non-text contrast against the background each palette targets", () => {
        // WCAG 1.4.11: graph strokes and dots are non-text graphics.
        for (const color of GRAPH_LANE_COLORS_LIGHT) {
            expect(contrast(color, "#ffffff")).toBeGreaterThanOrEqual(3);
            expect(contrast(color, "#f3f3f3")).toBeGreaterThanOrEqual(3);
        }
        for (const color of GRAPH_LANE_COLORS) {
            expect(contrast(color, "#1e1e1e")).toBeGreaterThanOrEqual(3);
            expect(contrast(color, "#2b3342")).toBeGreaterThanOrEqual(3);
        }
    });

    it("keeps the two palettes the same length so lane indices stay stable", () => {
        expect(GRAPH_LANE_COLORS_LIGHT).toHaveLength(GRAPH_LANE_COLORS.length);
    });
});

describe("computeGraph palette", () => {
    const commits = [
        { hash: "c", parentHashes: ["b"] },
        { hash: "b", parentHashes: ["a"] },
        { hash: "a", parentHashes: [] },
    ];

    it("colors lanes from the palette it is given", () => {
        const rows = computeGraph(commits, GRAPH_LANE_COLORS_LIGHT);
        expect(rows.map((row) => row.color)).toEqual([
            GRAPH_LANE_COLORS_LIGHT[0],
            GRAPH_LANE_COLORS_LIGHT[0],
            GRAPH_LANE_COLORS_LIGHT[0],
        ]);
    });

    it("defaults to the dark palette and ignores an empty one", () => {
        expect(computeGraph(commits)[0].color).toBe(GRAPH_LANE_COLORS[0]);
        expect(computeGraph(commits, [])[0].color).toBe(GRAPH_LANE_COLORS[0]);
    });

    it("keeps lane topology independent of the palette", () => {
        const dark = computeGraph(commits, GRAPH_LANE_COLORS);
        const light = computeGraph(commits, GRAPH_LANE_COLORS_LIGHT);
        expect(light.map((row) => row.column)).toEqual(dark.map((row) => row.column));
        expect(light.map((row) => row.numColumns)).toEqual(dark.map((row) => row.numColumns));
    });
});
