import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { createWebviewBuildOptions, WEBVIEW_CONFIGS } from "../../../scripts/webviewConfigs.js";

/** Builds the actual bundle configuration without filesystem output. */
async function compile(entry: string, out: string, contents?: string) {
    const options = createWebviewBuildOptions({ entry, out, production: true });
    return build({
        ...options,
        ...(contents
            ? {
                  entryPoints: undefined,
                  stdin: { contents, resolveDir: process.cwd(), loader: "tsx" as const },
              }
            : {}),
        write: false,
        sourcemap: false,
        metafile: true,
    });
}

describe("shared React runtime", () => {
    it("exports one React identity and browser renderer under no-eval CSP", async () => {
        const runtime = await compile("react/shared/reactRuntime", "webview-react");
        const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
        vm.runInContext(runtime.outputFiles[0].text, context);
        const api = context.IntelliGitReact;
        expect(api.React.useState).toBeTypeOf("function");
        expect(api.Client.createRoot).toBeTypeOf("function");
        expect(api.JSX.jsx).toBeTypeOf("function");
        const consumer = await compile(
            "sentinel",
            "sentinel",
            'import React, {useState} from "react"; import {jsx} from "react/jsx-runtime"; import {createRoot} from "react-dom/client"; globalThis.__runtime = {React,useState,jsx,createRoot};',
        );
        vm.runInContext(consumer.outputFiles[0].text, context);
        expect(context.__runtime.React).toBe(api.React);
        expect(context.__runtime.useState).toBe(api.React.useState);
        expect(context.__runtime.jsx).toBe(api.JSX.jsx);
        expect(context.__runtime.createRoot).toBe(api.Client.createRoot);
    });
    it("keeps React and React DOM implementation out of every application bundle", async () => {
        for (const config of WEBVIEW_CONFIGS.filter(
            ({ out }) => !["webview-react", "webview-shiki"].includes(out),
        )) {
            const result = await compile(config.entry, config.out);
            expect(
                Object.keys(result.metafile!.inputs).filter((file) =>
                    /node_modules\/(react|react-dom)\//.test(file),
                ),
                config.out,
            ).toEqual([]);
        }
    }, 30_000);
});
