/**
 * Guards the commit-panel section header's `+N`/`-N` totals against being drawn on a
 * surface that makes them unreadable.
 *
 * This is a regression oracle for a real constraint, not a style preference. The header
 * used to paint itself with `var(--intelligit-pycharm-selected)` unconditionally. That
 * token is a mid-tone in the dark themes (`[79,95,124]` in HC Black), and a mid-tone
 * background caps the contrast ANY foreground can reach against it -- measured, the best
 * available red on it was 1.40:1 and no green cleared 4.5:1. That is why the totals
 * shipped uncoloured for so long: on that surface, colouring them was not possible.
 *
 * The assertion is deliberately NOT "the header's background token equals
 * `var(--intelligit-pycharm-header)`". That would pin today's spelling and pass for any
 * other mid-tone written a different way. Instead the exported
 * {@link COMMIT_PANEL_SECTION_HEADER_BG} -- the very value the component renders -- is
 * RESOLVED against every host fixture and the diff-status tokens are measured against it,
 * so any future surface change that costs legibility goes red regardless of how it is
 * expressed.
 *
 * The exception list is a TWO-WAY ratchet, matching
 * `tests/visual/fixtures/knownFindings.json`: a cell that drops below the floor without
 * being listed fails, and a listed cell that rises above the floor ALSO fails, so a fix
 * cannot silently leave a stale entry rotting in the list.
 */

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
    compositeOver,
    contrastRatio,
    readFixtureVariables,
    resolveColor,
    resolveRgba,
} from "../../helpers/cssColor";
import { JETBRAINS_UI } from "../../../src/webviews/react/shared/tokens";
import { HOST_TOKENS } from "../../../src/webviews/react/commit-panel/theme";
import { COMMIT_PANEL_SECTION_HEADER_BG } from "../../../src/webviews/react/shared/components/SectionHeader";

const FIXTURE_DIR = join(process.cwd(), "tests/visual/fixtures/host");

/** The floor `tests/visual/nonPixelOracles.spec.ts` enforces against real rendered DOM. */
const CONTRAST_FLOOR = 4.5;

const STAT_TOKENS = [
    { name: "added", expression: JETBRAINS_UI.color.added },
    { name: "deleted", expression: JETBRAINS_UI.color.deleted },
] as const;

/**
 * Cells that sit below {@link CONTRAST_FLOOR} on the header's surface and are accepted.
 *
 * Exactly one, and it is not a concession this change introduced: Dark Modern's `deleted`
 * measures the same 3.87:1 against the header background as it already does against the
 * panel background under every per-file row in `FileTreeRows` -- the cell recorded as
 * `@3.9` in `knownFindings.json`. Colouring the total therefore lands it at parity with
 * the numbers it sums rather than adding a new blind spot. Raising it means changing the
 * `deleted` token itself, which `diffStatusChroma.test.ts` constrains.
 *
 * Swapping the token was measured against this fixture set and does not work, because the
 * two dark and light ends pull in opposite directions -- Dark Modern needs a LIGHTER red
 * and Light Modern a DARKER one, and no host token is both (dark-modern / hc-black /
 * hc-light / light-modern):
 *
 *   shipped `deleted`                        3.87  4.58  7.47  7.04
 *   --vscode-charts-red                      4.97  8.55  6.61  4.46
 *   --vscode-editorError-foreground          4.97  8.55  6.61  4.46
 *   --vscode-errorForeground                 5.30  8.55  6.61  3.16
 *   --vscode-debugTokenExpression-error      7.23  8.55  4.74  4.46
 *   --vscode-testing-iconFailed              7.03    --    --  6.75   (undeclared in HC)
 *
 * Every candidate that lifts Dark Modern above the floor drops Light Modern below it, so
 * the swap trades one sub-floor cell for another while also repainting every per-file row.
 * The shipped token is the best available compromise, and this entry records the cost.
 */
const ACCEPTED_BELOW_FLOOR = new Map<string, number>([["dark-modern:deleted", 3.87]]);

/** How far a recorded cell may drift before the entry is considered stale. */
const ACCEPTED_TOLERANCE = 0.05;

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

describe("commit-panel section header totals stay legible", () => {
    it("finds the host fixtures to measure against", () => {
        // Without this the suite below would silently iterate an empty list and pass.
        expect(
            fixtureFiles.length,
            `no *.json fixtures in ${FIXTURE_DIR}`,
        ).toBeGreaterThanOrEqual(4);
    });

    /** Every cell the loop below actually measures — known at collection time, so the
     * stale-entry check never depends on test execution order. */
    const measured = new Set(
        fixtureFiles.flatMap((fixtureName) =>
            STAT_TOKENS.map((token) => `${fixtureName.replace(/\.json$/, "")}:${token.name}`),
        ),
    );

    for (const fixtureName of fixtureFiles) {
        const themeName = fixtureName.replace(/\.json$/, "");

        for (const token of STAT_TOKENS) {
            const cell = `${themeName}:${token.name}`;

            it(`${themeName}: \`${token.name}\` total is legible on the header background`, () => {
                // The fixtures declare the host's `--vscode-*` variables; the
                // `--intelligit-pycharm-*` layer is emitted at runtime by the webview theme.
                // Seeding the same map here means this resolves the way the browser does,
                // and a repointed HOST_TOKENS entry changes what is measured.
                const variables = readFixtureVariables(join(FIXTURE_DIR, fixtureName));
                for (const [property, expression] of Object.entries(HOST_TOKENS)) {
                    variables.set(property, expression);
                }

                // The header background may be declared translucent; flatten it over the
                // panel exactly as the browser paints it, or an alpha token would be
                // measured as opaque and report a ratio the user never sees.
                const panel = resolveColor(JETBRAINS_UI.color.panel, variables);
                const background = compositeOver(
                    resolveRgba(COMMIT_PANEL_SECTION_HEADER_BG, variables),
                    panel,
                );
                const ratio = contrastRatio(resolveColor(token.expression, variables), background);

                const accepted = ACCEPTED_BELOW_FLOOR.get(cell);
                if (accepted === undefined) {
                    expect(
                        ratio,
                        `\`${token.name}\` totals measure ${ratio.toFixed(2)}:1 on the section ` +
                            `header background in ${themeName}, under the ${CONTRAST_FLOOR}:1 floor ` +
                            `that tests/visual/nonPixelOracles.spec.ts enforces. The header surface ` +
                            `is COMMIT_PANEL_SECTION_HEADER_BG in SectionHeader.tsx -- fix the ` +
                            `surface rather than desaturating the token, which ` +
                            `diffStatusChroma.test.ts blocks.`,
                    ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
                    return;
                }

                // Ratchet, downward half: a recorded cell must not get worse.
                expect(
                    ratio,
                    `${cell} is recorded at ${accepted.toFixed(2)}:1 but now measures ` +
                        `${ratio.toFixed(2)}:1 -- it got worse, which the recorded entry does not cover.`,
                ).toBeGreaterThanOrEqual(accepted - ACCEPTED_TOLERANCE);

                // Ratchet, upward half: a recorded cell that now clears the floor means the
                // entry is stale. Without this the list would silently outlive its reason.
                expect(
                    ratio,
                    `${cell} now measures ${ratio.toFixed(2)}:1, at or above the ` +
                        `${CONTRAST_FLOOR}:1 floor -- delete its ACCEPTED_BELOW_FLOOR entry so the ` +
                        `list keeps meaning "still below the floor".`,
                ).toBeLessThan(CONTRAST_FLOOR);
            });
        }
    }

    it("has no ACCEPTED_BELOW_FLOOR entry for a cell that is never measured", () => {
        // A typo'd or renamed key would otherwise sit in the list forever, exempting
        // nothing while reading as a deliberate, reviewed concession.
        const unmatched = [...ACCEPTED_BELOW_FLOOR.keys()].filter((key) => !measured.has(key));
        expect(
            unmatched,
            `ACCEPTED_BELOW_FLOOR names cells that no fixture produces: ${unmatched.join(", ")}`,
        ).toEqual([]);
    });
});
