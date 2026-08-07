// Canonicalization for the raw values `captureHostFixture` reads out of the
// page, so the on-disk artifact is byte-comparable across runs. PLAN.md's
// Phase 6 step 39 recaptures every host fixture in the pinned CI container
// and byte-compares the result against what is committed here -- that
// comparison is only meaningful if incidental ordering (property insertion
// order in a browser-generated `cssText`, `Object.keys` iteration order for
// a `dataset`) can never make two otherwise-identical captures differ.

/**
 * Canonicalizes a raw `element.style.cssText` string: keeps only `--*`
 * custom properties (the `--vscode-*` theme tokens), sorts them by name, and
 * renders each as `name: value;` joined by a single space.
 *
 * Raw `cssText` order reflects `Object.entries()` iteration order over VS
 * Code's internal theme-token map when it wrote the properties
 * (`documentStyle.setProperty` in a `for...of` loop, see
 * `out/vs/workbench/contrib/webview/browser/pre/index.html`'s
 * `applyStyles`) -- an implementation detail, not a contract. Sorting here is
 * what turns "recapture and byte-compare" from order-flaky into meaningful.
 */
export function canonicalizeStyleCssText(cssText: string): string {
    const properties: Array<{ readonly name: string; readonly value: string }> = [];

    for (const rawDeclaration of cssText.split(";")) {
        const declaration = rawDeclaration.trim();
        if (!declaration) continue;

        const colonIndex = declaration.indexOf(":");
        if (colonIndex === -1) continue;

        const name = declaration.slice(0, colonIndex).trim();
        const value = declaration.slice(colonIndex + 1).trim();
        if (!name.startsWith("--")) continue;

        properties.push({ name, value });
    }

    properties.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return properties.map(({ name, value }) => `${name}: ${value};`).join(" ");
}

/** Sorts a `classList` snapshot for stable output. `classList` entries are already unique, so sorting alone canonicalizes it. */
export function canonicalizeClassList(classList: readonly string[]): readonly string[] {
    return [...classList].sort();
}

/**
 * Sorts a `dataset` snapshot's keys and drops `undefined` values.
 *
 * `DOMStringMap` types every value as `string | undefined` even though a
 * present key is always a string in practice; this is where that theoretical
 * gap actually gets closed before the value reaches disk.
 */
export function canonicalizeDataset(
    dataset: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
    const canonical: Record<string, string> = {};
    for (const key of Object.keys(dataset).sort()) {
        const value = dataset[key];
        if (value !== undefined) {
            canonical[key] = value;
        }
    }
    return canonical;
}
