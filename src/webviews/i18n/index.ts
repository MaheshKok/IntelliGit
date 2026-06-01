import * as vscode from "vscode";
import en from "./en.json";
import de from "./de.json";

export type WebviewCatalogValue = string | Record<string, string>;
export type WebviewCatalog = Record<string, WebviewCatalogValue>;

export interface WebviewI18nPayload {
    locale: string;
    fallbackLocale: "en";
    catalog: WebviewCatalog;
    fallbackCatalog: WebviewCatalog;
}

const CATALOGS: Record<string, WebviewCatalog> = {
    en,
    de,
};

export function getWebviewI18nPayload(locale = vscode.env.language): WebviewI18nPayload {
    const normalizedLocale = normalizeLocale(locale);
    const baseCatalog = CATALOGS[normalizedLocale] ?? en;
    if (isPseudoLocEnabled()) {
        const pseudo = pseudoLocalizeCatalog(en);
        return {
            locale: normalizedLocale,
            fallbackLocale: "en",
            catalog: pseudo,
            fallbackCatalog: pseudo,
        };
    }
    return {
        locale: normalizedLocale,
        fallbackLocale: "en",
        catalog: baseCatalog,
        fallbackCatalog: en,
    };
}

function normalizeLocale(locale: string): string {
    return locale.trim().toLowerCase().replace("_", "-") || "en";
}

function isPseudoLocEnabled(): boolean {
    return process.env.INTELLIGIT_PSEUDO_LOC === "1";
}

/**
 * Wraps every catalog value with accented, widened text so that hardcoded
 * (untranslated) strings stand out as plain ASCII and layout overflow becomes
 * visible. Placeholders like {count} are preserved verbatim.
 */
function pseudoLocalizeCatalog(catalog: WebviewCatalog): WebviewCatalog {
    const result: WebviewCatalog = {};
    for (const [key, value] of Object.entries(catalog)) {
        if (typeof value === "string") {
            result[key] = pseudoLocalize(value);
        } else {
            const variants: Record<string, string> = {};
            for (const [category, template] of Object.entries(value)) {
                variants[category] = pseudoLocalize(template);
            }
            result[key] = variants;
        }
    }
    return result;
}

const PSEUDO_MAP: Record<string, string> = {
    a: "á",
    e: "é",
    i: "í",
    o: "ó",
    u: "ú",
    c: "ç",
    n: "ñ",
    s: "š",
    y: "ý",
    A: "Á",
    E: "É",
    I: "Í",
    O: "Ó",
    U: "Ú",
    C: "Ç",
    N: "Ñ",
    S: "Š",
};

function pseudoLocalize(value: string): string {
    // Split on placeholders (kept via the capture group) so {count}, {filePath},
    // etc. pass through unaccented while surrounding text is mapped to accented
    // look-alikes. Trailing padding exposes layout overflow.
    const accented = value
        .split(/(\{[A-Za-z0-9_]+\})/g)
        .map((segment) =>
            segment.startsWith("{") && segment.endsWith("}")
                ? segment
                : segment.replace(/[A-Za-z]/g, (char) => PSEUDO_MAP[char] ?? char),
        )
        .join("");
    return `⟦${accented}  ⟧`;
}
