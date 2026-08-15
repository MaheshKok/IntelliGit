import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WEBVIEW_CATALOG_LOCALES } from "../../../src/webviews/i18n/catalogs";

const CATALOG_DIRECTORY = path.resolve(process.cwd(), "src/webviews/i18n");

function catalogFilesOnDisk(): readonly string[] {
    return readdirSync(CATALOG_DIRECTORY)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .sort();
}

describe("webview catalog registration", () => {
    it("has no registered locale without a catalog file", () => {
        const registered = new Set(WEBVIEW_CATALOG_LOCALES);
        const onDisk = new Set(catalogFilesOnDisk());

        expect([...registered].filter((locale) => !onDisk.has(locale))).toEqual([]);
    });

    it("has no catalog file that is absent from the resolver", () => {
        const registered = new Set(WEBVIEW_CATALOG_LOCALES);
        const onDisk = new Set(catalogFilesOnDisk());

        expect([...onDisk].filter((locale) => !registered.has(locale))).toEqual([]);
    });
});
