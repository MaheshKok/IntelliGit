import * as vscode from "vscode";
import type {
    Branch,
    CommitDetail,
    ThemeFolderIconMap,
    ThemeIconFont,
    WorkingFile,
} from "../../types";
import { FileIconThemeResolver, type ThemeFolderIcons } from "../../utils/fileIconTheme";
import { registerThemeChangeListeners, disposeAll } from "./themeListeners";

/**
 * Owns file-icon-theme resolution and cached icon metadata for a single attached webview.
 *
 * View providers attach their current webview during resolution. The service then expands webview
 * resource roots for theme assets, caches folder icons/fonts, marks caches dirty on theme changes,
 * and releases per-webview listeners when the owning view is disposed.
 */
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

    /**
     * Creates an inert icon-theme cache scoped to the extension installation.
     *
     * Theme resources cannot be resolved until a VS Code webview is attached because URI rewriting
     * and CSP resource roots are webview-specific.
     */
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Rebinds the service to the currently resolved VS Code webview.
     *
     * Any previous resolver and theme listeners are disposed first so a restored or replaced view
     * cannot keep stale resource roots, then cached theme data is marked dirty for reinitialization.
     */
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

    /**
     * Returns the last initialized folder icon pair without triggering I/O.
     *
     * Callers that require fresh theme data should await {@link initIconThemeData} before reading
     * this snapshot; before initialization the fallback is an empty icon set.
     */
    getFolderIcons(): ThemeFolderIcons {
        return this.folderIcons;
    }

    /**
     * Returns cached icon font declarations for webview messages.
     *
     * The array reflects the last successful theme initialization and remains empty when no webview
     * resolver is attached or the active icon theme does not provide custom fonts.
     */
    getIconFonts(): ThemeIconFont[] {
        return this.iconFonts;
    }

    /**
     * Returns a single snapshot of cached folder icons and icon fonts for posting to a webview.
     *
     * This helper avoids reading the two caches at different times, but it still does not refresh
     * dirty data; providers call {@link initIconThemeData} before emitting theme-sensitive payloads.
     */
    getThemeData(): { folderIcons: ThemeFolderIcons; iconFonts: ThemeIconFont[] } {
        return {
            folderIcons: this.folderIcons,
            iconFonts: this.iconFonts,
        };
    }

    /**
     * Initializes or refreshes icon-theme data for the attached webview.
     *
     * The method is a no-op until a webview resolver exists. When the theme resource root changes,
     * it merges the extension `dist` root and theme root into `localResourceRoots` so generated icon
     * and font URIs remain loadable under the webview CSP.
     */
    async initIconThemeData(): Promise<void> {
        if (!this.iconResolver || !this.webview) return;
        if (!this.iconThemeDirty && this.iconThemeInitialized) return;

        const distRoot = vscode.Uri.joinPath(this.extensionUri, "dist");
        const themeRoot = this.iconResolver.getThemeResourceRootUri();
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

    /**
     * Decorates commit-detail file rows with the current file icon theme when available.
     *
     * If a provider calls this before webview attachment, the original detail is returned unchanged
     * so cached commit state can still be posted later without failing the view lifecycle.
     */
    async decorateCommitDetail(detail: CommitDetail): Promise<CommitDetail> {
        if (!this.iconResolver) return detail;
        const files = await this.iconResolver.decorateCommitFiles(detail.files);
        return { ...detail, files };
    }

    /**
     * Decorates working-tree rows with file icons while preserving no-webview fallback behavior.
     *
     * Returning the original array when no resolver is attached lets refreshes run during early
     * activation or disposal races without blocking repository state updates.
     */
    async decorateWorkingFiles(files: WorkingFile[]): Promise<WorkingFile[]> {
        if (!this.iconResolver) return files;
        return this.iconResolver.decorateWorkingFiles(files);
    }

    /**
     * Decorates commit details and derives folder icon metadata in one theme-initialized pass.
     *
     * Providers remain responsible for sequence checks before storing the result because icon-theme
     * work can finish after a newer commit selection has replaced the original detail.
     */
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

    /**
     * Resolves folder icons for the parent directories present in commit-detail file rows.
     *
     * Theme data is initialized first so callers receive a map suitable for immediate webview
     * posting, with the empty map as the fallback when no resolver is attached.
     */
    async getFolderIconsByCommitFiles(files: CommitDetail["files"]): Promise<ThemeFolderIconMap> {
        await this.initIconThemeData();
        return this.getFolderIconsByPaths(files.map((file) => file.path));
    }

    /**
     * Resolves folder icons for the parent directories present in working-tree rows.
     *
     * Paths are treated as repository-relative display paths, not filesystem paths, so literal Git
     * output is split only on `/` for icon-name extraction.
     */
    async getFolderIconsByWorkingFiles(files: WorkingFile[]): Promise<ThemeFolderIconMap> {
        await this.initIconThemeData();
        return this.getFolderIconsByPaths(files.map((file) => file.path));
    }

    /**
     * Resolves folder icons for slash-separated branch name segments.
     *
     * Remote branch names drop their remote prefix before segment extraction, and leaf branch names
     * are ignored so only folder-like prefixes such as `feature/` request theme folder icons.
     */
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

    /**
     * Resolves theme folder icons for already extracted folder names.
     *
     * Duplicate handling and icon fallback behavior live in the resolver; this boundary guarantees
     * theme initialization and returns an empty map when no webview resolver is available.
     */
    async getFolderIconsByNames(names: string[]): Promise<ThemeFolderIconMap> {
        if (!this.iconResolver) return {};
        await this.initIconThemeData();
        return this.iconResolver ? this.iconResolver.getFolderIconsByName(names) : {};
    }

    /**
     * Idempotently releases webview-specific icon resources and marks cached data stale.
     *
     * Providers may call dispose on view disposal and replacement paths; the next attachment will
     * create a fresh resolver and re-expand resource roots for that webview.
     */
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
            ...registerThemeChangeListeners(() => this.markIconThemeDirty()),
        );
    }

    private disposeResolver(): void {
        this.iconResolver?.dispose();
        this.iconResolver = undefined;
    }

    private disposeIconThemeDisposables(): void {
        disposeAll(this.iconThemeDisposables);
    }
}
