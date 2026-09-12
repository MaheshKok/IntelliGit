import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { getWebviewBuildConfigs } from "../../../scripts/build.js";

describe("shared highlighter packaging", () => {
    it("preserves every bundled grammar's complete data and frozen objects", async () => {
        const config = getWebviewBuildConfigs(true).find(({ outfile }) =>
            outfile.endsWith("webview-shiki.js"),
        )!;
        for (const language of [
            "javascript",
            "typescript",
            "jsx",
            "tsx",
            "json",
            "python",
            "go",
            "css",
            "html",
            "yaml",
            "shell",
            "markdown",
        ]) {
            const original = await import(/* @vite-ignore */ `@shikijs/langs/${language}`);
            const result = await build({
                ...config,
                entryPoints: undefined,
                stdin: {
                    contents: `export { default } from "@shikijs/langs/${language}";`,
                    resolveDir: process.cwd(),
                    loader: "js",
                },
                globalName: "IntelliGitGrammar",
                write: false,
                sourcemap: false,
            });
            const context = vm.createContext(
                {},
                { codeGeneration: { strings: false, wasm: false } },
            );
            vm.runInContext(result.outputFiles[0].text, context);
            const actual = context.IntelliGitGrammar.default;
            expect(JSON.stringify(actual), language).toBe(JSON.stringify(original.default));
            expect(actual.map(Object.isFrozen), language).toEqual(
                original.default.map(Object.isFrozen),
            );
        }
    });

    it("bundles the full grammar runtime once and keeps all three consumers within their budgets", async () => {
        const configs = getWebviewBuildConfigs(true).filter(({ outfile }) =>
            /webview-(?:shiki|diffviewer|mergeeditor|filehistory)\.js$/.test(outfile),
        );
        expect(configs).toHaveLength(4);
        const results = await Promise.all(
            configs.map((config) =>
                build({
                    ...config,
                    write: false,
                    sourcemap: false,
                    metafile: true,
                }),
            ),
        );
        let totalBytes = 0;
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const js = result.outputFiles.find(({ path }) => path.endsWith(".js"))!;
            totalBytes += js.contents.length;
            expect(js.contents.length).toBeLessThan(2 * 1024 * 1024);
            const grammarInputs = Object.keys(result.metafile!.inputs).filter((path) =>
                path.includes("@shikijs/langs/"),
            );
            if (configs[index].outfile.endsWith("webview-shiki.js")) {
                expect(grammarInputs.map((path) => path.split("/").at(-1))).toEqual(
                    expect.arrayContaining([
                        "javascript.mjs",
                        "typescript.mjs",
                        "jsx.mjs",
                        "tsx.mjs",
                        "json.mjs",
                        "python.mjs",
                        "go.mjs",
                        "css.mjs",
                        "html.mjs",
                        "yaml.mjs",
                        "shellscript.mjs",
                        "markdown.mjs",
                    ]),
                );
            } else {
                expect(grammarInputs).toEqual([]);
                expect(
                    Object.keys(result.metafile!.inputs).some((path) =>
                        path.endsWith("diff-core/shikiHighlighter.ts"),
                    ),
                ).toBe(false);
            }
        }
        expect(totalBytes).toBeLessThan(2 * 1024 * 1024);
    }, 30_000);

    it("runs the unchanged highlighting API under a no-eval/no-wasm context for every language and theme", async () => {
        const config = getWebviewBuildConfigs(true).find(({ outfile }) =>
            outfile.endsWith("webview-shiki.js"),
        );
        expect(config).toBeDefined();
        const result = await build({ ...config!, write: false, sourcemap: false });
        const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
        vm.runInContext(result.outputFiles[0].text, context);
        const api = context.IntelliGitSyntax;
        expect(Object.keys(api).sort()).toEqual([
            "detectTheme",
            "highlightLine",
            "initShiki",
            "isShikiReady",
            "langForPath",
        ]);
        expect(api.initShiki()).toBe(true);
        expect(api.initShiki()).toBe(false);
        expect(api.isShikiReady()).toBe(true);
        for (const extension of [
            "js",
            "ts",
            "jsx",
            "tsx",
            "json",
            "py",
            "go",
            "css",
            "html",
            "yaml",
            "sh",
            "md",
        ]) {
            const language = api.langForPath(`sample.${extension}`);
            expect(language).not.toBeNull();
            for (const theme of ["dark-plus", "light-plus"]) {
                const tokens = api.highlightLine("const value = 42;", language, theme);
                expect(tokens, `${extension} ${theme}`).not.toBeNull();
                expect(tokens.map((token: { text: string }) => token.text).join("")).toBe(
                    "const value = 42;",
                );
                expect(tokens.some((token: { color?: string }) => Boolean(token.color))).toBe(true);
            }
        }
    }, 30_000);
});
