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
    icon?: string;
};

type ExtensionManifest = {
    contributes?: {
        commands?: CommandContribution[];
        menus?: {
            commandPalette?: WebviewContextMenuItem[];
            "webview/context"?: WebviewContextMenuItem[];
            "view/title"?: WebviewContextMenuItem[];
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
            ["intelligit.graph.sync", "navigation@1", "$(sync)"],
            ["intelligit.graph.fetch", "navigation@2", "$(cloud-download)"],
            ["intelligit.graph.pull", "navigation@3", "$(arrow-down)"],
            ["intelligit.graph.push", "navigation@4", "$(cloud-upload)"],
        ] as const;

        for (const [command, group, icon] of actions) {
            const item = titleMenu.find((entry) => entry.command === command);
            const commandContribution = commands.find((entry) => entry.command === command);
            const paletteItem = commandPalette.find((entry) => entry.command === command);

            expect(item?.when).toBe("view == intelligit.sidebarGraph");
            expect(item?.group).toBe(group);
            expect(commandContribution?.icon).toBe(icon);
            expect(paletteItem?.when).toBe("false");
        }
    });
});
