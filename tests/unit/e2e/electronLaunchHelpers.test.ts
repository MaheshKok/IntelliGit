import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    seedProfileSettings,
    toElectronLaunchEnv,
} from "../../e2e/hostFixtures/electronLaunchHelpers";

describe("toElectronLaunchEnv", () => {
    it("drops undefined-valued keys instead of forwarding them to Electron", () => {
        const result = toElectronLaunchEnv({ PRESENT: "value", OMIT: undefined });

        expect(result).toEqual({ PRESENT: "value" });
        expect(Object.hasOwn(result, "OMIT")).toBe(false);
    });
});

describe("seedProfileSettings", () => {
    it("writes load-bearing shelf and modal settings into the profile", async () => {
        const userDataDir = await mkdtemp(path.join(tmpdir(), "intelligit-launch-settings-"));
        const shelfStoragePath = path.join(userDataDir, "seeded-shelf-storage", "shelves");
        try {
            await seedProfileSettings(userDataDir, undefined, shelfStoragePath);
            const settings = JSON.parse(
                await readFile(path.join(userDataDir, "User", "settings.json"), "utf8"),
            ) as Record<string, string | boolean>;

            expect(settings["intelligit.shelf.path"]).toBe(shelfStoragePath);
            expect(settings["workbench.startupEditor"]).toBe("none");
            // A native macOS dialog is invisible to Playwright; this assertion is the consumer that
            // fails if the custom workbench confirmation renderer is ever dropped from the harness.
            expect(settings["window.dialogStyle"]).toBe("custom");
        } finally {
            await rm(userDataDir, { recursive: true, force: true });
        }
    });
});
