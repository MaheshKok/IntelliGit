import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import visualConfig from "../../../playwright.visual.config";
import { oracles } from "../../oracles";
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

describe("pixel baseline layout", () => {
    it("stores exactly the 32-cell matrix at the configured template path", () => {
        expect(
            existsSync(BASELINE_DIR),
            `No baselines at ${BASELINE_DIR}. Generate them with bun run test:visual:container.`,
        ).toBe(true);

        const baselineLayout = oracles.get("baselineLayout");
        const expected = new Set(
            HOST_CONTEXT_IDS.flatMap((contextId) =>
                pixelProjectNames.map((projectName) =>
                    baselineLayout.expectedBaselineName(contextId, projectName),
                ),
            ),
        );

        expect(expected.size).toBe(HOST_CONTEXT_IDS.length * pixelProjectNames.length);
        expect(
            baselineLayout.findBaselineLayoutFindings(
                HOST_CONTEXT_IDS,
                pixelProjectNames,
                readdirSync(BASELINE_DIR),
            ),
        ).toEqual([]);
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
