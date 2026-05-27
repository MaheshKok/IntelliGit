import * as vscode from "vscode";
import { randomBytes } from "crypto";

export type OnboardingContext = "no-workspace" | "no-git-repo";

export class OnboardingViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.onboarding";

    private view?: vscode.WebviewView;

    constructor(
        private readonly contextType: OnboardingContext,
        private readonly title: string,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
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

        const actions: Array<{ id: string; label: string; icon: string }> = [];
        if (isNoWorkspace) {
            actions.push(
                { id: "cloneRepository", label: "Clone Repository", icon: "\u{1F4E5}" },
                { id: "openFolder", label: "Open Folder", icon: "\u{1F4C2}" },
            );
        } else {
            actions.push(
                { id: "initializeRepository", label: "Initialize Repository", icon: "\u{1F680}" },
                { id: "cloneRepository", label: "Clone Repository", icon: "\u{1F4E5}" },
                { id: "openFolder", label: "Open Folder", icon: "\u{1F4C2}" },
            );
        }

        const heading = isNoWorkspace ? "No Folder Open" : "No Git Repository";
        const subtitle = isNoWorkspace
            ? "Open a folder to get started with IntelliGit."
            : "Initialize a Git repository or open an existing one to get started.";

        const buttonsHtml = actions
            .map(
                (a) =>
                    `<button class="onboarding-btn" data-action="${a.id}"><span class="btn-icon">${a.icon}</span><span>${a.label}</span></button>`,
            )
            .join("\n");

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <title>${this.title}</title>
    <style nonce="${nonce}">
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 32px 24px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            text-align: center;
        }
        .onboarding-icon { font-size: 40px; margin-bottom: 16px; opacity: 0.6; }
        .onboarding-heading {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .onboarding-subtitle {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 28px;
            max-width: 280px;
            line-height: 1.5;
        }
        .onboarding-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
            width: 100%;
            max-width: 260px;
        }
        .onboarding-btn {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 10px 16px;
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
    <div class="onboarding-icon">🐙</div>
    <h1 class="onboarding-heading">${heading}</h1>
    <p class="onboarding-subtitle">${subtitle}</p>
    <div class="onboarding-actions">
        ${buttonsHtml}
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
