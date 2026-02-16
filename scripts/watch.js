// esbuild watch mode for development. Rebuilds on file changes for both
// the extension host and webview bundles.

const esbuild = require("esbuild");
const path = require("path");

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

    const webviewCtx = await esbuild.context({
        entryPoints: [path.resolve(__dirname, "../src/webviews/react/CommitGraphApp.tsx")],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/webview-commitgraph.js"),
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
    });
    await webviewCtx.watch();
    console.log("Watching webview: commitgraph");

    const commitPanelCtx = await esbuild.context({
        entryPoints: [
            path.resolve(__dirname, "../src/webviews/react/commit-panel/CommitPanelApp.tsx"),
        ],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/webview-commitpanel.js"),
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
    });
    await commitPanelCtx.watch();
    console.log("Watching webview: commitpanel");

    const commitInfoCtx = await esbuild.context({
        entryPoints: [path.resolve(__dirname, "../src/webviews/react/CommitInfoApp.tsx")],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/webview-commitinfo.js"),
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
    });
    await commitInfoCtx.watch();
    console.log("Watching webview: commitinfo");
}

watch().catch((err) => {
    console.error(err);
    process.exit(1);
});
