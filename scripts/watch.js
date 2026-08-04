// esbuild watch mode for development. Rebuilds on file changes for both
// the extension host and webview bundles.

const esbuild = require("esbuild");
const path = require("path");
const { WEBVIEW_CONFIGS, createWebviewBuildOptions } = require("./webviewConfigs");

/**
 * Returns the seven browser webview build options used by watch mode.
 *
 * @returns {import("esbuild").BuildOptions[]} Shared IIFE options for each webview.
 */
function getWebviewWatchConfigs() {
    return WEBVIEW_CONFIGS.map(({ entry, out }) => createWebviewBuildOptions({ entry, out }));
}

/**
 * Starts esbuild watch contexts for the extension host, editor helper, and webviews.
 *
 * @returns {Promise<void>} Resolves after all watch contexts are active.
 */
async function watch() {
    const extensionCtx = await esbuild.context({
        entryPoints: [path.resolve(__dirname, "../src/extension.ts")],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/extension.js"),
        external: ["vscode"],
        format: "cjs",
        platform: "node",
        target: "node20",
        sourcemap: true,
    });

    await extensionCtx.watch();
    console.log("Watching extension...");

    const editorHelperCtx = await esbuild.context({
        entryPoints: [path.resolve(__dirname, "../src/git/interactiveRebase/editorHelper.ts")],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/interactive-rebase-editor-helper.cjs"),
        format: "cjs",
        platform: "node",
        target: "node20",
        sourcemap: true,
    });

    await editorHelperCtx.watch();
    console.log("Watching interactive rebase editor helper...");

    for (const webview of getWebviewWatchConfigs()) {
        const ctx = await esbuild.context(webview);
        await ctx.watch();
        console.log(
            `Watching webview: ${path.basename(webview.outfile, ".js").replace(/^webview-/, "")}`,
        );
    }
}

if (require.main === module) {
    watch().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { getWebviewWatchConfigs, watch };
