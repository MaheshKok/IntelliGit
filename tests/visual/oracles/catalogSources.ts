import type { WebviewCatalog } from "../../../src/webviews/i18n/catalogs";

const PLACEHOLDER_TOKEN = /\{[A-Za-z0-9_]+\}/u;

/**
 * Collects static strings from one active webview catalog for truncation matching.
 *
 * Plural variants are flattened because each variant can render independently. Values containing
 * a `{placeholder}` token are excluded: a rendered value such as `HEAD: main` cannot be
 * prefix-matched against the template `HEAD: {name}`, so retaining that template would create a
 * false `[ambiguous-source]` finding without catching a real truncation. Interpolated results are
 * already reachable through fixture-derived sources.
 */
export function collectCatalogStrings(catalog: WebviewCatalog): readonly string[] {
    const strings = new Set<string>();
    for (const value of Object.values(catalog)) {
        const variants = typeof value === "string" ? [value] : Object.values(value);
        for (const variant of variants) {
            if (!PLACEHOLDER_TOKEN.test(variant)) {
                strings.add(variant);
            }
        }
    }
    return [...strings].sort();
}
