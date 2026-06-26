import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

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
                    markdownDescription?: string;
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

    it("contributes graph git actions to the native sidebar view title", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
        ) as ExtensionManifest;
        const commands = manifest.contributes?.commands ?? [];
        const commandPalette = manifest.contributes?.menus?.commandPalette ?? [];
        const titleMenu = manifest.contributes?.menus?.["view/title"] ?? [];

        const actions = [
            ["intelligit.graph.sync", "navigation@1", "media/icons/git-sync-white.svg"],
            ["intelligit.graph.fetch", "navigation@2", "media/icons/git-fetch-white.svg"],
            ["intelligit.graph.pull", "navigation@3", "media/icons/git-pull-white.svg"],
            ["intelligit.graph.push", "navigation@4", "media/icons/git-push-white.svg"],
        ] as const;

        for (const [command, group, icon] of actions) {
            const item = titleMenu.find((entry) => entry.command === command);
            const commandContribution = commands.find((entry) => entry.command === command);
            const paletteItem = commandPalette.find((entry) => entry.command === command);

            expect(item?.when).toBe("view == intelligit.sidebarGraph");
            expect(item?.group).toBe(group);
            expect(commandContribution?.icon).toEqual({ light: icon, dark: icon });
            expect(paletteItem?.when).toBe("false");
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

        expect(setting?.type).toBe("boolean");
        expect(setting?.default).toBe(true);
        expect(setting?.markdownDescription).toBe(
            "%configuration.undockableWindowButtonVisability.markdownDescription%",
        );
        expect(undockButton?.when).toBe(
            "view == intelligit.commitGraph && config.intelligit.undockableWindowButtonVisability",
        );
    });
});
