import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import type { HostFixture } from "../../../e2e/hostFixtures/types";
import hcBlack from "../../../visual/fixtures/host/hc-black.json";
import darkModern from "../../../visual/fixtures/host/dark-modern.json";
import {
    DEFAULT_HARNESS_WEBVIEW_SETTINGS,
    renderHarnessDocument,
    type HarnessDocumentInput,
    type HarnessWebviewSettings,
} from "../../../visual/harness/renderHarnessDocument";
import {
    hostContextFor,
    WEBVIEW_HOST_CONTEXTS,
    type ResolvedHostContext,
} from "../../../visual/harness/hostContexts";
import type { WebviewI18nPayload } from "../../../../src/webviews/i18n";
import { buildWebviewI18nPayload } from "../../../../src/webviews/i18n/catalogs";

const DARK_MODERN = darkModern as HostFixture;
const HC_BLACK = hcBlack as HostFixture;
const DEFAULT_SETTINGS: HarnessWebviewSettings = DEFAULT_HARNESS_WEBVIEW_SETTINGS;
const I18N: WebviewI18nPayload = {
    locale: "en-GB",
    fallbackLocale: "en",
    catalog: { Graph: "Graph" },
    fallbackCatalog: { Graph: "Graph" },
};

const FIXTURES = [
    ["dark-modern", DARK_MODERN],
    ["hc-black", HC_BLACK],
] as const;

const MATRIX_CASES = WEBVIEW_HOST_CONTEXTS.flatMap((context) =>
    FIXTURES.map(([fixtureId, fixture]) => ({ context, fixtureId, fixture })),
);

function inputFor(
    context: ResolvedHostContext,
    hostFixture: HostFixture,
    i18n: WebviewI18nPayload = I18N,
): HarnessDocumentInput {
    return {
        context,
        hostFixture,
        i18n,
        settings: DEFAULT_SETTINGS,
        assetBaseUrl: "/dist",
    };
}

function parseDocument(html: string): Document {
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    expect(dom.window.document.doctype?.name).toBe("html");
    return dom.window.document;
}

function dataAttributes(element: Element): Record<string, string> {
    return Object.fromEntries(
        [...element.attributes]
            .filter((attribute) => attribute.name.startsWith("data-"))
            .map((attribute) => [attribute.name, attribute.value]),
    );
}

function expectedDataAttributes(dataset: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(dataset).map(([key, value]) => [
            `data-${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
            value,
        ]),
    );
}

function scriptJsonAssignment(document: Document, name: string): unknown {
    const bootstrap = document.querySelectorAll("script")[0]?.textContent ?? "";
    const match = bootstrap.match(new RegExp(`window\\.${name} = (.+);`));
    if (!match) throw new Error(`Missing ${name} assignment.`);
    return JSON.parse(match[1]);
}

describe("renderHarnessDocument", () => {
    it.each([
        ["en-GB", "en"],
        ["pt", "pt-br"],
    ] as const)(
        "uses the production-resolved locale in html lang for %s",
        (requested, resolved) => {
            const document = parseDocument(
                renderHarnessDocument(
                    inputFor(
                        WEBVIEW_HOST_CONTEXTS[0],
                        DARK_MODERN,
                        buildWebviewI18nPayload(requested),
                    ),
                ),
            );

            expect(document.documentElement.lang).toBe(resolved);
        },
    );

    it.each(MATRIX_CASES)(
        "$context.contextId × $fixtureId parses the complete static shell",
        ({ context, fixture }) => {
            const html = renderHarnessDocument(inputFor(context, fixture));
            const document = parseDocument(html);
            const htmlElement = document.documentElement;
            const body = document.body;
            const stylesheetLinks = [...document.querySelectorAll('link[rel="stylesheet"]')];
            const scripts = [...document.querySelectorAll("script")];
            const lastScript = scripts[scripts.length - 1];

            expect(document.querySelectorAll("#root")).toHaveLength(1);
            expect(lastScript?.getAttribute("src")).toBe(`/dist/${context.scriptFile}`);
            expect(stylesheetLinks).toHaveLength(context.styleFiles.length);
            expect(stylesheetLinks.map((link) => link.getAttribute("href"))).toEqual(
                context.styleFiles.map((styleFile) => `/dist/${styleFile}`),
            );
            expect(document.documentElement.lang).toBe(I18N.locale);
            expect(document.querySelector("title")?.textContent).toBe(
                context.titleDescriptor.kind === "literal"
                    ? context.titleDescriptor.value
                    : context.titleDescriptor.key,
            );
            expect(document.querySelector("style")?.textContent).toContain(
                `background: ${context.resolvedBackgroundVar};`,
            );
            expect(document.querySelector("style")?.textContent).toContain("font-size: 13px");
            expect(document.querySelector("style")?.textContent).toContain(
                "@media (prefers-reduced-motion: reduce)",
            );
            expect(htmlElement.getAttribute("style")).toBe(fixture.documentElement.styleCssText);
            expect(htmlElement.className).toBe(fixture.documentElement.classList.join(" "));
            expect(dataAttributes(htmlElement)).toEqual(
                expectedDataAttributes(fixture.documentElement.dataset),
            );
            expect(body.className).toBe(fixture.body.classList.join(" "));
            expect(dataAttributes(body)).toEqual(expectedDataAttributes(fixture.body.dataset));
        },
    );

    it("keeps adversarial fixture and payload values inside their contexts", () => {
        const adversarialFixture: HostFixture = {
            ...DARK_MODERN,
            documentElement: {
                ...DARK_MODERN.documentElement,
                styleCssText: `${DARK_MODERN.documentElement.styleCssText}; --adversarial: \"</style>\" &;`,
                dataset: {
                    ...DARK_MODERN.documentElement.dataset,
                    adversarialValue: "> and ' & \"",
                },
            },
        };
        const adversarialContext: ResolvedHostContext = {
            ...WEBVIEW_HOST_CONTEXTS[0],
            titleDescriptor: { kind: "literal", value: '<script>& "title" \'</script>' },
        };
        const adversarialI18n: WebviewI18nPayload = {
            ...I18N,
            catalog: { payload: '</script><script>breakout() & "quote"</script>' },
        };

        const html = renderHarnessDocument(
            inputFor(adversarialContext, adversarialFixture, adversarialI18n),
        );
        const document = parseDocument(html);
        const scripts = [...document.querySelectorAll("script")];

        expect(document.querySelectorAll("style")).toHaveLength(1);
        expect(document.documentElement.getAttribute("style")).toBe(
            adversarialFixture.documentElement.styleCssText,
        );
        expect(dataAttributes(document.documentElement)).toMatchObject({
            "data-adversarial-value": "> and ' & \"",
        });
        expect(document.querySelector("title")?.textContent).toBe('<script>& "title" \'</script>');
        expect(scripts).toHaveLength(2);
        expect(html.match(/<\/script>/g)).toHaveLength(2);
        expect(scriptJsonAssignment(document, "intelligitI18n")).toEqual(adversarialI18n);
    });

    it("exposes settings and i18n in the bootstrap but not the E2E channel", () => {
        const document = parseDocument(
            renderHarnessDocument(inputFor(WEBVIEW_HOST_CONTEXTS[0], DARK_MODERN)),
        );

        expect(scriptJsonAssignment(document, "intelligitSettings")).toEqual(DEFAULT_SETTINGS);
        expect(scriptJsonAssignment(document, "intelligitI18n")).toEqual(I18N);
        expect(document.documentElement.outerHTML).not.toContain("intelligitE2E");
        expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull();
        expect(
            [...document.querySelectorAll("script")].every(
                (script) => !script.hasAttribute("nonce"),
            ),
        ).toBe(true);
    });

    it.each(["allChecked", "noneChecked", "preserveSelection"] as const)(
        "serializes the commit-check mode %s in the fixture bootstrap",
        (commitCheckState) => {
            const document = parseDocument(
                renderHarnessDocument({
                    ...inputFor(WEBVIEW_HOST_CONTEXTS[0], DARK_MODERN),
                    settings: { ...DEFAULT_SETTINGS, commitCheckState },
                }),
            );

            expect(scriptJsonAssignment(document, "intelligitSettings")).toMatchObject({
                commitCheckState,
            });
        },
    );

    it("renders byte-identical output for identical input", () => {
        const input = inputFor(WEBVIEW_HOST_CONTEXTS[5], HC_BLACK);

        expect(renderHarnessDocument(input)).toBe(renderHarnessDocument(input));
    });

    it("normalizes a trailing slash on the asset base rather than emitting a doubled separator", () => {
        const context = hostContextFor("merge-editor");
        const document = parseDocument(
            renderHarnessDocument({ ...inputFor(context, DARK_MODERN), assetBaseUrl: "/dist/" }),
        );
        const scripts = [...document.querySelectorAll("script")];

        expect(scripts[scripts.length - 1]?.getAttribute("src")).toBe(
            `/dist/${context.scriptFile}`,
        );
        expect(document.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe(
            `/dist/${context.styleFiles[0]}`,
        );
    });

    // `scriptSafeJson` is the renderer's only throw. Exercising it needs a payload `JSON.stringify`
    // returns `undefined` for -- the happy path can never reach the branch, so without a state built
    // to violate it the guard would be unreachable code that reads as a safety check.
    it("can fail: a bootstrap payload that cannot be serialized throws", () => {
        const input = inputFor(WEBVIEW_HOST_CONTEXTS[0], DARK_MODERN);

        expect(() =>
            renderHarnessDocument({ ...input, i18n: undefined as unknown as WebviewI18nPayload }),
        ).toThrow(/must be JSON-serializable/);
    });
});
