import * as vscode from "vscode";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import ja from "./ja.json";
import ko from "./ko.json";
import pl from "./pl.json";
import ptBr from "./pt-br.json";
import ptPt from "./pt-pt.json";
import ru from "./ru.json";
import zhCn from "./zh-cn.json";
import zhTw from "./zh-tw.json";

type WebviewCatalogValue = string | Record<string, string>;
type WebviewCatalog = Record<string, WebviewCatalogValue>;

export interface WebviewI18nPayload {
    locale: string;
    fallbackLocale: "en";
    catalog: WebviewCatalog;
    fallbackCatalog: WebviewCatalog;
}

const CATALOGS: Record<string, WebviewCatalog> = {
    de,
    en,
    es,
    fr,
    ja,
    ko,
    pl,
    "pt-br": ptBr,
    "pt-pt": ptPt,
    ru,
    "zh-cn": zhCn,
    "zh-tw": zhTw,
};

const LOCALE_ALIASES: Record<string, string> = {
    zh: "zh-cn",
    "zh-hans": "zh-cn",
    "zh-hant": "zh-tw",
    "zh-hk": "zh-tw",
    "zh-mo": "zh-tw",
    "zh-sg": "zh-cn",
    pt: "pt-br",
};

export function getWebviewI18nPayload(locale = vscode.env.language): WebviewI18nPayload {
    const normalizedLocale = normalizeLocale(locale);
    const resolvedLocale = resolveCatalogLocale(normalizedLocale);
    const baseCatalog = CATALOGS[resolvedLocale] ?? en;
    if (isPseudoLocEnabled()) {
        const pseudo = pseudoLocalizeCatalog(en);
        return {
            locale: resolvedLocale,
            fallbackLocale: "en",
            catalog: pseudo,
            fallbackCatalog: pseudo,
        };
    }
    return {
        locale: resolvedLocale,
        fallbackLocale: "en",
        catalog: baseCatalog,
        fallbackCatalog: en,
    };
}

function normalizeLocale(locale: string): string {
    return locale.trim().toLowerCase().replace(/_/g, "-") || "en";
}

function resolveCatalogLocale(locale: string): string {
    if (CATALOGS[locale]) return locale;
    if (LOCALE_ALIASES[locale]) return LOCALE_ALIASES[locale];
    if (locale.startsWith("zh-hant-")) return "zh-tw";
    if (locale.startsWith("zh-hans-")) return "zh-cn";

    const [baseLanguage] = locale.split("-");
    return LOCALE_ALIASES[baseLanguage] ?? (CATALOGS[baseLanguage] ? baseLanguage : "en");
}

function isPseudoLocEnabled(): boolean {
    return process.env.INTELLIGIT_PSEUDO_LOC === "1";
}

/**
 * Wraps every catalog value with accented, widened text so that hardcoded
 * (untranslated) strings stand out as plain ASCII and layout overflow becomes
 * visible. Placeholder tokens are preserved verbatim.
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
