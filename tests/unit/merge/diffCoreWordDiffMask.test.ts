// The char-level masks diff-core hands the word-fragment renderer.
//
// `bridgeChangedWordRuns` decides which gaps get filled; this file covers the seam that
// consumes it, where a bridged gap has to be kept out of the neutral whitespace tint.
// Without that half, merge-editor.css paints every bridged gap with
// `.word-diff-change.word-diff-whitespace` and the seam reappears in a lighter colour.

import { describe, expect, it } from "vitest";
import { buildChangedCharMasks } from "../../../src/webviews/react/diff-core/segments";

/** One glyph per character, so a failure prints the run the eye would see. */
const glyphs = (mask: boolean[]): string => mask.map((v) => (v ? "#" : ".")).join("");

describe("buildChangedCharMasks", () => {
    it("expands a rewritten line into one unbroken changed run", () => {
        const line = "        // The load-bearing assertion of this pair.";
        const compare = "        // Every wash reaches the block through a token.";
        const { changed } = buildChangedCharMasks(line, compare);

        const run = glyphs(changed);
        expect(
            /#\.#/.test(run),
            `the changed run is still punctured, so the block renders as speckle:\n` +
                `  ${line}\n  ${run}`,
        ).toBe(false);
    });

    it("keeps a bridged gap out of the neutral whitespace tint", () => {
        const line = "one two three";
        const compare = "AAA BBB CCC";
        const { changed, whitespace } = buildChangedCharMasks(line, compare);

        expect(changed.every(Boolean), "an all-changed line kept a hole").toBe(true);
        expect(
            whitespace.some(Boolean),
            "a bridged gap was flagged as whitespace, which hands it the neutral tint " +
                "instead of the run's own colour and reopens the seam",
        ).toBe(false);
    });

    it("still flags whitespace that is itself the change", () => {
        // Indentation grew; nothing else moved. That whitespace is the change, so it
        // keeps the flag and the merge editor tints it neutrally rather than shouting.
        const line = "        const total = 1;";
        const compare = "    const total = 1;";
        const { changed, whitespace } = buildChangedCharMasks(line, compare);

        expect(changed[0], "the changed indent stopped being marked at all").toBe(true);
        expect(
            whitespace[0],
            "a genuine indent change lost its whitespace flag and now paints in the " +
                "full fragment colour",
        ).toBe(true);
    });
});
