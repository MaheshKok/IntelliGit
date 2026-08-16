import fs from "node:fs";
import path from "node:path";

import { test as base, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

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
    routeHarnessRequest,
} from "./visualHarnessUtils";
import { prepareVisualEnvironment } from "./visualEnvironmentGuard";
import { settleRootSubtree } from "./settleRootSubtree";

const HARNESS_ORIGIN = "http://intelligit-harness.test";
const REPO_ROOT = path.resolve(__dirname, "../../..");
const VISUAL_FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const HOST_FIXTURES_DIR = path.join(VISUAL_FIXTURES_DIR, "host");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const DEFAULT_LOCALE = "en";

// Minimum continuous quiet time under "#root" (no observed change) required before the
// fixture-driven render is considered settled -- see `waitForRootSubtreeToSettle`. Samples are
// taken from inside `requestAnimationFrame` callbacks, so a sample always follows a completed
// layout pass, but the requirement itself is wall-clock rather than a raw frame count: React's
// scheduler flushes a batched update within roughly one macrotask (nothing here waits on I/O),
// so 100ms is a wide (~5x) multiple of the 1-2 frames that takes in practice -- chosen to absorb
// scheduling jitter on a loaded CI box, not the minimum that happens to work locally. A 2-frame
// (~33ms) threshold was tried first and measured to resolve in ~20ms against a synthetic render
// deferred by 100-250ms: it was satisfied by "nothing has changed YET" as readily as by "nothing
// will change again", which is exactly the ambiguity a settle predicate exists to resolve.
const SETTLE_MIN_STABLE_MS = 100;
// Generous ceiling relative to SETTLE_MIN_STABLE_MS, so a render that never settles fails loudly
// with a clear diagnostic instead of riding the suite's 30s test timeout to an opaque error.
const SETTLE_MAX_MS = 3000;

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

/**
 * Worker-scoped fixtures live in `extend`'s SECOND type parameter. Declaring `visualEnvironment`
 * alongside the test-scoped fixtures while passing `{ scope: "worker" }` typechecks as a
 * test-scoped fixture value, so the scope option and the declared scope disagreed.
 */
interface VisualWorkerFixtures {
    readonly visualEnvironment: void;
}

/** Reads a JSON fixture from disk with the expected runtime shape supplied by its caller. */
function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
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

/**
 * Waits until `#root`'s rendered subtree stops changing for `SETTLE_MIN_STABLE_MS` of continuous
 * wall-clock quiet time. The predicate itself lives in `settleRootSubtree.ts`, where it is
 * unit-tested against a driven clock; this wrapper only carries it into the page.
 *
 * The fixture dispatch below returns as soon as `window.dispatchEvent` has run, but the
 * "message" handlers it invokes update React state, and React 18 batches and commits that
 * update asynchronously -- layout for the commit can land an animation frame later still.
 * Returning immediately after dispatch let callers read `#root` before the commit, or its
 * layout pass, had happened: a race the suite has so far won on timing luck, not a guarantee.
 * Every sample is taken from inside a `requestAnimationFrame` callback, never from a synchronous
 * pre-frame read -- a synchronous sample could equal the first frame's sample simply because the
 * scheduled commit had not landed yet, which would satisfy a naive "matches last frame" check
 * without anything having actually settled. Gating on elapsed wall-clock time (via each frame's
 * own timestamp) rather than a raw frame count keeps the requirement meaningful regardless of
 * the page's actual frame rate.
 */
async function waitForRootSubtreeToSettle(page: Page): Promise<void> {
    await page.evaluate(settleRootSubtree, {
        minStableMs: SETTLE_MIN_STABLE_MS,
        maxWaitMs: SETTLE_MAX_MS,
    });
}

/** Installs the in-process browser harness and exposes its recorder-backed mount operation. */
export const test = base.extend<VisualFixtures, VisualWorkerFixtures>({
    visualEnvironment: [
        async ({ browser }: { browser: Browser }, use, workerInfo) => {
            await prepareVisualEnvironment(browser, workerInfo.config.workers);
            await use();
        },
        { scope: "worker", auto: true },
    ],
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
            routeHarnessRequest(route, HARNESS_ORIGIN, DIST_DIR, () => documentHtml, networkEscapes),
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

                // The dispatched messages drive a React re-render that has not necessarily
                // committed or laid out yet -- wait for it before handing back to the caller.
                await waitForRootSubtreeToSettle(page);
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
