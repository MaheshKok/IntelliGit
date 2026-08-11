import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import visualConfig from "../../../playwright.visual.config";
import { HOST_CONTEXT_IDS } from "../../visual/hostContextFixtures";

const REPO_ROOT = resolve(__dirname, "../../..");
const PIXEL_SPEC_PATH = "tests/visual/pixelBaselines.spec.ts";

/**
 * The directory Playwright resolves from snapshotPathTemplate. The default template would
 * produce `pixelBaselines.spec.ts-snapshots` instead, so the name itself is the evidence
 * that the configured template is the one in effect.
 */
const BASELINE_DIR = resolve(REPO_ROOT, "tests/visual/__screenshots__/pixelBaselines.spec.ts");

/** Projects that actually run the pixel spec, read from the config rather than re-listed. */
const pixelProjectNames = (visualConfig.projects ?? [])
    .filter((project) => !(project.testIgnore as RegExp | undefined)?.test(PIXEL_SPEC_PATH))
    .map((project) => project.name as string);

/**
 * Playwright derives the snapshot `{arg}` from the full test title. Reproducing it here means
 * renaming the describe or the test orphans all 32 baselines and turns this red, which is the
 * intended outcome -- a renamed test silently comparing against nothing is the failure mode.
 */
function expectedBaselineName(contextId: string, projectName: string): string {
    return `pixel-baseline-screenshots-${contextId}-matches-the-pixel-baseline-1-${projectName}.png`;
}

describe("pixel baseline layout", () => {
    it("stores exactly the 32-cell matrix at the configured template path", () => {
        expect(
            existsSync(BASELINE_DIR),
            `No baselines at ${BASELINE_DIR}. Generate them with bun run test:visual:container.`,
        ).toBe(true);

        const expected = new Set(
            HOST_CONTEXT_IDS.flatMap((contextId) =>
                pixelProjectNames.map((projectName) => expectedBaselineName(contextId, projectName)),
            ),
        );
        const actual = new Set(readdirSync(BASELINE_DIR));

        expect(expected.size).toBe(HOST_CONTEXT_IDS.length * pixelProjectNames.length);
        // Both directions: one way alone lets an orphaned baseline linger after a screen is
        // renamed, and the other lets a missing screen pass as covered.
        expect(actual).toEqual(expected);
        expect(expected).toEqual(actual);
    });

    it("can fail: no baseline carries a platform suffix", () => {
        // Playwright's default template appends the platform. Platform is already pinned by the
        // container guard, so a `-linux`/`-darwin` axis in the filename can only ever let a
        // second, unreviewable baseline sit beside the real one.
        const suffixed = readdirSync(BASELINE_DIR).filter((name) =>
            /-(linux|darwin|win32)\.png$/.test(name),
        );

        expect(suffixed).toEqual([]);
    });

    it("can fail: baselines live in no directory other than the configured one", () => {
        const snapshotRoot = resolve(REPO_ROOT, visualConfig.snapshotDir as string);

        expect(readdirSync(snapshotRoot)).toEqual(["pixelBaselines.spec.ts"]);
    });
});
