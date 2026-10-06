import type { Page } from "@playwright/test";
import { expect, test } from "./playwright/harnessPage";
import { mountWorkbenchMerge } from "./legacyMerge";
import fixture from "./fixtures/merge-editor/conflicted.json";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";
import { LINE_HEIGHT_PX } from "../../src/webviews/react/diff-core/mergeScrollLayout";

const data = fixture.messages[0].message.data as MergeEditorData;
const conflicts = data.segments.filter((segment) => segment.type === "conflict");
const first = conflicts[0];
const next = conflicts[1];
const paths = "svg.merge-connectors path.merge-connector";
const missingGutter = /merge-editor: CSS variable --merge-line-number-gutter is missing or 0/;

async function scrollTo(page: Page, top: number) {
    await page.locator(".merge-content").evaluate((element, value) => {
        element.scrollTop = value;
    }, top);
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => resolve());
                }),
            ),
    );
}

async function rowExtent(page: Page, pane: string, texts: string[]) {
    return page.locator(`.pane-${pane} .cm-line`).evaluateAll((elements, expected) => {
        const rows = expected.map((text) => {
            const matches = elements.filter((element) => element.textContent === text);
            if (matches.length !== 1) throw new Error(`expected one owned row for ${text}`);
            return matches[0].getBoundingClientRect();
        });
        if (!rows.length) throw new Error("expected non-empty owned rows");
        const top = Math.min(...rows.map((row) => row.top));
        return { top, bottom: Math.max(top + 3, ...rows.map((row) => row.bottom)) };
    }, texts);
}

async function expectUnion(
    page: Page,
    index: number,
    left: { pane: string; rows: string[] },
    right: { pane: string; rows: string[] },
) {
    const path = page.locator(paths).nth(index);
    await expect(path).toHaveAttribute("d", /\S/);
    await expect(path).not.toHaveCSS("display", "none");
    await expect
        .poll(
            async () => {
                const a = await rowExtent(page, left.pane, left.rows);
                const b = await rowExtent(page, right.pane, right.rows);
                const box = await path.boundingBox();
                if (!box) throw new Error("ribbon has no box");
                return Math.max(
                    Math.abs(box.y - Math.min(a.top, b.top)),
                    Math.abs(box.y + box.height - Math.max(a.bottom, b.bottom)),
                );
            },
            { message: `ribbon ${index} must span its adjacent owned rows` },
        )
        .toBeLessThanOrEqual(1);
}

async function expectFirstUnion(page: Page) {
    const result = { pane: "result", rows: first.baseLines };
    await expectUnion(page, 0, { pane: "ours", rows: first.oursLines }, result);
    await expectUnion(page, 1, result, { pane: "theirs", rows: first.theirsLines });
}

async function expectEdgeExtents(
    page: Page,
    index: number,
    left: { pane: string; rows: string[] },
    right: { pane: string; rows: string[] },
) {
    const a = await rowExtent(page, left.pane, left.rows);
    const b = await rowExtent(page, right.pane, right.rows);
    const viewport = await page.locator(".merge-viewport").boundingBox();
    if (!viewport) throw new Error("merge viewport has no box");
    for (const extent of [a, b]) {
        expect(extent.top).toBeGreaterThanOrEqual(viewport.y);
        expect(extent.bottom).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
    await expect(page.locator(paths).nth(index)).not.toHaveCSS("display", "none");
    const actual = await page
        .locator(paths)
        .nth(index)
        .evaluate((element) => {
            const path = element as SVGPathElement;
            const matrix = path.getScreenCTM();
            const d = path.getAttribute("d");
            if (!matrix || !d) throw new Error("ribbon geometry is missing");
            // Band endpoints: initial M, the third/fourth L, and the last L.
            const points = [...d.matchAll(/[ML] ([-\d.]+),([-\d.]+)/g)].map((match) =>
                new DOMPoint(Number(match[1]), Number(match[2])).matrixTransform(matrix),
            );
            if (points.length !== 6) throw new Error(`unexpected band path: ${d}`);
            return {
                leftTop: points[0].y,
                leftBottom: points[5].y,
                rightTop: points[2].y,
                rightBottom: points[3].y,
            };
        });
    for (const [edge, expected] of Object.entries({
        leftTop: a.top,
        leftBottom: a.bottom,
        rightTop: b.top,
        rightBottom: b.bottom,
    })) {
        expect(
            Math.abs(actual[edge as keyof typeof actual] - expected),
            `ribbon ${index} ${edge}: actual ${actual[edge as keyof typeof actual]}, owned row ${expected}`,
        ).toBeLessThanOrEqual(1);
    }
}

test.beforeEach(async ({ mountHarness, page }, testInfo) => {
    await mountWorkbenchMerge(async (context, options) => {
        const harness = await mountHarness(context, options);
        if (testInfo.title === "zero-width gutters surface the required CSS-variable error") {
            harness.allowConsoleError(missingGutter);
        }
        return harness;
    }, page);
    await expect(page.locator(paths)).toHaveCount(3);
    await expect(page.locator(paths).first()).toHaveAttribute("d", /\S/);
});

test.afterEach(async ({ page }) => {
    await expect
        .poll(() =>
            page.locator(".merge-viewport, .merge-col").evaluateAll((elements) =>
                elements.map((element) => ({
                    top: element.scrollTop,
                    left: element.scrollLeft,
                })),
            ),
        )
        .toEqual(Array.from({ length: 4 }, () => ({ top: 0, left: 0 })));
});

test("ribbons span the divider at the hunk's rows", async ({ page }) => {
    await expect(
        page.locator(".pane-ours .cm-line.mrow-pending").filter({ hasText: first.oursLines[0] }),
    ).toHaveCount(first.oursLines.length);
    await expectFirstUnion(page);
    for (const index of [0, 1]) {
        await expect(page.locator(paths).nth(index)).toHaveClass(/change-conflict/);
        await expect(page.locator(paths).nth(index)).not.toHaveClass(/connector-resolved/);
    }
    const edges = await page.evaluate((selector) => {
        const rect = (query: string) => {
            const element = document.querySelector(query);
            if (!element) throw new Error(`missing ${query}`);
            return element.getBoundingClientRect();
        };
        const oursHost = document.querySelector(".pane-ours");
        if (!oursHost) throw new Error("ours editor host is missing");
        // The PR chrome still has a host border; main's band spans use the column's outer edge.
        const hostBorder = Number.parseFloat(getComputedStyle(oursHost).borderRightWidth);
        return [...document.querySelectorAll(selector)].slice(0, 2).map((path, index) => ({
            left: path.getBoundingClientRect().left,
            right: path.getBoundingClientRect().right,
            start:
                index === 0
                    ? rect(".pane-ours .cm-gutters-after").left + hostBorder
                    : rect(".col-middle").right,
            end: rect(index === 0 ? ".pane-result .cm-gutters" : ".pane-theirs .cm-gutters").right,
        }));
    }, paths);
    for (const edge of edges) {
        expect(Math.abs(edge.left - edge.start), JSON.stringify(edge)).toBeLessThanOrEqual(1);
        expect(Math.abs(edge.right - edge.end), JSON.stringify(edge)).toBeLessThanOrEqual(1);
    }
});

test("ribbons follow the shared scroll", async ({ page }) => {
    await scrollTo(page, LINE_HEIGHT_PX);
    expect(await page.locator(".merge-content").evaluate((element) => element.scrollTop)).toBe(
        LINE_HEIGHT_PX,
    );
    await expectFirstUnion(page);
});

test("accepting a side turns its ribbon into a resolved contour", async ({ page }) => {
    await page.locator(".pane-ours .accept-btn").first().click();
    await expect(page.locator(paths).nth(0)).toHaveClass(/connector-resolved/);
    await expect(page.locator(paths).nth(1)).not.toHaveClass(/connector-resolved/);
    await expect(page.locator(paths).nth(0)).toHaveAttribute("d", / Z M /);
});

test("typing inside a hunk removes its ribbons", async ({ page }) => {
    const before = await page.locator(paths).count();
    await page
        .locator(".pane-result .cm-line")
        .filter({ hasText: new RegExp(`^${first.baseLines[0]}$`) })
        .click();
    await page.keyboard.type("z");
    await expect(page.locator(paths)).toHaveCount(before - 2);
    await expectUnion(
        page,
        0,
        { pane: "result", rows: next.theirsLines },
        { pane: "theirs", rows: next.theirsLines },
    );
});

test("a hunk scrolled out of view hides its ribbon", async ({ page }) => {
    await scrollTo(
        page,
        (data.segments[0].type === "common"
            ? data.segments[0].lines.length + first.baseLines.length + 1
            : 0) * LINE_HEIGHT_PX,
    );
    for (const index of [0, 1])
        await expect(page.locator(paths).nth(index)).toHaveCSS("display", "none");
});

test("ribbons line up with both columns when the pane offsets differ", async ({
    mountHarness,
    page,
}) => {
    // The committed corpus has no two-sided hunk after unequal-length content.
    // Prefix it with a conflict derived from its first hunk; keep the target hunk intact.
    const prefix = {
        ...first,
        id: Math.max(...conflicts.map((hunk) => hunk.id)) + 1,
        oursLines: Array.from({ length: first.oursLines.length + 1 }, (_, i) => `prefix ours ${i}`),
        baseLines: first.baseLines.map((line) => `prefix ${line}`),
        theirsLines: Array.from(
            { length: first.theirsLines.length + 2 },
            (_, i) => `prefix theirs ${i}`,
        ),
    };
    if (!data.workbench) throw new Error("fixture workbench snapshot is missing");
    await mountWorkbenchMerge(mountHarness, page, {
        ...data,
        segments: [prefix, ...data.segments],
        workbench: {
            ...data.workbench,
            base: prefix.baseLines.join("\n") + "\n" + data.workbench.base,
            ours: prefix.oursLines.join("\n") + "\n" + data.workbench.ours,
            theirs: prefix.theirsLines.join("\n") + "\n" + data.workbench.theirs,
        },
    });
    await expect(page.locator(paths)).toHaveCount(5);
    await scrollTo(
        page,
        Math.max(prefix.oursLines.length, prefix.baseLines.length, prefix.theirsLines.length) *
            LINE_HEIGHT_PX,
    );
    await expect
        .poll(() =>
            page.locator(".merge-col").evaluateAll((columns) => {
                const offsets = columns.map(
                    (column) => new DOMMatrixReadOnly(getComputedStyle(column).transform).m42,
                );
                return {
                    offsets,
                    nonzero: offsets.every((offset) => offset !== 0),
                    distinct: new Set(offsets).size,
                };
            }),
        )
        .toMatchObject({ nonzero: true, distinct: 3 });
    await expectEdgeExtents(
        page,
        2,
        { pane: "ours", rows: first.oursLines },
        { pane: "result", rows: first.baseLines },
    );
    await expectEdgeExtents(
        page,
        3,
        { pane: "result", rows: first.baseLines },
        { pane: "theirs", rows: first.theirsLines },
    );
});

test("zero-width gutters surface the required CSS-variable error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    const geometry = await page.locator(".merge-viewport").evaluate((viewport) => ({
        width: viewport.clientWidth,
        variable: getComputedStyle(viewport).getPropertyValue("--merge-line-number-gutter").trim(),
    }));
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.variable).toBe("");
    await page.addStyleTag({
        content: ".merge-workbench .cm-gutters { display: none !important; }",
    });
    const gutterCount = await page.locator(".merge-col .cm-gutters").count();
    expect(gutterCount).toBeGreaterThan(0);
    await expect
        .poll(() =>
            page
                .locator(".merge-col .cm-gutters")
                .evaluateAll((gutters) =>
                    gutters.map((gutter) => (gutter as HTMLElement).offsetWidth),
                ),
        )
        .toEqual(Array.from({ length: gutterCount }, () => 0));
    await scrollTo(page, LINE_HEIGHT_PX);
    await expect.poll(() => errors.join("\n")).toMatch(missingGutter);
});
