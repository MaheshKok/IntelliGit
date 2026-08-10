import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { test as base, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import type { WebviewContextId } from "../../../src/e2e/webviewCapture";
import type { WebviewI18nPayload } from "../../../src/webviews/i18n";
import { buildWebviewI18nPayload } from "../../../src/webviews/i18n/catalogs";
import type { HostFixture } from "../../e2e/hostFixtures/types";
import {
    DEFAULT_HARNESS_WEBVIEW_SETTINGS,
    renderHarnessDocument,
} from "../harness/renderHarnessDocument";
import { hostContextFor } from "../harness/hostContexts";
import { installAcquireVsCodeApiStub } from "../harness/acquireVsCodeApiStub";
import {
    assertNoNetworkEscapes,
    hostFixtureIdForProject,
    resolveDistAssetPath,
} from "./visualHarnessUtils";

const HARNESS_ORIGIN = "http://intelligit-harness.test";
const REPO_ROOT = path.resolve(__dirname, "../../..");
const VISUAL_FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const HOST_FIXTURES_DIR = path.join(VISUAL_FIXTURES_DIR, "host");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const DEFAULT_LOCALE = "en";

interface WebviewFixtureMessage {
    readonly message: unknown;
}

interface LoadedWebviewFixture {
    readonly contextId: WebviewContextId;
    readonly messages: readonly WebviewFixtureMessage[];
}

interface HarnessRecorderSnapshot {
    readonly postedMessages: readonly unknown[];
}

interface HarnessWindow extends Window {
    __intelligitVsCodeApiRecorder?: () => HarnessRecorderSnapshot;
}

/** The callable fixture API exposed to visual specs. */
interface MountHarness {
    (
        contextId: WebviewContextId,
        options?: { readonly webviewFixture?: string; readonly locale?: string },
    ): Promise<{
        readonly i18n: WebviewI18nPayload;
        readonly locale: string;
        readonly recordedMessages: () => Promise<readonly unknown[]>;
        /**
         * Exempts one console-error pattern for the remainder of this test.
         *
         * Only a test that deliberately provokes a failed request needs this. Filtering
         * `net::ERR_FAILED` globally instead would blind the guard to a genuinely missing
         * production bundle -- a blank page that still screenshots cleanly, which is precisely
         * the false green the guard exists to catch.
         */
        readonly allowConsoleError: (pattern: RegExp) => void;
    }>;
}

interface VisualFixtures {
    readonly mountHarness: MountHarness;
}

/** Reads a JSON fixture from disk with the expected runtime shape supplied by its caller. */
function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/** Returns the content type needed for a deterministic in-process asset response. */
function contentTypeFor(filePath: string): string {
    if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
    if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
    if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
    return "application/octet-stream";
}

/** Creates the browser init script from the single Phase 3-ii stub implementation. */
function acquireVsCodeApiInitScript(): string {
    const stubSource = installAcquireVsCodeApiStub.toString();
    return `(() => {
    const result = (${stubSource})(window);
    window.__intelligitVsCodeApiRecorder = result.recorder;
})();`;
}

/** Loads one recorded inbound fixture and verifies it belongs to the mounted context. */
function loadWebviewFixture(
    contextId: WebviewContextId,
    fixtureName: string,
): LoadedWebviewFixture {
    const contextDir = path.join(VISUAL_FIXTURES_DIR, contextId);
    const fixturePath = path.resolve(contextDir, fixtureName);
    const relativePath = path.relative(contextDir, fixturePath);
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(`Webview fixture escapes its context directory: "${fixtureName}".`);
    }

    const fixture = readJson<LoadedWebviewFixture>(fixturePath);
    if (fixture.contextId !== contextId) {
        throw new Error(
            `Webview fixture "${fixtureName}" belongs to "${fixture.contextId}", not "${contextId}".`,
        );
    }
    return fixture;
}

/** Routes one synthetic-origin request without allowing any network fallback. */
async function routeHarnessRequest(
    route: Route,
    documentHtml: () => string | undefined,
    networkEscapes: string[],
): Promise<void> {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== HARNESS_ORIGIN) {
        networkEscapes.push(requestUrl.href);
        await route.abort("failed");
        return;
    }

    if (requestUrl.pathname === "/") {
        const html = documentHtml();
        if (html === undefined) {
            await route.abort("failed");
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: html,
        });
        return;
    }

    if (requestUrl.pathname.startsWith("/dist/")) {
        const filePath = resolveDistAssetPath(DIST_DIR, requestUrl.pathname);
        if (filePath === undefined || !fs.existsSync(filePath)) {
            // A missing or unsafe asset is a failed request, not an HTTP 404 that
            // could leave a blank page looking like a valid visual result.
            await route.abort("failed");
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: contentTypeFor(filePath),
            body: await readFile(filePath),
        });
        return;
    }

    await route.abort("failed");
}

/** Installs the in-process browser harness and exposes its recorder-backed mount operation. */
export const test = base.extend<VisualFixtures>({
    mountHarness: async ({ page }: { page: Page }, use, testInfo) => {
        let documentHtml: string | undefined;
        const networkEscapes: string[] = [];
        const consoleErrors: string[] = [];
        const pageExceptions: string[] = [];
        const allowedConsoleErrors: RegExp[] = [];

        page.on("console", (message) => {
            if (message.type() === "error") {
                consoleErrors.push(message.text());
            }
        });
        page.on("pageerror", (error) => {
            pageExceptions.push(error.stack ?? error.message);
        });
        await page.route("**/*", (route) =>
            routeHarnessRequest(route, () => documentHtml, networkEscapes),
        );

        // This runs before every navigation and delegates the implementation to
        // the Phase 3-ii stub; the production bundle therefore acquires the same
        // browser API through its real `vscodeApi.ts` call site.
        await page.addInitScript({ content: acquireVsCodeApiInitScript() });

        const mountHarness: MountHarness = async (contextId, options) => {
            const context = hostContextFor(contextId);
            const hostFixtureId = hostFixtureIdForProject(testInfo.project.name);
            const hostFixture = readJson<HostFixture>(
                path.join(HOST_FIXTURES_DIR, `${hostFixtureId}.json`),
            );
            const i18n = buildWebviewI18nPayload(options?.locale ?? DEFAULT_LOCALE);
            const fixture = options?.webviewFixture
                ? loadWebviewFixture(contextId, options.webviewFixture)
                : undefined;

            documentHtml = renderHarnessDocument({
                context,
                hostFixture,
                i18n,
                settings: DEFAULT_HARNESS_WEBVIEW_SETTINGS,
                assetBaseUrl: `${HARNESS_ORIGIN}/dist`,
            });

            await page.goto(`${HARNESS_ORIGIN}/`, { waitUntil: "load" });

            // `?.childElementCount !== 0` would be the inverted guard: optional chaining yields
            // `undefined` when `#root` is absent entirely, and `undefined !== 0` is true, so a page
            // that never rendered the mount point would satisfy the wait immediately. Coalesce
            // first, then require a real subtree.
            await page.waitForFunction(
                () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
            );

            // The stub reaches the page as serialized source, so a future module-scope reference in
            // `installAcquireVsCodeApiStub` would produce an init script that silently installs
            // nothing. Checking at mount fails every spec, not only the ones reading the recorder.
            const recorderInstalled = await page.evaluate(
                () => typeof (window as HarnessWindow).__intelligitVsCodeApiRecorder === "function",
            );
            if (!recorderInstalled) {
                throw new Error(
                    "Visual harness VS Code API recorder was not installed by the init script.",
                );
            }
            if (fixture !== undefined) {
                await page.evaluate(
                    (messages) => {
                        for (const message of messages) {
                            window.dispatchEvent(new MessageEvent("message", { data: message }));
                        }
                    },
                    fixture.messages.map((entry) => entry.message),
                );
            }

            return {
                i18n,
                locale: i18n.locale,
                allowConsoleError: (pattern: RegExp): void => {
                    allowedConsoleErrors.push(pattern);
                },
                recordedMessages: async (): Promise<readonly unknown[]> =>
                    page.evaluate(() => {
                        const recorder = (window as HarnessWindow).__intelligitVsCodeApiRecorder;
                        if (typeof recorder !== "function") {
                            throw new Error(
                                "Visual harness VS Code API recorder was not installed.",
                            );
                        }
                        return recorder().postedMessages;
                    }),
            };
        };

        await use(mountHarness);

        assertNoNetworkEscapes(networkEscapes);
        const unexpectedConsoleErrors = consoleErrors.filter(
            (text) => !allowedConsoleErrors.some((pattern) => pattern.test(text)),
        );
        if (unexpectedConsoleErrors.length > 0) {
            throw new Error(
                `Visual harness page console error: ${unexpectedConsoleErrors.join(" | ")}`,
            );
        }
        if (pageExceptions.length > 0) {
            throw new Error(
                `Visual harness uncaught page exception: ${pageExceptions.join(" | ")}`,
            );
        }
    },
});

export { expect };
