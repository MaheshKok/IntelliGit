import os from "node:os";

import type { Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    captureVisualEnvironment,
    type FontListExecutor,
} from "../../../visual/playwright/captureVisualEnvironment";

function browserWithVersion(version: string): Browser {
    return {
        version: async () => version,
    } as unknown as Browser;
}

describe("captureVisualEnvironment", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns an empty font list when fc-list is missing", async () => {
        const execute: FontListExecutor = () => {
            throw new Error("fc-list: command not found");
        };

        vi.stubEnv("INTELLIGIT_BASE_IMAGE", "mcr.microsoft.com/playwright@sha256:test");

        const environment = await captureVisualEnvironment(
            browserWithVersion("141.0.7390.37"),
            execute,
        );

        expect(environment.baseImage).toBe("mcr.microsoft.com/playwright@sha256:test");
        expect(environment.browserVersion).toBe("141.0.7390.37");
        expect(environment.platform).toBe(`${process.platform}-${process.arch}`);
        expect(environment.osRelease).toBe(os.release());
        expect(environment.fonts).toEqual([]);
    });

    it("invokes fc-list for family names with a bounded UTF-8 execution", async () => {
        const calls: Array<{
            readonly file: string;
            readonly args: readonly string[];
            readonly options: { readonly encoding: "utf8"; readonly timeout: number };
        }> = [];
        const execute: FontListExecutor = (file, args, options) => {
            calls.push({ file, args: [...args], options });
            return "Arial\n";
        };

        await captureVisualEnvironment(browserWithVersion("141.0.7390.37"), execute);

        expect(calls).toEqual([
            {
                file: "fc-list",
                args: [":", "family"],
                options: { encoding: "utf8", timeout: 5_000 },
            },
        ]);
    });

    it("uses the outside-container sentinel when the base image is unset", async () => {
        vi.stubEnv("INTELLIGIT_BASE_IMAGE", "temporarily-set");
        delete process.env.INTELLIGIT_BASE_IMAGE;

        const environment = await captureVisualEnvironment(
            browserWithVersion("141.0.7390.37"),
            () => "Arial\n",
        );

        expect(environment.baseImage).toBe("<not-in-container>");
    });

    it("splits, trims, deduplicates, and sorts fontconfig aliases", async () => {
        const execute: FontListExecutor = () => "Noto Sans, Noto Sans CJK\nArial\nNoto Sans\n";

        const environment = await captureVisualEnvironment(
            browserWithVersion("139.0.7258.5"),
            execute,
        );

        expect(environment.fonts).toEqual(["Arial", "Noto Sans", "Noto Sans CJK"]);
    });

    it("unescapes fontconfig family names without splitting escaped commas", async () => {
        const execute: FontListExecutor = () => "Unifont\\-JP, Family\\, With Comma\n";

        const environment = await captureVisualEnvironment(
            browserWithVersion("141.0.7390.37"),
            execute,
        );

        expect(environment.fonts).toEqual(["Family, With Comma", "Unifont-JP"]);
    });
});
