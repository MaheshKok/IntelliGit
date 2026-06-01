import * as vscode from "vscode";
import en from "./en.json";

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
};

export function getWebviewI18nPayload(locale = vscode.env.language): WebviewI18nPayload {
    const normalizedLocale = normalizeLocale(locale);
    return {
        locale: normalizedLocale,
        fallbackLocale: "en",
        catalog: CATALOGS[normalizedLocale] ?? en,
        fallbackCatalog: en,
    };
}

function normalizeLocale(locale: string): string {
    return locale.trim().toLowerCase().replace("_", "-") || "en";
}
