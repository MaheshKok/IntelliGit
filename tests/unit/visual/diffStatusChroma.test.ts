/**
 * Guards the diff-status colours against being drained to satisfy a contrast gate.
 *
 * This is a regression oracle for a real defect: commit 4e2207b7 wrapped `added`
 * and `deleted` in `color-mix(... 55%, var(--vscode-foreground))` to lift one
 * failing contrast cell. Measured across these same four fixtures, that shifted
 * hue by under a degree while removing 25-45% of the HSL saturation -- the green
 * and red stopped reading as green and red in the commit panel, which is the one
 * thing these particular tokens exist to do.
 *
 * The assertion is deliberately NOT "the token string equals `var(--vscode-...)`".
 * That would pin today's spelling and pass for any future transformation written
 * a different way. Instead each token is RESOLVED against every host fixture and
 * compared to the host's own value, so any transformation that costs chroma --
 * a mix toward the foreground, a mix toward white, an alpha fade -- goes red
 * regardless of how it is expressed.
 */

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
    hueAndSaturation,
    hueDistance,
    readFixtureVariables,
    resolveColor,
} from "../../helpers/cssColor";
import { JETBRAINS_UI } from "../../../src/webviews/react/shared/tokens";

const FIXTURE_DIR = join(process.cwd(), "tests/visual/fixtures/host");

/** A token may lose at most this fraction of the host colour's saturation. */
const MIN_CHROMA_RETENTION = 0.9;
/** ...and must still be recognisably the same hue. */
const MAX_HUE_SHIFT_DEGREES = 5;

const DIFF_STATUS_TOKENS = [
    {
        name: "added",
        expression: JETBRAINS_UI.color.added,
        hostVar: "--vscode-gitDecoration-addedResourceForeground",
    },
    {
        name: "modified",
        expression: JETBRAINS_UI.color.modified,
        hostVar: "--vscode-gitDecoration-modifiedResourceForeground",
    },
    {
        name: "deleted",
        expression: JETBRAINS_UI.color.deleted,
        hostVar: "--vscode-gitDecoration-deletedResourceForeground",
    },
] as const;

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

describe("diff-status colours keep the host's chroma", () => {
    it("finds the host fixtures to measure against", () => {
        // Without this the suite below would silently iterate an empty list and pass.
        expect(fixtureFiles.length, `no *.json fixtures in ${FIXTURE_DIR}`).toBeGreaterThanOrEqual(
            4,
        );
    });

    for (const fixtureName of fixtureFiles) {
        const themeName = fixtureName.replace(/\.json$/, "");

        for (const token of DIFF_STATUS_TOKENS) {
            it(`${themeName}: \`${token.name}\` keeps the chroma of ${token.hostVar}`, () => {
                const variables = readFixtureVariables(join(FIXTURE_DIR, fixtureName));

                // A fixture that does not declare the host variable would make both
                // sides fall back to the same literal, and the comparison below would
                // pass without measuring anything.
                const hostDeclaration = variables.get(token.hostVar);
                expect(
                    hostDeclaration,
                    `${themeName} does not declare ${token.hostVar}, so this comparison would be vacuous`,
                ).toBeDefined();

                const host = hueAndSaturation(resolveColor(hostDeclaration as string, variables));
                const resolved = hueAndSaturation(resolveColor(token.expression, variables));

                expect(
                    hueDistance(resolved.hue, host.hue),
                    `\`${token.name}\` shifted hue away from the host's ${token.hostVar} in ${themeName}`,
                ).toBeLessThanOrEqual(MAX_HUE_SHIFT_DEGREES);

                expect(
                    resolved.saturation,
                    `\`${token.name}\` lost ${(((host.saturation - resolved.saturation) / host.saturation) * 100).toFixed(0)}% ` +
                        `of the host's chroma in ${themeName}. Raising contrast by mixing toward the foreground ` +
                        `drains the very signal these tokens carry -- adjust lightness, or record the cell in ` +
                        `tests/visual/fixtures/knownFindings.json, but do not desaturate.`,
                ).toBeGreaterThanOrEqual(host.saturation * MIN_CHROMA_RETENTION);
            });
        }
    }
});
