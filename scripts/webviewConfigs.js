const path = require("path");

const WEBVIEW_CONFIGS = [
    { entry: "react/CommitGraphApp", out: "webview-commitgraph" },
    { entry: "react/CompactCommitGraphApp", out: "webview-compactcommitgraph" },
    { entry: "react/commit-panel/CommitPanelApp", out: "webview-commitpanel" },
    { entry: "react/CommitInfoApp", out: "webview-commitinfo" },
    { entry: "react/merge-editor/MergeEditorApp", out: "webview-mergeeditor" },
    {
        entry: "react/merge-conflicts-session/MergeConflictSessionApp",
        out: "webview-mergeconflictsession",
    },
    { entry: "react/UndockedApp", out: "webview-undocked" },
];

/**
 * Creates the shared IIFE esbuild options used by every browser webview bundle.
 *
 * @param {{entry: string, out: string, production?: boolean}} options Entry module
 *   and output name, with optional production minification.
 * @returns {import("esbuild").BuildOptions} Browser-safe bundled options.
 */
function createWebviewBuildOptions({ entry, out, production = false }) {
    return {
        entryPoints: [path.resolve(__dirname, `../src/webviews/${entry}.tsx`)],
        bundle: true,
        outfile: path.resolve(__dirname, `../dist/${out}.js`),
        format: "iife",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
        minify: production,
        treeShaking: true,
        define: {
            "process.env.NODE_ENV": production ? '"production"' : '"development"',
        },
    };
}

module.exports = { WEBVIEW_CONFIGS, createWebviewBuildOptions };
