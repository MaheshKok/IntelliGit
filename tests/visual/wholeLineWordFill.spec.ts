import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * A wholly added or wholly deleted line carries ONE tint, not two.
 *
 * `.diff-segment-inserted` and `.diff-segment-deleted` already wash the whole block in their
 * own hue at 15% (diff-viewer.css:326-327). On top of that, every changed word run paints
 * `--diff-word-wash` at 30% of the same hue (diff-viewer.css:390, :517) -- and inside a
 * one-sided hunk that run is the ENTIRE line, because `WordDiffLine` compares against an empty
 * counterpart and `buildChangedCharMasks` then marks every character
 * (src/webviews/react/diff-core/segments.tsx:169-185). So the glyphs sit in a 30% box inside a
 * 15% band: the band says "this line is new", and the darker box inside it repeats the same
 * sentence in a louder voice.
 *
 * The word mark exists to answer "which words changed". On a two-sided `.diff-segment-modified`
 * hunk that question has an answer and the mark is the only thing that gives it, which is why
 * the modified case is asserted here as a CONTROL rather than exempted. Without it, deleting
 * `.word-diff-change` outright -- or dropping the spans from the DOM -- satisfies the one-sided
 * assertion completely and this file passes while marking nothing anywhere.
 *
 * On a one-sided hunk the question has no answer. Every word changed, and a mark that covers
 * every word distinguishes nothing from nothing.
 *
 * No existing gate sees this. The pixel baselines froze the double tint as correct; the contrast
 * oracles read each span against its own background and a 30%-on-15% pair of the same hue is a
 * legible foreground/background pair, so it clears them; and jsdom resolves neither `color-mix`
 * nor the custom-property substitution the wash depends on
 * (`tests/unit/visual/diffCorePalette.test.ts` parses the stylesheet as text for exactly that
 * reason, so it can assert what the rule SAYS but never what a browser paints).
 */

/** One `.word-diff-change` run, measured against the block it sits inside. */
interface MarkSample {
    /** The block's state marker, without the `diff-segment-` prefix. */
    readonly state: string;
    /** Composited 8-bit RGBA of the block's own wash. */
    readonly blockRgba: string;
    /** Composited 8-bit RGBA of the mark's background, `0,0,0,0` when it paints nothing. */
    readonly markRgba: string;
    readonly markAlpha: number;
    /** True when the mark paints a tint the block does not already carry. */
    readonly addsTint: boolean;
    readonly text: string;
}

interface MarkSurvey {
    readonly oneSided: readonly MarkSample[];
    readonly twoSided: readonly MarkSample[];
    /** Every changed block found, by state -- so an empty survey names which half went missing. */
    readonly blockCounts: Readonly<Record<string, number>>;
}

/**
 * Reads every word mark and its containing block in ONE evaluate.
 *
 * Colours are normalised through a canvas rather than compared as computed strings: the values
 * arrive as `rgb()`, `rgba()` and `color(srgb ... / a)` depending on whether `color-mix` resolved,
 * and two spellings of the same colour must not read as a difference. `transparent` and a fully
 * transparent `color-mix` both normalise to `0,0,0,0`, which is the point -- this asserts what is
 * painted, not which syntax expressed it.
 */
async function surveyMarks(page: import("@playwright/test").Page): Promise<MarkSurvey> {
    return page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d context: nothing was measured");

        const rgbaOf = (value: string): string => {
            // A sentinel goes in first: an unparseable value leaves `fillStyle` at whatever it
            // held, so without one this would report the previous colour and pass an assertion
            // that never measured anything.
            ctx.fillStyle = "#000000";
            ctx.fillStyle = "#ff00ff";
            ctx.fillStyle = value;
            if (ctx.fillStyle === "#ff00ff" && value !== "#ff00ff") {
                throw new Error(`unparseable colour ${JSON.stringify(value)}`);
            }
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return `${r},${g},${b},${a}`;
        };

        const STATES = ["inserted", "deleted", "modified"] as const;
        const oneSided: unknown[] = [];
        const twoSided: unknown[] = [];
        const blockCounts: Record<string, number> = {};

        for (const state of STATES) {
            const blocks = Array.from(
                document.querySelectorAll<HTMLElement>(`.diff-viewer .diff-segment-${state}`),
            );
            blockCounts[state] = blocks.length;

            for (const block of blocks) {
                const blockRgba = rgbaOf(getComputedStyle(block).backgroundColor);
                for (const mark of Array.from(
                    block.querySelectorAll<HTMLElement>(".word-diff-change"),
                )) {
                    const markRgba = rgbaOf(getComputedStyle(mark).backgroundColor);
                    const markAlpha = Number(markRgba.split(",")[3]);
                    const sample = {
                        state,
                        blockRgba,
                        markRgba,
                        markAlpha,
                        addsTint: markAlpha > 0 && markRgba !== blockRgba,
                        text: (mark.textContent ?? "").slice(0, 40),
                    };
                    (state === "modified" ? twoSided : oneSided).push(sample);
                }
            }
        }

        return { oneSided, twoSided, blockCounts };
    }) as Promise<MarkSurvey>;
}

test.describe("whole-line word fill", () => {
    test("a one-sided hunk tints the line once, and a modified hunk still marks its words", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", {
            webviewFixture: HOST_CONTEXT_FIXTURES["diff-viewer"],
        });
        const survey = await surveyMarks(page);

        // Anti-vacuity, and the reason it is not optional: the failure this file exists to catch
        // is a SECOND tint, and every cheap way to remove a second tint -- dropping the rule,
        // dropping the spans, dropping the fixture's one-sided hunks -- also removes the samples.
        // Asserting on an empty list is how a suite reports "fixed" for "no longer measured".
        expect(
            survey.oneSided.length,
            `no word marks were found inside a one-sided hunk, so nothing was measured. ` +
                `Blocks found: ${JSON.stringify(survey.blockCounts)}`,
        ).toBeGreaterThan(0);

        expect(
            survey.twoSided.length,
            `no word marks were found inside a two-sided hunk, so the control below cannot ` +
                `distinguish this fix from deleting every word mark in the viewer. ` +
                `Blocks found: ${JSON.stringify(survey.blockCounts)}`,
        ).toBeGreaterThan(0);

        const doubled = survey.oneSided.filter((sample) => sample.addsTint);
        // Tallied by state rather than reported as one number: the two directions are separate
        // rules in the stylesheet, and a count alone cannot say whether a fix reached both or
        // only the one whose sample happened to sort first.
        const byState = doubled.reduce<Record<string, number>>((tally, sample) => {
            tally[sample.state] = (tally[sample.state] ?? 0) + 1;
            return tally;
        }, {});
        expect(
            doubled.length,
            `${doubled.length}/${survey.oneSided.length} word marks inside a wholly added or ` +
                `wholly deleted hunk paint a second tint over the block's own wash, so the line ` +
                `reads as two shades of one colour instead of one. By state: ` +
                `${JSON.stringify(byState)}. First: ${JSON.stringify(doubled[0])}`,
        ).toBe(0);

        // The control. A modified hunk has a counterpart, so "which words changed" has an answer
        // and the mark is the only thing that gives it -- this must keep painting.
        const marked = survey.twoSided.filter((sample) => sample.addsTint);
        expect(
            marked.length,
            `no word mark inside a two-sided hunk paints a tint of its own, so a reader cannot ` +
                `see which words changed. Samples: ${JSON.stringify(survey.twoSided.slice(0, 3))}`,
        ).toBeGreaterThan(0);
    });
});
