// Local preview for the built merge editor webview bundle.

const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const assets = ["webview-mergeeditor.js", "webview-mergeeditor.css"];
const requestedPort =
    Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length)) ||
    Number(process.env.PORT) ||
    4177;

for (const asset of assets) {
    const filePath = path.join(distDir, asset);
    if (!fs.existsSync(filePath)) {
        console.error(`Missing ${filePath}. Run: bun run build`);
        process.exit(1);
    }
}

// Mirrors the user's real config.ts merge: an unchanged-on-one-side import
// conflict, a 4-line constant conflict (both stacked reproduces the reported
// contour issues), a tall one-sided green insertion (right-divider wedge), and
// a theirs-only insertion (left-divider artifacts).
const sampleConflictData = {
    filePath: "src/config.ts",
    oursLabel: "main",
    theirsLabel: "feature/incoming",
    eol: "\n",
    hasTrailingNewline: true,
    segments: [
        {
            type: "common",
            lines: [
                "// ============================================",
                "// SECTION 1: Imports and Constants",
                "// ============================================",
                'import * as fs from "fs";',
                'import * as path from "path";',
            ],
        },
        {
            // Ours and theirs each added a different import where base had
            // nothing: zero-height middle, so FIX 2's cross-middle thin line
            // is exercised here instead of the (no longer representative)
            // unchanged-on-one-side case.
            type: "conflict",
            id: 1,
            changeKind: "conflict",
            baseLines: [],
            oursLines: ['import * as yaml from "yaml";'],
            theirsLines: ['import * as toml from "toml";'],
        },
        {
            type: "common",
            lines: [""],
        },
        {
            type: "conflict",
            id: 2,
            changeKind: "conflict",
            baseLines: [
                'const CONFIG_FILE_NAME = "app.config.json";',
                'const ENV_PREFIX = "APP_";',
                "const MAX_CACHE_SIZE = 100;",
                'const DEFAULT_LOG_LEVEL = "info";',
            ],
            oursLines: [
                'const CONFIG_FILE_NAME = "app.config.yaml";',
                'const ENV_PREFIX = "MYAPP_";',
                "const MAX_CACHE_SIZE = 500;",
                'const DEFAULT_LOG_LEVEL = "debug";',
            ],
            theirsLines: [
                'const CONFIG_FILE_NAME = "app.config.toml";',
                'const ENV_PREFIX = "SVC_";',
                "const MAX_CACHE_SIZE = 250;",
                'const DEFAULT_LOG_LEVEL = "warn";',
            ],
        },
        {
            type: "common",
            lines: ["", "// SECTION 2: Types", "interface AppConfig {", "  port: number;", "}"],
        },
        {
            // Tall one-sided green insertion: only ours added mergeConfig.
            type: "conflict",
            id: 3,
            changeKind: "ours-only",
            baseLines: [],
            oursLines: [
                "private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {",
                "  return {",
                "    ...base,",
                "    ...override,",
                "    database: {",
                "      ...base.database,",
                "      ...(override.database ?? {}),",
                "    },",
                "    features: {",
                "      ...base.features,",
                "      ...(override.features ?? {}),",
                "    },",
                "  };",
                "}",
            ],
            theirsLines: [],
        },
        {
            type: "common",
            lines: ["", "loadFromEnv(): void {", '  const envPort = process.env["PORT"];', "}"],
        },
        {
            // Theirs-only insertion: envHost handling added on the right.
            type: "conflict",
            id: 4,
            changeKind: "theirs-only",
            baseLines: [],
            oursLines: [],
            theirsLines: [
                '  const envHost = process.env["HOST"];',
                "  if (envHost) {",
                "    this.config.host = envHost;",
                "  }",
            ],
        },
        {
            type: "common",
            // Filler so the document exceeds the viewport and the preview can
            // exercise scroll-driven ribbon redraws, not just the first frame.
            lines: Array.from({ length: 40 }, (unused, i) => `  trace("scroll filler ${i}");`),
        },
    ],
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Merge Editor Preview</title>
<link rel="stylesheet" href="/dist/webview-mergeeditor.css" />
<style>
html, body, #root { height: 100%; margin: 0; }
body {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-editor-font-family: Menlo, Monaco, Consolas, monospace;
  --vscode-editor-font-size: 13px;
  --vscode-editor-background: #273548;
  --vscode-editor-foreground: #d2d6db;
  --vscode-editorGutter-background: #243144;
  --vscode-sideBar-background: #243144;
  --vscode-editorLineNumber-foreground: #7d8796;
  --vscode-foreground: #d2d6db;
  --vscode-panel-background: #243144;
  --vscode-panel-border: #334155;
  --vscode-button-background: #365f9f;
  --vscode-button-foreground: #ffffff;
  --vscode-focusBorder: #4ea1ff;
  overflow: hidden;
}
</style>
<script>
// The merge scroll driver draws in requestAnimationFrame, which Chrome suspends
// for hidden tabs — headless/screenshot tooling would never get a frame. The
// preview swaps in a timeout-based shim so frames always run.
window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
const sampleConflictData = ${JSON.stringify(sampleConflictData)};
function postSampleConflictData() {
  window.dispatchEvent(new MessageEvent("message", {
    data: { type: "setConflictData", data: sampleConflictData }
  }));
}
window.acquireVsCodeApi = () => ({
  postMessage(message) {
    console.log("[merge-preview]", message);
    if (message?.type === "ready") window.setTimeout(postSampleConflictData, 0);
  },
  getState() {
    return {};
  },
  setState() {}
});
</script>
</head>
<body>
<div id="root"></div>
<script src="/dist/webview-mergeeditor.js"></script>
<script>
window.setTimeout(postSampleConflictData, 100);
window.setTimeout(postSampleConflictData, 500);
</script>
</body>
</html>`;

/** Return a tiny content type map for served preview assets. */
function contentType(filePath) {
    if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
    if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
    return "application/octet-stream";
}

/** Serve the preview page and dist assets without allowing path traversal. */
function handleRequest(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
    }

    if (!url.pathname.startsWith("/dist/")) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }

    const filePath = path.normalize(path.join(root, url.pathname));
    if (!filePath.startsWith(`${distDir}${path.sep}`)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        response.writeHead(200, { "content-type": contentType(filePath) });
        response.end(data);
    });
}

/** Start on the requested port, falling forward if that port is busy. */
function listen(port) {
    const server = http.createServer(handleRequest);
    server.on("error", (error) => {
        if (error.code === "EADDRINUSE" && port < requestedPort + 20) {
            listen(port + 1);
            return;
        }
        throw error;
    });
    server.listen(port, "127.0.0.1", () => {
        console.log(`Merge editor preview: http://127.0.0.1:${port}/`);
        console.log("Press Ctrl+C to stop.");
    });
}

listen(requestedPort);
