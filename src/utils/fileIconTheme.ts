import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { parse as parseJsonc } from "jsonc-parser";
import type {
    CommitFile,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../types";

interface IconDefinition {
    iconPath?: string;
    fontCharacter?: string;
    fontColor?: string;
    fontId?: string;
    baseDir: string;
}

interface ThemeFontSource {
    path: string;
    format?: string;
}

interface ThemeFontDefinition {
    id: string;
    baseDir: string;
    source: ThemeFontSource;
    weight?: string;
    style?: string;
    size?: string;
}

interface ParsedIconTheme {
    iconDefinitions: Record<string, IconDefinition>;
    file?: string;
    folder?: string;
    folderExpanded?: string;
    rootFolder?: string;
    rootFolderExpanded?: string;
    fileExtensions: Record<string, string>;
    fileNames: Record<string, string>;
    languageIds: Record<string, string>;
    folderNames: Record<string, string>;
    folderNamesExpanded: Record<string, string>;
    fonts: Record<string, ThemeFontDefinition>;
    defaultFontId?: string;
}

interface IconThemeContribution {
    id: string;
    path: string;
}

export interface ThemeFolderIcons {
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
}

const EMPTY_THEME: ParsedIconTheme = {
    iconDefinitions: {},
    fileExtensions: {},
    fileNames: {},
    languageIds: {},
    folderNames: {},
    folderNamesExpanded: {},
    fonts: {},
};

function normalizeMap(input: unknown): Record<string, string> {
    if (!input || typeof input !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string") out[key.toLowerCase()] = value;
    }
    return out;
}

function parseFonts(
    section: Record<string, unknown>,
    baseDir: string,
): {
    fonts: Record<string, ThemeFontDefinition>;
    defaultFontId?: string;
} {
    const out: Record<string, ThemeFontDefinition> = {};
    const rawFonts = section.fonts;
    if (!Array.isArray(rawFonts)) return { fonts: out };

    for (const font of rawFonts) {
        if (!font || typeof font !== "object") continue;
        const typed = font as Record<string, unknown>;
        const id = typeof typed.id === "string" ? typed.id : undefined;
        if (!id) continue;
        const srcArray = Array.isArray(typed.src) ? typed.src : [];
        const srcEntry = srcArray.find(
            (entry) =>
                !!entry &&
                typeof entry === "object" &&
                typeof (entry as Record<string, unknown>).path === "string",
        ) as Record<string, unknown> | undefined;
        if (!srcEntry) continue;

        const srcPath = srcEntry.path as string;
        const format = typeof srcEntry.format === "string" ? srcEntry.format : undefined;
        out[id] = {
            id,
            baseDir,
            source: {
                path: srcPath,
                format,
            },
            weight: typeof typed.weight === "string" ? typed.weight : undefined,
            style: typeof typed.style === "string" ? typed.style : undefined,
            size: typeof typed.size === "string" ? typed.size : undefined,
        };
    }

    const defaultFontId = Object.keys(out)[0];
    return { fonts: out, defaultFontId };
}

function parseThemeSection(section: unknown, baseDir: string): ParsedIconTheme {
    if (!section || typeof section !== "object") return { ...EMPTY_THEME };
    const raw = section as Record<string, unknown>;
    const iconDefinitions: Record<string, IconDefinition> = {};
    const defs = raw.iconDefinitions;
    if (defs && typeof defs === "object") {
        for (const [iconId, def] of Object.entries(defs as Record<string, unknown>)) {
            if (!def || typeof def !== "object") continue;
            const typed = def as Record<string, unknown>;
            const iconPath = typeof typed.iconPath === "string" ? typed.iconPath : undefined;
            const fontCharacter =
                typeof typed.fontCharacter === "string" ? typed.fontCharacter : undefined;
            const fontColor = typeof typed.fontColor === "string" ? typed.fontColor : undefined;
            const fontId = typeof typed.fontId === "string" ? typed.fontId : undefined;
            if (!iconPath && !fontCharacter) continue;
            iconDefinitions[iconId] = {
                iconPath,
                fontCharacter,
                fontColor,
                fontId,
                baseDir,
            };
        }
    }

    const parsedFonts = parseFonts(raw, baseDir);
    return {
        iconDefinitions,
        file: typeof raw.file === "string" ? raw.file : undefined,
        folder: typeof raw.folder === "string" ? raw.folder : undefined,
        folderExpanded: typeof raw.folderExpanded === "string" ? raw.folderExpanded : undefined,
        rootFolder: typeof raw.rootFolder === "string" ? raw.rootFolder : undefined,
        rootFolderExpanded:
            typeof raw.rootFolderExpanded === "string" ? raw.rootFolderExpanded : undefined,
        fileExtensions: normalizeMap(raw.fileExtensions),
        fileNames: normalizeMap(raw.fileNames),
        languageIds: normalizeMap(raw.languageIds),
        folderNames: normalizeMap(raw.folderNames),
        folderNamesExpanded: normalizeMap(raw.folderNamesExpanded),
        fonts: parsedFonts.fonts,
        defaultFontId: parsedFonts.defaultFontId,
    };
}

function mergeTheme(base: ParsedIconTheme, overlay: ParsedIconTheme): ParsedIconTheme {
    return {
        iconDefinitions: { ...base.iconDefinitions, ...overlay.iconDefinitions },
        file: overlay.file ?? base.file,
        folder: overlay.folder ?? base.folder,
        folderExpanded: overlay.folderExpanded ?? base.folderExpanded,
        rootFolder: overlay.rootFolder ?? base.rootFolder,
        rootFolderExpanded: overlay.rootFolderExpanded ?? base.rootFolderExpanded,
        fileExtensions: { ...base.fileExtensions, ...overlay.fileExtensions },
        fileNames: { ...base.fileNames, ...overlay.fileNames },
        languageIds: { ...base.languageIds, ...overlay.languageIds },
        folderNames: { ...base.folderNames, ...overlay.folderNames },
        folderNamesExpanded: { ...base.folderNamesExpanded, ...overlay.folderNamesExpanded },
        fonts: { ...base.fonts, ...overlay.fonts },
        defaultFontId: overlay.defaultFontId ?? base.defaultFontId,
    };
}

function tryParseJson(text: string): Record<string, unknown> | null {
    try {
        return parseJsonc(text) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function resolveExtendsPath(themePath: string, extendsValue: string): string {
    return path.resolve(path.dirname(themePath), extendsValue);
}

function createFileUri(filePath: string): vscode.Uri | null {
    const uriFactory = vscode.Uri as unknown as { file?: (v: string) => vscode.Uri };
    if (typeof uriFactory.file === "function") return uriFactory.file(filePath);
    return { fsPath: filePath, path: filePath } as unknown as vscode.Uri;
}

function pickVariantSection(
    raw: Record<string, unknown>,
    kind: vscode.ColorThemeKind,
): Record<string, unknown> | null {
    if (kind === vscode.ColorThemeKind.Light) {
        const light = raw.light;
        return light && typeof light === "object" ? (light as Record<string, unknown>) : null;
    }
    if (
        kind === vscode.ColorThemeKind.HighContrast ||
        kind === vscode.ColorThemeKind.HighContrastLight
    ) {
        const highContrast = raw.highContrast;
        return highContrast && typeof highContrast === "object"
            ? (highContrast as Record<string, unknown>)
            : null;
    }
    return null;
}

async function loadThemeRecursive(
    themeFilePath: string,
    colorThemeKind: vscode.ColorThemeKind,
    visited: Set<string>,
): Promise<ParsedIconTheme> {
    const normalizedPath = path.resolve(themeFilePath);
    if (visited.has(normalizedPath)) return { ...EMPTY_THEME };
    visited.add(normalizedPath);

    const rawText = await fs.readFile(normalizedPath, "utf8");
    const rawTheme = tryParseJson(rawText);
    if (!rawTheme) return { ...EMPTY_THEME };

    let merged = { ...EMPTY_THEME };
    if (typeof rawTheme.extends === "string") {
        const parentPath = resolveExtendsPath(normalizedPath, rawTheme.extends);
        const parentTheme = await loadThemeRecursive(parentPath, colorThemeKind, visited);
        merged = mergeTheme(merged, parentTheme);
    }

    merged = mergeTheme(merged, parseThemeSection(rawTheme, path.dirname(normalizedPath)));
    const variant = pickVariantSection(rawTheme, colorThemeKind);
    if (variant) {
        merged = mergeTheme(merged, parseThemeSection(variant, path.dirname(normalizedPath)));
    }
    return merged;
}

function decodeFontCharacter(raw: string): string | undefined {
    const value = raw.trim();
    const slashHexMatch = value.match(/^\\([a-fA-F0-9]+)$/);
    if (slashHexMatch) {
        const codePoint = Number.parseInt(slashHexMatch[1], 16);
        if (Number.isFinite(codePoint)) return String.fromCodePoint(codePoint);
    }

    const unicodeMatch = value.match(/^\\u([a-fA-F0-9]{4})$/);
    if (unicodeMatch) {
        const codePoint = Number.parseInt(unicodeMatch[1], 16);
        if (Number.isFinite(codePoint)) return String.fromCodePoint(codePoint);
    }

    return value.length > 0 ? value : undefined;
}

function sanitizeFontToken(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class FileIconThemeResolver {
    private languageCache:
        | {
              byExtension: Map<string, string>;
              byFilename: Map<string, string>;
          }
        | undefined;

    private themeCache:
        | {
              key: string;
              parsed: ParsedIconTheme;
              themeId: string;
          }
        | undefined;

    constructor(private readonly webview: vscode.Webview) {}

    private resolveConfiguredThemeId(): string | undefined {
        const config = vscode.workspace.getConfiguration("workbench");
        const direct = config.get<string | null>("iconTheme");
        if (typeof direct === "string" && direct.trim().length > 0) {
            return direct.trim();
        }

        const inspected = config.inspect<string | null>("iconTheme");
        const candidates = [
            inspected?.workspaceFolderValue,
            inspected?.workspaceValue,
            inspected?.globalValue,
            inspected?.defaultValue,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return candidate.trim();
            }
        }

        return "vs-seti";
    }

    private async resolveThemeContribution(): Promise<{
        extensionPath: string;
        contribution: IconThemeContribution;
        themeId: string;
    } | null> {
        try {
            const themeId = this.resolveConfiguredThemeId();
            if (!themeId) return null;
            const allExtensions = (
                vscode.extensions as unknown as { all?: vscode.Extension<unknown>[] }
            ).all;
            if (!Array.isArray(allExtensions)) return null;

            for (const ext of allExtensions) {
                const iconThemes = (
                    ext.packageJSON as {
                        contributes?: { iconThemes?: IconThemeContribution[] };
                    }
                )?.contributes?.iconThemes;
                if (!Array.isArray(iconThemes)) continue;
                const matched = iconThemes.find((theme) => theme.id === themeId);
                if (matched) {
                    return {
                        extensionPath: ext.extensionPath,
                        contribution: matched,
                        themeId,
                    };
                }
            }
        } catch {
            return null;
        }
        return null;
    }

    private async getParsedTheme(): Promise<{ themeId: string; parsed: ParsedIconTheme } | null> {
        const contribution = await this.resolveThemeContribution();
        if (!contribution) return null;

        const key = [
            contribution.themeId,
            vscode.window.activeColorTheme.kind,
            contribution.extensionPath,
            contribution.contribution.path,
        ].join("|");
        if (this.themeCache?.key === key) {
            return { themeId: this.themeCache.themeId, parsed: this.themeCache.parsed };
        }

        const themeFilePath = path.resolve(
            contribution.extensionPath,
            contribution.contribution.path,
        );

        try {
            const parsed = await loadThemeRecursive(
                themeFilePath,
                vscode.window.activeColorTheme.kind,
                new Set<string>(),
            );
            this.themeCache = { key, parsed, themeId: contribution.themeId };
            return { themeId: contribution.themeId, parsed };
        } catch {
            return null;
        }
    }

    private getLanguageAssociations(): {
        byExtension: Map<string, string>;
        byFilename: Map<string, string>;
    } {
        if (this.languageCache) return this.languageCache;

        const byExtension = new Map<string, string>();
        const byFilename = new Map<string, string>();
        const allExtensions = (vscode.extensions as unknown as { all?: vscode.Extension<unknown>[] })
            .all;
        if (Array.isArray(allExtensions)) {
            for (const ext of allExtensions) {
                const contributedLanguages = (
                    ext.packageJSON as {
                        contributes?: {
                            languages?: Array<{
                                id?: string;
                                extensions?: string[];
                                filenames?: string[];
                            }>;
                        };
                    }
                )?.contributes?.languages;
                if (!Array.isArray(contributedLanguages)) continue;
                for (const language of contributedLanguages) {
                    if (!language || typeof language.id !== "string") continue;
                    const languageId = language.id.toLowerCase();

                    if (Array.isArray(language.extensions)) {
                        for (const extName of language.extensions) {
                            if (typeof extName !== "string") continue;
                            const key = extName.toLowerCase();
                            if (!key.startsWith(".")) continue;
                            if (!byExtension.has(key)) {
                                byExtension.set(key, languageId);
                            }
                        }
                    }

                    if (Array.isArray(language.filenames)) {
                        for (const filename of language.filenames) {
                            if (typeof filename !== "string") continue;
                            const key = filename.toLowerCase();
                            if (!byFilename.has(key)) {
                                byFilename.set(key, languageId);
                            }
                        }
                    }
                }
            }
        }

        this.languageCache = { byExtension, byFilename };
        return this.languageCache;
    }

    private resolveLanguageIdForPath(filePath: string): string | undefined {
        const { byExtension, byFilename } = this.getLanguageAssociations();
        const baseName = path.basename(filePath).toLowerCase();

        const byName = byFilename.get(baseName);
        if (byName) return byName;

        const dotPositions: number[] = [];
        for (let i = 0; i < baseName.length; i++) {
            if (baseName.charAt(i) === ".") dotPositions.push(i);
        }

        for (const dotIndex of dotPositions) {
            if (dotIndex >= baseName.length - 1) continue;
            const candidate = baseName.slice(dotIndex);
            const lang = byExtension.get(candidate);
            if (lang) return lang;
        }

        return undefined;
    }

    private toWebviewUri(filePath: string): string | undefined {
        const fileUri = createFileUri(filePath);
        if (!fileUri) return undefined;
        try {
            return this.webview.asWebviewUri(fileUri).toString();
        } catch {
            return undefined;
        }
    }

    private fontFamilyName(themeId: string, fontId: string): string {
        return `intelligit-theme-${sanitizeFontToken(themeId)}-${sanitizeFontToken(fontId)}`;
    }

    private resolveIcon(
        iconId: string | undefined,
        themeId: string,
        theme: ParsedIconTheme,
    ): ThemeTreeIcon | undefined {
        if (!iconId) return undefined;
        const definition = theme.iconDefinitions[iconId];
        if (!definition) return undefined;

        if (definition.iconPath) {
            const absolutePath = path.resolve(definition.baseDir, definition.iconPath);
            const uri = this.toWebviewUri(absolutePath);
            if (!uri) return undefined;
            return { uri };
        }

        if (definition.fontCharacter) {
            const glyph = decodeFontCharacter(definition.fontCharacter);
            if (!glyph) return undefined;
            const fontId = definition.fontId ?? theme.defaultFontId;
            const font = fontId ? theme.fonts[fontId] : undefined;
            return {
                glyph,
                color: definition.fontColor,
                fontFamily: fontId ? this.fontFamilyName(themeId, fontId) : undefined,
                fontSize: font?.size,
                fontWeight: font?.weight,
                fontStyle: font?.style,
            };
        }

        return undefined;
    }

    private resolveFileIconForPath(
        filePath: string,
        themeId: string,
        theme: ParsedIconTheme,
    ): ThemeTreeIcon | undefined {
        const baseName = path.basename(filePath).toLowerCase();

        const fileNameIcon = this.resolveIcon(theme.fileNames[baseName], themeId, theme);
        if (fileNameIcon) return fileNameIcon;

        const firstDot = baseName.indexOf(".");
        if (firstDot >= 0) {
            let ext = baseName.slice(firstDot + 1);
            while (ext.length > 0) {
                const icon = this.resolveIcon(theme.fileExtensions[ext], themeId, theme);
                if (icon) return icon;
                const nextDot = ext.indexOf(".");
                if (nextDot < 0) break;
                ext = ext.slice(nextDot + 1);
            }
        }

        const languageId = this.resolveLanguageIdForPath(filePath);
        if (languageId) {
            const languageIcon = this.resolveIcon(theme.languageIds[languageId], themeId, theme);
            if (languageIcon) return languageIcon;
        }

        return this.resolveIcon(theme.file, themeId, theme);
    }

    private resolveFolderIconForName(
        name: string,
        isExpanded: boolean,
        themeId: string,
        theme: ParsedIconTheme,
    ): ThemeTreeIcon | undefined {
        const key = name.trim().toLowerCase();
        if (!key) {
            const rootIconId = isExpanded
                ? theme.rootFolderExpanded ?? theme.folderExpanded
                : theme.rootFolder ?? theme.folder;
            return this.resolveIcon(rootIconId, themeId, theme);
        }

        const namedIconId = isExpanded
            ? theme.folderNamesExpanded[key] ??
              theme.folderNames[key] ??
              theme.folderExpanded ??
              theme.folder
            : theme.folderNames[key] ?? theme.folder;

        return this.resolveIcon(namedIconId, themeId, theme);
    }

    async decoratePathItems<T extends { path: string; icon?: ThemeTreeIcon }>(
        files: T[],
    ): Promise<T[]> {
        const resolved = await this.getParsedTheme();
        if (!resolved) return files;

        return files.map((file) => ({
            ...file,
            icon: this.resolveFileIconForPath(file.path, resolved.themeId, resolved.parsed),
        }));
    }

    async decorateWorkingFiles(files: WorkingFile[]): Promise<WorkingFile[]> {
        return this.decoratePathItems(files);
    }

    async decorateCommitFiles(files: CommitFile[]): Promise<CommitFile[]> {
        return this.decoratePathItems(files);
    }

    async getFolderIcons(): Promise<ThemeFolderIcons> {
        const resolved = await this.getParsedTheme();
        if (!resolved) return {};
        return {
            folderIcon: this.resolveIcon(resolved.parsed.folder, resolved.themeId, resolved.parsed),
            folderExpandedIcon: this.resolveIcon(
                resolved.parsed.folderExpanded,
                resolved.themeId,
                resolved.parsed,
            ),
        };
    }

    async getFolderIconsByName(folderNames: string[]): Promise<ThemeFolderIconMap> {
        const resolved = await this.getParsedTheme();
        if (!resolved) return {};

        const byName: ThemeFolderIconMap = {};
        const deduped = new Set<string>(
            folderNames
                .map((name) => name.trim().toLowerCase())
                .filter((name) => name.length > 0),
        );

        for (const name of deduped) {
            byName[name] = {
                collapsed: this.resolveFolderIconForName(
                    name,
                    false,
                    resolved.themeId,
                    resolved.parsed,
                ),
                expanded: this.resolveFolderIconForName(
                    name,
                    true,
                    resolved.themeId,
                    resolved.parsed,
                ),
            };
        }

        return byName;
    }

    async getThemeFonts(): Promise<ThemeIconFont[]> {
        const resolved = await this.getParsedTheme();
        if (!resolved) return [];

        const fonts: ThemeIconFont[] = [];
        for (const font of Object.values(resolved.parsed.fonts)) {
            const absolutePath = path.resolve(font.baseDir, font.source.path);
            const src = this.toWebviewUri(absolutePath);
            if (!src) continue;
            fonts.push({
                fontFamily: this.fontFamilyName(resolved.themeId, font.id),
                src,
                format: font.source.format,
                weight: font.weight,
                style: font.style,
            });
        }
        return fonts;
    }

    async getThemeResourceRootUri(): Promise<vscode.Uri | null> {
        const contribution = await this.resolveThemeContribution();
        if (!contribution) return null;
        return createFileUri(contribution.extensionPath);
    }
}
