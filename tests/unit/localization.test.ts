import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
    language: "ja",
    translations: new Map<string, string>(),
}));

vi.mock("vscode", () => {
    function joinPath(base: { fsPath?: string; path?: string }, ...segments: string[]) {
        const basePath = base.path ?? base.fsPath ?? "";
        const joined = [basePath, ...segments].join("/").replace(/\/+/g, "/");
        return {
            fsPath: joined,
            path: joined,
            toString: () => joined,
        };
    }

    return {
        env: {
            get language() {
                return vscodeState.language;
            },
        },
        l10n: {
            t: (message: string) => vscodeState.translations.get(message) ?? message,
        },
        Uri: { joinPath },
        workspace: {
            getConfiguration: () => ({
                get: (key: string) => {
                    if (key === "editor.hover.delay") return 300;
                    if (key === "intelligit.tooltips.enabled") return true;
                    if (key === "intelligit.icons") return "standard";
                    if (key === "intelligit.commitWindowPosition") return "left";
                    return undefined;
                },
            }),
        },
    };
});

import { OnboardingViewProvider } from "../../src/views/OnboardingViewProvider";
import {
    buildWebviewShellHtml,
    escapeHtmlAttr,
    escapeHtmlText,
    scriptSafeJson,
} from "../../src/views/webviewHtml";
import { getWebviewI18nPayload } from "../../src/webviews/i18n";

type CatalogValue = string | Record<string, string>;
type Catalog = Record<string, CatalogValue>;

const repoRoot = process.cwd();
const originalPseudoLoc = process.env.INTELLIGIT_PSEUDO_LOC;
const manifestLocales = [
    "de",
    "es",
    "fr",
    "ja",
    "ko",
    "pl",
    "pt-br",
    "pt-pt",
    "ru",
    "zh-cn",
    "zh-tw",
];
const runtimeLocales = manifestLocales;

beforeEach(() => {
    vscodeState.language = "ja";
    vscodeState.translations.clear();
    delete process.env.INTELLIGIT_PSEUDO_LOC;
});

afterEach(() => {
    if (originalPseudoLoc === undefined) {
        delete process.env.INTELLIGIT_PSEUDO_LOC;
    } else {
        process.env.INTELLIGIT_PSEUDO_LOC = originalPseudoLoc;
    }
});

describe("localization catalogs", () => {
    it("keeps the consolidated translation CSV valid and synced", () => {
        execFileSync("bun", ["scripts/localization-csv.js", "validate", "--quiet"], {
            cwd: repoRoot,
            stdio: "pipe",
        });
    });

    it("exposes localization sync and missing-translation commands", () => {
        const packageJson = readJson<{ scripts?: Record<string, string> }>("package.json");
        expect(packageJson.scripts?.["l10n:sync"]).toBe("bun scripts/localization-csv.js sync");
        expect(packageJson.scripts?.["l10n:translate"]).toBe(
            "bun scripts/localization-csv.js translate",
        );

        execFileSync(
            "bun",
            ["scripts/localization-csv.js", "translate", "--only-missing", "--quiet"],
            {
                cwd: repoRoot,
                stdio: "pipe",
            },
        );
    });

    it("keeps package.nls locale files complete and wired from package.json", () => {
        const source = readJson<Catalog>("package.nls.json");
        const localeFiles = readdirSync(repoRoot)
            .filter((file) => /^package\.nls\.[a-z-]+\.json$/.test(file))
            .sort();

        expect(localeFiles).toEqual(manifestLocales.map((locale) => `package.nls.${locale}.json`));
        for (const file of localeFiles) {
            assertCompatibleCatalog(source, readJson<Catalog>(file), localeFromManifestFile(file));
        }

        const manifest = readJson<unknown>("package.json");
        const referencedKeys = collectPercentPlaceholders(manifest);
        expect([...referencedKeys].sort()).toEqual(Object.keys(source).sort());
    });

    it("keeps host l10n bundle files complete", () => {
        const source = readJson<Catalog>("l10n/bundle.l10n.json");
        expect(Object.keys(source).length).toBeGreaterThan(0);

        for (const [key, value] of Object.entries(source)) {
            expect(value).toBe(key);
        }

        const hostBundleFiles = catalogFiles("l10n", /^bundle\.l10n(?:\.[a-z-]+)?\.json$/);
        for (const locale of runtimeLocales) {
            expect(hostBundleFiles).toContain(`bundle.l10n.${locale}.json`);
        }

        for (const file of hostBundleFiles) {
            const locale =
                file === "bundle.l10n.json"
                    ? "en"
                    : file.match(/^bundle\.l10n\.([a-z-]+)\.json$/)?.[1];
            expect(locale).toBeDefined();
            assertCompatibleCatalog(
                source,
                readJson<Catalog>(path.join("l10n", file)),
                locale ?? "en",
            );
        }
    });

    it("keeps webview catalog files complete", () => {
        const source = readJson<Catalog>("src/webviews/i18n/en.json");
        expect(Object.keys(source).length).toBeGreaterThan(0);

        const webviewCatalogFiles = catalogFiles("src/webviews/i18n", /^[a-z-]+\.json$/);
        for (const locale of runtimeLocales) {
            expect(webviewCatalogFiles).toContain(`${locale}.json`);
        }

        for (const file of webviewCatalogFiles) {
            const locale = file.replace(/\.json$/, "");
            assertCompatibleCatalog(
                source,
                readJson<Catalog>(path.join("src/webviews/i18n", file)),
                locale,
            );
        }
    });

    it("keeps generated artifacts and replacement characters out of translated catalogs", () => {
        const localeCatalogPaths = [
            ...manifestLocales.map((locale) => `package.nls.${locale}.json`),
            ...runtimeLocales.map((locale) => `l10n/bundle.l10n.${locale}.json`),
            ...runtimeLocales.map((locale) => `src/webviews/i18n/${locale}.json`),
        ];

        for (const catalogPath of localeCatalogPaths) {
            const catalog = readJson<Catalog>(catalogPath);
            const leaked = collectStringValues(catalog).filter((value) =>
                /\bZXQ\d+ZX\b/i.test(value),
            );
            expect(leaked, catalogPath).toEqual([]);

            const corrupted = collectStringValues(catalog).filter((value) =>
                value.includes("\uFFFD"),
            );
            expect(corrupted, catalogPath).toEqual([]);
        }
    });

    it("preserves literal Git tokens that users must copy exactly", () => {
        const source = readJson<Catalog>("l10n/bundle.l10n.json");
        const literalTokens = [
            { token: "reword", contains: containsAsciiWord },
            { token: "origin", contains: containsAsciiWord },
            { token: ".git/config", contains: (value: string, token: string) => value.includes(token) },
        ];
        const hostBundleFiles = runtimeLocales.map((locale) => `l10n/bundle.l10n.${locale}.json`);

        for (const file of hostBundleFiles) {
            const catalog = readJson<Catalog>(file);
            for (const [key, sourceValue] of Object.entries(source)) {
                if (typeof sourceValue !== "string") continue;
                const translatedValue = catalog[key];
                expect(typeof translatedValue, `${file}:${key}`).toBe("string");
                for (const { token, contains } of literalTokens) {
                    if (contains(sourceValue, token)) {
                        expect(contains(translatedValue as string, token), `${file}:${key}`).toBe(true);
                    }
                }
            }
        }
    });
});

describe("webview i18n payload", () => {
    it("resolves every runtime locale through the host-side loader", () => {
        for (const locale of runtimeLocales) {
            const expected = readJson<Catalog>(`src/webviews/i18n/${locale}.json`);
            const payload = getWebviewI18nPayload(locale);

            expect(payload.locale).toBe(locale);
            expect(payload.fallbackLocale).toBe("en");
            expect(payload.catalog).toEqual(expected);
        }
    });

    it("resolves common base and regional locale variants to supported catalogs", () => {
        const aliases: Record<string, string> = {
            "de-AT": "de",
            "es-MX": "es",
            "fr-CA": "fr",
            "ja-JP": "ja",
            "ko-KR": "ko",
            "pl-PL": "pl",
            pt: "pt-br",
            pt_BR: "pt-br",
            "pt-PT": "pt-pt",
            "ru-RU": "ru",
            zh: "zh-cn",
            "zh-Hans": "zh-cn",
            "zh-Hans-CN": "zh-cn",
            "zh-Hant": "zh-tw",
            "zh-Hant-TW": "zh-tw",
            "zh-HK": "zh-tw",
        };

        for (const [input, expectedLocale] of Object.entries(aliases)) {
            const expected = readJson<Catalog>(`src/webviews/i18n/${expectedLocale}.json`);
            const payload = getWebviewI18nPayload(input);

            expect(payload.locale, input).toBe(expectedLocale);
            expect(payload.catalog, input).toEqual(expected);
        }
    });

    it("pseudo-localizes webview strings while preserving placeholders and plural shapes", () => {
        process.env.INTELLIGIT_PSEUDO_LOC = "1";

        const payload = getWebviewI18nPayload("ja-JP");
        expect(payload.locale).toBe("ja");
        expect(payload.catalog).toEqual(payload.fallbackCatalog);
        expect(payload.catalog["commitInfo.byAuthor"]).toBe("⟦bý {author}  ⟧");

        const fileCount = payload.catalog["common.fileCount"];
        expect(isStringMap(fileCount)).toBe(true);
        expect(fileCount).toMatchObject({
            one: "⟦{count} fílé  ⟧",
            other: "⟦{count} fíléš  ⟧",
        });
    });
});

describe("localization packaging", () => {
    it("packages manifest and host localization assets without relying on src catalogs at runtime", () => {
        const packageJson = readJson<{ l10n?: string }>("package.json");
        expect(packageJson.l10n).toBe("./l10n");

        const packagedFiles = listVsceFiles();
        if (!packagedFiles) {
            console.warn("Skipping VSCE packaging check because node_modules/.bin/vsce is missing.");
            return;
        }

        const files = new Set(packagedFiles);
        expect(files).toContain("l10n/bundle.l10n.json");
        for (const locale of runtimeLocales) {
            expect(files).toContain(`l10n/bundle.l10n.${locale}.json`);
        }
        expect(files).toContain("package.nls.json");
        for (const locale of manifestLocales) {
            expect(files).toContain(`package.nls.${locale}.json`);
        }
        expect([...files].some((file) => file.startsWith("src/"))).toBe(false);

        const webviewLoader = readText("src/webviews/i18n/index.ts");
        expect(webviewLoader).toContain('import en from "./en.json"');
        for (const locale of runtimeLocales) {
            expect(webviewLoader).toContain(`from "./${locale}.json"`);
        }
        expect(webviewLoader).not.toMatch(/\b(readFile|workspace\.fs|joinPath)\b/);
    });
});

describe("localized HTML output", () => {
    it("escapes translated values in script payloads, text nodes, and attributes", () => {
        const unsafe = `</script><span title="x">'&`;

        expect(scriptSafeJson({ value: unsafe })).not.toContain("</script>");
        expect(scriptSafeJson({ value: unsafe })).not.toContain("<");
        expect(scriptSafeJson({ value: unsafe })).toContain("\\u003c/script>");

        expect(escapeHtmlText(unsafe)).toBe(`&lt;/script&gt;&lt;span title="x"&gt;'&amp;`);
        expect(escapeHtmlAttr(unsafe)).toBe(
            "&lt;/script&gt;&lt;span title=&quot;x&quot;&gt;&#39;&amp;",
        );

        const webviewHtml = buildWebviewShellHtml({
            extensionUri: fakeUri("/extension"),
            webview: fakeWebview(),
            scriptFile: "webview.js",
            title: unsafe,
        });
        expect(webviewHtml).toContain(`<title>${escapeHtmlText(unsafe)}</title>`);

        vscodeState.translations.set("IntelliGit", unsafe);
        const onboardingHtml = getOnboardingHtml("no-workspace", "IntelliGit");
        expect(onboardingHtml).toContain(`alt="${escapeHtmlAttr(unsafe)}"`);
    });

    it("uses VS Code language for webview and onboarding html lang attributes", () => {
        vscodeState.language = "ru";

        const webviewHtml = buildWebviewShellHtml({
            extensionUri: fakeUri("/extension"),
            webview: fakeWebview(),
            scriptFile: "webview.js",
            title: "Graph",
        });
        expect(webviewHtml).toContain('<html lang="ru">');
        expect(webviewHtml).not.toContain('<html lang="en">');

        const onboardingHtml = getOnboardingHtml("no-git-repo", "Commit");
        expect(onboardingHtml).toContain('<html lang="ru">');
        expect(onboardingHtml).not.toContain('<html lang="en">');
    });
});

function assertCompatibleCatalog(source: Catalog, candidate: Catalog, locale: string): void {
    expect(Object.keys(candidate).sort()).toEqual(Object.keys(source).sort());

    for (const [key, sourceValue] of Object.entries(source)) {
        const candidateValue = candidate[key];
        if (typeof sourceValue === "string") {
            expect(typeof candidateValue, `${locale}:${key}`).toBe("string");
            expect(placeholders(candidateValue as string).sort(), `${locale}:${key}`).toEqual(
                placeholders(sourceValue).sort(),
            );
            continue;
        }

        expect(isStringMap(candidateValue), `${locale}:${key}`).toBe(true);
        assertPluralCategories(candidateValue as Record<string, string>, locale, key);
        for (const [category, value] of Object.entries(candidateValue as Record<string, string>)) {
            const sourceTemplate = sourceValue[category] ?? sourceValue.other;
            expect(placeholders(value).sort(), `${locale}:${key}.${category}`).toEqual(
                placeholders(sourceTemplate).sort(),
            );
        }
    }
}

function assertPluralCategories(value: Record<string, string>, locale: string, key: string): void {
    const expected = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.sort();
    expect(Object.keys(value).sort(), `${locale}:${key}`).toEqual(expected);
}

function placeholders(value: string): string[] {
    return Array.from(value.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]);
}

function containsAsciiWord(value: string, token: string): boolean {
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}($|[^A-Za-z0-9_])`).test(
        value,
    );
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectStringValues(value: CatalogValue | Catalog): string[] {
    if (typeof value === "string") return [value];
    return Object.values(value).flatMap((item) =>
        typeof item === "string" ? [item] : collectStringValues(item),
    );
}

function collectPercentPlaceholders(value: unknown, found = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        for (const match of value.matchAll(/%([^%]+)%/g)) {
            found.add(match[1]);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) collectPercentPlaceholders(item, found);
    } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectPercentPlaceholders(item, found);
    }
    return found;
}

function listVsceFiles(): string[] | undefined {
    const executable = path.join(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "vsce.cmd" : "vsce",
    );
    if (!existsSync(executable)) return undefined;

    return execFileSync(executable, ["ls", "--no-dependencies"], {
        cwd: repoRoot,
        encoding: "utf8",
    })
        .split(/\r?\n/)
        .filter(Boolean);
}

function catalogFiles(directory: string, pattern: RegExp): string[] {
    const absolute = path.join(repoRoot, directory);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute)
        .filter((file) => pattern.test(file))
        .sort();
}

function localeFromManifestFile(file: string): string {
    const match = file.match(/^package\.nls\.([a-z-]+)\.json$/);
    if (!match) throw new Error(`Unexpected manifest catalog filename: ${file}`);
    return match[1];
}

function readJson<T>(relativePath: string): T {
    return JSON.parse(readText(relativePath)) as T;
}

function readText(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function isStringMap(value: unknown): value is Record<string, string> {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === "string")
    );
}

function fakeUri(uriPath: string) {
    return {
        fsPath: uriPath,
        path: uriPath,
        toString: () => uriPath,
    };
}

function fakeWebview() {
    return {
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { path?: string; fsPath?: string }) => ({
            toString: () => `webview:${uri.path ?? uri.fsPath ?? ""}`,
        }),
    };
}

function getOnboardingHtml(contextType: "no-workspace" | "no-git-repo", title: string): string {
    const provider = new OnboardingViewProvider(fakeUri("/extension") as never, contextType, title);
    return (
        provider as unknown as {
            getHtml(webview: ReturnType<typeof fakeWebview>): string;
        }
    ).getHtml(fakeWebview());
}
