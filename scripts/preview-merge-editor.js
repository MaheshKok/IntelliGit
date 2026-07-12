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
                'getDatabaseConfig(): Readonly<AppConfig["database"]> {',
                "  return Object.freeze({ ...this.config.database });",
                "}",
                "",
            ],
        },
        {
            type: "conflict",
            id: 8,
            changeKind: "conflict",
            baseLines: ["exportConfig(): string {"],
            oursLines: [
                "exportToYaml(): string { return yaml.stringify(this.config); } // long left line for horizontal scroll",
            ],
            theirsLines: [
                "reload(): AppConfig {",
                "  this.config = this.loadDefaults();",
                "  return this.loadFromFile();",
                "}",
                "",
                "validate(): string[] {",
                "  const errors: string[] = [];",
                '  if (this.config.port < 1) errors.push("Port must be between 1 and 65535");',
                "  return errors;",
                "}",
            ],
        },
        {
            type: "common",
            lines: ["}", "loadFromEnv(): void {"],
        },
        {
            type: "conflict",
            id: 9,
            changeKind: "conflict",
            baseLines: ['  const raw = process.env["APP_PORT"];'],
            oursLines: [
                '  const envPort = process.env["MYAPP_PORT"];',
                "  if (envPort) {",
                "    this.config.port = parseInt(envPort, 10);",
                "  }",
            ],
            theirsLines: ['  const envPort = process.env["SVC_PORT"];'],
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
