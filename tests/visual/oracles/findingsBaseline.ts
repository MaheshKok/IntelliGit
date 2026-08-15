/**
 * Ratchet comparison for the live-page oracles.
 *
 * The oracles found real defects in code that predates them. Asserting zero findings would
 * make the suite permanently red, and a gate that can never pass is not a gate -- it trains
 * everyone to reach for `--no-verify`, which skips every other check too. Asserting
 * `observed ⊆ baseline` instead would rot: a fixed defect lingers in the file forever and
 * nothing ever notices.
 *
 * So the contract is **exact set equality** in both directions:
 *
 * - `regressions` — observed but not baselined. A new defect. Fix it.
 * - `resolved` — baselined but no longer observed. A defect was fixed; delete its entry so
 *   the baseline can never quietly re-accept it later.
 *
 * That makes the baseline a backlog that can only shrink, and makes shrinking it a
 * deliberate, reviewed edit rather than a silent drift.
 */

export interface FindingDiff {
    /** Observed now, absent from the baseline: a regression. */
    readonly regressions: readonly string[];
    /** In the baseline, no longer observed: a stale entry to delete. */
    readonly resolved: readonly string[];
}

/** Deduplicated + sorted, so a baseline file never churns on ordering or repeats. */
export function normalizeFindingKeys(keys: readonly string[]): readonly string[] {
    return [...new Set(keys)].sort();
}

export function diffFindings(
    observed: readonly string[],
    baseline: readonly string[],
): FindingDiff {
    const observedSet = new Set(observed);
    const baselineSet = new Set(baseline);
    return {
        regressions: [...observedSet].filter((key) => !baselineSet.has(key)).sort(),
        resolved: [...baselineSet].filter((key) => !observedSet.has(key)).sort(),
    };
}

export function isClean(diff: FindingDiff): boolean {
    return diff.regressions.length === 0 && diff.resolved.length === 0;
}

/**
 * Contrast keys carry the ratio rounded to one decimal place. Storing the bare element id
 * would let a known-bad element silently degrade further (4.4 -> 1.2) without failing;
 * storing the full float would churn the baseline on sub-pixel rendering noise.
 *
 * `ratio` is optional because `ContrastViolation` omits it for `unresolved-background`, where no
 * opaque background resolved and there is no ratio to round. That case gets its own key rather
 * than a numeric one: calling `.toFixed` on the missing ratio was a latent TypeError that only
 * stayed dormant while no fixture produced an unresolved background.
 */
export function contrastKey(id: string, ratio: number | undefined): string {
    return ratio === undefined ? `${id} @unresolved-background` : `${id} @${ratio.toFixed(1)}`;
}

export function describeDiff(label: string, diff: FindingDiff): string {
    const parts: string[] = [];
    if (diff.regressions.length > 0) {
        parts.push(
            `${label}: ${diff.regressions.length} NEW finding(s) — this change introduced them:\n` +
                diff.regressions.map((key) => `    + ${key}`).join("\n"),
        );
    }
    if (diff.resolved.length > 0) {
        parts.push(
            `${label}: ${diff.resolved.length} baselined finding(s) no longer occur. ` +
                `If you fixed them, delete these entries from the baseline ` +
                `(UPDATE_VISUAL_BASELINE=1 ... --workers=1):\n` +
                diff.resolved.map((key) => `    - ${key}`).join("\n"),
        );
    }
    return parts.join("\n");
}
