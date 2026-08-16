/** A baseline-layout defect found by comparing the expected matrix with disk contents. */
export type BaselineLayoutFinding =
    | { readonly kind: "orphan"; readonly filename: string }
    | { readonly kind: "gap"; readonly filename: string };

/** Derives the filename Playwright writes for one context/project baseline cell. */
export function expectedBaselineName(contextId: string, projectName: string): string {
    return `pixel-baseline-screenshots-${contextId}-matches-the-pixel-baseline-1-${projectName}.png`;
}

/**
 * Reports committed baselines without an owning matrix cell and matrix cells without a file.
 * Findings are grouped by defect and sorted by filename for deterministic failure messages.
 */
export function findBaselineLayoutFindings(
    contextIds: readonly string[],
    projectNames: readonly string[],
    actualFilenames: readonly string[],
): readonly BaselineLayoutFinding[] {
    const expectedFilenames = new Set(
        contextIds.flatMap((contextId) =>
            projectNames.map((projectName) => expectedBaselineName(contextId, projectName)),
        ),
    );
    const actualFilenameSet = new Set(actualFilenames);

    const orphans = [...actualFilenameSet]
        .filter((filename) => !expectedFilenames.has(filename))
        .sort()
        .map((filename) => ({ kind: "orphan" as const, filename }));
    const gaps = [...expectedFilenames]
        .filter((filename) => !actualFilenameSet.has(filename))
        .sort()
        .map((filename) => ({ kind: "gap" as const, filename }));

    return [...orphans, ...gaps];
}
