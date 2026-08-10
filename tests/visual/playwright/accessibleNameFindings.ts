import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { normalizeFindingKeys } from "../oracles/findingsBaseline";
import { matchTruncatedRendering } from "../oracles/truncationSources";
import type { CollectedOracleInputs } from "./collectOracleInputs";

type RenderedText = CollectedOracleInputs["renderedTexts"][number];

/**
 * Reports elements whose visible text abbreviates a known source string without exposing the full
 * string to assistive technology.
 *
 * Truncation itself is not the defect -- an ellipsis is a deliberate layout choice. Losing the
 * content is. So an abbreviated rendering is only a finding when no candidate source matches the
 * element's computed accessible name, which is the name a screen reader would announce whether it
 * comes from DOM content, `aria-label`, `aria-labelledby`, or a native label.
 *
 * `[ambiguous-source]` is reported separately: when several sources could have produced the same
 * abbreviation, a passing name check proves only that one of them matched, so the result cannot be
 * trusted either way and the ambiguity is what needs fixing.
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

        if (match.sources.length > 1) {
            findings.push(`${id} [ambiguous-source]`);
        }

        let matched = false;
        for (const source of match.sources) {
            try {
                await expect(page.locator(`[data-oracle-key="${oracleKey}"]`)).toHaveAccessibleName(
                    source,
                    { timeout: 250 },
                );
                matched = true;
                break;
            } catch {
                // A non-matching source is the finding, not a test failure -- the baseline
                // decides whether this finding is already known.
            }
        }
        if (!matched && match.sources.length === 1) {
            findings.push(`${id} [truncated-name]`);
        }
    }

    return normalizeFindingKeys(findings);
}
