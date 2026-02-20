import * as vscode from "vscode";
import type { Branch, CommitDetail, ThemeFolderIconMap, ThemeIconFont } from "../../types";
import { FileIconThemeResolver, type ThemeFolderIcons } from "../../utils/fileIconTheme";

export class IconThemeService implements vscode.Disposable {
    private webview?: vscode.Webview;
    private iconResolver?: FileIconThemeResolver;
    private folderIcons: ThemeFolderIcons = {};
    private iconFonts: ThemeIconFont[] = [];
    private iconThemeDirty = true;
    private iconThemeInitialized = false;
    private lastThemeRootUri: string | undefined;
    private iconThemeDisposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {}

    attachWebview(webview: vscode.Webview): void {
        this.disposeResolver();
        this.disposeIconThemeDisposables();

        this.webview = webview;
        this.iconResolver = new FileIconThemeResolver(webview);
        this.lastThemeRootUri = undefined;
        this.markIconThemeDirty();
        this.registerIconThemeListeners();
    }

    getFolderIcons(): ThemeFolderIcons {
        return this.folderIcons;
    }

    getIconFonts(): ThemeIconFont[] {
        return this.iconFonts;
    }

    getThemeData(): { folderIcons: ThemeFolderIcons; iconFonts: ThemeIconFont[] } {
        return {
            folderIcons: this.folderIcons,
            iconFonts: this.iconFonts,
        };
    }

    async initIconThemeData(): Promise<void> {
        if (!this.iconResolver || !this.webview) return;
        if (!this.iconThemeDirty && this.iconThemeInitialized) return;

        const distRoot = vscode.Uri.joinPath(this.extensionUri, "dist");
        const themeRoot = await this.iconResolver.getThemeResourceRootUri();
        const nextThemeRootUri = themeRoot?.toString();
        if (this.lastThemeRootUri !== nextThemeRootUri) {
            this.webview.options = {
                ...this.webview.options,
                localResourceRoots: themeRoot ? [distRoot, themeRoot] : [distRoot],
            };
            this.lastThemeRootUri = nextThemeRootUri;
        }
        this.folderIcons = await this.iconResolver.getFolderIcons();
        this.iconFonts = await this.iconResolver.getThemeFonts();
        this.iconThemeDirty = false;
        this.iconThemeInitialized = true;
    }

    async decorateCommitDetail(detail: CommitDetail): Promise<CommitDetail> {
        if (!this.iconResolver) return detail;
        const files = await this.iconResolver.decorateCommitFiles(detail.files);
        return { ...detail, files };
    }

    async decorateCommitDetailWithFolderIcons(detail: CommitDetail): Promise<{
        detail: CommitDetail;
        folderIconsByName: ThemeFolderIconMap;
    }> {
        await this.initIconThemeData();
        const decoratedDetail = await this.decorateCommitDetail(detail);
        const folderIconsByName = await this.getFolderIconsByCommitFiles(decoratedDetail.files);
        return {
            detail: decoratedDetail,
            folderIconsByName,
        };
    }

    async getFolderIconsByCommitFiles(files: CommitDetail["files"]): Promise<ThemeFolderIconMap> {
        const names: string[] = [];
        for (const file of files) {
            const parts = file.path.split("/").slice(0, -1);
            for (const part of parts) {
                const trimmed = part.trim();
                if (trimmed.length > 0) names.push(trimmed);
            }
        }
        return this.getFolderIconsByNames(names);
    }

    async getFolderIconsByBranches(branches: Branch[]): Promise<ThemeFolderIconMap> {
        const names: string[] = [];

        for (const branch of branches) {
            const fullName = branch.name;
            let displayName = fullName;
            if (branch.isRemote) {
                const remotePrefix = branch.remote ? `${branch.remote}/` : undefined;
                if (remotePrefix && fullName.startsWith(remotePrefix)) {
                    displayName = fullName.slice(remotePrefix.length);
                } else {
                    const firstSlash = fullName.indexOf("/");
                    displayName = firstSlash >= 0 ? fullName.slice(firstSlash + 1) : fullName;
                }
            }

            const parts = displayName.split("/");
            if (parts.length <= 1) continue;
            for (const folderName of parts.slice(0, -1)) {
                const trimmed = folderName.trim();
                if (trimmed.length > 0) names.push(trimmed);
            }
        }

        return this.getFolderIconsByNames(names);
    }

    async getFolderIconsByNames(names: string[]): Promise<ThemeFolderIconMap> {
        if (!this.iconResolver) return {};
        return this.iconResolver.getFolderIconsByName(names);
    }

    dispose(): void {
        this.disposeResolver();
        this.disposeIconThemeDisposables();
        this.webview = undefined;
        this.lastThemeRootUri = undefined;
        this.markIconThemeDirty();
    }

    private markIconThemeDirty(): void {
        this.iconThemeDirty = true;
        this.iconThemeInitialized = false;
    }

    private registerIconThemeListeners(): void {
        const windowWithThemeEvents = vscode.window as unknown as {
            onDidChangeActiveColorTheme?: (listener: () => void) => vscode.Disposable;
        };
        if (typeof windowWithThemeEvents.onDidChangeActiveColorTheme === "function") {
            this.iconThemeDisposables.push(
                windowWithThemeEvents.onDidChangeActiveColorTheme(() => this.markIconThemeDirty()),
            );
        }

        const workspaceWithThemeEvents = vscode.workspace as unknown as {
            onDidChangeConfiguration?: (
                listener: (event: { affectsConfiguration: (section: string) => boolean }) => void,
            ) => vscode.Disposable;
        };
        if (typeof workspaceWithThemeEvents.onDidChangeConfiguration === "function") {
            this.iconThemeDisposables.push(
                workspaceWithThemeEvents.onDidChangeConfiguration((event) => {
                    if (
                        event.affectsConfiguration("workbench.iconTheme") ||
                        event.affectsConfiguration("workbench.colorTheme")
                    ) {
                        this.markIconThemeDirty();
                    }
                }),
            );
        }
    }

    private disposeResolver(): void {
        this.iconResolver?.dispose();
        this.iconResolver = undefined;
    }

    private disposeIconThemeDisposables(): void {
        for (const disposable of this.iconThemeDisposables) {
            disposable.dispose();
        }
        this.iconThemeDisposables = [];
    }
}
