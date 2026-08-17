import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { TOOLBAR_ICON_ACCENTS } from "../../../src/webviews/react/shared/tokens";

/**
 * The light-theme counterpart of a title-bar icon, and proof it ships.
 *
 * VS Code paints `icon` contributions as images, not masks, so it never
 * recolors them: a white glyph stays white on a light title bar, and a
 * dark-tuned accent keeps its dark-tuned lightness. Every family therefore
 * ships two files — `-white` pairs with `-ink`, `-color` with `-color-light` —
 * and pointing both manifest entries at the same file is the bug this guards.
 */
function expectLightVariant(darkIcon: string): string {
    const light = darkIcon.endsWith("-white.svg")
        ? darkIcon.replace(/-white\.svg$/, "-ink.svg")
        : darkIcon.replace(/-color\.svg$/, "-color-light.svg");
    expect(light).not.toBe(darkIcon);
    expect(existsSync(path.join(process.cwd(), light))).toBe(true);
    return light;
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colors. */
function contrastRatio(a: string, b: string): number {
    const luminance = (hex: string): number => {
        const [r, g, b2] = [1, 3, 5].map((i) => {
            const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

type WebviewContextMenuItem = {
    command?: string;
    when?: string;
    group?: string;
};

type CommandContribution = {
    command?: string;
    icon?: string | { light: string; dark: string };
};

type ExtensionManifest = {
    activationEvents?: string[];
    contributes?: {
        commands?: CommandContribution[];
        menus?: {
            commandPalette?: WebviewContextMenuItem[];
            "webview/context"?: WebviewContextMenuItem[];
            "view/title"?: WebviewContextMenuItem[];
        };
        configuration?: {
            properties?: Record<
                string,
                {
                    type?: string;
                    default?: unknown;
                    scope?: string;
                    markdownDescription?: string;
                    properties?: Record<string, { type?: string; default?: unknown }>;
                }
            >;
        };
    };
};

describe("extension manifest", () => {
    it("contributes commit file context actions to the undocked webview", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const contextMenu = manifest.contributes?.menus?.["webview/context"] ?? [];
        const commitFileCommands = [
            "intelligit.commitFileCompareWithLocal",
            "intelligit.commitFileCherryPickChange",
            "intelligit.commitFileRevertChange",
        ];

        for (const command of commitFileCommands) {
            const item = contextMenu.find((entry) => entry.command === command);
            expect(item?.when).toContain("webviewId == 'intelligit.commitGraph'");
            expect(item?.when).toContain("webviewId == 'intelligit.commitFiles'");
            expect(item?.when).toContain("webviewId == 'intelligit.undocked'");
            expect(item?.when).toContain("webviewSection == 'commitInfoFile'");
        }
    });

    it("limits ignored commit-panel file context actions to delete and refresh", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const commands = manifest.contributes?.commands ?? [];
        const contextMenu = manifest.contributes?.menus?.["webview/context"] ?? [];
        const itemFor = (command: string): WebviewContextMenuItem | undefined =>
            contextMenu.find((entry) => entry.command === command);

        expect(commands.some((entry) => entry.command === "intelligit.fileShowHistory")).toBe(
            false,
        );
        expect(commands.some((entry) => entry.command === "intelligit.fileRefreshing")).toBe(false);
        expect(itemFor("intelligit.fileShowHistory")).toBeUndefined();
        expect(itemFor("intelligit.fileDelete")?.when).toBe(
            "webviewId == 'intelligit.commitPanel' && webviewSection == 'file'",
        );
        expect(itemFor("intelligit.fileRefresh")?.when).toBe(
            "webviewId == 'intelligit.commitPanel' && webviewSection == 'file'",
        );
        expect(itemFor("intelligit.fileRefreshing")).toBeUndefined();

        for (const command of [
            "intelligit.fileRollback",
            "intelligit.fileJumpToSource",
            "intelligit.fileShelve",
        ]) {
            expect(itemFor(command)?.when).toContain("&& !webviewIgnoredFile");
        }
    });

    it("contributes graph git actions to the native sidebar view title", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const commands = manifest.contributes?.commands ?? [];
        const commandPalette = manifest.contributes?.menus?.commandPalette ?? [];
        const titleMenu = manifest.contributes?.menus?.["view/title"] ?? [];

        const actions = [
            [
                "intelligit.graph.sync",
                "intelligit.graph.sync.color",
                "navigation@1",
                "media/icons/git-sync-white.svg",
                "media/icons/git-sync-color.svg",
            ],
            [
                "intelligit.graph.fetch",
                "intelligit.graph.fetch.color",
                "navigation@2",
                "media/icons/git-fetch-white.svg",
                "media/icons/git-fetch-color.svg",
            ],
            [
                "intelligit.graph.pull",
                "intelligit.graph.pull.color",
                "navigation@3",
                "media/icons/git-pull-white.svg",
                "media/icons/git-pull-color.svg",
            ],
            [
                "intelligit.graph.push",
                "intelligit.graph.push.color",
                "navigation@4",
                "media/icons/git-push-white.svg",
                "media/icons/git-push-color.svg",
            ],
        ] as const;

        for (const [command, colorCommand, group, icon, colorIcon] of actions) {
            const item = titleMenu.find((entry) => entry.command === command);
            const colorItem = titleMenu.find((entry) => entry.command === colorCommand);
            const commandContribution = commands.find((entry) => entry.command === command);
            const colorCommandContribution = commands.find(
                (entry) => entry.command === colorCommand,
            );
            const paletteItem = commandPalette.find((entry) => entry.command === command);
            const colorPaletteItem = commandPalette.find((entry) => entry.command === colorCommand);

            expect(item?.when).toBe(
                "view == intelligit.sidebarGraph && config.intelligit.icons != color",
            );
            expect(colorItem?.when).toBe(
                "view == intelligit.sidebarGraph && config.intelligit.icons == color",
            );
            expect(item?.group).toBe(group);
            expect(colorItem?.group).toBe(group);
            expect(commandContribution?.icon).toEqual({
                light: expectLightVariant(icon),
                dark: icon,
            });
            expect(colorCommandContribution?.icon).toEqual({
                light: expectLightVariant(colorIcon),
                dark: colorIcon,
            });
            expect(paletteItem?.when).toBe("false");
            expect(colorPaletteItem?.when).toBe("false");
        }

        const indicator = titleMenu.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator",
        );
        const colorIndicator = titleMenu.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator.color",
        );
        const indicatorContribution = commands.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator",
        );
        const colorIndicatorContribution = commands.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator.color",
        );
        const indicatorPalette = commandPalette.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator",
        );
        const colorIndicatorPalette = commandPalette.find(
            (entry) => entry.command === "intelligit.sidebarRepositoryIndicator.color",
        );

        expect(indicator).toBeUndefined();
        expect(colorIndicator).toBeUndefined();
        expect(indicatorContribution?.icon).toEqual({
            light: "media/icons/select-repository-ink.svg",
            dark: "media/icons/select-repository-white.svg",
        });
        expect(colorIndicatorContribution?.icon).toEqual({
            light: "media/icons/select-repository-color-light.svg",
            dark: "media/icons/select-repository-color.svg",
        });
        expect(indicatorPalette?.when).toBe("false");
        expect(colorIndicatorPalette?.when).toBe("false");
        expect(
            titleMenu.find(
                (entry) =>
                    entry.command === "intelligit.selectRepository" &&
                    entry.when?.includes("intelligit.sidebarGraph"),
            ),
        ).toBeUndefined();
        expect(
            titleMenu.find(
                (entry) =>
                    entry.command === "intelligit.selectRepository.color" &&
                    entry.when?.includes("intelligit.sidebarGraph"),
            ),
        ).toBeUndefined();
    });

    it("contributes color variants for native commit graph title actions", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const commands = manifest.contributes?.commands ?? [];
        const activationEvents = manifest.activationEvents ?? [];
        const commandPalette = manifest.contributes?.menus?.commandPalette ?? [];
        const titleMenu = manifest.contributes?.menus?.["view/title"] ?? [];

        const actions = [
            [
                "intelligit.refresh",
                "intelligit.refresh.color",
                "view == intelligit.commitGraph",
                "media/icons/refresh-white.svg",
                "media/icons/refresh-color.svg",
            ],
            [
                "intelligit.selectRepository",
                "intelligit.selectRepository.color",
                "view == intelligit.commitGraph",
                "media/icons/select-repository-white.svg",
                "media/icons/select-repository-color.svg",
            ],
            [
                "intelligit.openUndocked",
                "intelligit.openUndocked.color",
                "view == intelligit.commitGraph && config.intelligit.undockableWindowButtonVisability",
                "media/icons/undock-white.svg",
                "media/icons/undock-color.svg",
            ],
        ] as const;

        for (const [command, colorCommand, baseWhen, icon, colorIcon] of actions) {
            const item = titleMenu.find((entry) => entry.command === command);
            const colorItem = titleMenu.find((entry) => entry.command === colorCommand);
            const commandContribution = commands.find((entry) => entry.command === command);
            const colorCommandContribution = commands.find(
                (entry) => entry.command === colorCommand,
            );
            const colorPaletteItem = commandPalette.find((entry) => entry.command === colorCommand);

            expect(item?.when).toBe(`${baseWhen} && config.intelligit.icons != color`);
            expect(colorItem?.when).toBe(`${baseWhen} && config.intelligit.icons == color`);
            expect(item?.group).toBe("navigation");
            expect(colorItem?.group).toBe("navigation");
            expect(commandContribution?.icon).toEqual({
                light: expectLightVariant(icon),
                dark: icon,
            });
            expect(colorCommandContribution?.icon).toEqual({
                light: expectLightVariant(colorIcon),
                dark: colorIcon,
            });
            expect(colorPaletteItem?.when).toBe("false");
            expect(activationEvents).toContain(`onCommand:${command}`);
            expect(activationEvents).toContain(`onCommand:${colorCommand}`);
        }
    });

    it("keeps native sidebar color icons matching the commit tab toolbar icons", () => {
        const tabBarSource = readFileSync(
            path.join(process.cwd(), "src/webviews/react/commit-panel/components/TabBar.tsx"),
            "utf8",
        );
        const icons = [
            {
                name: "sync",
                color: "#c8a2ff",
                paths: [
                    "M13 2v4H9l1.55-1.55A4.4 4.4 0 0 0 3.9 6.2l-.94-.34A5.4 5.4 0 0 1 11.25 3.75L13 2zM3 14v-4h4l-1.55 1.55A4.4 4.4 0 0 0 12.1 9.8l.94.34a5.4 5.4 0 0 1-8.29 2.11L3 14z",
                ],
            },
            {
                name: "fetch",
                color: "#4ec7d6",
                paths: [
                    "M5 12.5h-.5a2.8 2.8 0 0 1-.35-5.58A4.1 4.1 0 0 1 12 5.8a2.9 2.9 0 0 1 .5 5.7H11",
                    "M8 6.7v5.6m-2.1-2L8 12.4l2.1-2.1",
                ],
            },
            {
                name: "pull",
                color: "#8fd5ff",
                paths: [
                    "M7.5 1h1v8.1l2.15-2.15.7.7L8 11 4.65 7.65l.7-.7L7.5 9.1V1z",
                    "M3 13h10v1H3v-1z",
                ],
            },
            {
                name: "push",
                color: "#a6e3a1",
                paths: [
                    "M8 1l3.35 3.35-.7.7L8.5 2.9V11h-1V2.9L5.35 5.05l-.7-.7L8 1z",
                    "M3 13h10v1H3v-1z",
                ],
            },
        ] as const;

        for (const icon of icons) {
            const labelNeedle = `label={t("common.${icon.name}")}`;
            const start = tabBarSource.indexOf(labelNeedle);
            expect(start).toBeGreaterThanOrEqual(0);
            const end = tabBarSource.indexOf("</GitActionButton>", start);
            expect(end).toBeGreaterThan(start);
            const iconBlock = tabBarSource.slice(start, end);
            const svg = readFileSync(
                path.join(process.cwd(), `media/icons/git-${icon.name}-color.svg`),
                "utf8",
            );
            const lightSvg = readFileSync(
                path.join(process.cwd(), `media/icons/git-${icon.name}-color-light.svg`),
                "utf8",
            );
            // The webview resolves its accent through a host token; the native icon is a
            // static file and cannot. They stay in sync through the token's fallback,
            // which is the value the dark-theme SVG paints. The tab bar names the
            // *action* rather than a hue, so reassigning an accent in
            // `TOOLBAR_ICON_ACCENTS` fails here until the native icon follows.
            expect(iconBlock).toContain(`color={TOOLBAR_ICON_ACCENTS.${icon.name}}`);
            expect(TOOLBAR_ICON_ACCENTS[icon.name]).toContain(icon.color);
            expect(svg).toContain(icon.color);
            // The light variant is a different file because a static SVG cannot follow
            // the theme. It has to clear 3:1 (WCAG 1.4.11) on the light title bar.
            const lightFill = lightSvg.match(/#[0-9a-f]{6}/)?.[0];
            expect(lightFill).toBeDefined();
            expect(contrastRatio(lightFill as string, "#f3f3f3")).toBeGreaterThanOrEqual(3);
            for (const pathData of icon.paths) {
                expect(iconBlock).toContain(`d="${pathData}"`);
                expect(svg).toContain(`d="${pathData}"`);
                expect(lightSvg).toContain(`d="${pathData}"`);
            }
        }
    });

    it("offers every host-config provider id in the commitChecks.hosts enum", () => {
        // The setting schema's enum is what VS Code validates user input against. If a
        // provider id is accepted by the runtime host-map normalizer but missing from this
        // enum, users get a red squiggle and cannot configure it. This guards that drift:
        // the manifest enum must list exactly the self-hosted (host-configurable) ids.
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const hostsSetting = manifest.contributes?.configuration?.properties?.[
            "intelligit.commitChecks.hosts"
        ] as { additionalProperties?: { enum?: string[] } } | undefined;
        const providerEnum = hostsSetting?.additionalProperties?.enum ?? [];

        expect(providerEnum).toContain("gitlab");
        expect(providerEnum).toContain("bitbucket-server");
        // Fixed-host SaaS ids must NOT be configurable here (mapping a host to them is
        // meaningless and the normalizer drops them).
        expect(providerEnum).not.toContain("github");
        expect(providerEnum).not.toContain("bitbucket-cloud");
        expect([...providerEnum].sort()).toEqual(["bitbucket-server", "gitlab"]);
    });

    it("contributes the commitChecks.enabled feature toggle as a window-scoped boolean", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const setting =
            manifest.contributes?.configuration?.properties?.["intelligit.commitChecks.enabled"];

        expect(setting?.type).toBe("boolean");
        expect(setting?.default).toBe(true);
        // Window scope: read once at activation, takes effect after a reload (like hosts).
        expect(setting?.scope).toBe("window");
        expect(setting?.markdownDescription).toBe(
            "%configuration.commitChecks.enabled.markdownDescription%",
        );
    });

    it("contributes a per-provider commitChecks.providers object defaulting all to true", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const setting =
            manifest.contributes?.configuration?.properties?.["intelligit.commitChecks.providers"];

        expect(setting?.type).toBe("object");
        expect(setting?.scope).toBe("window");
        // The default object must enable every provider id the runtime understands, so an
        // empty/absent setting and the documented default agree.
        expect(setting?.default).toEqual({
            github: true,
            gitlab: true,
            "bitbucket-cloud": true,
            "bitbucket-server": true,
        });
        expect(setting?.markdownDescription).toBe(
            "%configuration.commitChecks.providers.markdownDescription%",
        );
    });

    it("contributes a commitChecks.ciCdFilter string defaulting to empty (built-in pattern)", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const setting =
            manifest.contributes?.configuration?.properties?.["intelligit.commitChecks.ciCdFilter"];

        expect(setting?.type).toBe("string");
        expect(setting?.default).toBe("");
        expect(setting?.scope).toBe("window");
        expect(setting?.markdownDescription).toBe(
            "%configuration.commitChecks.ciCdFilter.markdownDescription%",
        );
    });

    it("defines manifest NLS keys for the three new commitChecks settings", () => {
        const nls = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.nls.json"), "utf8"),
        ) as Record<string, string>;

        for (const key of [
            "configuration.commitChecks.enabled.markdownDescription",
            "configuration.commitChecks.providers.markdownDescription",
            "configuration.commitChecks.ciCdFilter.markdownDescription",
        ]) {
            expect(typeof nls[key]).toBe("string");
            expect(nls[key].length).toBeGreaterThan(0);
        }
        // Each description must tell the user the value is read at activation.
        expect(nls["configuration.commitChecks.enabled.markdownDescription"]).toMatch(/reload/i);
    });

    it("keeps the commit-check badge refresh reachable from the Command Palette", () => {
        // The badge popover's only other recovery path is a window reload: refreshBadges
        // clears the coordinator cache and the per-origin rate-limit buckets, so a bucket
        // parked by a bad provider response is unstuck from here. It was registered but
        // never contributed, which is invisible -- the palette simply does not list it.
        //
        // Targeted rather than derived: "registered" and "contributed" are deliberately
        // different sets (the `.color` duplicates are contributed and hidden; plenty of
        // internal ids are registered and never shown), so no general rule separates them.
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const nls = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.nls.json"), "utf8"),
        ) as Record<string, string>;
        const id = "intelligit.commitChecks.refreshBadges";

        const contributed = (manifest.contributes?.commands ?? []).find(
            (entry) => entry.command === id,
        );
        expect(contributed?.title).toBe("%command.commitChecksRefreshBadges%");
        expect(nls["command.commitChecksRefreshBadges"]).toBeTruthy();
        expect(
            (manifest.contributes?.menus?.commandPalette ?? []).find(
                (entry) => entry.command === id,
            ),
        ).toBeUndefined();

        // Listing it in the palette means it can be invoked in every activation mode, so
        // each mode must own a handler. Without the two placeholders VS Code answers the
        // palette entry with "command not found" whenever no repository is open.
        for (const file of [
            "src/activation/repositoryMode.ts",
            "src/activation/onboarding.ts",
            "src/activation/noRepositoryMode.ts",
        ]) {
            expect(readFileSync(path.join(process.cwd(), file), "utf8")).toContain(`"${id}"`);
        }
    });

    it("gates the undock view title button with a visible-by-default setting", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const titleMenu = manifest.contributes?.menus?.["view/title"] ?? [];
        const setting =
            manifest.contributes?.configuration?.properties?.[
                "intelligit.undockableWindowButtonVisability"
            ];
        const undockButton = titleMenu.find((entry) => entry.command === "intelligit.openUndocked");
        const colorUndockButton = titleMenu.find(
            (entry) => entry.command === "intelligit.openUndocked.color",
        );

        expect(setting?.type).toBe("boolean");
        expect(setting?.default).toBe(true);
        expect(setting?.markdownDescription).toBe(
            "%configuration.undockableWindowButtonVisability.markdownDescription%",
        );
        expect(undockButton?.when).toBe(
            "view == intelligit.commitGraph && config.intelligit.undockableWindowButtonVisability && config.intelligit.icons != color",
        );
        expect(colorUndockButton?.when).toBe(
            "view == intelligit.commitGraph && config.intelligit.undockableWindowButtonVisability && config.intelligit.icons == color",
        );
    });
});
