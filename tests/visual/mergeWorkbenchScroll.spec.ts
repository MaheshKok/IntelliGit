import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";
import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./playwright/harnessPage";
import { mountWorkbenchMerge } from "./legacyMerge";
import fixture from "./fixtures/merge-editor/conflicted.json";
import { parseConflictVersions } from "../../src/mergeEditor/conflictParser";
import { LINE_HEIGHT_PX } from "../../src/webviews/react/diff-core/mergeScrollLayout";

const uniqueToken = "ENDTOKEN";
const longLineNumber = 80;
const lines = Array.from({ length: 3000 }, (_, index) => `row ${index + 1}`);
lines[longLineNumber] = "";
lines[longLineNumber - 1] = "wide " + "x".repeat(440);
lines[2980] = uniqueToken;
const base = lines.join("\n") + "\n";
function version(side: string) {
    const changed = [...lines];
    for (const index of [3, 1499, 2990]) changed[index] = `${side} ${index + 1}`;
    return changed.join("\n") + "\n";
}
const ours = version("ours");
const theirs = version("theirs");
const data: MergeEditorData = {
    ...(fixture.messages[0].message.data as MergeEditorData),
    segments: parseConflictVersions(base, ours, theirs),
    hasTrailingNewline: true,
    workbench: {
        ...fixture.messages[0].message.data.workbench,
        base,
        ours,
        theirs,
        snapshotId: randomBytes(32).toString("hex"),
    },
};

async function settleScroll(page: Page) {
    let previous = -1;
    let stable = 0;
    await expect
        .poll(
            async () => {
                const current = await page.locator(".merge-content").evaluate((el) => el.scrollTop);
                stable = current === previous ? stable + 1 : 0;
                previous = current;
                return stable;
            },
            { intervals: [100], timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(3);
}

async function expectInsideViewport(page: Page, selector: string) {
    await expect
        .poll(() =>
            page.locator(selector).evaluateAll((elements) => {
                const viewport = document.querySelector(".merge-viewport")!.getBoundingClientRect();
                const boxes = elements.map((element) => element.getBoundingClientRect().toJSON());
                return {
                    boxes,
                    viewport: viewport.toJSON(),
                    scroll: document.querySelector(".merge-content")!.scrollTop,
                    inside: elements.some((element) => {
                        const box = element.getBoundingClientRect();
                        return (
                            box.height > 0 &&
                            box.top >= viewport.top - 1 &&
                            box.bottom <= viewport.bottom + 1 &&
                            box.left >= viewport.left - 1 &&
                            box.right <= viewport.right + 1
                        );
                    }),
                };
            }),
        )
        .toMatchObject({ inside: true });
}

async function expectHorizontalAgreement(page: Page) {
    const bar = page.locator(".merge-horizontal-scroll");
    await expect
        .poll(() =>
            bar.evaluate((el) => ({
                left: el.scrollLeft,
                width: el.clientWidth,
                total: el.scrollWidth,
                panes: [...document.querySelectorAll(".merge-content .cm-scroller")].map(
                    (pane) => ({
                        width: pane.clientWidth,
                        total: pane.scrollWidth,
                        left: pane.scrollLeft,
                    }),
                ),
                positive: el.scrollLeft > 0,
            })),
        )
        .toMatchObject({ positive: true });
    await expect
        .poll(async () => {
            const left = await bar.evaluate((el) => el.scrollLeft);
            return page
                .locator(".merge-content .cm-scroller")
                .evaluateAll(
                    (elements, expected) => elements.map((el) => el.scrollLeft === expected),
                    left,
                );
        })
        .toEqual([true, true, true]);
}

test.beforeEach(async ({ mountHarness, page }) => {
    await mountWorkbenchMerge(mountHarness, page, data);
});

test.afterEach(async ({ page }) => {
    await expect
        .poll(() =>
            page
                .locator(".merge-viewport, .merge-col")
                .evaluateAll((elements) =>
                    elements.map((el) => ({ top: el.scrollTop, left: el.scrollLeft })),
                ),
        )
        .toEqual(Array.from({ length: 4 }, () => ({ top: 0, left: 0 })));
});

test("long file renders rows after a far scroll", async ({ page }) => {
    await page.locator(".overview-marker").last().click();
    await settleScroll(page);
    // The result starts from base, whose last conflicting line is still 'row 2991'.
    const lastHunk = page
        .locator(".pane-result .cm-line.mrow-pending")
        .filter({ hasText: "row 2991" });
    await expect(lastHunk).toHaveCount(1);
    await expect
        .poll(() =>
            lastHunk.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const viewport = document.querySelector(".merge-viewport")!.getBoundingClientRect();
                return (
                    box.bottom > viewport.top &&
                    box.top < viewport.bottom &&
                    box.right > viewport.left &&
                    box.left < viewport.right
                );
            }),
        )
        .toBe(true);
    const box = await page.locator(".merge-content").boundingBox();
    if (!box) throw new Error("merge content has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
    await settleScroll(page);
    // Derive the first full row from the live translated column and measured row height.
    // This fixture has equal pane row counts, so canonical and pane offsets coincide.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const viewport = document.querySelector(".merge-viewport")!.getBoundingClientRect();
                const column = document.querySelector<HTMLElement>(".col-middle")!;
                const content = document.querySelector(".merge-content")!;
                const offset = -new DOMMatrixReadOnly(getComputedStyle(column).transform).m42;
                const height = document
                    .querySelector(".pane-result .cm-line")!
                    .getBoundingClientRect().height;
                const first = [
                    ...document.querySelectorAll(".pane-result .cm-lineNumbers .cm-gutterElement"),
                ].find((el) => {
                    const rect = el.getBoundingClientRect();
                    return (
                        rect.top >= viewport.top &&
                        rect.top < viewport.bottom &&
                        getComputedStyle(el).visibility !== "hidden"
                    );
                });
                return (
                    Number(first?.textContent) === Math.ceil(offset / height) + 1 &&
                    Math.abs(content.scrollTop - offset) < 1
                );
            }),
        )
        .toBe(true);
});

test("typing at the end keeps the caret visible", async ({ page }) => {
    await page.locator(".pane-result .cm-line").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("new\nlines\nend");
    await expectInsideViewport(page, ".pane-result .cm-cursor");
    expect(await page.locator(".merge-content").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("Find next scrolls the match into the viewport", async ({ page }) => {
    await page.getByRole("button", { name: "Find in result", exact: true }).click();
    await page.locator(".cm-search input[name=search]").pressSequentially(uniqueToken);
    await page.locator(".cm-search input[name=search]").press("Enter");
    await expectInsideViewport(page, ".pane-result .cm-searchMatch-selected");
});

test("caret navigation past the viewport scrolls .merge-content", async ({ page }) => {
    await page.locator(".pane-result .cm-line").first().click();
    for (let i = 0; i < 5; i++) await page.keyboard.press("PageDown");
    await expectInsideViewport(page, ".pane-result .cm-cursor");
    expect(await page.locator(".merge-content").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("caret at the end of a long line moves the shared bar", async ({ page }) => {
    await page.locator(".merge-content").evaluate((element, number) => {
        const height = document
            .querySelector(".pane-result .cm-line")!
            .getBoundingClientRect().height;
        element.scrollTop = (number - 2) * height;
    }, longLineNumber);
    await settleScroll(page);
    await page
        .locator(".pane-result .cm-line")
        .filter({ hasText: "wide " })
        .click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("End");
    await expectHorizontalAgreement(page);
});

test("bar drag moves all three editors", async ({ page }) => {
    await page.locator(".merge-content").evaluate((element, number) => {
        const height = document
            .querySelector(".pane-result .cm-line")!
            .getBoundingClientRect().height;
        element.scrollTop = (number - 2) * height;
    }, longLineNumber);
    await settleScroll(page);
    await page.locator(".merge-horizontal-scroll").evaluate((element) => {
        element.scrollLeft = 200;
        element.dispatchEvent(new Event("scroll"));
    });
    await expectHorizontalAgreement(page);
});

test("Find panel renders inside .merge-find-host", async ({ page }) => {
    await page.getByRole("button", { name: "Find in result", exact: true }).click();
    await expect(page.locator(".merge-find-host .cm-search")).toHaveCount(1);
    await expect(page.locator(".cm-editor .cm-panels-bottom .cm-search")).toHaveCount(0);
});

test("caret on an empty line returns the bar to 0", async ({ page }) => {
    await page.locator(".merge-content").evaluate((element, number) => {
        const height = document
            .querySelector(".pane-result .cm-line")!
            .getBoundingClientRect().height;
        element.scrollTop = (number - 2) * height;
    }, longLineNumber);
    await settleScroll(page);
    await page.locator(".merge-horizontal-scroll").evaluate((element) => {
        element.scrollLeft = 200;
        element.dispatchEvent(new Event("scroll"));
    });
    await expectHorizontalAgreement(page);
    // A pointer click does not request a scroll; the caret moving onto the empty line does.
    const point = await page.locator(".pane-result .cm-content").evaluate((element) => {
        const wide = [...element.querySelectorAll(".cm-line")].find((line) =>
            line.textContent?.startsWith("wide "),
        );
        if (!wide || wide.nextElementSibling?.textContent !== "")
            throw new Error("wide line followed by an empty line is not rendered");
        const line = wide.getBoundingClientRect();
        const pane = element.closest(".cm-scroller")!.getBoundingClientRect();
        const gutters = element
            .closest(".cm-editor")!
            .querySelector(".cm-gutters")!
            .getBoundingClientRect();
        return {
            x: gutters.right + (pane.right - gutters.right) / 2,
            y: line.top + line.height / 2,
        };
    });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("ArrowDown");
    await expect
        .poll(() =>
            page
                .locator(".merge-horizontal-scroll, .merge-content .cm-scroller")
                .evaluateAll((elements) => elements.map((element) => element.scrollLeft)),
        )
        .toEqual([0, 0, 0, 0]);
});

test("a scroll request right after a long line grows lands at the requested scrollLeft", async ({
    page,
}) => {
    await page.locator(".merge-content").evaluate(
        (element, top) => {
            element.scrollTop = top;
        },
        (longLineNumber - 2) * LINE_HEIGHT_PX,
    );
    await settleScroll(page);
    await page
        .locator(".pane-result .cm-line")
        .filter({ hasText: "wide " })
        .click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("End");
    await expectHorizontalAgreement(page);
    const bar = page.locator(".merge-horizontal-scroll");
    let previous = -1;
    let stable = 0;
    await expect
        .poll(async () => {
            const current = await bar.evaluate((element) => element.scrollLeft);
            stable = current === previous ? stable + 1 : 0;
            previous = current;
            return stable;
        })
        .toBeGreaterThanOrEqual(3);
    const oldMaximum = await bar.evaluate((element) => element.scrollWidth - element.clientWidth);
    // One paste-like insert grows the line past the bar before the next measurement.
    await page.keyboard.insertText("y".repeat(60));
    await expect
        .poll(() => bar.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeGreaterThan(oldMaximum);
    await expect
        .poll(
            () =>
                bar.evaluate((element) =>
                    Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft),
                ),
            { message: "the grown line's end must not stay capped by the previous bar width" },
        )
        .toBeLessThanOrEqual(LINE_HEIGHT_PX);
    await expect
        .poll(
            () =>
                bar.evaluate((element) => {
                    const panes = [...document.querySelectorAll(".merge-content .cm-scroller")];
                    if (panes.length !== 3) throw new Error("expected three editor scrollers");
                    return Math.max(
                        ...panes.map((pane) => Math.abs(pane.scrollLeft - element.scrollLeft)),
                    );
                }),
            { message: "all three editor scrollLeft values must match the shared bar" },
        )
        .toBeLessThanOrEqual(1);
    const caret = await page.locator(".pane-result .cm-cursor").evaluate((element) => {
        const scroller = document.querySelector(".pane-result .cm-scroller");
        const gutters = document.querySelector(".pane-result .cm-gutters");
        if (!scroller || !gutters) throw new Error("result content box is missing");
        return {
            left: element.getBoundingClientRect().left,
            start: gutters.getBoundingClientRect().right,
            end: scroller.getBoundingClientRect().right,
        };
    });
    expect(caret.left).toBeGreaterThanOrEqual(caret.start);
    expect(caret.left).toBeLessThanOrEqual(caret.end);
});
