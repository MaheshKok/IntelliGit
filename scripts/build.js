// esbuild configuration for building the extension host bundle and webview bundles.
// Produces dist/extension.js (CJS for VS Code) and dist/webview-*.js (ESM for webviews).

const esbuild = require("esbuild");
const path = require("path");

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
};

const webviewConfigs = [
    { entry: "react/CommitGraphApp", out: "webview-commitgraph" },
    { entry: "react/commit-panel/CommitPanelApp", out: "webview-commitpanel" },
    { entry: "react/CommitInfoApp", out: "webview-commitinfo" },
].map(({ entry, out }) => ({
    entryPoints: [path.resolve(__dirname, `../src/webviews/${entry}.tsx`)],
    bundle: true,
    outfile: path.resolve(__dirname, `../dist/${out}.js`),
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    minify: process.argv.includes("--production"),
    treeShaking: true,
    define: {
        "process.env.NODE_ENV": process.argv.includes("--production")
            ? '"production"'
            : '"development"',
    },
}));

async function build() {
    try {
        await esbuild.build(extensionConfig);
        console.log("Extension bundle built.");

        for (const config of webviewConfigs) {
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

build();
