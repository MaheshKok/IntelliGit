import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { isValidRemoteName } from "../utils/gitRefs";
import { areSameRepositoryRoot } from "../utils/repositoryRoot";
import type {
    ManagedRemote,
    ManageRemotesRequest,
    ManageRemotesResponse,
} from "../webviews/protocol/manageRemotesTypes";
import { buildWebviewShellHtml } from "./webviewHtml";

/** Owns one repository-scoped Manage Remotes dialog and its untrusted message boundary. */
export class ManageRemotesPanel {
    private static readonly instances = new Set<ManageRemotesPanel>();
    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private busy = false;
    private revision = 0;
    private remotes: ManagedRemote[] = [];
    private configuredCounts = new Map<string, number>();

    private constructor(
        extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly repoRoot: string,
        private readonly refresh: (repoRoot: string) => Promise<void>,
    ) {
        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.manageRemotes",
            vscode.l10n.t("Git Remotes"),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        this.panel = rawPanel;
        this.panel.webview.html = buildWebviewShellHtml({
            extensionUri,
            webview: this.panel.webview,
            scriptFile: "webview-manage-remotes.js",
            styleFiles: ["webview-manage-remotes.css"],
            title: vscode.l10n.t("Git Remotes"),
            e2eViewId: `manage-remotes:${repoRoot}`,
        });
        this.panel.webview.onDidReceiveMessage(async (raw: unknown) => this.handleMessage(raw));
        this.panel.onDidDispose(() => {
            this.disposed = true;
            ManageRemotesPanel.instances.delete(this);
        });
    }

    /** Reveals the existing panel for a canonical root or opens a separate repository instance. */
    static open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        repoRoot: string,
        refresh: (repoRoot: string) => Promise<void>,
    ): void {
        const existing = [...this.instances].find(
            (instance) => !instance.disposed && areSameRepositoryRoot(instance.repoRoot, repoRoot),
        );
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        this.instances.add(new ManageRemotesPanel(extensionUri, gitOps, repoRoot, refresh));
    }

    /** Parses a closed message shape; extra properties such as client repository paths are refused. */
    private parseRequest(raw: unknown): ManageRemotesRequest | undefined {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const value = raw as Record<string, unknown>;
        const keys = Object.keys(value).sort().join(",");
        switch (value.type) {
            case "ready":
            case "reload":
            case "close":
                return keys === "type" ? { type: value.type } : undefined;
            case "add":
                return keys === "name,type,url" &&
                    typeof value.name === "string" &&
                    typeof value.url === "string"
                    ? { type: "add", name: value.name, url: value.url }
                    : undefined;
            case "edit":
                return keys === "name,originalName,revision,type,url" &&
                    Number.isSafeInteger(value.revision) &&
                    typeof value.originalName === "string" &&
                    typeof value.name === "string" &&
                    typeof value.url === "string"
                    ? {
                          type: "edit",
                          revision: value.revision as number,
                          originalName: value.originalName,
                          name: value.name,
                          url: value.url,
                      }
                    : undefined;
            case "remove":
                return keys === "name,revision,type" &&
                    Number.isSafeInteger(value.revision) &&
                    typeof value.name === "string"
                    ? { type: "remove", revision: value.revision as number, name: value.name }
                    : undefined;
            default:
                return undefined;
        }
    }

    /** Validates every incoming action before any Git write and serializes confirmation with mutations. */
    private async handleMessage(raw: unknown): Promise<void> {
        if (this.disposed) return;
        const request = this.parseRequest(raw);
        if (!request) return;
        if (request.type === "close") {
            this.panel.dispose();
            return;
        }
        if (this.busy) return;
        this.busy = true;
        await this.post({ type: "busy" });
        try {
            if (request.type === "ready" || request.type === "reload") {
                await this.load();
            } else if (request.type === "add") {
                await this.add(request);
            } else if (request.type === "edit") {
                await this.edit(request);
            } else {
                await this.remove(request);
            }
        } catch (error) {
            await this.post({ type: "error", message: getErrorMessage(error) });
        } finally {
            this.busy = false;
        }
    }

    /** Reads a strict, host-authoritative snapshot without masking Git errors as zero remotes. */
    private async readSnapshot(): Promise<void> {
        const names = await this.gitOps.getRemoteNames();
        const rows: ManagedRemote[] = [];
        const counts = new Map<string, number>();
        for (const name of names) {
            const urls = await this.gitOps.getConfiguredRemoteUrls(name);
            counts.set(name, urls.length);
            rows.push({
                name,
                url: urls[0] ?? "",
                additionalUrlCount: Math.max(0, urls.length - 1),
            });
        }
        this.remotes = rows;
        this.configuredCounts = counts;
        this.revision++;
    }

    /** Sends the current authoritative state while preserving an operation error when supplied. */
    private async snapshot(error?: string, completed?: boolean): Promise<void> {
        await this.post({
            type: "snapshot",
            repoLabel: this.repoRoot,
            revision: this.revision,
            remotes: this.remotes,
            ...(error ? { error } : {}),
            ...(completed ? { completed } : {}),
        });
    }

    /** Loads or retries remote data, leaving a failed read visible as an error. */
    private async load(): Promise<void> {
        await this.readSnapshot();
        await this.snapshot();
    }

    /** Normalizes only outer whitespace and rejects unsafe or unsupported remote fields. */
    private fields(name: string, url: string): { name: string; url: string } {
        if (/[\0\r\n]/.test(name)) throw new Error(vscode.l10n.t("Invalid remote name."));
        const normalizedName = name.trim();
        const normalizedUrl = url.trim();
        if (!isValidRemoteName(normalizedName))
            throw new Error(vscode.l10n.t("Invalid remote name."));
        if (!normalizedUrl || /[\0\r\n]/.test(url)) {
            throw new Error(vscode.l10n.t("Enter a valid remote URL."));
        }
        return { name: normalizedName, url: normalizedUrl };
    }

    /** Adds through the captured repository and refreshes after Git has accepted the write. */
    private async add(request: Extract<ManageRemotesRequest, { type: "add" }>): Promise<void> {
        const { name, url } = this.fields(request.name, request.url);
        if ((await this.gitOps.getRemoteNames()).includes(name)) {
            throw new Error(vscode.l10n.t("Remote {name} already exists.", { name }));
        }
        await this.gitOps.addRemote(name, url);
        await this.afterMutation();
    }

    /** Rejects stale identity or URL before ordering rename ahead of selective URL replacement. */
    private async edit(request: Extract<ManageRemotesRequest, { type: "edit" }>): Promise<void> {
        const { name, url } = this.fields(request.name, request.url);
        const original = this.remotes.find((item) => item.name === request.originalName);
        if (request.revision !== this.revision || !original) {
            throw new Error(vscode.l10n.t("Remote data changed. Reload and try again."));
        }
        const names = await this.gitOps.getRemoteNames();
        const urls = names.includes(original.name)
            ? await this.gitOps.getConfiguredRemoteUrls(original.name)
            : [];
        if (
            !names.includes(original.name) ||
            (urls[0] ?? "") !== original.url ||
            urls.length !== this.configuredCounts.get(original.name)
        ) {
            await this.readSnapshot();
            await this.snapshot(vscode.l10n.t("Remote data changed. Reload and try again."));
            return;
        }
        if (name === original.name && url === original.url) {
            await this.snapshot(undefined, true);
            return;
        }
        let renamed = false;
        let attemptedUrlChange = false;
        try {
            if (name !== original.name) {
                await this.gitOps.renameRemote(original.name, name);
                renamed = true;
            }
            if (url !== original.url) {
                attemptedUrlChange = true;
                await this.gitOps.setRemoteUrl(name, urls[0], url);
            }
        } catch (error) {
            if (renamed) {
                await this.afterMutation(
                    vscode.l10n.t(
                        "Remote renamed to {name}, but its URL could not be changed: {message}",
                        { name, message: getErrorMessage(error) },
                    ),
                );
                return;
            }
            if (attemptedUrlChange) {
                await this.afterMutation(
                    vscode.l10n.t("Remote URL could not be changed: {message}", {
                        message: getErrorMessage(error),
                    }),
                    false,
                );
                return;
            }
            throw error;
        }
        await this.afterMutation();
    }

    /** Confirms deletion of the host-selected remote before removing its Git configuration. */
    private async remove(
        request: Extract<ManageRemotesRequest, { type: "remove" }>,
    ): Promise<void> {
        const original = this.remotes.find((item) => item.name === request.name);
        if (request.revision !== this.revision || !original) {
            throw new Error(vscode.l10n.t("Remote data changed. Reload and try again."));
        }
        const removeLabel = vscode.l10n.t("Remove");
        const answer = await vscode.window.showWarningMessage(
            vscode.l10n.t("Remove remote {name}?", { name: original.name }),
            { modal: true },
            removeLabel,
        );
        if (answer !== removeLabel || this.disposed) {
            await this.snapshot();
            return;
        }
        const names = await this.gitOps.getRemoteNames();
        const urls = names.includes(original.name)
            ? await this.gitOps.getConfiguredRemoteUrls(original.name)
            : [];
        if (
            !names.includes(original.name) ||
            (urls[0] ?? "") !== original.url ||
            urls.length !== this.configuredCounts.get(original.name)
        ) {
            await this.readSnapshot();
            await this.snapshot(vscode.l10n.t("Remote data changed. Reload and try again."));
            return;
        }
        await this.gitOps.removeRemote(original.name);
        await this.afterMutation();
    }

    /** Refreshes the captured repository even if the panel was closed during an accepted write. */
    private async afterMutation(error?: string, changed = true): Promise<void> {
        let readError: string | undefined;
        try {
            await this.readSnapshot();
        } catch (failure) {
            readError = vscode.l10n.t("The remote list could not be refreshed: {message}", {
                message: getErrorMessage(failure),
            });
        }
        try {
            await this.refresh(this.repoRoot);
        } catch (failure) {
            const refreshError = vscode.l10n.t(
                "Repository views could not be refreshed: {message}",
                { message: getErrorMessage(failure) },
            );
            readError = readError ? `${readError} ${refreshError}` : refreshError;
        }
        if (readError) {
            const prefix = error ?? (changed ? vscode.l10n.t("Change saved.") : "");
            await this.post({ type: "error", message: `${prefix} ${readError}`.trim() });
        } else {
            await this.snapshot(error, !error);
        }
    }

    /** Avoids posting to a disposed webview; accepted Git writes are never canceled in flight. */
    private async post(message: ManageRemotesResponse): Promise<void> {
        if (this.disposed) return;
        try {
            await this.panel.webview.postMessage(message);
        } catch {
            /* Disposal can race posting. */
        }
    }
}
