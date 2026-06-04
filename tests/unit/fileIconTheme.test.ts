import * as os from "os";
import * as path from "path";
import { promises as fsp } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface VscodeState {
    themeId?: string;
    colorThemeKind: number;
    extensionsAll: Array<{ extensionPath: string; packageJSON: unknown }>;
    extensionChangeListener?: () => void;
    extensionDisposeCount: number;
}

async function loadResolver(state: VscodeState): Promise<
    typeof import("../../src/utils/fileIconTheme")
> {
    class FakeUri {
        readonly path: string;
        readonly scheme: string;

        constructor(public readonly fsPath: string, scheme = "file") {
            this.scheme = scheme;
            this.path = fsPath;
        }

        toString(): string {
            return `${this.scheme}:${this.path}`;
        }

        static file(filePath: string): FakeUri {
            if (filePath === "throw://bad") throw new Error("bad uri");
            return new FakeUri(filePath, "file");
        }
    }

    vi.resetModules();
    vi.doMock("vscode", () => ({
        Uri: FakeUri,
        ColorThemeKind: {
            Light: 1,
            Dark: 2,
            HighContrast: 3,
            HighContrastLight: 4,
        },
        window: {
            get activeColorTheme() {
                return { kind: state.colorThemeKind };
            },
        },
        workspace: {
            getConfiguration: (section: string) => ({
                get: (key: string) =>
                    section === "workbench" && key === "iconTheme" ? state.themeId : undefined,
                inspect: () => ({
                    workspaceFolderValue: undefined,
                    workspaceValue: undefined,
                    globalValue: state.themeId,
                    defaultValue: undefined,
                }),
            }),
        },
        extensions: {
            get all() {
                return state.extensionsAll;
            },
            onDidChange: (listener: () => void) => {
                state.extensionChangeListener = listener;
                return {
                    dispose: () => {
                        state.extensionDisposeCount += 1;
                    },
                };
            },
        },
    }));
    return import("../../src/utils/fileIconTheme");
}

function makeState(): VscodeState {
    return {
        colorThemeKind: 1,
        extensionsAll: [],
        extensionDisposeCount: 0,
    };
}

function makeWebview() {
    return {
        asWebviewUri: (uri: { fsPath: string }) => ({
            toString: () => `webview:${uri.fsPath}`,
        }),
    };
}

describe("FileIconThemeResolver", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unmock("vscode");
    });

    it("loads contributed icon themes, resolves file/folder/font icons, and exposes resource roots", async () => {
        const extensionPath = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-icon-theme-"));
        try {
            const themeDir = path.join(extensionPath, "themes");
            await fsp.mkdir(themeDir, { recursive: true });
            await fsp.writeFile(
                path.join(themeDir, "parent.json"),
                JSON.stringify({
                    iconDefinitions: {
                        _file: { iconPath: "./file.svg" },
                        _folder: {
                            fontCharacter: "\\e001",
                            fontColor: "#cccccc",
                            fontId: "custom",
                        },
                        _folderOpen: { fontCharacter: "\\uE002", fontId: "custom" },
                        _ts: { fontCharacter: "T", fontColor: "#3178c6", fontId: "custom" },
                        _config: { iconPath: "./config.svg" },
                        _root: { fontCharacter: "R" },
                    },
                    fonts: [
                        {
                            id: "custom",
                            src: [
                                { path: "icons.otf", format: "opentype" },
                                { path: "icons.woff2", format: "woff2" },
                            ],
                            weight: "400",
                            style: "normal",
                            size: "16px",
                        },
                    ],
                    file: "_file",
                    folder: "_folder",
                    folderExpanded: "_folderOpen",
                    rootFolderNames: { repo: "_root" },
                    fileExtensions: { ts: "_ts" },
                    fileNames: { "package.json": "_config" },
                    folderNames: { src: "_folder" },
                }),
                "utf8",
            );
            await fsp.writeFile(
                path.join(themeDir, "theme.json"),
                JSON.stringify({
                    extends: "./parent.json",
                    light: {
                        fileExtensions: { tsx: "_ts" },
                        folderNamesExpanded: { src: "_folderOpen" },
                    },
                }),
                "utf8",
            );

            const state = makeState();
            state.themeId = "test-theme";
            state.extensionsAll = [
                {
                    extensionPath,
                    packageJSON: {
                        contributes: {
                            iconThemes: [{ id: "test-theme", path: "themes/theme.json" }],
                            languages: [
                                { id: "typescriptreact", extensions: [".tsx"], filenames: ["Dockerfile"] },
                            ],
                        },
                    },
                },
            ];
            const { FileIconThemeResolver } = await loadResolver(state);

            const resolver = new FileIconThemeResolver(makeWebview() as never);
            const decorated = await resolver.decorateWorkingFiles([
                { path: "src/App.ts", status: "M", staged: false, additions: 1, deletions: 0 },
                { path: "src/App.tsx", status: "M", staged: false, additions: 1, deletions: 0 },
                { path: "package.json", status: "A", staged: true, additions: 2, deletions: 0 },
                { path: "README", status: "?", staged: false, additions: 0, deletions: 0 },
            ]);

            expect(decorated[0].icon).toMatchObject({
                glyph: "T",
                color: "#3178c6",
                fontFamily: "intelligit-theme-test-theme-custom",
                fontSize: "16px",
                fontWeight: "400",
                fontStyle: "normal",
            });
            expect(decorated[1].icon).toMatchObject({ glyph: "T" });
            expect(decorated[2].icon).toMatchObject({ uri: expect.stringContaining("config.svg") });
            expect(decorated[3].icon).toMatchObject({ uri: expect.stringContaining("file.svg") });

            await expect(resolver.getFolderIcons()).resolves.toEqual({
                folderIcon: expect.objectContaining({ glyph: "" }),
                folderExpandedIcon: expect.objectContaining({ glyph: "" }),
            });
            await expect(resolver.getFolderIconsByName(["src", "repo", "nested / components", ""])).resolves.toEqual(
                expect.objectContaining({
                    src: {
                        collapsed: expect.objectContaining({ glyph: "" }),
                        expanded: expect.objectContaining({ glyph: "" }),
                    },
                    repo: {
                        collapsed: expect.objectContaining({ glyph: "R" }),
                        expanded: expect.objectContaining({ glyph: "R" }),
                    },
                    "nested / components": {
                        collapsed: expect.objectContaining({ glyph: "" }),
                        expanded: expect.objectContaining({ glyph: "" }),
                    },
                }),
            );
            await expect(resolver.getThemeFonts()).resolves.toEqual([
                expect.objectContaining({
                    fontFamily: "intelligit-theme-test-theme-custom",
                    src: expect.stringContaining("icons.woff2"),
                    format: "woff2",
                    weight: "400",
                    style: "normal",
                }),
            ]);
            expect(resolver.getThemeResourceRootUri()?.fsPath).toBe(extensionPath);

            state.extensionChangeListener?.();
            resolver.dispose();
            expect(state.extensionDisposeCount).toBe(1);
        } finally {
            await fsp.rm(extensionPath, { recursive: true, force: true });
        }
    });

    it("gracefully preserves input when no usable icon theme is configured", async () => {
        const state = makeState();
        const { FileIconThemeResolver } = await loadResolver(state);
        const resolver = new FileIconThemeResolver(makeWebview() as never);
        const files = [
            { path: "src/a.ts", status: "M" as const, staged: false, additions: 1, deletions: 0 },
        ];

        await expect(resolver.decorateWorkingFiles(files)).resolves.toBe(files);
        await expect(resolver.getFolderIcons()).resolves.toEqual({});
        await expect(resolver.getFolderIconsByName(["src"])).resolves.toEqual({});
        await expect(resolver.getThemeFonts()).resolves.toEqual([]);
        expect(resolver.getThemeResourceRootUri()).toBeNull();
    });
});
