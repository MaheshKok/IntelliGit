type CatalogValue = string | Record<string, string>;
type Catalog = Record<string, CatalogValue>;

interface IntelligitI18nPayload {
    locale: string;
    fallbackLocale: string;
    catalog: Catalog;
    fallbackCatalog: Catalog;
}

type InterpolationArgs = Record<string, string | number | boolean>;

const pluralRulesByLocale = new Map<string, Intl.PluralRules>();

/**
 * Resolves a localized webview string from the injected catalog payload.
 *
 * Lookup prefers the active locale, falls back to the fallback catalog, applies
 * plural category selection when the catalog value is pluralized, and leaves
 * unknown `{placeholder}` tokens intact if no interpolation value is provided.
 */
export function t(key: string, args: InterpolationArgs = {}): string {
    const payload = getPayload();
    const value = payload?.catalog[key] ?? payload?.fallbackCatalog[key];
    if (typeof value === "string") return interpolate(value, args);
    if (value && typeof value === "object") {
        const count = typeof args.count === "number" ? args.count : undefined;
        const locale = payload?.locale ?? "en";
        const category = count === undefined ? "other" : pluralRulesFor(locale).select(count);
        return interpolate(value[category] ?? value.other ?? key, args);
    }
    return key;
}

function pluralRulesFor(locale: string): Intl.PluralRules {
    const cached = pluralRulesByLocale.get(locale);
    if (cached) return cached;
    // PluralRules is cached per locale; this allocation happens once per locale.
    // react-doctor-disable-next-line react-doctor/js-hoist-intl
    const rules = new Intl.PluralRules(locale);
    pluralRulesByLocale.set(locale, rules);
    return rules;
}

function getPayload(): IntelligitI18nPayload | undefined {
    const root = typeof window === "undefined" ? globalThis : window;
    const candidate = (root as typeof globalThis & { intelligitI18n?: unknown }).intelligitI18n;
    if (!candidate || typeof candidate !== "object") return undefined;
    return candidate as IntelligitI18nPayload;
}

function interpolate(value: string, args: InterpolationArgs): string {
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match: string, name: string) => {
        const replacement = args[name];
        return replacement === undefined ? match : String(replacement);
    });
}
