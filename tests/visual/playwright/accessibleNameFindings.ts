import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { classifyAccessibleName } from "../oracles/accessibleNameVerdict";
import { normalizeFindingKeys } from "../oracles/findingsBaseline";
import { matchTruncatedRendering } from "../oracles/truncationSources";
import type { CollectedOracleInputs } from "./collectOracleInputs";

type RenderedText = CollectedOracleInputs["renderedTexts"][number];

const NAME_PROBE_TIMEOUT_MS = 250;

/** Resolves whether the element's computed accessible name is exactly `candidate`. */
async function announces(target: Locator, candidate: string): Promise<boolean> {
    try {
        await expect(target).toHaveAccessibleName(candidate, { timeout: NAME_PROBE_TIMEOUT_MS });
        return true;
    } catch {
        // A name that does not match is evidence, not a test failure -- the verdict below decides
        // what it means, and the baseline decides whether the resulting finding is already known.
        return false;
    }
}

/**
 * Reports elements whose visible text abbreviates a known source string without exposing the full
 * string to assistive technology.
 *
 * Truncation itself is not the defect -- an ellipsis is a deliberate layout choice. Losing the
 * content is. So this collector gathers evidence about one element -- how many sources could have
 * produced the abbreviation, whether any source equals it outright, and what the element actually
 * announces -- and leaves the ruling to `classifyAccessibleName`, which is pure and unit-tested.
 * The accessible name is the name a screen reader would announce, whether it comes from DOM
 * content, `aria-label`, `aria-labelledby`, or a native label.
 */
export async function collectAccessibleNameFindings(
    page: Page,
    renderedTexts: readonly RenderedText[],
    sourceStrings: readonly string[],
): Promise<readonly string[]> {
    const findings: string[] = [];

    for (const { id, oracleKey, text } of renderedTexts) {
        const match = matchTruncatedRendering(text, sourceStrings);
        if (match === undefined) {
            continue;
        }

        const target = page.locator(`[data-oracle-key="${oracleKey}"]`);
        // Only asked when a complete source exists, because that is the only case whose ruling
        // consults it -- and an unasked probe costs a full timeout per element.
        const announcesRenderedText =
            match.completeSourceExists && (await announces(target, match.rendered));

        let announcesSomeSource = false;
        for (const source of match.sources) {
            if (await announces(target, source)) {
                announcesSomeSource = true;
                break;
            }
        }

        const verdict = classifyAccessibleName({
            sourceCount: match.sources.length,
            completeSourceExists: match.completeSourceExists,
            announcesRenderedText,
            announcesSomeSource,
        });
        if (verdict !== undefined) {
            findings.push(`${id} [${verdict}]`);
        }
    }

    return normalizeFindingKeys(findings);
}
