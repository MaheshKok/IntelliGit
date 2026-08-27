import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DiffPane } from "../../src/webviews/react/diff-viewer/segmentMarkers";
import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * Where the revert arrow actually lands, measured in a real browser.
 *
 * `revertArrowX` is unit-proven, but it only decides which of the arrow's own edges meets the
 * anchor. The lane that box stands in is CSS -- `--diff-viewer-action-gutter` widening each
 * pane's number column, and the `.line-number-row` padding that pushes the numbers off the code
 * side of it -- and none of that exists in jsdom. The integration suite loads no stylesheet, so
 * it reads every column as zero wide; the pixel baselines mount the recorded fixture, which
 * names no editable pane and therefore draws no arrow at all. Between them the placement had no
 * oracle: the arrow could sit anywhere and every gate stayed green.
 *
 * Both editable sides are driven, because the arrow lands on the pane OPPOSITE the editable one
 * and the two panes anchor from opposite edges of their own number columns. Measuring only the
 * working-tree-on-the-right case covered a real placement while leaving the mirrored half -- the
 * rule this surface adds on top of diff-core, and the second transform -- unproven: a mutant
 * that anchored both panes from the same edge passed that version of this spec unchanged.
 */

/**
 * The editable payload is the RECORDED one plus the three fields that make an edit expressible,
 * not a payload written here.
 *
 * The recorded fixture is read-only, and it cannot simply be copied into an editable variant on
 * disk: `webviewFixtureRegistry` types a fixture's filename as a `RepositoryScenarioId`, so a
 * committed `editable-*.json` is an orphan until a recorder reproduces it from a repository
 * scenario -- and "which pane the host named editable" is not a repository state. Deriving the
 * payload from `clean.json` at mount time keeps the recorder the single source of what a
 * `setDiffData` looks like: when the recording changes, this spec follows it.
 */
const RECORDED = JSON.parse(
    readFileSync(
        resolve(__dirname, "fixtures/diff-viewer", HOST_CONTEXT_FIXTURES["diff-viewer"]),
        "utf8",
    ),
) as {
    readonly messages: readonly {
        readonly message: { readonly type: string; readonly data?: Record<string, unknown> };
    }[];
};

function recordedDiffData(): Record<string, unknown> {
    const posts = RECORDED.messages.filter((entry) => entry.message.type === "setDiffData");
    expect(posts.length, "recorded setDiffData messages").toBe(1);
    return posts[0].message.data!;
}

/** The recorded payload, re-posted with one side named editable and its document attached. */
function editablePayload(editable: DiffPane): Record<string, unknown> {
    const data = recordedDiffData();
    const segments = data.segments as readonly Record<DiffPane, readonly string[]>[];
    return {
        ...data,
        editablePane: editable,
        // `revertablePaneOf` needs all three: a payload naming an editable side without the
        // document behind it renders read-only blocks and no arrows at all. The text is the
        // editable side of the recorded segments, so the editor mounts on the same bytes the
        // read-only blocks would otherwise have shown.
        editableText: segments.flatMap((segment) => segment[editable]).join("\n"),
        documentVersion: 1,
        // The editable side is the working tree by definition, so the labels follow the side
        // rather than staying at whatever the recording captured.
        leftLabel: editable === "left" ? "Working tree" : "HEAD",
        rightLabel: editable === "right" ? "Working tree" : "HEAD",
    };
}

const CASES = [
    // The changed-files viewer: the working tree is the right pane, so the arrow points `»`
    // into it and stands on the left pane's strip, which diff-core's own rule cuts.
    { editable: "right", arrowPane: "left" },
    // `panelFileActions`: the working tree is the left pane, so the arrow stands on the right
    // pane's strip -- the one the mirrored rule in diff-viewer.css cuts.
    { editable: "left", arrowPane: "right" },
] as const;

test.describe("revert arrow placement", () => {
    for (const { editable, arrowPane } of CASES) {
        test(`stands in the ${arrowPane} pane's action strip when the ${editable} pane is editable`, async ({
            mountHarness,
            page,
        }) => {
            await mountHarness("diff-viewer", {
                webviewFixture: HOST_CONTEXT_FIXTURES["diff-viewer"],
            });
            await page.evaluate((data) => {
                window.dispatchEvent(
                    new MessageEvent("message", { data: { type: "setDiffData", data } }),
                );
            }, editablePayload(editable));

            // Readiness is "the arrow and both number columns stopped moving", held across three
            // consecutive animation frames -- not a sleep, and not "the element exists", which is
            // true while it is still `display: none`. Opening the action strip takes two passes
            // by construction: the commit that widens the columns cannot measure the new width
            // (the segments carry `content-visibility: auto`, so a pane whose own DOM did not
            // change still reports the previous frame's grid, and a `getBoundingClientRect` on
            // the column returns that stale value rather than flushing it), and the
            // `ResizeObserver` on the columns delivers the settled one a few frames later.
            // Reading between those two lands on the first, pre-strip placement.
            await page.waitForFunction(() => {
                const arrow = document.querySelector<HTMLElement>(".diff-hunk-revert");
                if (arrow === null || arrow.style.display !== "flex" || arrow.style.left === "") {
                    return false;
                }
                const columns = [...document.querySelectorAll('[data-testid^="diff-pane-"]')]
                    .map(
                        (pane) =>
                            pane.querySelector(".line-numbers")?.getBoundingClientRect().width,
                    )
                    .join(",");
                const reading = `${arrow.style.left}|${columns}`;
                const state = window as unknown as { __arrow?: { reading: string; held: number } };
                const held = state.__arrow?.reading === reading ? state.__arrow.held + 1 : 0;
                state.__arrow = { reading, held };
                return held >= 3;
            });

            const geometry = await page.evaluate(() => {
                const box = (element: Element | null) => {
                    if (element === null) return null;
                    const { left, right, width } = element.getBoundingClientRect();
                    return { left, right, width };
                };
                const paneParts = (pane: "left" | "right") => {
                    const root = `[data-testid="diff-pane-${pane}"]`;
                    return {
                        // The whole number column: line-number gutter plus the action strip,
                        // which together are the track the grid template sizes.
                        column: box(document.querySelector(`${root} .line-numbers`)),
                        // The first rendered number cell, which is where the row's padding has
                        // pushed the digits to -- the far side of the strip.
                        number: box(document.querySelector(`${root} .line-number`)),
                    };
                };
                const visible = [...document.querySelectorAll(".diff-hunk-revert")].filter(
                    (element) => getComputedStyle(element).display !== "none",
                );
                return {
                    arrows: visible.map((element) => box(element)),
                    // The glyph's own font box, which is what actually overflows. A text range's
                    // client rect is ascent+descent (~1.29em), never `line-height`, so this is
                    // the measurement the font-size ceiling in diff-viewer.css is derived from.
                    glyphs: visible.map((element) => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        const glyph = range.getBoundingClientRect();
                        const button = element.getBoundingClientRect();
                        return { glyph: glyph.height, button: button.height };
                    }),
                    left: paneParts("left"),
                    right: paneParts("right"),
                };
            });

            const { left, right } = geometry;
            expect(left.column, "the left pane's number column").not.toBeNull();
            expect(left.number, "the left pane's first line number").not.toBeNull();
            expect(right.column, "the right pane's number column").not.toBeNull();
            expect(right.number, "the right pane's first line number").not.toBeNull();

            // The recorded payload has three changed segments, so it draws three arrows. Zero
            // would make every assertion below pass over an empty list, which is the shape this
            // whole spec exists to rule out.
            expect(geometry.arrows.length, "visible revert arrows").toBeGreaterThan(0);

            // Each pane's strip: the part of its number column the digits were padded away
            // from, which is the part touching that pane's own code. The left pane numbers on
            // its right, so its strip is the near edge of the column; the right pane numbers on
            // its left, so its strip is the far edge.
            const strips = {
                left: { left: left.column!.left, right: left.number!.left },
                right: { left: right.number!.right, right: right.column!.right },
            };

            // 30px: `--diff-revert-arrow-size`, which sizes the arrow's box and the lane cut for
            // it from the same number, so the two can never drift into a clipped glyph or a
            // button floating away from the line it annotates.
            expect(strips.left.right - strips.left.left, "the left pane's action strip").toBe(30);
            expect(strips.right.right - strips.right.left, "the right pane's action strip").toBe(
                30,
            );
            expect(right.column!.width, "both panes reserve the same column").toBe(
                left.column!.width,
            );

            // The glyph is sized to its box, so growing the box grows the glyph -- and a glyph
            // taller than the box it is centred in overflows `.diff-viewport` wherever a hunk
            // sits flush against the top of the scroller, which is where it goes invisible
            // rather than merely looking wrong. Nothing else measures this: the recorded
            // fixture draws no arrow, so the clipping collector never sees one.
            for (const [index, { glyph, button }] of geometry.glyphs.entries()) {
                expect(glyph, `arrow ${index} glyph inside its own box`).toBeLessThanOrEqual(
                    button,
                );
            }

            const strip = strips[arrowPane];
            for (const [index, arrow] of geometry.arrows.entries()) {
                expect(arrow!.left, `arrow ${index} left edge`).toBe(strip.left);
                expect(arrow!.right, `arrow ${index} right edge`).toBe(strip.right);
            }
        });
    }
});
