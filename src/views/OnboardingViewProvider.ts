import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { escapeHtmlAttr, escapeHtmlText } from "./webviewHtml";

export type OnboardingContext = "no-workspace" | "no-git-repo";

export class OnboardingViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.onboarding";

    private view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly contextType: OnboardingContext,
        private readonly title: string,
        private readonly showActions = true,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        };

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });

        webviewView.webview.onDidReceiveMessage((msg) => {
            switch (msg.type) {
                case "cloneRepository":
                    void vscode.commands.executeCommand("intelligit.cloneRepository");
                    break;
                case "openFolder":
                    void vscode.commands.executeCommand("intelligit.openFolder");
                    break;
                case "initializeRepository":
                    void vscode.commands.executeCommand("intelligit.initializeRepository");
                    break;
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);
    }

    private getHtml(webview: vscode.Webview): string {
        const isNoWorkspace = this.contextType === "no-workspace";
        const nonce = randomBytes(16).toString("base64");

        const iconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "media", "intelligit.svg"),
        );

        const actions: Array<{ id: string; label: string; icon: string }> = [];
        if (this.showActions) {
            if (isNoWorkspace) {
                actions.push(
                    {
                        id: "cloneRepository",
                        label: vscode.l10n.t("Clone Repository"),
                        icon: "\u{1F4E5}",
                    },
                    {
                        id: "openFolder",
                        label: vscode.l10n.t("Open Folder"),
                        icon: "\u{1F4C2}",
                    },
                );
            } else {
                actions.push({
                    id: "initializeRepository",
                    label: vscode.l10n.t("Initialize Repository"),
                    icon: "\u{1F680}",
                });
            }
        }

        const heading = isNoWorkspace
            ? vscode.l10n.t("No Folder Open")
            : vscode.l10n.t("No Git Repository");
        const subtitle = isNoWorkspace
            ? vscode.l10n.t("Open a folder to get started with IntelliGit.")
            : vscode.l10n.t(
                  "Initialize a Git repository or open an existing one to get started.",
              );

        const buttonsHtml = actions
            .map(
                (a) =>
                    `<button class="onboarding-btn" data-action="${escapeHtmlAttr(a.id)}"><span class="btn-icon">${escapeHtmlText(a.icon)}</span><span>${escapeHtmlText(a.label)}</span></button>`,
            )
            .join("\n");
        const contentHtml = this.showActions
            ? `<img class="onboarding-icon" src="${escapeHtmlAttr(String(iconUri))}" alt="${escapeHtmlAttr(vscode.l10n.t("IntelliGit"))}" />
        <h1 class="onboarding-heading">${escapeHtmlText(heading)}</h1>
        <p class="onboarding-subtitle">${escapeHtmlText(subtitle)}</p>
        <div class="onboarding-actions">
            ${buttonsHtml}
        </div>`
            : "";

        return `<!DOCTYPE html>
<html lang="${escapeHtmlAttr(vscode.env.language)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <title>${escapeHtmlText(this.title)}</title>
    <style nonce="${nonce}">
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            justify-content: flex-start;
            min-height: 100vh;
            padding: 12px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            text-align: left;
        }
        .onboarding-shell {
            width: 100%;
            max-width: 320px;
        }
        .onboarding-icon {
            display: block;
            width: 32px;
            height: 32px;
            margin: 0 auto 12px;
            opacity: 0.85;
        }
        .onboarding-heading {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .onboarding-subtitle {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
            max-width: 320px;
            line-height: 1.5;
        }
        .onboarding-actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
        }
        .onboarding-btn {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            gap: 10px;
            width: 100%;
            padding: 6px 10px;
            border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-button-border));
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            font-family: inherit;
            font-size: 13px;
        }
        .onboarding-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .onboarding-btn:focus-visible {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        .btn-icon { font-size: 16px; flex-shrink: 0; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-border);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="onboarding-shell">
        ${contentHtml}
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.onboarding-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                vscode.postMessage({ type: btn.dataset.action });
            });
        });
        var initBtn = document.querySelector('[data-action="initializeRepository"]');
        if (initBtn) initBtn.classList.add('btn-primary');
    </script>
</body>
</html>`;
    }
}
