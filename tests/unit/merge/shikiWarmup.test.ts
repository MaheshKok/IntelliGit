// @vitest-environment jsdom
// The grammar warm-up in shikiHighlighter, pinned against the defect it exists for.
//
// Measured on eight identical container mounts of the diff-viewer fixture: Shiki's
// FIRST `codeToTokensBase` call against a freshly built grammar classified
// `const hd0 = 0;` as a single `0;` numeric token -- semicolon swallowed into the
// literal and painted number-green -- on three of them, and as `0` + `;` on the
// other five. `highlightLine` memoizes per line, so one cold call poisons that line
// for the whole session, and whichever line lands on it varies run to run. That is
// what made a different pixel-baseline cell fail on each full visual run.
//
// The real highlighter reproduces this only ~3 times in 8, so a test driving it
// would pass five runs out of eight with the fix removed. The fake below reproduces
// the SHAPE of the defect exactly -- first call coarse, every later call correct --
// so the guarantee is asserted deterministically rather than re-rolled as a lottery.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({ tokenizedLines: [] as string[] }));

const COLD_RESULT = [[{ content: "const hd0 = 0;", color: "#cccccc", fontStyle: 0 }]];
const WARM_RESULT = [
    [
        { content: "const hd0 = ", color: "#d4d4d4", fontStyle: 0 },
        { content: "0", color: "#b5cea8", fontStyle: 0 },
        { content: ";", color: "#d4d4d4", fontStyle: 0 },
    ],
];

vi.mock("shiki/core", () => ({
    createHighlighterCoreSync: () => ({
        codeToTokensBase: (code: string) => {
            hoisted.tokenizedLines.push(code);
            return hoisted.tokenizedLines.length === 1 ? COLD_RESULT : WARM_RESULT;
        },
    }),
}));
vi.mock("shiki/engine/javascript", () => ({
    createJavaScriptRegexEngine: () => ({}),
}));

describe("Shiki grammar warm-up", () => {
    beforeEach(() => {
        hoisted.tokenizedLines = [];
        vi.resetModules();
    });

    it("spends the cold tokenization on a throwaway line, not a user-visible one", async () => {
        const mod = await import("../../../src/webviews/react/diff-core/shikiHighlighter");
        expect(mod.initShiki()).toBe(true);

        const tokens = mod.highlightLine("const hd0 = 0;", "typescript", "dark-plus");

        expect(hoisted.tokenizedLines[0]).not.toBe("const hd0 = 0;");
        expect(hoisted.tokenizedLines).toContain("const hd0 = 0;");
        // The caller gets the warm classification: the semicolon is its own token
        // and keeps default foreground instead of the numeric literal's colour.
        // Both halves matter -- the boundary AND the colour -- because the pixel
        // baselines only ever saw the second one.
        expect(tokens?.map((t) => t.text)).toEqual(["const hd0 = ", "0", ";"]);
        expect(tokens?.map((t) => t.color)).toEqual(["#d4d4d4", "#b5cea8", "#d4d4d4"]);
    });

    it("warms each language once, not once per line", async () => {
        const mod = await import("../../../src/webviews/react/diff-core/shikiHighlighter");
        mod.initShiki();

        mod.highlightLine("const a1 = 1;", "typescript", "dark-plus");
        mod.highlightLine("const a2 = 2;", "typescript", "dark-plus");
        mod.highlightLine("const a3 = 3;", "typescript", "dark-plus");

        const warmups = hoisted.tokenizedLines.filter((l) => l === "const a = 0;");
        expect(warmups).toHaveLength(1);
    });

    it("warms a second language separately from the first", async () => {
        const mod = await import("../../../src/webviews/react/diff-core/shikiHighlighter");
        mod.initShiki();

        mod.highlightLine("x = 1", "typescript", "dark-plus");
        const beforePython = hoisted.tokenizedLines.length;
        mod.highlightLine("x = 1", "python", "dark-plus");

        // A per-language warm-up means python costs two calls (throwaway + real),
        // not one -- a single global flag would leave python's grammar cold.
        expect(hoisted.tokenizedLines.length - beforePython).toBe(2);
    });
});
