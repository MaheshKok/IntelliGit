import { SYSTEM_FONT_STACK } from "../../../src/utils/constants";
import type { WebviewI18nPayload } from "../../../src/webviews/i18n";
import type { HostFixture } from "../../e2e/hostFixtures/types";
import type { ResolvedHostContext } from "./hostContexts";

/** The settings read by production before it bootstraps a webview bundle. */
export interface HarnessWebviewSettings {
    readonly hoverDelay: number;
    readonly tooltipsEnabled: boolean;
    readonly iconStyle: "color" | "standard";
    readonly commitWindowPosition: "left" | "right";
}

/** The no-VS-Code settings baseline used by callers that do not need overrides. */
export const DEFAULT_HARNESS_WEBVIEW_SETTINGS: HarnessWebviewSettings = {
    hoverDelay: 300,
    tooltipsEnabled: true,
    iconStyle: "standard",
    commitWindowPosition: "left",
};

/** All data required to render one browser-loadable webview shell. */
export interface HarnessDocumentInput {
    readonly context: ResolvedHostContext;
    readonly hostFixture: HostFixture;
    readonly i18n: WebviewI18nPayload;
    readonly settings: HarnessWebviewSettings;
    readonly assetBaseUrl: string;
}

/**
 * Escapes a value for either an HTML text node or a quoted attribute.
 *
 * Production splits this into `escapeHtmlText`/`escapeHtmlAttr` because it needs the text variant to
 * leave quotes untouched. The harness deliberately keeps ONE function: two names for byte-identical
 * behavior is a distinction no test can falsify, so swapping the call sites would be a silent no-op.
 * Escaping quotes in a text node is safe -- the browser decodes the entity back before layout -- and
 * the Phase 6 drift guard normalizes entities before comparing.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Serializes JSON without leaving a literal `<` that could begin an HTML script end tag. */
function scriptSafeJson(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error("Harness bootstrap payload must be JSON-serializable.");
    }
    return serialized.replace(/</g, "\\u003c");
}

/** Converts a DOMStringMap key to the corresponding kebab-case data attribute suffix. */
function datasetKeyToAttribute(key: string): string {
    return `data-${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

/** Renders a static class attribute, retaining the fixture's class-list order. */
function renderClassAttribute(classList: readonly string[]): string {
    return `class="${escapeHtml(classList.join(" "))}"`;
}

/** Renders static data attributes from the fixture's camelCase dataset keys. */
function renderDatasetAttributes(dataset: Readonly<Record<string, string>>): string {
    return Object.entries(dataset)
        .map(([key, value]) => ` ${datasetKeyToAttribute(key)}="${escapeHtml(value)}"`)
        .join("");
}

/** Joins a relative bundle asset to the caller-provided browser URL base. */
function assetUrl(assetBaseUrl: string, assetFile: string): string {
    const base = assetBaseUrl.replace(/\/+$/, "");
    const file = assetFile.replace(/^\/+/, "");
    return `${base}/${file}`;
}

/** Resolves a title descriptor without consulting a catalog unavailable to the plain Node harness. */
function titleFor(context: ResolvedHostContext): string {
    return context.titleDescriptor.kind === "literal"
        ? context.titleDescriptor.value
        : context.titleDescriptor.key;
}

/**
 * Renders an independent browser-loadable HTML shell for a resolved IntelliGit host context.
 *
 * Host theme state is static markup so screenshots remain meaningful with JavaScript disabled;
 * runtime bootstrap is limited to the production settings/i18n globals and the final bundle tag.
 */
export function renderHarnessDocument(input: HarnessDocumentInput): string {
    const { context, hostFixture, i18n, settings } = input;
    const { documentElement, body } = hostFixture;
    const styleLinks = context.styleFiles
        .map(
            (styleFile) =>
                `    <link rel="stylesheet" href="${escapeHtml(assetUrl(input.assetBaseUrl, styleFile))}">`,
        )
        .join("\n");
    const settingsJson = scriptSafeJson(settings);
    const i18nJson = scriptSafeJson(i18n);

    // A plain browser server has neither VS Code's cspSource nor its nonce policy, so this harness
    // deliberately emits no CSP meta element and no nonce. Phase 3-iii controls the page boundary.
    return `<!DOCTYPE html>
<html lang="${escapeHtml(i18n.locale)}" style="${escapeHtml(documentElement.styleCssText)}" ${renderClassAttribute(documentElement.classList)}${renderDatasetAttributes(documentElement.dataset)}>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(titleFor(context))}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
            width: 100%; height: 100%; overflow: hidden;
            font-family: ${SYSTEM_FONT_STACK};
            font-size: 13px;
            color: var(--vscode-foreground);
            background: ${context.resolvedBackgroundVar};
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
                scroll-behavior: auto !important;
            }
        }
    </style>
${styleLinks ? `${styleLinks}\n` : ""}</head>
<body ${renderClassAttribute(body.classList)}${renderDatasetAttributes(body.dataset)}>
    <div id="root"></div>
    <script>
        window.intelligitSettings = ${settingsJson};
        window.intelligitI18n = ${i18nJson};
    </script>
    <script src="${escapeHtml(assetUrl(input.assetBaseUrl, context.scriptFile))}"></script>
</body>
</html>`;
}
