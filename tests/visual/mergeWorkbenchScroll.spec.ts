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

async function caretBox(page: Page) {
    return page.evaluate(() => {
        const selection = window.getSelection();
        if (!selection?.focusNode) throw new Error("caret selection is missing");
        const range = document.createRange();
        range.setStart(selection.focusNode, selection.focusOffset);
        range.collapse(true);
        const box = range.getClientRects()[0];
        if (!box) throw new Error("caret has no measured rectangle");
        return box.toJSON();
    });
}

async function expectCaretInsideViewport(page: Page) {
    await expect
        .poll(async () => {
            const caret = await caretBox(page);
            const viewport = await page.locator(".merge-viewport").boundingBox();
            if (!viewport) throw new Error("merge viewport is missing");
            return (
                caret.height > 0 &&
                caret.top >= viewport.y - 1 &&
                caret.bottom <= viewport.y + viewport.height + 1 &&
                caret.left >= viewport.x - 1 &&
                caret.right <= viewport.x + viewport.width + 1
            );
        })
        .toBe(true);
}

async function wideLine(page: Page) {
    await page.locator(".merge-content").evaluate((element, number) => {
        const line = document.querySelector(".pane-result .cm-line");
        if (!line) throw new Error("line height is missing");
        element.scrollTop = (number - 2) * line.getBoundingClientRect().height;
    }, longLineNumber);
    await settleScroll(page);
}

// The bar's range grows only after CodeMirror draws the long line; scrolling earlier clamps to 0.
async function expectSharedOverflow(page: Page) {
    await expect
        .poll(
            () =>
                page
                    .locator(".merge-horizontal-scroll")
                    .evaluate((bar) => bar.scrollWidth - bar.clientWidth),
            { message: "long line creates shared horizontal overflow" },
        )
        .toBeGreaterThan(0);
}

async function scrollToFraction(page: Page, fraction: number) {
    await expectSharedOverflow(page);
    await page.locator(".merge-horizontal-scroll").evaluate((bar, part) => {
        bar.scrollLeft = (bar.scrollWidth - bar.clientWidth) * part;
        bar.dispatchEvent(new Event("scroll"));
    }, fraction);
    await expectHorizontalAgreement(page, fraction > 0);
}

async function clickVisibleWideLine(page: Page) {
    const point = await page.locator(".pane-result .cm-content").evaluate((content) => {
        const line = [...content.querySelectorAll(".cm-line")].find((element) =>
            element.textContent?.startsWith("wide "),
        );
        if (!line) throw new Error("wide line is missing");
        const box = content.getBoundingClientRect();
        const row = line.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: row.top + row.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
}

// Compare against the same frame with only the requested paint hidden. This avoids counting
// text or gutter icons that happen to share the theme's cursor/selection colour. Given `frames`
// (two shots of an unmoved view), count pixels the paint toggles between them in either order.
async function paintCounts(
    page: Page,
    kind: "caret" | "selection",
    frames?: { before: Buffer; after: Buffer },
) {
    const geometry = await page.locator(".pane-result .cm-content").evaluate((content, kind) => {
        const name =
            kind === "caret"
                ? "--vscode-editorCursor-foreground"
                : "--vscode-editor-selectionBackground";
        const colour = getComputedStyle(content).getPropertyValue(name).trim();
        if (!colour || !CSS.supports("color", colour)) throw new Error(`${name} is missing`);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        const rgba = [...context.getImageData(0, 0, 1, 1).data];
        if (!rgba[3]) throw new Error(`${name} has no paint`);
        const line = [...content.querySelectorAll(".cm-line")].find((element) =>
            element.textContent?.startsWith("wide "),
        );
        if (!line) throw new Error("paint row is missing");
        const gutters = [...document.querySelectorAll(".merge-content .cm-gutters")];
        if (!gutters.length) throw new Error("gutter boxes are missing");
        return {
            rgba,
            code: content.getBoundingClientRect().toJSON(),
            row: line.getBoundingClientRect().toJSON(),
            gutters: gutters.map((element) => element.getBoundingClientRect().toJSON()),
            ratio: devicePixelRatio,
        };
    }, kind);
    const hidden =
        kind === "caret"
            ? ".cm-content, .cm-content * { caret-color: transparent !important; } .cm-cursor { visibility: hidden !important; }"
            : ".cm-content::selection, .cm-content ::selection { background: transparent !important; } .cm-selectionBackground { visibility: hidden !important; }";
    const before = frames?.before ?? (await page.screenshot({ caret: "initial", style: hidden }));
    const after = frames?.after ?? (await page.screenshot({ caret: "initial" }));
    return page.evaluate(
        async ({ before, after, geometry, either }) => {
            const decode = async (base64: string) => {
                const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
                const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d", { willReadFrequently: true })!;
                context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, image.width, image.height);
                image.close();
                return pixels;
            };
            const [base, painted] = await Promise.all([decode(before), decode(after)]);
            const { rgba, code, row, gutters, ratio } = geometry;
            // A fractional clip edge can paint a partially covered device pixel. Gutters count
            // only whole pixels, so their shared edge is not mistaken for gutter bleed.
            const coversPixel = (box: typeof code, x: number, y: number) =>
                x + 1 > box.left * ratio &&
                x < box.right * ratio &&
                y + 1 > box.top * ratio &&
                y < box.bottom * ratio;
            const containsPixel = (box: typeof code, x: number, y: number) =>
                x >= box.left * ratio &&
                x + 1 <= box.right * ratio &&
                y >= box.top * ratio &&
                y + 1 <= box.bottom * ratio;
            const counts = { code: 0, gutters: 0, outside: 0 };
            for (let y = Math.ceil(row.top * ratio); y < Math.floor(row.bottom * ratio); y++) {
                for (let x = 0; x < painted.width; x++) {
                    const offset = (y * painted.width + x) * 4;
                    const changed = [0, 1, 2].some(
                        (channel) => painted.data[offset + channel] !== base.data[offset + channel],
                    );
                    const over = (top: ImageData, under: ImageData) =>
                        [0, 1, 2].every(
                            (channel) =>
                                top.data[offset + channel] ===
                                Math.round(
                                    (rgba[channel] * rgba[3]) / 255 +
                                        under.data[offset + channel] * (1 - rgba[3] / 255),
                                ),
                        );
                    const matches = over(painted, base) || (either && over(base, painted));
                    if (!changed || !matches) continue;
                    if (coversPixel(code, x, y)) counts.code++;
                    else counts.outside++;
                    if (gutters.some((box) => containsPixel(box, x, y))) counts.gutters++;
                }
            }
            return counts;
        },
        {
            before: before.toString("base64"),
            after: after.toString("base64"),
            geometry,
            either: Boolean(frames),
        },
    );
}

// Chrome does not repaint a native caret for a caret-color change, so a style-hidden frame can
// still show it. Instead wait up to 3 seconds for the native blink to toggle the caret between
// adjacent frames of an unmoved view; any movement restarts from the newer frame.
async function expectCaretPaint(page: Page, step: string) {
    const view = () =>
        page.evaluate(() =>
            JSON.stringify([
                window.getSelection()!.getRangeAt(0).getBoundingClientRect(),
                document.querySelector(".merge-horizontal-scroll")!.scrollLeft,
                document.querySelector(".merge-content")!.scrollTop,
            ]),
        );
    const frame = async () => {
        const state = await view();
        const png = await page.screenshot({ caret: "initial" });
        return { png, state: state === (await view()) ? state : undefined };
    };
    let reference = await frame();
    let paint = { code: 0, gutters: 0, outside: 0 };
    for (const deadline = Date.now() + 3000; !paint.code && Date.now() < deadline;) {
        await page.waitForTimeout(100);
        const next = await frame();
        if (next.state && next.state === reference.state)
            paint = await paintCounts(page, "caret", { before: reference.png, after: next.png });
        reference = next;
    }
    expect(paint.code, `${step}: caret paints inside the code area`).toBeGreaterThan(0);
    expect(paint.gutters, `${step}: no caret paint in gutters`).toBe(0);
    expect(paint.outside, `${step}: no caret paint outside code`).toBe(0);
}

async function settleScroll(
    page: Page,
    selector = ".merge-content",
    axis: "scrollTop" | "scrollLeft" = "scrollTop",
) {
    let previous = -1;
    let stable = 0;
    await expect
        .poll(
            async () => {
                const current = await page.locator(selector).evaluate((el, key) => el[key], axis);
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

async function expectHorizontalAgreement(page: Page, positive = true) {
    const bar = page.locator(".merge-horizontal-scroll");
    await expect
        .poll(() =>
            bar.evaluate((el) => ({
                left: el.scrollLeft,
                width: el.clientWidth,
                total: el.scrollWidth,
                panes: [...document.querySelectorAll(".merge-content .cm-content")].map((pane) => ({
                    width: pane.clientWidth,
                    total: pane.scrollWidth,
                    left: pane.scrollLeft,
                })),
                positive: el.scrollLeft > 0,
            })),
        )
        .toMatchObject({ positive });
    await expect
        .poll(async () => {
            const left = await bar.evaluate((el) => el.scrollLeft);
            return page
                .locator(".merge-content .cm-content")
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

test("sideways caret paint is visible inside code and clipped at both edges", async ({ page }) => {
    await wideLine(page);
    await clickVisibleWideLine(page);
    await page.keyboard.press("End");
    await scrollToFraction(page, 0.5);
    await clickVisibleWideLine(page);
    await expectCaretPaint(page, "sideways");
    for (const fraction of [1, 0]) {
        await scrollToFraction(page, fraction);
        const caret = await caretBox(page);
        const code = await page.locator(".pane-result .cm-content").boundingBox();
        if (!code) throw new Error("code box is missing");
        expect(
            caret.x < code.x || caret.x > code.x + code.width,
            "caret crossed the clip edge",
        ).toBe(true);
        for (let frame = 0; frame < 3; frame++) {
            const paint = await paintCounts(page, "caret");
            expect(paint.gutters, "clipped caret never paints in a gutter").toBe(0);
            expect(paint.outside, "clipped caret never paints outside code").toBe(0);
            expect(paint.code, "scrolled-past caret no longer paints inside code").toBe(0);
        }
    }
});

test("sideways selection crossing either clip edge paints only inside code", async ({ page }) => {
    await wideLine(page);
    await clickVisibleWideLine(page);
    await page.keyboard.press("End");
    for (const key of ["End", "Home"]) {
        await scrollToFraction(page, 0.5);
        await clickVisibleWideLine(page);
        await page.keyboard.press(`Shift+${key}`);
        // Keyboard selection reveals its head a frame later; let that land, then restore the
        // shared offset to cross the clip edge.
        await settleScroll(page, ".merge-horizontal-scroll", "scrollLeft");
        await scrollToFraction(page, 0.5);
        const crosses = await page.locator(".pane-result .cm-content").evaluate((content) => {
            const selection = window.getSelection();
            if (!selection?.rangeCount) throw new Error("selection range is missing");
            const range = selection.getRangeAt(0).getBoundingClientRect();
            const code = content.getBoundingClientRect();
            return (
                range.right > code.left &&
                range.left < code.right &&
                (range.left < code.left || range.right > code.right)
            );
        });
        expect(crosses, `${key}: selection straddles a measured code edge`).toBe(true);
        const paint = await paintCounts(page, "selection");
        expect(paint.code, `${key}: selection paints inside code`).toBeGreaterThan(0);
        expect(paint.gutters, `${key}: no selection-coloured pixels in any gutter`).toBe(0);
        expect(paint.outside, `${key}: no selection-coloured pixels outside code`).toBe(0);
    }
});

test("keyboard End arrows and Home keep caret paint and all panes synchronized", async ({
    page,
}) => {
    await wideLine(page);
    await expectSharedOverflow(page);
    await clickVisibleWideLine(page);
    const steps = await page.locator(".pane-result .cm-content").evaluate((content) => {
        const line = [...content.querySelectorAll(".cm-line")].find((element) =>
            element.textContent?.startsWith("wide "),
        );
        if (!line) throw new Error("wide line is missing");
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text?.textContent) throw new Error("wide line text is missing");
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const width = range.getBoundingClientRect().width;
        if (!width || !content.clientWidth) throw new Error("keyboard geometry is missing");
        return Math.ceil(content.clientWidth / width) + 1;
    });
    await page.keyboard.press("End");
    await expectCaretPaint(page, "End");
    await expectHorizontalAgreement(page);
    for (const key of ["ArrowLeft", "ArrowRight"]) {
        for (let index = 0; index < steps; index++) await page.keyboard.press(key);
        await expectCaretPaint(page, key);
        await expectHorizontalAgreement(page);
    }
    await page.keyboard.press("Home");
    await expectCaretPaint(page, "Home");
    await expectHorizontalAgreement(page, false);
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
    await expectCaretInsideViewport(page);
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
    await expectCaretInsideViewport(page);
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

for (const [gesture, deltaX, deltaY, shift] of [
    ["a sideways trackpad swipe", 200, 0, false],
    ["Shift+wheel", 0, 200, true],
] as const) {
    test(`${gesture} over the panes moves all three editors`, async ({ page }) => {
        await wideLine(page);
        await expectSharedOverflow(page);
        const box = await page.locator(".merge-content").boundingBox();
        if (!box) throw new Error("merge content has no box");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        if (shift) await page.keyboard.down("Shift");
        await page.mouse.wheel(deltaX, deltaY);
        if (shift) await page.keyboard.up("Shift");
        await expectHorizontalAgreement(page);
    });
}

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
        const pane = element.getBoundingClientRect();
        return {
            x: pane.left + pane.width / 2,
            y: line.top + line.height / 2,
        };
    });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("ArrowDown");
    await expect
        .poll(() =>
            page
                .locator(".merge-horizontal-scroll, .merge-content .cm-content")
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
                    const panes = [...document.querySelectorAll(".merge-content .cm-content")];
                    if (panes.length !== 3) throw new Error("expected three editor scrollers");
                    return Math.max(
                        ...panes.map((pane) => Math.abs(pane.scrollLeft - element.scrollLeft)),
                    );
                }),
            { message: "all three editor scrollLeft values must match the shared bar" },
        )
        .toBeLessThanOrEqual(1);
    const caret = await caretBox(page);
    const code = await page.locator(".pane-result .cm-content").boundingBox();
    if (!code) throw new Error("result content box is missing");
    expect(caret.left).toBeGreaterThanOrEqual(code.x);
    expect(caret.left).toBeLessThanOrEqual(code.x + code.width);
});
