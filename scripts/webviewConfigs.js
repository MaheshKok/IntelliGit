const path = require("path");
const { readFile } = require("node:fs/promises");

const WEBVIEW_CONFIGS = [
    { entry: "react/diff-core/shikiHighlighter", out: "webview-shiki" },
    { entry: "react/CommitGraphApp", out: "webview-commitgraph" },
    { entry: "react/CompactCommitGraphApp", out: "webview-compactcommitgraph" },
    { entry: "react/commit-panel/CommitPanelApp", out: "webview-commitpanel" },
    { entry: "react/CommitInfoApp", out: "webview-commitinfo" },
    { entry: "react/merge-editor/MergeEditorApp", out: "webview-mergeeditor" },
    { entry: "react/diff-viewer/DiffViewerApp", out: "webview-diffviewer" },
    { entry: "react/file-history/FileHistoryApp", out: "webview-filehistory" },
    {
        entry: "react/merge-conflicts-session/MergeConflictSessionApp",
        out: "webview-mergeconflictsession",
    },
    { entry: "react/UndockedApp", out: "webview-undocked" },
];

// Substitute only the existing highlighter module in the three consuming apps.
// The shared classic script must execute before these bundles capture its API.
const sharedHighlighterPlugin = {
    name: "shared-shiki-highlighter",
    /**
     * Replaces the resolved highlighter module with the preloaded browser API.
     *
     * @param {import("esbuild").PluginBuild} build Active bundle's module resolver.
     * @returns {void} Registers the narrow module substitution.
     */
    setup(build) {
        const highlighterPath = path.resolve(
            __dirname,
            "../src/webviews/react/diff-core/shikiHighlighter",
        );
        build.onResolve({ filter: /(?:^|\/)shikiHighlighter(?:\.ts)?$/ }, (args) => {
            if (path.resolve(args.resolveDir, args.path).replace(/\.ts$/, "") === highlighterPath) {
                return { path: highlighterPath, namespace: "shared-shiki" };
            }
        });
        build.onLoad({ filter: /.*/, namespace: "shared-shiki" }, () => ({
            contents: "module.exports = globalThis.IntelliGitSyntax;",
            loader: "js",
        }));
    },
};

const grammarDataPlugin = {
    name: "shiki-grammar-data",
    /**
     * Decodes generated grammar JSON strings before minification to avoid shipping
     * their extra escaping; module exports and the grammar's Object.freeze remain.
     *
     * @param {import("esbuild").PluginBuild} build Active highlighter bundle loader.
     * @returns {void} Registers the installed grammar-data transformation.
     */
    setup(build) {
        build.onLoad({ filter: /@shikijs[\\/]langs[\\/]dist[\\/].*\.mjs$/ }, async (args) => ({
            contents: (await readFile(args.path, "utf8")).replace(
                /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/g,
                (_, literal) => JSON.parse(literal),
            ),
            loader: "js",
        }));
    },
};

/**
 * Creates the shared IIFE esbuild options used by every browser webview bundle.
 *
 * @param {{entry: string, out: string, production?: boolean}} options Entry module
 *   and output name, with optional production minification.
 * @returns {import("esbuild").BuildOptions} Browser-safe bundled options.
 */
function createWebviewBuildOptions({ entry, out, production = false }) {
    const sharedHighlighter = out === "webview-shiki";
    const consumesHighlighter = [
        "webview-diffviewer",
        "webview-mergeeditor",
        "webview-filehistory",
    ].includes(out);
    return {
        entryPoints: [
            path.resolve(__dirname, `../src/webviews/${entry}.${sharedHighlighter ? "ts" : "tsx"}`),
        ],
        bundle: true,
        outfile: path.resolve(__dirname, `../dist/${out}.js`),
        format: "iife",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
        minify: production,
        treeShaking: true,
        ...(sharedHighlighter
            ? { globalName: "IntelliGitSyntax", plugins: [grammarDataPlugin] }
            : {}),
        ...(consumesHighlighter ? { plugins: [sharedHighlighterPlugin] } : {}),
        define: {
            "process.env.NODE_ENV": production ? '"production"' : '"development"',
        },
    };
}

module.exports = { WEBVIEW_CONFIGS, createWebviewBuildOptions };
