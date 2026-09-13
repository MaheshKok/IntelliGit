import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./playwright/harnessPage";

const CENTER_TOLERANCE_PX = 2;

/** Creates stable, unique code rows without coupling navigation to syntax highlighting. */
function rows(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

const DIFF_SEGMENTS = [
    { type: "common", left: rows("head", 2), right: rows("head", 2) },
    { type: "changed", left: rows("first-old", 4), right: rows("first-new", 4) },
    { type: "common", left: rows("before-middle", 30), right: rows("before-middle", 30) },
    { type: "changed", left: rows("middle-old", 6), right: rows("middle-new", 6) },
    { type: "common", left: rows("before-last", 30), right: rows("before-last", 30) },
    { type: "changed", left: rows("last-old", 4), right: rows("last-new", 4) },
    { type: "common", left: rows("tail", 2), right: rows("tail", 2) },
] as const;

/** Builds the same long diff for read-only and document-backed rendering paths. */
function diffData(editable: boolean): Record<string, unknown> {
    return {
        path: "src/navigation.ts",
        leftLabel: "HEAD",
        rightLabel: "Working tree",
        languageId: "typescript",
        left: { eol: "lf", terminalNewline: true },
        right: { eol: "lf", terminalNewline: true },
        newlineDifference: false,
        ignoreWhitespace: false,
        segments: DIFF_SEGMENTS,
        ...(editable
            ? {
                  editablePane: "right",
                  editableText: DIFF_SEGMENTS.flatMap((segment) => segment.right).join("\n"),
                  documentVersion: 1,
                  editableReseedToken: 0,
              }
            : {}),
    };
}

/** Delivers a production-shaped host message to the mounted webview. */
async function dispatch(page: Page, type: string, data: unknown): Promise<void> {
    await page.evaluate(
        ({ messageType, payload }) =>
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: messageType, data: payload } }),
            ),
        { messageType: type, payload: data },
    );
}

/** Measures the target's canonical union midpoint against the visible scroll viewport. */
async function midpointDistance(viewport: Locator, targets: Locator): Promise<number> {
    const viewportBox = await viewport.boundingBox();
    const boxes = await targets.evaluateAll((elements) =>
        elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom };
        }),
    );
    expect(viewportBox, "navigation viewport must be measurable").not.toBeNull();
    expect(boxes.length, "target must render in every pane").toBeGreaterThan(0);
    const targetTop = Math.min(...boxes.map((box) => box.top));
    const targetBottom = Math.max(...boxes.map((box) => box.bottom));
    return Math.abs(
        (targetTop + targetBottom) / 2 - ((viewportBox?.y ?? 0) + (viewportBox?.height ?? 0) / 2),
    );
}

/** Waits through smooth scrolling and requires the rendered hunk midpoint to settle centrally. */
async function expectCentered(viewport: Locator, targets: Locator): Promise<void> {
    await expect
        .poll(() => midpointDistance(viewport, targets))
        .toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
}

for (const editable of [false, true]) {
    test(`${editable ? "editable" : "read-only"} diff centers previous and next differences`, async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
        await dispatch(page, "setDiffData", diffData(editable));

        const viewport = page.locator(".diff-content");
        const changes = page.locator(".diff-pane-left .diff-segment-changed");
        await expect(changes).toHaveCount(3);

        const next = page.getByTestId("diff-next-change");
        const previous = page.getByTestId("diff-prev-change");
        await next.click();
        await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
        await next.click();
        await expectCentered(viewport, changes.nth(1));
        await next.click();
        await expectCentered(viewport, changes.nth(2));
        const lastTop = await viewport.evaluate((element) => element.scrollTop);
        await next.click();
        await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(lastTop);

        await previous.click();
        await expectCentered(viewport, changes.nth(1));
        await previous.click();
        await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
        await previous.click();
        await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    });
}

test("three-pane merge centers the canonical conflict extent", async ({ mountHarness, page }) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
    await dispatch(page, "setConflictData", {
        filePath: "src/conflict.ts",
        oursLabel: "Ours",
        theirsLabel: "Theirs",
        eol: "\n",
        hasTrailingNewline: true,
        diffOptions: {},
        editorFontSize: 14,
        segments: [
            { type: "common", lines: rows("head", 2) },
            {
                type: "conflict",
                id: 0,
                changeKind: "conflict",
                oursLines: rows("first-ours", 2),
                theirsLines: rows("first-theirs", 3),
                baseLines: rows("first-base", 1),
            },
            { type: "common", lines: rows("before-middle", 30) },
            {
                type: "conflict",
                id: 1,
                changeKind: "conflict",
                oursLines: rows("middle-ours", 2),
                theirsLines: rows("middle-theirs", 8),
                baseLines: rows("middle-base", 4),
            },
            { type: "common", lines: rows("before-last", 30) },
            {
                type: "conflict",
                id: 2,
                changeKind: "conflict",
                oursLines: rows("last-ours", 4),
                theirsLines: rows("last-theirs", 3),
                baseLines: rows("last-base", 2),
            },
            { type: "common", lines: rows("tail", 2) },
        ],
    });

    const viewport = page.locator(".merge-content");
    const next = page.getByRole("button", { name: "Next conflict", exact: true });
    const previous = page.getByRole("button", { name: "Previous conflict", exact: true });
    await expect(page.locator('[data-conflict-id="1"]')).toHaveCount(3);

    // Loading selects the first conflict without moving the scroll position.
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await next.click();
    await expectCentered(viewport, page.locator('[data-conflict-id="1"]'));
    await next.click();
    await expectCentered(viewport, page.locator('[data-conflict-id="2"]'));
    await next.click();
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await previous.click();
    await expectCentered(viewport, page.locator('[data-conflict-id="2"]'));
    await previous.click();
    await expectCentered(viewport, page.locator('[data-conflict-id="1"]'));
});
