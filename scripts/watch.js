// esbuild watch mode for development. Rebuilds on file changes for both
// the extension host and webview bundles.

const esbuild = require("esbuild");
const path = require("path");
const { WEBVIEW_CONFIGS } = require("./webviewConfigs");

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

    for (const webview of WEBVIEW_CONFIGS.map(({ entry, out }) => ({
        name: out.replace(/^webview-/, ""),
        entry: `../src/webviews/${entry}.tsx`,
        out: `../dist/${out}.js`,
    }))) {
        const ctx = await esbuild.context({
            entryPoints: [path.resolve(__dirname, webview.entry)],
            bundle: true,
            outfile: path.resolve(__dirname, webview.out),
            format: "esm",
            platform: "browser",
            target: "es2022",
            sourcemap: true,
        });
        await ctx.watch();
        console.log(`Watching webview: ${webview.name}`);
    }
}

watch().catch((err) => {
    console.error(err);
    process.exit(1);
});
