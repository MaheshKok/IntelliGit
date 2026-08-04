// esbuild configuration for building the extension host bundle and webview bundles.
// Produces dist/extension.js (CJS for VS Code) and dist/webview-*.js (IIFE for webviews).

const esbuild = require("esbuild");
const path = require("path");
const { WEBVIEW_CONFIGS, createWebviewBuildOptions } = require("./webviewConfigs");

const extensionConfig = {
    entryPoints: [path.resolve(__dirname, "../src/extension.ts")],
    bundle: true,
    outfile: path.resolve(__dirname, "../dist/extension.js"),
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    minify: process.argv.includes("--production"),
    treeShaking: true,
    mainFields: ["module", "main"],
};

const editorHelperConfig = {
    entryPoints: [path.resolve(__dirname, "../src/git/interactiveRebase/editorHelper.ts")],
    bundle: true,
    outfile: path.resolve(__dirname, "../dist/interactive-rebase-editor-helper.cjs"),
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    minify: process.argv.includes("--production"),
    treeShaking: true,
};

/**
 * Returns the seven browser webview build options for the current build mode.
 *
 * @param {boolean} [production] Whether to minify and define production mode.
 * @returns {import("esbuild").BuildOptions[]} Shared IIFE options for each webview.
 */
function getWebviewBuildConfigs(production = process.argv.includes("--production")) {
    return WEBVIEW_CONFIGS.map(({ entry, out }) =>
        createWebviewBuildOptions({ entry, out, production }),
    );
}

/**
 * Builds the extension, editor helper, and every configured webview bundle.
 *
 * @returns {Promise<void>} Resolves after all available bundles are built.
 */
async function build() {
    try {
        await esbuild.build(extensionConfig);
        console.log("Extension bundle built.");

        await esbuild.build(editorHelperConfig);
        console.log("Interactive rebase editor helper built.");

        for (const config of getWebviewBuildConfigs()) {
            try {
                await esbuild.build(config);
                console.log(`Webview bundle built: ${config.outfile}`);
            } catch {
                // Webview entry may not exist yet in early phases
                console.log(`Skipped (not found): ${config.entryPoints[0]}`);
            }
        }

        console.log("Build complete.");
    } catch (error) {
        console.error("Build failed:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    build();
}

module.exports = { build, getWebviewBuildConfigs };
