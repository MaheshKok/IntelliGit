import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * The merge editor's copy of the whole-line double tint, asserted on the merge editor's own DOM.
 *
 * `wholeLineWordFill.spec.ts` pins this for the diff viewer. The merge editor reaches the same
 * result through different markup, so it needs its own measurement rather than a second context
 * in that file: there the wash sits on the block element itself, here it sits on the individual
 * `.real-line-row` inside a column (merge-editor.css:798-803), and the state classes are
 * `.variant-*` on a wrapper rather than `.diff-segment-*` on the block.
 *
 * The arithmetic is identical. `--merge-inserted-block-bg` washes a wholly-inserted hunk's rows
 * in `--merge-ok` at 15% (merge-editor.css:80), and `--pycharm-inserted` paints every changed
 * word run in the SAME hue at 30% (merge-editor.css:71, applied at :1071-1075). Inside a
 * one-sided hunk that run is the entire line: `sideVariantClass` returns `variant-insertion`
 * exactly when `segment.baseLines.length === 0` (merge-editor/segments.tsx:181), the columns pass
 * `compareLines={segment.baseLines}` (segments.tsx:508), `padLines` fills every row with `""`,
 * and `buildChangedCharMasks` then marks every character. So the glyphs sit in a 30% box inside a
 * 15% band, and the band's "this line is new" is repeated by a darker box saying nothing more.
 *
 * The control is a true conflict. `sideVariantClass` returns "" when `changeKind === "conflict"`
 * (segments.tsx:180), so `.change-conflict` and `.variant-*` are mutually exclusive and the two
 * populations cannot overlap. A conflict hunk has a counterpart on both sides, so "which words
 * differ" has an answer and the mark is the only thing that gives it. Asserting it rather than
 * exempting it is what stops the cheap fixes: deleting the word-mark rules outright, or dropping
 * the spans from the DOM, satisfies the one-sided assertion completely and would leave the merge
 * editor marking nothing anywhere.
 *
 * The band is resolved by walking up from the mark rather than by naming a class, because the two
 * populations do not paint it in the same place -- and because of a case the class-naming version
 * would miss entirely: `merge-editor.css:816-821` forces the UNCHANGED column of a one-sided hunk
 * transparent, but there is no word-fill counterpart to that rule, so a mark in that column keeps
 * the full 30% green over a band that paints nothing. That is a tint with no wash beneath it at
 * all, and the walk reports it the same way it reports the double tint.
 *
 * No existing gate sees any of this. The pixel baselines froze whatever was there; the contrast
 * oracles read each span against its own background, and 30%-on-15% of one hue is a perfectly
 * legible pair; and jsdom resolves neither `color-mix` nor custom-property substitution, which is
 * why the stylesheet unit tests can assert what the rule SAYS but never what a browser paints.
 */

/** One `.word-diff-change` run, measured against the band it actually sits on. */
interface MarkSample {
    /** `variant-insertion` for the one-sided population, `change-conflict` for the control. */
    readonly state: string;
    /** The column the mark sits in, so a failure names which side is wrong. */
    readonly column: string;
    /** Composited 8-bit RGBA of the nearest ancestor that paints anything, `0,0,0,0` if none. */
    readonly bandRgba: string;
    /** Composited 8-bit RGBA of the mark's own background. */
    readonly markRgba: string;
    readonly markAlpha: number;
    /** True when the mark paints a tint the band does not already carry. */
    readonly addsTint: boolean;
    readonly text: string;
}

interface MarkSurvey {
    readonly oneSided: readonly MarkSample[];
    readonly twoSided: readonly MarkSample[];
    /** Every conflict wrapper found, by state -- so an empty survey names which half went missing. */
    readonly blockCounts: Readonly<Record<string, number>>;
}

/**
 * Reads every word mark, its column and its band in ONE evaluate.
 *
 * Colours are normalised through a canvas rather than compared as computed strings: they arrive
 * as `rgb()`, `rgba()` and `color(srgb ... / a)` depending on whether `color-mix` resolved, and
 * two spellings of one colour must not read as a difference. `transparent` and a fully
 * transparent `color-mix` both normalise to `0,0,0,0`, which is the point -- this asserts what is
 * painted, not which syntax expressed it.
 */
async function surveyMergeMarks(page: import("@playwright/test").Page): Promise<MarkSurvey> {
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

        const COLUMNS = ["conflict-ours", "conflict-theirs", "conflict-result"];
        const oneSided: unknown[] = [];
        const twoSided: unknown[] = [];
        const blockCounts: Record<string, number> = {
            "variant-insertion": 0,
            "variant-deletion": 0,
            "variant-modification": 0,
            "change-conflict": 0,
        };

        const wrappers = Array.from(
            document.querySelectorAll<HTMLElement>(".merge-editor .segment-conflict"),
        );
        for (const wrapper of wrappers) {
            for (const key of Object.keys(blockCounts)) {
                if (wrapper.classList.contains(key)) blockCounts[key] += 1;
            }

            // Only the two populations this file compares. `variant-deletion` and
            // `variant-modification` are counted above but not sampled: the first cannot be
            // reproduced by any committed fixture, and the second is the merge editor's own
            // two-sided case, already represented by the conflict control.
            const oneSidedWrapper = wrapper.classList.contains("variant-insertion");
            const controlWrapper = wrapper.classList.contains("change-conflict");
            if (!oneSidedWrapper && !controlWrapper) continue;

            for (const mark of Array.from(
                wrapper.querySelectorAll<HTMLElement>(".word-diff-change"),
            )) {
                // The band is whatever actually paints behind this mark, found by walking out to
                // the wrapper. Naming a class instead would measure the wrong element in the one
                // case that matters most -- the unchanged column, whose row is forced transparent
                // while the mark above it is not.
                let bandRgba = "0,0,0,0";
                for (
                    let node: HTMLElement | null = mark.parentElement;
                    node !== null;
                    node = node.parentElement
                ) {
                    const candidate = rgbaOf(getComputedStyle(node).backgroundColor);
                    if (Number(candidate.split(",")[3]) > 0) {
                        bandRgba = candidate;
                        break;
                    }
                    if (node === wrapper) break;
                }

                const markRgba = rgbaOf(getComputedStyle(mark).backgroundColor);
                const markAlpha = Number(markRgba.split(",")[3]);
                const column =
                    COLUMNS.find((name) => mark.closest(`.${name}`) !== null) ?? "unknown";
                const sample = {
                    state: oneSidedWrapper ? "variant-insertion" : "change-conflict",
                    column,
                    bandRgba,
                    markRgba,
                    markAlpha,
                    addsTint: markAlpha > 0 && markRgba !== bandRgba,
                    text: (mark.textContent ?? "").slice(0, 40),
                };
                (oneSidedWrapper ? oneSided : twoSided).push(sample);
            }
        }

        return { oneSided, twoSided, blockCounts };
    }) as Promise<MarkSurvey>;
}

test.describe("merge-editor whole-line word fill", () => {
    test("a wholly inserted hunk tints the line once, and a conflict still marks its words", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("merge-editor", {
            webviewFixture: HOST_CONTEXT_FIXTURES["merge-editor"],
        });
        const survey = await surveyMergeMarks(page);

        // Anti-vacuity, and the reason it is not optional: the failure this file exists to catch
        // is a SECOND tint, and every cheap way to remove a second tint -- dropping the rule,
        // dropping the spans, losing the fixture's one-sided hunk -- also removes the samples.
        // Asserting on an empty list is how a suite reports "fixed" for "no longer measured".
        // `blockCounts` is in the message so an empty survey says WHICH half went: a zero
        // `variant-insertion` count means the fixture regressed, a non-zero one with no samples
        // means the spans did.
        expect(
            survey.oneSided.length,
            `no word marks were found inside a wholly inserted hunk, so nothing was measured. ` +
                `Wrappers found: ${JSON.stringify(survey.blockCounts)}`,
        ).toBeGreaterThan(0);

        expect(
            survey.twoSided.length,
            `no word marks were found inside a conflict hunk, so the control below cannot ` +
                `distinguish this fix from deleting every word mark in the merge editor. ` +
                `Wrappers found: ${JSON.stringify(survey.blockCounts)}`,
        ).toBeGreaterThan(0);

        const doubled = survey.oneSided.filter((sample) => sample.addsTint);
        // Tallied by column rather than reported as one number: the unchanged column fails for a
        // different reason than the changed one -- a mark over a transparent band rather than a
        // mark over a wash -- and a bare count cannot say which of the two a fix reached.
        const byColumn = doubled.reduce<Record<string, number>>((tally, sample) => {
            tally[sample.column] = (tally[sample.column] ?? 0) + 1;
            return tally;
        }, {});
        expect(
            doubled.length,
            `${doubled.length}/${survey.oneSided.length} word marks inside a wholly inserted ` +
                `hunk paint a second tint over the band beneath them, so the line reads as two ` +
                `shades of one colour instead of one. By column: ${JSON.stringify(byColumn)}. ` +
                `First: ${JSON.stringify(doubled[0])}`,
        ).toBe(0);

        // The control. A conflict hunk has a counterpart on both sides, so "which words differ"
        // has an answer and the mark is the only thing that gives it -- this must keep painting.
        const marked = survey.twoSided.filter((sample) => sample.addsTint);
        expect(
            marked.length,
            `no word mark inside a conflict hunk paints a tint of its own, so a reader cannot ` +
                `see which words differ between the two sides. ` +
                `Samples: ${JSON.stringify(survey.twoSided.slice(0, 3))}`,
        ).toBeGreaterThan(0);
    });
});
