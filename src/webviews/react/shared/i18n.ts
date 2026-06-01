type CatalogValue = string | Record<string, string>;
type Catalog = Record<string, CatalogValue>;

interface IntelligitI18nPayload {
    locale: string;
    fallbackLocale: string;
    catalog: Catalog;
    fallbackCatalog: Catalog;
}

type InterpolationArgs = Record<string, string | number | boolean>;

export function t(key: string, args: InterpolationArgs = {}): string {
    const payload = getPayload();
    const value = payload?.catalog[key] ?? payload?.fallbackCatalog[key];
    if (typeof value === "string") return interpolate(value, args);
    if (value && typeof value === "object") {
        const count = typeof args.count === "number" ? args.count : undefined;
        const locale = payload?.locale ?? "en";
        const category = count === undefined ? "other" : new Intl.PluralRules(locale).select(count);
        return interpolate(value[category] ?? value.other ?? key, args);
    }
    return key;
}

function getPayload(): IntelligitI18nPayload | undefined {
    const root = typeof window === "undefined" ? globalThis : window;
    const candidate = (root as typeof globalThis & { intelligitI18n?: unknown }).intelligitI18n;
    if (!candidate || typeof candidate !== "object") return undefined;
    return candidate as IntelligitI18nPayload;
}

function interpolate(value: string, args: InterpolationArgs): string {
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
        const replacement = args[name];
        return replacement === undefined ? match : String(replacement);
    });
}
