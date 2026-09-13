import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const scriptPath = path.resolve(__dirname, "../../../scripts/preview-merge-editor.js");

type PreviewHandler = (
    request: { url: string },
    response: {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
    },
) => void;

/** Runs the real preview entry point against an in-memory filesystem and HTTP transport. */
function previewContext(missingAsset?: string) {
    const createServer = vi.fn((_handler: PreviewHandler) => ({ on: vi.fn(), listen: vi.fn() }));
    const exit = vi.fn(() => {
        throw new Error("preview exited");
    });
    const error = vi.fn();
    const fs = {
        existsSync: (file: string) => path.basename(file) !== missingAsset,
        readFile: (file: string, callback: (error: null, data: Buffer) => void) =>
            callback(null, Buffer.from(`asset:${path.basename(file)}`)),
    };
    const modules: Record<string, unknown> = { fs, http: { createServer }, path };
    const context = vm.createContext({
        __dirname: path.dirname(scriptPath),
        require: (module: string) => modules[module],
        process: { argv: [], env: {}, exit },
        console: { log: vi.fn(), error },
        URL,
    });
    return { context, createServer, exit, error };
}

describe("merge editor preview shared runtime", () => {
    it("serves the shared highlighter before the merge consumer as synchronous classic scripts", () => {
        const { context, createServer } = previewContext();
        vm.runInContext(readFileSync(scriptPath, "utf8"), context);
        const handler = createServer.mock.calls[0][0];
        const response = { writeHead: vi.fn(), end: vi.fn() };
        handler({ url: "/" }, response);
        const html = response.end.mock.calls[0][0] as string;
        const scripts = [...html.matchAll(/<script([^>]*src="([^"]+)"[^>]*)>/g)];
        expect(scripts.map((script) => script[2])).toEqual([
            "/dist/webview-shiki.js",
            "/dist/webview-mergeeditor.js",
        ]);
        for (const script of scripts) expect(script[1]).not.toMatch(/\b(?:async|defer|type)=?/);
        response.end.mockClear();
        handler({ url: "/dist/webview-shiki.js" }, response);
        expect(response.writeHead).toHaveBeenLastCalledWith(200, {
            "content-type": "text/javascript; charset=utf-8",
        });
        expect(response.end.mock.calls[0][0].toString()).toBe("asset:webview-shiki.js");
    });

    it("fails before opening a server when the required shared highlighter is missing", () => {
        const { context, createServer, exit, error } = previewContext("webview-shiki.js");
        expect(() => vm.runInContext(readFileSync(scriptPath, "utf8"), context)).toThrow(
            "preview exited",
        );
        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls[0][0]).toContain("webview-shiki.js. Run: bun run build");
        expect(createServer).not.toHaveBeenCalled();
    });
});
