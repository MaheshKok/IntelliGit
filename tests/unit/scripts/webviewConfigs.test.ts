import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { getWebviewBuildConfigs } from "../../../scripts/build.js";
import { getWebviewWatchConfigs } from "../../../scripts/watch.js";
import { createWebviewBuildOptions, WEBVIEW_CONFIGS } from "../../../scripts/webviewConfigs.js";

describe("webview bundle configuration", () => {
    it("derives ten build and watch configs including the shared highlighter", () => {
        const expectedConfigs = WEBVIEW_CONFIGS.map(({ entry, out }) => {
            const config = createWebviewBuildOptions({ entry, out });
            return {
                ...config,
                ...(config.plugins
                    ? {
                          plugins: config.plugins.map((plugin) => ({
                              name: plugin.name,
                              setup: expect.any(Function),
                          })),
                      }
                    : {}),
            };
        });

        expect(getWebviewBuildConfigs(false)).toEqual(expectedConfigs);
        expect(getWebviewWatchConfigs()).toEqual(expectedConfigs);
        expect(expectedConfigs).toHaveLength(10);
        expect(expectedConfigs.map(({ format }) => format)).toEqual(Array(10).fill("iife"));
    });

    it("keeps top-level webview variables out of the classic-script global scope", async () => {
        const {
            entryPoints: _entryPoints,
            outfile: _outfile,
            ...sharedOptions
        } = createWebviewBuildOptions({ entry: "sentinel", out: "sentinel" });
        const { outputFiles } = await build({
            ...sharedOptions,
            stdin: {
                contents: 'var top = "top"; globalThis.__sentinelTop = top;',
                resolveDir: process.cwd(),
            },
            write: false,
        });
        const globalScope: { __sentinelTop?: string } = {};
        Object.defineProperty(globalScope, "top", {
            configurable: false,
            get() {
                throw new Error("window.top read");
            },
            set() {
                throw new Error("window.top collision");
            },
        });

        expect(() => vm.runInNewContext(outputFiles[0].text, globalScope)).not.toThrow();
        expect(globalScope.__sentinelTop).toBe("top");
    });
});
