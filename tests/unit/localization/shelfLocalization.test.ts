import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { t } from "../../../src/webviews/react/shared/i18n";

type Catalog = Record<string, string | Record<string, string>>;

const repoRoot = process.cwd();
const locales = ["de", "es", "fr", "ja", "ko", "pl", "pt-br", "pt-pt", "ru", "zh-cn", "zh-tw"];

const shelfWebviewComponents = [
    "CommitTab.tsx",
    "ShelfTab.tsx",
    "ShelfToolbar.tsx",
    "ShelfTabDialogs.tsx",
    "UnshelveDialog.tsx",
    "ShelveDialog.tsx",
    "ShelfList.tsx",
    "ShelfRow.tsx",
    "ShelfFileTree.tsx",
    "TabBar.tsx",
    "Toolbar.tsx",
    "CleanUpDialog.tsx",
    "ShelfDialogFocus.tsx",
];

const shelfWebviewKeys = [
    ...new Set(
        shelfWebviewComponents.flatMap((component) =>
            [
                ...readFileSync(
                    path.join(repoRoot, "src/webviews/react/commit-panel/components", component),
                    "utf8",
                ).matchAll(/t\(\s*["']((?:shelf|a11y)\.[^"']+)["']/g),
            ].map((match) => match[1]),
        ),
    ),
].sort();

const shelfHostKeys = [
    ...new Set([
        ...[
            ...readFileSync(
                path.join(repoRoot, "src/activation/shelfCommands.ts"),
                "utf8",
            ).matchAll(/localize\(\s*["']([^"']+)["']/g),
        ].map((match) => match[1]),
        "Shelf recovery failed: {message}",
        "{failure}: {message}",
        "Unshelve failed: {message}",
        "Clean up shelf failed: {message}",
        "Choose a name for the shelf",
        "Save to Shelf",
        "Unable to create shelf: {message}",
    ]),
].sort();

const shelfManifestKeys = [
    "command.shelf.shelveChanges",
    "command.shelf.shelveSilently",
    "command.shelf.saveToShelf",
    "command.shelf.unshelve",
    "command.shelf.importPatch",
    "command.shelf.cleanUp",
    "command.shelf.purgeRecovery",
    "configuration.shelf.recordBaseRevisions.description",
    "configuration.shelf.path.description",
    "configuration.shelf.removeOnUnshelve.description",
    "configuration.shelf.recoveryRetentionHours.description",
    "configuration.shelf.cleanupAfterDays.description",
];

function readJson<T>(relativePath: string): T {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

describe("shelf localization", () => {
    it("keeps required shelf webview keys complete in every locale", () => {
        expect(shelfWebviewKeys).not.toHaveLength(0);
        const english = readJson<Catalog>("src/webviews/i18n/en.json");
        for (const key of shelfWebviewKeys) expect(english, `en:${key}`).toHaveProperty(key);

        for (const locale of locales) {
            const catalog = readJson<Catalog>(`src/webviews/i18n/${locale}.json`);
            for (const key of shelfWebviewKeys)
                expect(catalog, `${locale}:${key}`).toHaveProperty(key);
        }
    });

    it("renders a translated non-English shelf value", () => {
        const catalog = readJson<Catalog>("src/webviews/i18n/es.json");
        const previous = (globalThis as typeof globalThis & { intelligitI18n?: unknown })
            .intelligitI18n;
        (globalThis as typeof globalThis & { intelligitI18n?: unknown }).intelligitI18n = {
            locale: "es",
            fallbackLocale: "en",
            catalog,
            fallbackCatalog: readJson<Catalog>("src/webviews/i18n/en.json"),
        };
        try {
            expect(t("shelf.action.unshelve")).not.toBe("Unshelve");
        } finally {
            (globalThis as typeof globalThis & { intelligitI18n?: unknown }).intelligitI18n =
                previous;
        }
    });

    it("does not retain English shelf values in non-Latin locales", () => {
        const nonLatinLocales = ["ja", "ko", "ru", "zh-cn", "zh-tw"];
        const webviewKeys = [
            "shelf.list.empty",
            "shelf.action.unshelveSilently",
            "shelf.dialog.shelve.title",
        ];
        const manifestKeys = ["command.shelf.shelveChanges"];
        const hostKeys = ["Shelf unshelved."];
        const englishWebview = readJson<Catalog>("src/webviews/i18n/en.json");
        const englishManifest = readJson<Catalog>("package.nls.json");
        const englishHost = readJson<Catalog>("l10n/bundle.l10n.json");

        for (const locale of nonLatinLocales) {
            const webviewCatalog = readJson<Catalog>(`src/webviews/i18n/${locale}.json`);
            const manifestCatalog = readJson<Catalog>(`package.nls.${locale}.json`);
            const hostCatalog = readJson<Catalog>(`l10n/bundle.l10n.${locale}.json`);
            for (const key of webviewKeys)
                expect(webviewCatalog[key], `${locale}:webview:${key}`).not.toBe(
                    englishWebview[key],
                );
            for (const key of manifestKeys)
                expect(manifestCatalog[key], `${locale}:manifest:${key}`).not.toBe(
                    englishManifest[key],
                );
            for (const key of hostKeys)
                expect(hostCatalog[key], `${locale}:host:${key}`).not.toBe(englishHost[key]);
        }
    });

    it("keeps shelf host and manifest localization keys complete", () => {
        const hostSource = readJson<Catalog>("l10n/bundle.l10n.json");
        for (const key of shelfHostKeys) expect(hostSource, `en:${key}`).toHaveProperty(key);

        const manifestSource = readJson<Catalog>("package.nls.json");
        for (const key of shelfManifestKeys)
            expect(manifestSource, `en:${key}`).toHaveProperty(key);

        for (const locale of locales) {
            const hostCatalog = readJson<Catalog>(`l10n/bundle.l10n.${locale}.json`);
            const manifestCatalog = readJson<Catalog>(`package.nls.${locale}.json`);
            for (const key of shelfHostKeys)
                expect(hostCatalog, `${locale}:${key}`).toHaveProperty(key);
            for (const key of shelfManifestKeys)
                expect(manifestCatalog, `${locale}:${key}`).toHaveProperty(key);
        }

        const manifest = readFileSync(path.join(repoRoot, "package.json"), "utf8");
        for (const key of shelfManifestKeys) expect(manifest).toContain(`%${key}%`);
        expect(
            readdirSync(repoRoot).filter((file) => /^package\.nls\.[a-z-]+\.json$/.test(file)),
        ).toHaveLength(11);
    });
});
