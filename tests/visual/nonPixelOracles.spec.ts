import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { oracles } from "../oracles";
import { HOST_CONTEXT_FIXTURES, HOST_CONTEXT_IDS } from "./hostContextFixtures";
import { collectAccessibleNameFindings } from "./playwright/accessibleNameFindings";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

const { findContrastViolations } = oracles.get("contrast");
const { contrastKey, describeDiff, diffFindings, isClean, normalizeFindingKeys } =
    oracles.get("findingsBaseline");
const { baselineFile } = oracles.get("findingsBaselineFile");
const { findClippingLosses, findZeroSizeTargets } = oracles.get("geometry");
const { collectSourceStrings } = oracles.get("truncationSources");

type Bucket = "clipping" | "contrast" | "accessibleNames" | "zeroSize";
const BUCKETS: readonly Bucket[] = ["clipping", "contrast", "accessibleNames", "zeroSize"];
const BASELINE = baselineFile(resolve(__dirname, "fixtures/knownFindings.json"), BUCKETS);

test.describe("live-page non-pixel oracles", () => {
    for (const contextId of HOST_CONTEXT_IDS) {
        test(`${contextId} matches the known-findings baseline`, async ({
            mountHarness,
            page,
        }, testInfo) => {
            await mountHarness(contextId, {
                webviewFixture: HOST_CONTEXT_FIXTURES[contextId],
            });
            const inputs = await collectOracleInputs(page);
            const fixture = JSON.parse(
                readFileSync(
                    resolve(__dirname, "fixtures", contextId, HOST_CONTEXT_FIXTURES[contextId]),
                    "utf8",
                ),
            ) as { readonly messages: readonly unknown[] };
            const sourceStrings = collectSourceStrings(fixture.messages);
            const accessibleNameFindings = await collectAccessibleNameFindings(
                page,
                inputs.renderedTexts,
                sourceStrings,
            );

            const observed: Record<Bucket, readonly string[]> = {
                clipping: normalizeFindingKeys(
                    inputs.clipping
                        .filter(({ input }) => findClippingLosses(input).length > 0)
                        .map(({ id }) => id),
                ),
                contrast: normalizeFindingKeys(
                    findContrastViolations(inputs.contrast, 4.5).map((finding) =>
                        contrastKey(finding.id, finding.ratio),
                    ),
                ),
                accessibleNames: accessibleNameFindings,
                zeroSize: normalizeFindingKeys(findZeroSizeTargets(inputs.interactiveTargets)),
            };

            const project = testInfo.project.name;

            if (BASELINE.isUpdateRequested()) {
                BASELINE.assertUpdatePlatform();
                BASELINE.assertSingleWorker(testInfo.config.workers);
                BASELINE.writeSlice(project, contextId, observed);
                return;
            }

            const baseline = BASELINE.read()[project]?.[contextId] ?? {};
            for (const bucket of BUCKETS) {
                const diff = diffFindings(observed[bucket], baseline[bucket] ?? []);
                expect
                    .soft(isClean(diff), describeDiff(`[${project}] ${contextId} ${bucket}`, diff))
                    .toBe(true);
            }
        });
    }
});
