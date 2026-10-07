import { expect, test } from "./playwright/harnessPage";
import { mountWorkbenchMerge } from "./legacyMerge";
import { mergeSelectors } from "./mergeSelectors";
import fixture from "./fixtures/merge-editor/conflicted.json";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";
import { buildWorkbenchDocument } from "../../src/webviews/react/merge-editor/workbenchModel";
import en from "../../src/webviews/i18n/en.json";

const selectors = mergeSelectors.workbench;
const data = fixture.messages[0].message.data as MergeEditorData;
const initial = buildWorkbenchDocument(data);
const first = initial.hunks.find((hunk) => hunk.id === 0);
if (!first) throw new Error("conflicted.json must contain hunk 0");

/** Resolves host colors through Chromium rather than assuming one serialized color syntax. */
async function color(page: import("@playwright/test").Page, variable: string): Promise<string> {
    return page.evaluate((name) => {
        if (!getComputedStyle(document.body).getPropertyValue(name).trim())
            throw new Error(`Missing CSS variable ${name}`);
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const result = getComputedStyle(probe).color;
        probe.remove();
        return result;
    }, variable);
}

test("workbench toolbar follows main's control order", async ({ mountHarness, page }) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    await expect
        .poll(() =>
            page
                .locator(".merge-toolbar .toolbar-left > *")
                .evaluateAll((children) =>
                    children.map((child) => [
                        child.className,
                        child.getAttribute("aria-label") ?? child.textContent,
                    ]),
                ),
        )
        .toEqual([
            ["toolbar-nav-group", ""],
            ["toolbar-icon-btn", "Undo"],
            ["toolbar-icon-btn", "Redo"],
            ["toolbar-icon-btn", "Find in result"],
            ["toolbar-icon-btn", "Base"],
            ["toolbar-icon-btn", "Confirm manual resolution"],
            ["toolbar-separator", ""],
            ["toolbar-select", en["merge.toolbar.ignoreMode.title"]],
            ["toolbar-btn subtle active", "Highlight words"],
            ["toolbar-btn subtle ", "Show Details"],
            ["toolbar-separator", ""],
            ["toolbar-icon-btn", en["merge.toolbar.applyNonConflicting"]],
            ["toolbar-icon-btn", "Accept All Yours"],
            ["toolbar-icon-btn", "Accept All Theirs"],
            ["toolbar-select", "Resolve change"],
        ]);
});

test("workbench details toggle visible and hidden", async ({ mountHarness, page }) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    const details = page.locator("#merge-details");
    await expect.soft(details).toBeHidden();
    await page.getByRole("button", { name: "Show Details", exact: true }).click();
    await expect.soft(details).toBeVisible();
    await page.getByRole("button", { name: "Hide Details", exact: true }).click();
    await expect.soft(details).toBeHidden();
});

test("workbench accept ours resolves and recolours conflict zero", async ({
    mountHarness,
    page,
}) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    const ours = page
        .locator(".pane-ours")
        .locator(selectors.codeRow)
        .filter({ hasText: first.segment.oursLines.join("\n") });
    const result = page.locator(".pane-result").locator(`${selectors.codeRow}.mrow-conflict`);
    await page.locator(selectors.acceptButton).first().click();
    await expect
        .poll(async () => ({
            text: await result.allTextContents(),
            ours: await ours.evaluateAll((rows) =>
                rows.map((row) => ({
                    accepted: row.classList.contains("mrow-accepted"),
                    background: getComputedStyle(row).backgroundColor,
                })),
            ),
            // Main keeps the result conflict-filled while the other side can still be stacked.
            result: await result.evaluateAll((rows) =>
                rows.map((row) => ({
                    pending: row.classList.contains("mrow-pending"),
                    filled: getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)",
                })),
            ),
        }))
        .toEqual({
            text: first.segment.oursLines,
            ours: first.segment.oursLines.map(() => ({
                accepted: true,
                background: "rgba(0, 0, 0, 0)",
            })),
            result: first.segment.oursLines.map(() => ({ pending: true, filled: true })),
        });
});

test("workbench rail counts fixture hunks and true conflicts", async ({ mountHarness, page }) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    // overviewMarkers emits one marker for every hunk, including automatic changes.
    await expect.soft(page.locator(".overview-marker")).toHaveCount(initial.hunks.length);
    await expect
        .soft(page.locator(".overview-marker.marker-conflict"))
        .toHaveCount(initial.hunks.filter((hunk) => hunk.conflict).length);
});

test("workbench has no removed PR chrome", async ({ mountHarness, page }) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    await expect(
        page.locator(
            ".mw-hunks, .mw-toolbar, .mw-connectors, .mw-footer, .mw-base, .mw-error, .mw-headings",
        ),
    ).toHaveCount(0);
});

test("workbench phantom rows have no number or background", async ({ mountHarness, page }) => {
    if (!data.workbench) throw new Error("conflicted.json must contain workbench input");
    for (const text of [data.workbench.ours, initial.content, data.workbench.theirs])
        if (!text.endsWith("\n")) throw new Error("phantom-row fixture must end with a line break");
    await mountWorkbenchMerge(mountHarness, page, data);
    const panes = [selectors.oursClass, selectors.resultClass, selectors.theirsClass];
    await expect
        .poll(() =>
            Promise.all(
                panes.map(async (pane) => {
                    const host = page.locator(`.${pane}`);
                    return {
                        number: await host.locator(selectors.numberRow).last().textContent(),
                        background: await host
                            .locator(selectors.codeRow)
                            .last()
                            .evaluate((row) => getComputedStyle(row).backgroundColor),
                    };
                }),
            ),
        )
        .toEqual(panes.map(() => ({ number: "", background: "rgba(0, 0, 0, 0)" })));
});

test("merge workbench uses host colors and keeps input decisions reversible", async ({
    mountHarness,
    page,
}) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    const result = page.locator('[data-testid="merge-editor-1"] .cm-content');
    await expect(result).toHaveAttribute("contenteditable", "true");
    await expect(page.locator('[data-testid="merge-editor-0"] .cm-content')).toHaveAttribute(
        "contenteditable",
        "false",
    );
    await expect(page.locator(selectors.root)).toHaveCSS(
        "background-color",
        await color(page, "--vscode-editor-background"),
    );
    await expect(result).toHaveCSS("color", await color(page, "--vscode-editor-foreground"));
    const original = await result.innerText();
    await page.locator(selectors.acceptButton).first().click();
    await expect(result).toContainText("TWO-MAIN");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => result.innerText()).toBe(original);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(result).toContainText("TWO-MAIN");
    await page.getByRole("button", { name: "Base", exact: true }).click();
    await expect(page.locator(".pane-base .cm-content")).toContainText("two");
    expect(
        await page
            .locator(selectors.ribbonPath)
            .evaluateAll(
                (paths) => paths.filter((path) => getComputedStyle(path).display !== "none").length,
            ),
    ).toBeGreaterThan(0);
    // Ribbon bbox and exclusion checks live in mergeWorkbenchRibbons.spec.ts cases a, c, d.
});

test("merge workbench avoids duplicate whole-line tint and retains word-level contrast", async ({
    mountHarness,
    page,
}) => {
    await mountWorkbenchMerge(mountHarness, page, data);
    const side = page.locator('[data-testid="merge-editor-2"]');
    const inserted = side.locator(selectors.codeRow).filter({ hasText: "THEIRS-ONLY-ADD" });
    await expect(inserted).toHaveCount(1);
    // Main keeps the inserted row's word spans but clears their fill and draws no word border.
    const insertedMarks = await inserted.locator(selectors.wordFill).evaluateAll((spans) =>
        spans.map((span) => {
            const style = getComputedStyle(span);
            return `${style.backgroundColor} / outline ${style.outlineStyle}`;
        }),
    );
    expect(insertedMarks.length).toBeGreaterThan(0);
    expect(new Set(insertedMarks)).toEqual(new Set(["rgba(0, 0, 0, 0) / outline none"]));
    const changed = side
        .locator(selectors.codeRow)
        .filter({ hasText: "TWO-CONFLICT" })
        .locator(selectors.wordFill);
    expect(await changed.count()).toBeGreaterThan(0);
    await expect(changed.first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("localized merge controls remain reachable without page overflow", async ({
    mountHarness,
    page,
}) => {
    await mountWorkbenchMerge(mountHarness, page, data, "de");
    const viewport = page.viewportSize()!;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
    );
    for (const control of await page
        .locator(".merge-toolbar button, .merge-toolbar select, .merge-footer button")
        .all()) {
        await expect(control).toBeInViewport();
        const box = await control.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    }
});
