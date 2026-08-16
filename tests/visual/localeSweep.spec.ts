import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import type { WebviewCatalog } from "../../src/webviews/i18n/catalogs";
import { WEBVIEW_CATALOG_LOCALES } from "../../src/webviews/i18n/catalogs";
import { HOST_CONTEXT_FIXTURES, HOST_CONTEXT_IDS } from "./hostContextFixtures";
import { oracles } from "../oracles";
import { collectAccessibleNameFindings } from "./playwright/accessibleNameFindings";
import type { CollectedOracleInputs } from "./playwright/collectOracleInputs";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

const { describeDiff, diffFindings, isClean, normalizeFindingKeys } =
    oracles.get("findingsBaseline");
const { baselineFile } = oracles.get("findingsBaselineFile");
const { collectCatalogStrings } = oracles.get("catalogSources");
const { findClippingLosses, findZeroSizeTargets } = oracles.get("geometry");
const { collectSourceStrings } = oracles.get("truncationSources");

const FIXTURES_DIRECTORY = resolve(__dirname, "fixtures");
// Contrast is intentionally excluded: catalog swaps change text geometry, not colors, so the
// contrast findings are invariant across locales and would add baseline noise without signal.
const LOCALE_BUCKETS = ["clipping", "accessibleNames", "zeroSize"] as const;
type LocaleBucket = (typeof LOCALE_BUCKETS)[number];
const BASELINE = baselineFile(
    resolve(FIXTURES_DIRECTORY, "knownLocaleFindings.json"),
    LOCALE_BUCKETS,
);

interface RecordedFixture {
    readonly messages: readonly unknown[];
}

function fixtureMessagesFor(contextId: keyof typeof HOST_CONTEXT_FIXTURES): readonly unknown[] {
    const fixturePath = resolve(FIXTURES_DIRECTORY, contextId, HOST_CONTEXT_FIXTURES[contextId]);
    return (JSON.parse(readFileSync(fixturePath, "utf8")) as RecordedFixture).messages;
}

function sourceStringsFor(
    fixtureMessages: readonly unknown[],
    catalog: WebviewCatalog,
): readonly string[] {
    return [
        ...new Set([...collectSourceStrings(fixtureMessages), ...collectCatalogStrings(catalog)]),
    ].sort();
}

async function collectLocaleFindings(
    page: Page,
    inputs: CollectedOracleInputs,
    sourceStrings: readonly string[],
): Promise<Record<LocaleBucket, readonly string[]>> {
    const accessibleNames = await collectAccessibleNameFindings(
        page,
        inputs.renderedTexts,
        sourceStrings,
    );
    return {
        clipping: normalizeFindingKeys(
            inputs.clipping
                .filter(({ input }) => findClippingLosses(input).length > 0)
                .map(({ id }) => id),
        ),
        accessibleNames,
        zeroSize: normalizeFindingKeys(findZeroSizeTargets(inputs.interactiveTargets)),
    };
}

test.describe("live-page locale non-pixel oracles", () => {
    for (const locale of WEBVIEW_CATALOG_LOCALES) {
        for (const contextId of HOST_CONTEXT_IDS) {
            test(`${locale} ${contextId} matches the known-locale-findings baseline`, async ({
                mountHarness,
                page,
            }, testInfo) => {
                const mounted = await mountHarness(contextId, {
                    locale,
                    webviewFixture: HOST_CONTEXT_FIXTURES[contextId],
                });
                const inputs = await collectOracleInputs(page);
                const sourceStrings = sourceStringsFor(
                    fixtureMessagesFor(contextId),
                    mounted.i18n.catalog,
                );
                const observed = await collectLocaleFindings(page, inputs, sourceStrings);
                const project = testInfo.project.name;
                const baselineKey = `${mounted.locale}/${contextId}`;

                if (BASELINE.isUpdateRequested()) {
                    BASELINE.assertUpdatePlatform();
                    BASELINE.assertSingleWorker(testInfo.config.workers);
                    BASELINE.writeSlice(project, baselineKey, observed);
                    return;
                }

                const baseline = BASELINE.read()[project]?.[baselineKey] ?? {};
                for (const bucket of LOCALE_BUCKETS) {
                    const diff = diffFindings(observed[bucket], baseline[bucket] ?? []);
                    expect
                        .soft(
                            isClean(diff),
                            describeDiff(`[${project}] ${baselineKey} ${bucket}`, diff),
                        )
                        .toBe(true);
                }
            });
        }
    }
});
