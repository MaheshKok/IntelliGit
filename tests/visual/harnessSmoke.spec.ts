import { expect, test } from "./playwright/harnessPage";

/** Identifies the ready handshake without assuming a concrete outbound union in the smoke test. */
function isReadyMessage(message: unknown): boolean {
    return (
        typeof message === "object" &&
        message !== null &&
        (message as { readonly type?: unknown }).type === "ready"
    );
}

test.describe("production webview harness", () => {
    test("commit-graph-card mounts its real bundle and posts ready", async ({
        mountHarness,
        page,
    }) => {
        const { recordedMessages } = await mountHarness("commit-graph-card", {
            webviewFixture: "clean.json",
        });

        await expect
            .poll(() => page.locator("#root").evaluate((root) => root.childElementCount))
            .toBeGreaterThan(0);
        await expect.poll(async () => (await recordedMessages()).length).toBeGreaterThan(0);
        expect((await recordedMessages()).some(isReadyMessage)).toBe(true);
    });

    test("merge-editor mounts its real bundle and posts ready", async ({ mountHarness, page }) => {
        const { recordedMessages } = await mountHarness("merge-editor", {
            webviewFixture: "conflicted.json",
        });

        await expect
            .poll(() => page.locator("#root").evaluate((root) => root.childElementCount))
            .toBeGreaterThan(0);
        await expect.poll(async () => (await recordedMessages()).length).toBeGreaterThan(0);
        expect((await recordedMessages()).some(isReadyMessage)).toBe(true);
    });

    test("can fail: an unroutable asset request is rejected instead of becoming a silent 404", async ({
        mountHarness,
        page,
    }) => {
        const { allowConsoleError } = await mountHarness("commit-graph-card");
        // Chromium logs every aborted request as a console error, and this test provokes one on
        // purpose. Exempting the pattern here rather than in the guard keeps a real bundle-load
        // failure fatal in every other test.
        allowConsoleError(/ERR_FAILED/);

        const outcome = await page.evaluate(async () => {
            try {
                const response = await fetch("/dist/not-a-real-visual-asset.js");
                return `status:${response.status}`;
            } catch {
                return "rejected";
            }
        });

        expect(outcome).toBe("rejected");
    });

    test("can fail: a page console error fails the visual harness", async ({
        mountHarness,
        page,
    }) => {
        test.fail();
        await mountHarness("commit-graph-card");
        const consoleError = page.waitForEvent("console", (message) => message.type() === "error");
        await page.evaluate(() => console.error("visual-harness-console-sentinel"));
        await consoleError;
    });
});
