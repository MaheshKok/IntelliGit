import * as vscode from "vscode";
import { SYSTEM_FONT_STACK } from "../utils/constants";
import { getWebviewI18nPayload } from "../webviews/i18n";

interface WebviewShellOptions {
    extensionUri: vscode.Uri;
    webview: vscode.Webview;
    scriptFile: string;
    styleFiles?: string[];
    title: string;
    backgroundVar?: string;
}

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

    let hoverDelay = 300;
    let tooltipsEnabled = true;
    let iconStyle: "color" | "standard" = "standard";
    let commitWindowPosition: "left" | "right" = "left";
    try {
        const config = vscode.workspace?.getConfiguration?.();
        if (config) {
            hoverDelay = config.get?.<number>("editor.hover.delay") ?? 300;
            tooltipsEnabled = config.get?.<boolean>("intelligit.tooltips.enabled") !== false;
            const rawIconStyle = config.get?.<string>("intelligit.icons") ?? "color";
            iconStyle = rawIconStyle === "color" ? "color" : "standard";
            const rawPosition = config.get?.<string>("intelligit.commitWindowPosition") ?? "auto";
            if (rawPosition === "left" || rawPosition === "right") {
                commitWindowPosition = rawPosition;
            } else {
                const sidebarLocation =
                    config.get?.<string>("workbench.sideBar.location") ?? "left";
                commitWindowPosition = sidebarLocation === "right" ? "right" : "left";
            }
        }
    } catch {
        // Safe fallback when workspace is not mocked or available
    }

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

export function escapeHtmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(value: string): string {
    return escapeHtmlText(value)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function scriptSafeJson(value: unknown): string {
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
