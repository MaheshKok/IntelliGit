import * as vscode from "vscode";
import { SYSTEM_FONT_STACK } from "../utils/constants";
import { getWebviewI18nPayload } from "../webviews/i18n";

/**
 * Inputs required to generate a bundled IntelliGit webview shell.
 *
 * Callers pass extension-relative script and style filenames; the HTML helper is responsible for
 * converting them through `asWebviewUri` and applying the shared CSP/resource policy.
 */
interface WebviewShellOptions {
    extensionUri: vscode.Uri;
    webview: vscode.Webview;
    scriptFile: string;
    styleFiles?: string[];
    title: string;
    backgroundVar?: string;
}

type WebviewSettings = {
    hoverDelay: number;
    tooltipsEnabled: boolean;
    iconStyle: "color" | "standard";
    commitWindowPosition: "left" | "right";
};

/**
 * Builds the shared HTML shell for bundled IntelliGit webview applications.
 *
 * Script and stylesheet files are resolved under `dist` with `asWebviewUri`, settings/i18n payloads
 * are serialized with script-safe JSON, and a nonce-scoped CSP prevents remote or inline script
 * execution outside the generated bootstrap block.
 */
export function buildWebviewShellHtml({
    extensionUri,
    webview,
    scriptFile,
    styleFiles = [],
    title,
    backgroundVar = "var(--vscode-editor-background)",
}: WebviewShellOptions): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", scriptFile));
    const styleUris = styleFiles.map((styleFile) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", styleFile)),
    );
    const nonce = createNonce();
    const styleLinks = styleUris
        .map((styleUri) => `    <link rel="stylesheet" href="${escapeHtmlAttr(String(styleUri))}">`)
        .join("\n");
    const i18nPayload = getWebviewI18nPayload();
    const { hoverDelay, tooltipsEnabled, iconStyle, commitWindowPosition } = readWebviewSettings();

    const settingsPayload = scriptSafeJson({
        hoverDelay,
        tooltipsEnabled,
        iconStyle,
        commitWindowPosition,
    });
    const i18nPayloadJson = scriptSafeJson(i18nPayload);

    return `<!DOCTYPE html>
<html lang="${escapeHtmlAttr(i18nPayload.locale)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <title>${escapeHtmlText(title)}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
            width: 100%; height: 100%; overflow: hidden;
            font-family: ${SYSTEM_FONT_STACK};
            font-size: 13px;
            color: var(--vscode-foreground);
            background: ${backgroundVar};
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
${styleLinks ? `${styleLinks}\n` : ""}
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">
        window.intelligitSettings = ${settingsPayload};
        window.intelligitI18n = ${i18nPayloadJson};
    </script>
    <script nonce="${nonce}" src="${escapeHtmlAttr(String(scriptUri))}"></script>
</body>
</html>`;
}

/** Reads the webview bootstrap settings and returns safe defaults when workspace configuration is unavailable. */
function readWebviewSettings(): WebviewSettings {
    const defaults: WebviewSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
    };

    try {
        const config = vscode.workspace?.getConfiguration?.();
        if (!config) return defaults;

        const rawIconStyle = config.get?.<string>("intelligit.icons") ?? "color";
        return {
            hoverDelay: config.get?.<number>("editor.hover.delay") ?? defaults.hoverDelay,
            tooltipsEnabled: config.get?.<boolean>("intelligit.tooltips.enabled") !== false,
            iconStyle: rawIconStyle === "color" ? "color" : "standard",
            commitWindowPosition: resolveCommitWindowPosition(config),
        };
    } catch {
        return defaults;
    }
}

/** Honors an explicit commit position or derives the automatic position from the VS Code sidebar. */
function resolveCommitWindowPosition(
    config: Pick<vscode.WorkspaceConfiguration, "get">,
): "left" | "right" {
    const rawPosition = config.get?.<string>("intelligit.commitWindowPosition") ?? "auto";
    if (rawPosition === "left" || rawPosition === "right") return rawPosition;

    return config.get?.<string>("workbench.sideBar.location") === "right" ? "right" : "left";
}

/**
 * Escapes localized or dynamic text for HTML text-node contexts.
 *
 * Quote characters are intentionally left untouched because text nodes do not need them escaped;
 * use {@link escapeHtmlAttr} for attribute values that are wrapped in quotes.
 */
export function escapeHtmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes text for HTML attribute contexts used by generated webview markup.
 *
 * Attribute escaping builds on text escaping and additionally encodes both quote characters so
 * localized strings and resource URIs cannot break out of quoted attributes.
 */
export function escapeHtmlAttr(value: string): string {
    return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Serializes JSON for inline script assignment without allowing `</script>` termination.
 *
 * The replacement preserves JSON semantics while preventing literal `<` characters from being
 * interpreted by the HTML parser before the JavaScript engine receives the payload.
 */
export function scriptSafeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function createNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(bytes[i] % chars.length);
    return r;
}
