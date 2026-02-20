import * as vscode from "vscode";

interface WebviewShellOptions {
    extensionUri: vscode.Uri;
    webview: vscode.Webview;
    scriptFile: string;
    title: string;
    backgroundVar?: string;
}

export function buildWebviewShellHtml({
    extensionUri,
    webview,
    scriptFile,
    title,
    backgroundVar = "var(--vscode-editor-background)",
}: WebviewShellOptions): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", scriptFile));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <title>${title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
            width: 100%; height: 100%; overflow: hidden;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: ${backgroundVar};
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(bytes[i] % chars.length);
    return r;
}
