import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { routeHarnessRequest } from "../../../visual/playwright/visualHarnessUtils";

const HARNESS_ORIGIN = "http://intelligit-harness.test";
const DIST_DIR = resolve(__dirname, "../../../../dist");
const MERGE_EDITOR_BUNDLE = resolve(DIST_DIR, "webview-mergeeditor.js");

type FulfillOptions = NonNullable<Parameters<Route["fulfill"]>[0]>;

interface RecordingRoute {
    readonly route: Route;
    readonly fulfill: ReturnType<typeof vi.fn>;
    readonly abort: ReturnType<typeof vi.fn>;
    readonly fulfills: readonly FulfillOptions[];
}

/** Creates a fake Playwright route that records fulfillment and abort operations. */
function recordingRoute(url: string): RecordingRoute {
    const fulfills: FulfillOptions[] = [];
    const abort = vi.fn(async (_errorCode?: Parameters<Route["abort"]>[0]) => undefined);
    const fulfill = vi.fn(async (options?: FulfillOptions) => {
        if (options !== undefined) fulfills.push(options);
    });
    const route = {
        request: () => ({ url: () => url }),
        abort,
        fulfill,
    } as unknown as Route;
    return { route, fulfill, abort, fulfills };
}

describe("routeHarnessRequest", () => {
    it("aborts off-origin requests and records escapes", async () => {
        const request = recordingRoute("https://example.test/escape");
        const networkEscapes: string[] = [];

        await routeHarnessRequest(
            request.route,
            HARNESS_ORIGIN,
            DIST_DIR,
            () => "<html />",
            networkEscapes,
        );

        expect(request.abort).toHaveBeenCalledWith("failed");
        expect(request.fulfill).not.toHaveBeenCalled();
        expect(networkEscapes).toEqual(["https://example.test/escape"]);
    });

    it("aborts the root request before the document is available", async () => {
        const request = recordingRoute(`${HARNESS_ORIGIN}/`);

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => undefined, []);

        expect(request.abort).toHaveBeenCalledWith("failed");
        expect(request.fulfill).not.toHaveBeenCalled();
    });

    it("fulfills the root request with the exact HTML document", async () => {
        const request = recordingRoute(`${HARNESS_ORIGIN}/`);
        const document = "<!doctype html><html><body>exact</body></html>";

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => document, []);

        expect(request.abort).not.toHaveBeenCalled();
        expect(request.fulfill).toHaveBeenCalledTimes(1);
        expect(request.fulfills[0]).toEqual({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: document,
        });
    });

    it("fulfills the real merge editor bundle with its bytes and content type", async () => {
        const request = recordingRoute(`${HARNESS_ORIGIN}/dist/webview-mergeeditor.js`);

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => undefined, []);

        expect(request.abort).not.toHaveBeenCalled();
        expect(request.fulfill).toHaveBeenCalledTimes(1);
        expect(request.fulfills[0]).toEqual({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: readFileSync(MERGE_EDITOR_BUNDLE),
        });
    });

    it("aborts a missing dist asset without fulfilling a 404", async () => {
        const request = recordingRoute(`${HARNESS_ORIGIN}/dist/missing.js`);

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => undefined, []);

        expect(request.abort).toHaveBeenCalledWith("failed");
        expect(request.fulfill).not.toHaveBeenCalled();
    });

    it("aborts a dist traversal path escaping the dist root", async () => {
        // Two separate traps here, both of which make this case pass without ever reaching the
        // resolver's containment check:
        //
        // `%2e%2e` does not survive URL parsing -- the WHATWG parser resolves dot-segments while
        // building `pathname`, so `/dist/%2e%2e/%2e%2e/package.json` arrives as `/package.json`
        // and lands in the catch-all, duplicating the favicon case. An encoded slash survives, so
        // the request keeps its `/dist/` prefix.
        //
        // And the escape must land on a file that EXISTS. `../../package.json` resolves to a
        // directory above the repository that has no manifest, so `existsSync` aborts it and the
        // assertion is satisfied by the missing-asset branch instead; deleting the containment
        // check entirely still leaves this green. One level up is the repository's own manifest,
        // which exists, so containment is the only thing that can reject it.
        const request = recordingRoute(`${HARNESS_ORIGIN}/dist/..%2fpackage.json`);

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => undefined, []);

        expect(request.abort).toHaveBeenCalledWith("failed");
        expect(request.fulfill).not.toHaveBeenCalled();
    });

    it("aborts favicon requests", async () => {
        const request = recordingRoute(`${HARNESS_ORIGIN}/favicon.ico`);

        await routeHarnessRequest(request.route, HARNESS_ORIGIN, DIST_DIR, () => undefined, []);

        expect(request.abort).toHaveBeenCalledWith("failed");
        expect(request.fulfill).not.toHaveBeenCalled();
    });
});
