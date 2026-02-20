import * as vscode from "vscode";
import type {
    Branch,
    CommitDetail,
    ThemeFolderIconMap,
    ThemeIconFont,
    WorkingFile,
} from "../../types";
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
    private disposed = false;

    constructor(private readonly extensionUri: vscode.Uri) {}

    attachWebview(webview: vscode.Webview): void {
        this.disposeResolver();
        this.disposeIconThemeDisposables();

        this.webview = webview;
        this.iconResolver = new FileIconThemeResolver(webview);
        this.lastThemeRootUri = undefined;
        this.disposed = false;
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
            const existingRoots = this.webview.options.localResourceRoots ?? [];
            const mergedRoots: vscode.Uri[] = [];
            const seen = new Set<string>();
            const addRoot = (root: vscode.Uri | undefined | null): void => {
                if (!root) return;
                const key = this.getUriIdentity(root);
                if (seen.has(key)) return;
                seen.add(key);
                mergedRoots.push(root);
            };
            for (const existing of existingRoots) {
                addRoot(existing);
            }
            addRoot(distRoot);
            addRoot(themeRoot);
            this.webview.options = {
                ...this.webview.options,
                localResourceRoots: mergedRoots,
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

    async decorateWorkingFiles(files: WorkingFile[]): Promise<WorkingFile[]> {
        if (!this.iconResolver) return files;
        return this.iconResolver.decorateWorkingFiles(files);
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
        await this.initIconThemeData();
        return this.getFolderIconsByPaths(files.map((file) => file.path));
    }

    async getFolderIconsByWorkingFiles(files: WorkingFile[]): Promise<ThemeFolderIconMap> {
        await this.initIconThemeData();
        return this.getFolderIconsByPaths(files.map((file) => file.path));
    }

    async getFolderIconsByBranches(branches: Branch[]): Promise<ThemeFolderIconMap> {
        await this.initIconThemeData();
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
        await this.initIconThemeData();
        if (!this.iconResolver) return {};
        return this.iconResolver.getFolderIconsByName(names);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
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

    private getUriIdentity(uri: vscode.Uri): string {
        const typed = uri as unknown as { fsPath?: string; path?: string; toString?: () => string };
        return typed.fsPath ?? typed.path ?? typed.toString?.() ?? "";
    }

    private async getFolderIconsByPaths(paths: string[]): Promise<ThemeFolderIconMap> {
        const names: string[] = [];
        for (const path of paths) {
            const parts = path.split("/").slice(0, -1);
            for (const part of parts) {
                const trimmed = part.trim();
                if (trimmed.length > 0) names.push(trimmed);
            }
        }
        return this.getFolderIconsByNames(names);
    }

    private registerIconThemeListeners(): void {
        this.iconThemeDisposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => this.markIconThemeDirty()),
        );

        this.iconThemeDisposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("workbench.iconTheme") ||
                    event.affectsConfiguration("workbench.colorTheme")
                ) {
                    this.markIconThemeDirty();
                }
            }),
        );
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
