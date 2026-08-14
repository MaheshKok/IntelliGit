// esbuild configuration for building the extension host bundle and webview bundles.
// Produces dist/extension.js (CJS for VS Code) and dist/webview-*.js (IIFE for webviews).
//
// Every declared output is provenance-tracked: dist/ is cleared before the build
// so a stale bundle from a previous invocation can never masquerade as an output
// of this one, and a manifest recording each output's content hash (see
// scripts/buildManifest.js) is written only after every build has succeeded. A
// webview entry that genuinely does not exist yet is skipped -- checked
// explicitly with fs.existsSync, never inferred from a caught exception. An
// esbuild failure for an entry that does exist is fatal and propagates: it must
// never be downgraded to "skipped, not found".

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { WEBVIEW_CONFIGS, createWebviewBuildOptions } = require("./webviewConfigs");
const { createManifest, writeManifest } = require("./buildManifest");

const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");

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
 * Runs one esbuild config and returns the declared output files it actually
 * wrote (the bundle and any sibling CSS chunk esbuild emitted for it -- not
 * source maps). The list comes from esbuild's own metafile rather than being
 * guessed from the config, so provenance always matches what esbuild really
 * produced for that invocation, including webviews that do or do not bundle
 * a CSS import.
 *
 * @param {import("esbuild").BuildOptions} config Build options for a single
 *   esbuild entry point.
 * @returns {Promise<string[]>} Absolute paths to the non-map outputs written.
 */
async function buildDeclaredOutputs(config) {
    // absWorkingDir is deliberately left unset so esbuild keeps resolving
    // config-relative concerns (e.g. tsconfig.json discovery, which walks up
    // from each entry point's own directory) exactly as it did before this
    // module started reading the metafile -- only the *return value* of this
    // function changed, not how esbuild itself behaves. Metafile output keys
    // are relative to esbuild's own default working directory (process.cwd()
    // when absWorkingDir is unset), so that is what they are resolved against.
    const result = await esbuild.build({ ...config, metafile: true });
    return Object.keys(result.metafile.outputs)
        .filter((outputPath) => !outputPath.endsWith(".map"))
        .map((outputPath) => path.resolve(process.cwd(), outputPath));
}

/**
 * Builds the extension, editor helper, and every configured webview bundle
 * into `distDir`, then writes a provenance manifest -- but only once every
 * build in this invocation has actually succeeded.
 *
 * `distDir` is fully cleared before anything is built, so a bundle left over
 * from an earlier, unrelated build can never survive a failed or partial
 * build: a build that fails partway leaves the remaining declared outputs
 * missing, never stale.
 *
 * A webview entry file that is genuinely absent (checked explicitly, not
 * inferred from a caught exception) is skipped and logged. An esbuild
 * failure for an entry that does exist is not caught here -- it propagates to
 * the caller as a rejected promise, which is the fatal case the caller must
 * treat as a build failure, never as "skipped".
 *
 * @param {object} input Build inputs.
 * @param {import("esbuild").BuildOptions} input.extensionConfig
 * @param {import("esbuild").BuildOptions} input.editorHelperConfig
 * @param {import("esbuild").BuildOptions[]} input.webviewConfigs
 * @param {string} input.distDir Absolute path to the build output directory.
 * @param {(message: string) => void} [input.log] Progress logger, defaults to
 *   console.log.
 * @returns {Promise<{outputs: string[], skipped: string[]}>} Absolute paths to
 *   every output written (`outputs`) and every webview entry point skipped
 *   because it did not exist (`skipped`).
 */
async function runBuild({
    extensionConfig: extConfig,
    editorHelperConfig: helperConfig,
    webviewConfigs,
    distDir,
    log = console.log,
}) {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    const outputs = [];
    const skipped = [];

    outputs.push(...(await buildDeclaredOutputs(extConfig)));
    log("Extension bundle built.");

    outputs.push(...(await buildDeclaredOutputs(helperConfig)));
    log("Interactive rebase editor helper built.");

    for (const config of webviewConfigs) {
        const [entryPoint] = config.entryPoints;
        if (!fs.existsSync(entryPoint)) {
            log(`Skipped (not found): ${entryPoint}`);
            skipped.push(entryPoint);
            continue;
        }
        outputs.push(...(await buildDeclaredOutputs(config)));
        log(`Webview bundle built: ${config.outfile}`);
    }

    writeManifest(distDir, createManifest({ distDir, outputPaths: outputs }));

    return { outputs, skipped };
}

/**
 * Production entry point: builds every declared output into `dist/` and exits
 * the process non-zero on any failure -- including a genuine esbuild compile
 * error, which is never reported as "skipped".
 *
 * @returns {Promise<void>} Resolves after a successful build, or exits the
 *   process on failure.
 */
async function build() {
    try {
        await runBuild({
            extensionConfig,
            editorHelperConfig,
            webviewConfigs: getWebviewBuildConfigs(),
            distDir: DIST_DIR,
        });
        console.log("Build complete.");
    } catch (error) {
        console.error("Build failed:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    build();
}

module.exports = { build, runBuild, getWebviewBuildConfigs, DIST_DIR };
