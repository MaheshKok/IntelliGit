import * as vscode from "vscode";
import { getE2eWebviewRegistry, isE2eControlChannelActive } from "../e2e/activationState";
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
    /**
     * Identifies this webview *instance* to the development-only E2E control channel.
     *
     * Required from every host context that can have more than one live instance at a time,
     * or that shares a `scriptFile` with another context; omitting it there makes two live
     * webviews collide on one registry key. Singleton view-container contexts may omit it and
     * take the `scriptFile`-derived default. See `deriveE2eViewId`.
     */
    e2eViewId?: string;
}

type WebviewSettings = {
    hoverDelay: number;
    tooltipsEnabled: boolean;
    iconStyle: "color" | "standard";
    commitWindowPosition: "left" | "right";
    commitCheckState: CommitFileCheckMode;
};

type CommitFileCheckMode = "allChecked" | "noneChecked" | "preserveSelection";

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
    e2eViewId,
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
    const { hoverDelay, tooltipsEnabled, iconStyle, commitWindowPosition, commitCheckState } =
        readWebviewSettings();

    const settingsPayload = scriptSafeJson({
        hoverDelay,
        tooltipsEnabled,
        iconStyle,
        commitWindowPosition,
        commitCheckState,
    });
    const i18nPayloadJson = scriptSafeJson(i18nPayload);
    const e2eBootstrapScript = buildE2eBootstrapScript(
        webview,
        e2eViewId ?? deriveE2eViewId(scriptFile),
    );

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
        window.intelligitI18n = ${i18nPayloadJson};${e2eBootstrapScript}
    </script>
    <script nonce="${nonce}" src="${escapeHtmlAttr(String(scriptUri))}"></script>
</body>
</html>`;
}

/**
 * Derives a default E2E view id from a webview's bundled entry script.
 *
 * This is only correct for host contexts that are genuinely singletons -- the view-container
 * providers, which VS Code mounts at most once. It is NOT sufficient on its own, and callers
 * that can violate either assumption below must pass an explicit `e2eViewId`:
 *
 *  - *Multi-instance contexts.* `MergeEditorPanel` and `ShelfConflictEditorPanel` each keep a
 *    static `Map` of live panels (`MergeEditorPanel.ts:69`, `ShelfConflictEditorPanel.ts:125`)
 *    and use `createWebviewPanel`, so several instances are open at once -- one per conflicted
 *    file or shelved change.
 *  - *Shared bundles.* Those same two classes both render `webview-mergeeditor.js`
 *    (`MergeEditorPanel.ts:343`, `ShelfConflictEditorPanel.ts:141`), so even one instance each
 *    would derive the same id.
 *
 * A collision is not a benign duplicate: `E2eWebviewRegistry.register` replaces the previous
 * entry, so an E2E request for that id is answered by whichever instance registered last --
 * a wrong-target success rather than the hard failure step 10 mandates for an unaddressable
 * view. Multi-repository data *within* one app is keyed by state-blob prefixes instead (see
 * `WEBVIEW_STATE_ALLOWLIST`), which is a separate axis and not affected by this id.
 */
function deriveE2eViewId(scriptFile: string): string {
    const basename = scriptFile.split("/").pop() ?? scriptFile;
    return basename.replace(/\.[^./]+$/, "");
}

/**
 * Builds the inline script fragment that bootstraps the E2E control channel's webview leg,
 * or an empty string when the channel is not active. Registration happens here -- the single
 * choke point every bundled webview's HTML passes through -- rather than in each of the 8
 * view providers individually. Runtime-gated, not build-gated: this branch is present in
 * every build, and only ever does anything when `isE2eControlChannelActive()` is true, which
 * itself requires `ExtensionMode.Development` and the other two gates in `evaluateE2eGate`.
 */
function buildE2eBootstrapScript(webview: vscode.Webview, viewId: string): string {
    if (!isE2eControlChannelActive()) {
        return "";
    }
    getE2eWebviewRegistry()?.register(viewId, webview);
    return "\n        window.intelligitE2E = true;";
}

/** Reads the webview bootstrap settings and returns safe defaults when workspace configuration is unavailable. */
function readWebviewSettings(): WebviewSettings {
    const defaults: WebviewSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
        commitCheckState: "noneChecked",
    };

    try {
        const config = vscode.workspace?.getConfiguration?.();
        if (!config) return defaults;

        const rawIconStyle = config.get?.<string>("intelligit.icons") ?? "color";
        const rawCommitCheckState = config.get?.<unknown>("intelligit.commitCheckState");
        return {
            hoverDelay: config.get?.<number>("editor.hover.delay") ?? defaults.hoverDelay,
            tooltipsEnabled: config.get?.<boolean>("intelligit.tooltips.enabled") !== false,
            iconStyle: rawIconStyle === "color" ? "color" : "standard",
            commitWindowPosition: resolveCommitWindowPosition(config),
            commitCheckState:
                rawCommitCheckState === "allChecked" ||
                rawCommitCheckState === "preserveSelection" ||
                rawCommitCheckState === "noneChecked"
                    ? rawCommitCheckState
                    : defaults.commitCheckState,
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
