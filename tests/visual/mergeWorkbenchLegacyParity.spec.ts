import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";
import conflict from "./fixtures/merge-editor/conflicted.json";
import { mountLegacyMerge, mountWorkbenchMerge } from "./legacyMerge";
import { mergeSelectors } from "./mergeSelectors";
import { expect, test } from "./playwright/harnessPage";

test("word-change outlines and borders match legacy, including high contrast", async ({
    mountHarness,
    page,
}, testInfo) => {
    const samples = [];
    for (const target of ["legacy", "workbench"] as const) {
        if (target === "legacy")
            await mountLegacyMerge(mountHarness, page, "en", { sessionKind: "gitMerge" });
        else await mountWorkbenchMerge(mountHarness, page);
        const selectors = mergeSelectors[target];
        // Read every mark across all panes and row variants, not just inserted rows.
        const marks = page.locator(`${selectors.root} ${selectors.wordFill}`);
        await expect.poll(() => marks.count()).toBeGreaterThan(0);
        const styles = await marks.evaluateAll((elements) =>
            elements.map((element) => {
                const style = getComputedStyle(element);
                return {
                    outlineStyle: style.outlineStyle,
                    outlineWidth: style.outlineWidth,
                    borderTopStyle: style.borderTopStyle,
                    borderRightStyle: style.borderRightStyle,
                    borderBottomStyle: style.borderBottomStyle,
                    borderLeftStyle: style.borderLeftStyle,
                };
            }),
        );
        expect(styles.length, `${target} word marks must not be empty`).toBeGreaterThan(0);
        samples.push(styles);
        await testInfo.attach(`${target}-word-change-edges`, {
            body: JSON.stringify(styles, null, 2),
            contentType: "application/json",
        });
    }
    const [legacy, workbench] = samples;
    expect(new Set(workbench.map((style) => JSON.stringify(style)))).toEqual(
        new Set(legacy.map((style) => JSON.stringify(style))),
    );
    if (testInfo.project.name.startsWith("hc-")) {
        for (const style of legacy) {
            expect(style.outlineStyle === "none" || style.outlineWidth === "0px").toBe(true);
            expect([
                style.borderTopStyle,
                style.borderRightStyle,
                style.borderBottomStyle,
                style.borderLeftStyle,
            ]).toEqual(["none", "none", "none", "none"]);
        }
    }
});

interface Bitmap {
    width: number;
    height: number;
    data: Buffer;
}

async function decode(page: Page, bytes: Buffer): Promise<Bitmap> {
    const decoded = await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
            colorSpaceConversion: "none",
            premultiplyAlpha: "none",
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        const { width, height } = image;
        image.close();
        // Base64 avoids serializing millions of pixel-array entries across the browser protocol.
        let binary = "";
        for (let offset = 0; offset < pixels.length; offset += 8192)
            binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
        return { width, height, data: btoa(binary) };
    }, bytes.toString("base64"));
    return { ...decoded, data: Buffer.from(decoded.data, "base64") };
}

async function encode(page: Page, bitmap: Bitmap): Promise<Buffer> {
    const url = await page.evaluate(
        ({ width, height, data }) => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!.putImageData(
                new ImageData(
                    Uint8ClampedArray.from(atob(data), (char) => char.charCodeAt(0)),
                    width,
                    height,
                ),
                0,
                0,
            );
            return canvas.toDataURL("image/png");
        },
        { ...bitmap, data: bitmap.data.toString("base64") },
    );
    return Buffer.from(url.split(",")[1], "base64");
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function boxes(page: Page, selector: string): Promise<Box[]> {
    return page.locator(selector).evaluateAll((elements) => {
        const shell = document.querySelector(".merge-content-shell")!.getBoundingClientRect();
        return elements.map((element) => {
            const rect = element.getBoundingClientRect();
            let { left, right, top, bottom } = rect;
            // Measure the visible region: overflowing word boxes can otherwise reach the rail.
            for (
                let ancestor = element.parentElement;
                ancestor;
                ancestor = ancestor.parentElement
            ) {
                const style = getComputedStyle(ancestor);
                const clip = ancestor.getBoundingClientRect();
                if (style.overflowX !== "visible") {
                    left = Math.max(left, clip.left);
                    right = Math.min(right, clip.right);
                }
                if (style.overflowY !== "visible") {
                    top = Math.max(top, clip.top);
                    bottom = Math.min(bottom, clip.bottom);
                }
            }
            return {
                x: left - shell.x,
                y: top - shell.y,
                width: Math.max(0, right - left),
                height: Math.max(0, bottom - top),
            };
        });
    });
}

async function heights(page: Page) {
    return page.evaluate(() => {
        const selectors = {
            toolbar: ".merge-toolbar",
            notices: ".merge-notice, [role=alert]",
            headers: ".pane-headers, .pane-meta-row",
            shell: ".merge-content-shell",
            rail: ".overview-rail",
            content: ".merge-content",
            viewport: ".merge-viewport",
            footer: ".merge-footer",
        };
        const elements = Object.fromEntries(
            Object.entries(selectors).map(([name, selector]) => [
                name,
                [...document.querySelectorAll(selector)].map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        top: rect.top,
                        height: rect.height,
                        width: rect.width,
                        className: element.className,
                    };
                }),
            ]),
        );
        const children = [...document.querySelector(".merge-editor")!.children].map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
                className: element.className,
                top: rect.top,
                height: rect.height,
                marginTop: style.marginTop,
                marginBottom: style.marginBottom,
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                borderTop: style.borderTopWidth,
                borderBottom: style.borderBottomWidth,
            };
        });
        return { viewportHeight: innerHeight, elements, children };
    });
}

async function markers(page: Page) {
    return page.locator(".overview-marker").evaluateAll((elements) => {
        const rail = document.querySelector(".overview-rail")!.getBoundingClientRect();
        return elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
                name: element.getAttribute("aria-label"),
                x: rect.x - rail.x,
                width: rect.width,
                top: rect.top - rail.top,
                bottom: rect.bottom - rail.top,
                colour: [
                    style.backgroundColor,
                    style.color,
                    style.opacity,
                    style.outlineColor,
                    style.boxShadow,
                ],
            };
        });
    });
}

type Capture = Awaited<ReturnType<typeof capture>>;

function requiredHeight(measurement: Capture, name: string) {
    const elements = measurement.heights.elements[name];
    expect(elements, `${name}: required DOM element`).toHaveLength(1);
    expect(elements[0].height, `${name}: positive DOM height`).toBeGreaterThan(0);
    return elements[0].height;
}

function compareRail(main: Capture, workbench: Capture) {
    const mainHeight = requiredHeight(main, "rail");
    const workbenchHeight = requiredHeight(workbench, "rail");
    expect
        .soft(
            mainHeight - workbenchHeight,
            "rail: height difference must equal toolbar difference (no non-toolbar contribution)",
        )
        .toBe(requiredHeight(workbench, "toolbar") - requiredHeight(main, "toolbar"));
    if (mainHeight === workbenchHeight) return false;
    // Pixels skip the rail when heights differ, so its own paint is compared as computed style.
    expect.soft(workbench.railStyle, "rail: background and borders").toEqual(main.railStyle);
    expect(main.markers.length, "rail: fixture must exercise markers").toBeGreaterThan(0);
    expect(workbench.markers, "rail: marker count").toHaveLength(main.markers.length);
    const scale = workbenchHeight / mainHeight;
    for (const [index, before] of main.markers.entries()) {
        const after = workbench.markers[index];
        const name = `rail: marker ${index} (${before.name})`;
        expect.soft(after.name, `${name}: identity`).toBe(before.name);
        expect.soft(after.x, `${name}: x`).toBe(before.x);
        expect.soft(after.width, `${name}: width`).toBe(before.width);
        expect.soft(after.colour, `${name}: colour`).toEqual(before.colour);
        expect
            .soft(Math.abs(after.top - before.top * scale), `${name}: proportional top`)
            .toBeLessThanOrEqual(1);
        expect
            .soft(Math.abs(after.bottom - before.bottom * scale), `${name}: proportional bottom`)
            .toBeLessThanOrEqual(1);
    }
    return true;
}

async function capture(page: Page, path: string) {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        for (const svg of document.querySelectorAll("svg")) {
            svg.pauseAnimations();
            svg.setCurrentTime(0);
        }
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
    });
    const rails = await boxes(page, ".overview-rail");
    const bytes = await page
        .locator(".merge-content-shell")
        .screenshot({ path, animations: "disabled" });
    return {
        image: await decode(page, bytes),
        rails,
        heights: await heights(page),
        markers: await markers(page),
        railStyle: await page.locator(".overview-rail").evaluate((rail) => {
            const style = getComputedStyle(rail);
            return [
                style.width,
                style.backgroundColor,
                style.backgroundImage,
                style.opacity,
                style.boxShadow,
                ...["Top", "Right", "Bottom", "Left"].flatMap((side) =>
                    ["Width", "Style", "Color"].map((part) =>
                        style.getPropertyValue(
                            `border-${side.toLowerCase()}-${part.toLowerCase()}`,
                        ),
                    ),
                ),
            ];
        }),
    };
}

function contains(box: Box, x: number, y: number) {
    return (
        box.width > 0 &&
        box.height > 0 &&
        x >= Math.floor(box.x) &&
        x < Math.ceil(box.x + box.width) &&
        y >= Math.floor(box.y) &&
        y < Math.ceil(box.y + box.height)
    );
}

function rgb(image: Bitmap, x: number, y: number) {
    const offset = (y * image.width + x) * 4;
    return image.data.subarray(offset, offset + 3).join(",");
}

function compare(main: Bitmap, workbench: Bitmap) {
    // Height may differ by the toolbar (see compareRail); width never may.
    expect(workbench.width, "shell screenshot width must match main").toBe(main.width);
    const width = Math.min(main.width, workbench.width);
    const height = Math.min(main.height, workbench.height);
    const diff: Bitmap = { width, height, data: Buffer.alloc(width * height * 4) };
    const changed: { x: number; y: number }[] = [];
    const pairs = new Map<string, number>();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            diff.data[offset + 3] = 255;
            const before = rgb(main, x, y);
            const after = rgb(workbench, x, y);
            if (before === after) continue;
            changed.push({ x, y });
            const pair = `${before}->${after}`;
            pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
            diff.data[offset] = 255;
        }
    }
    const bbox = changed.reduce(
        (bounds, { x, y }) => ({
            left: Math.min(bounds.left, x),
            top: Math.min(bounds.top, y),
            right: Math.max(bounds.right, x),
            bottom: Math.max(bounds.bottom, y),
        }),
        { left: width, top: height, right: -1, bottom: -1 },
    );
    return { diff, changed, bbox, pairs: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 5) };
}

test("workbench matches legacy below the toolbar at threshold 0", async ({
    mountHarness,
    page,
}, testInfo) => {
    await defaultCase(mountHarness, page, testInfo);
});

/** Default state; both renderers load with the first conflict active, so it is also the active state. */
async function defaultCase(
    mountHarness: Parameters<typeof mountWorkbenchMerge>[0],
    page: Page,
    testInfo: TestInfo,
) {
    // Same session kind as the workbench fixture (a git merge): main's merge editor, not its shelf footer.
    await mountLegacyMerge(mountHarness, page, "en", { sessionKind: "gitMerge" });
    const main = await capture(page, testInfo.outputPath("main.png"));
    await mountWorkbenchMerge(mountHarness, page);
    const workbench = await capture(page, testInfo.outputPath("workbench.png"));
    for (const [name, renderer] of [
        ["main", main],
        ["workbench", workbench],
    ] as const) {
        for (const element of [
            "toolbar",
            "headers",
            "shell",
            "rail",
            "content",
            "viewport",
            "footer",
        ])
            requiredHeight(renderer, element);
        // Layout heights can be fractional, so the sum is compared to 3 decimal places.
        expect(
            renderer.heights.children.reduce((sum, child) => sum + child.height, 0),
            `${name}: measured flow heights sum to viewport`,
        ).toBeCloseTo(renderer.heights.viewportHeight, 3);
    }
    const measurements = { main: main.heights, workbench: workbench.heights };
    await writeFile(testInfo.outputPath("heights.json"), JSON.stringify(measurements, null, 2));
    console.log(`${testInfo.project.name}: heights=${JSON.stringify(measurements)}`);
    const ratio = await page.evaluate(() => devicePixelRatio);
    const rails = [...main.rails, ...workbench.rails].map((box) => toDevice(box, ratio));
    const comparison = compare(main.image, workbench.image);
    await writeFile(testInfo.outputPath("diff.png"), await encode(page, comparison.diff));
    await writeFile(
        testInfo.outputPath("residuals.json"),
        JSON.stringify(
            comparison.changed.map(({ x, y }) => ({
                x,
                y,
                main: rgb(main.image, x, y),
                workbench: rgb(workbench.image, x, y),
            })),
        ),
    );
    const message = `${testInfo.project.name} (device pixel ratio ${ratio}): ${comparison.changed.length} changed pixels; bbox=${JSON.stringify(comparison.bbox)}; top 5 main->workbench=${JSON.stringify(comparison.pairs)}`;
    console.log(message);
    // Named regions localize regressions; the final assertion also checks every other pixel.
    const cases = [
        ["rail", ".overview-rail"],
        ["active ring", ".mrow-active"],
        ["result text", ".pane-result .cm-line.mrow-conflict"],
        ["word-fill corners", ".word-diff-change"],
        ["D1 code-band boundaries", ".cm-line.mrow-conflict"],
        ["D2a pending gutter seams", ".cm-gutterElement.mrow-pending.mrow-conflict"],
        [
            "D2b phantom gutter seams",
            ".cm-gutter:not(.cm-gutter-lint) .cm-gutterElement:last-child",
        ],
        ["D4 line-number colour", ".cm-lineNumbers"],
        ["D5 action-button offset", ".conflict-actions-left, .conflict-actions-right"],
        ["D7 code under after-side gutter", ".pane-ours .cm-gutters"],
        ["HC word outline", ".word-diff-change"],
    ];
    let geometricRail = false;
    for (const [name, selector] of cases) {
        await test.step(name, async () => {
            if (name === "rail") {
                geometricRail = compareRail(main, workbench);
                if (geometricRail) {
                    console.log(
                        `${testInfo.project.name}: step rail: ${workbench.markers.length} markers compared geometrically`,
                    );
                    return;
                }
            }
            const regions =
                name === "rail"
                    ? rails
                    : (await boxes(page, selector)).map((box) => toDevice(box, ratio));
            expect
                .soft(
                    regions.some((box) => box.width > 0 && box.height > 0),
                    `${name}: fixture must exercise a positive clipped region`,
                )
                .toBe(true);
            const changed = comparison.changed.filter(({ x, y }) =>
                regions.some((box) => contains(box, x, y)),
            );
            console.log(`${testInfo.project.name}: step ${name}: ${changed.length} changed pixels`);
            expect.soft(changed.length, `${name}; ${message}`).toBe(0);
        });
    }
    const remaining = comparison.changed.filter(
        ({ x, y }) => !geometricRail || !rails.some((box) => contains(box, x, y)),
    );
    console.log(
        `${testInfo.project.name}: step total outside geometric rail: ${remaining.length} changed pixels`,
    );
    expect(remaining.length, message).toBe(0);
}

const SIDEWAYS_PX = 60;

/** The fixture with its first common line long enough to scroll every pane sideways. */
function withLongCommonLine(): MergeEditorData {
    const data = conflict.messages[0].message.data as MergeEditorData;
    const long = `one ${"wide common text ".repeat(24)}`.trimEnd();
    const swap = (text: string) => {
        if (!text.startsWith("one\n")) throw new Error("fixture no longer starts with 'one'");
        return `${long}${text.slice("one".length)}`;
    };
    const { workbench } = data;
    const [first, ...rest] = data.segments;
    if (!workbench || first?.type !== "common" || first.lines[0] !== "one")
        throw new Error("fixture no longer starts with the common line 'one'");
    return {
        ...data,
        workbench: {
            ...workbench,
            base: swap(workbench.base),
            ours: swap(workbench.ours),
            theirs: swap(workbench.theirs),
        },
        segments: [{ ...first, lines: [long, ...first.lines.slice(1)] }, ...rest],
    };
}

/** Scroll state of the bar and of every code scroller in each compared column. */
function scrollState(page: Page, scroller: string) {
    return page.evaluate(
        ({ scroller, columns }) => {
            const state = (element: HTMLElement) => ({
                overflow: element.scrollWidth > element.clientWidth,
                left: element.scrollLeft,
            });
            const bar = document.querySelector<HTMLElement>(".merge-horizontal-scroll");
            if (!bar) throw new Error("horizontal bar is missing");
            return {
                bar: state(bar),
                columns: columns.map((column) =>
                    [
                        ...document.querySelectorAll<HTMLElement>(
                            `.merge-col.${column} ${scroller}`,
                        ),
                    ].map((element, index) => ({
                        column,
                        index,
                        empty: (element.textContent ?? "").trim() === "",
                        ...state(element),
                    })),
                ),
                overflowing: [
                    ...document.querySelectorAll<HTMLElement>(
                        `.merge-horizontal-scroll, ${scroller}`,
                    ),
                ]
                    .map(state)
                    .filter((element) => element.overflow),
            };
        },
        { scroller, columns: ["col-left", "col-middle", "col-right"] },
    );
}

/**
 * Drives the shared bar, then requires every column whose gutter is compared to have really
 * scrolled: each block with text overflows and sits at the offset. Only provably empty blocks
 * (main keeps one per hunk side, e.g. the missing side of a one-sided hunk) are excluded.
 */
async function scrollSideways(page: Page, scroller: string, label: string, offset: number) {
    // Setting scrollLeft before the bar's range reaches the offset clamps it and never retries.
    await expect
        .poll(
            () =>
                page
                    .locator(".merge-horizontal-scroll")
                    .evaluate((bar) => bar.scrollWidth - bar.clientWidth),
            { message: `${label}: the shared bar can reach the offset` },
        )
        .toBeGreaterThanOrEqual(offset);
    await page.locator(".merge-horizontal-scroll").evaluate((bar, left) => {
        bar.scrollLeft = left;
    }, offset);
    const verdict = async () => {
        const { bar, columns, overflowing } = await scrollState(page, scroller);
        return {
            barScrolled: bar.overflow && bar.left === offset,
            everyColumnHasText: columns.map((blocks) => blocks.some((block) => !block.empty)),
            textBlocksScrolled: columns.map((blocks) =>
                blocks.every((block) => block.empty || (block.overflow && block.left === offset)),
            ),
            everyOverflowingAtOffset: overflowing.every((element) => element.left === offset),
        };
    };
    await expect
        .poll(verdict, { message: `${label}: the bar and every compared column scrolled` })
        .toEqual({
            barScrolled: true,
            everyColumnHasText: [true, true, true],
            textBlocksScrolled: [true, true, true],
            everyOverflowingAtOffset: true,
        });
    const excluded = (await scrollState(page, scroller)).columns
        .flat()
        .filter((block) => block.empty);
    console.log(
        `${label}: empty blocks excluded from the scroll precondition: ${JSON.stringify(excluded)}`,
    );
}

/** Screenshots hold device pixels; DOM boxes are CSS pixels. */
function toDevice(box: Box, ratio: number): Box {
    return {
        x: box.x * ratio,
        y: box.y * ratio,
        width: box.width * ratio,
        height: box.height * ratio,
    };
}

async function sidewaysCase(
    mountHarness: Parameters<typeof mountWorkbenchMerge>[0],
    page: Page,
    testInfo: TestInfo,
    offset: number,
) {
    const label = `${testInfo.project.name} at scrollLeft ${offset}`;
    const data = withLongCommonLine();
    await mountLegacyMerge(mountHarness, page, "en", { sessionKind: "gitMerge", data });
    await scrollSideways(page, ".code-lines", `${label} main`, offset);
    const main = await capture(page, testInfo.outputPath("main-scrolled.png"));
    await mountWorkbenchMerge(mountHarness, page, data);
    await scrollSideways(page, ".cm-content", `${label} workbench`, offset);
    const workbench = await capture(page, testInfo.outputPath("workbench-scrolled.png"));
    const ratio = await page.evaluate(() => devicePixelRatio);
    const comparison = compare(main.image, workbench.image);
    await writeFile(testInfo.outputPath("diff-scrolled.png"), await encode(page, comparison.diff));
    const message = `${label} (device pixel ratio ${ratio}): ${comparison.changed.length} changed pixels overall; bbox=${JSON.stringify(comparison.bbox)}; top 5 main->workbench=${JSON.stringify(comparison.pairs)}`;
    console.log(message);
    for (const [name, selector] of [
        ["ours after-side gutter", ".pane-ours .cm-gutters-after"],
        ["result gutter", ".pane-result .cm-gutters-before"],
        ["theirs gutters", ".pane-theirs .cm-gutters-before"],
    ]) {
        await test.step(name, async () => {
            const regions = (await boxes(page, selector))
                .filter((box) => box.width > 0 && box.height > 0)
                .map((box) => toDevice(box, ratio));
            expect(regions.length, `${name}: fixture must exercise the gutter`).toBeGreaterThan(0);
            const changed = comparison.changed.filter(({ x, y }) =>
                regions.some((box) => contains(box, x, y)),
            );
            console.log(`${label}: scrolled ${name}: ${changed.length} changed pixels`);
            expect.soft(changed.length, `${name}; ${message}`).toBe(0);
        });
    }
    // Same standard as the default test: every pixel outside a geometrically compared rail.
    const geometricRail = compareRail(main, workbench);
    const rails = [...main.rails, ...workbench.rails].map((box) => toDevice(box, ratio));
    const remaining = comparison.changed.filter(
        ({ x, y }) => !geometricRail || !rails.some((box) => contains(box, x, y)),
    );
    console.log(
        `${label}: scrolled total outside geometric rail: ${remaining.length} changed pixels`,
    );
    expect(remaining.length, `scrolled total; ${message}`).toBe(0);
}

test("sideways-scrolled code never paints under a gutter", async ({
    mountHarness,
    page,
}, testInfo) => {
    await sidewaysCase(mountHarness, page, testInfo, SIDEWAYS_PX);
});

type Edges = [left: number, top: number, right: number, bottom: number];

/**
 * Device-px edges relative to the shell: each numbered gutter cell and the code row beside it
 * (keyed by column and line number), every painted vertical separator (borders and absolutely
 * positioned 1px pseudo-elements, merged into vertical runs), the ribbon columns and the ribbons.
 */
function geometry(page: Page) {
    return page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const ratio = devicePixelRatio;
        const shell = document.querySelector(".merge-content-shell")!.getBoundingClientRect();
        const device = ([left, top, right, bottom]: number[]): Edges => [
            (left - shell.left) * ratio,
            (top - shell.top) * ratio,
            (right - shell.left) * ratio,
            (bottom - shell.top) * ratio,
        ];
        // The painted part of a box: clipped by every ancestor that clips.
        const visible = (element: Element, box: number[] = []) => {
            const rect = element.getBoundingClientRect();
            let [left, top, right, bottom] = box.length
                ? box
                : [rect.left, rect.top, rect.right, rect.bottom];
            for (
                let ancestor = element.parentElement;
                ancestor;
                ancestor = ancestor.parentElement
            ) {
                const style = getComputedStyle(ancestor);
                const clip = ancestor.getBoundingClientRect();
                if (style.overflowX !== "visible")
                    [left, right] = [Math.max(left, clip.left), Math.min(right, clip.right)];
                if (style.overflowY !== "visible")
                    [top, bottom] = [Math.max(top, clip.top), Math.min(bottom, clip.bottom)];
            }
            return right > left && bottom > top ? [left, top, right, bottom] : null;
        };
        const painted = (colour: string) => colour !== "transparent" && !/,\s*0\)$/.test(colour);
        const cells: Record<string, Edges> = {};
        const rows: Record<string, Edges> = {};
        const separators: Record<string, Edges[]> = {};
        for (const column of ["col-left", "col-middle", "col-right"]) {
            const col = document.querySelector(`.merge-col.${column}`);
            if (!col) throw new Error(`geometry: column ${column} is missing`);
            const codeRows = [...col.querySelectorAll(".code-line, .cm-line")].flatMap((row) => {
                const box = visible(row);
                return box ? [box] : [];
            });
            for (const cell of col.querySelectorAll(
                ".line-numbers .line-number, .cm-lineNumbers .cm-gutterElement",
            )) {
                const number = (cell.textContent ?? "").trim();
                const box = visible(cell);
                if (!/^\d+$/.test(number) || !box) continue;
                const key = `${column} line ${number}`;
                if (cells[key]) throw new Error(`geometry: ${key} appears twice`);
                cells[key] = device(box);
                const middle = (box[1] + box[3]) / 2;
                const row = codeRows.find((code) => code[1] <= middle && middle < code[3]);
                if (row) rows[key] = device(row);
            }
            const strips: Edges[] = [];
            for (const element of col.querySelectorAll("*")) {
                const style = getComputedStyle(element);
                if (style.visibility !== "visible") continue;
                const rect = element.getBoundingClientRect();
                for (const side of ["Left", "Right"] as const) {
                    const width = parseFloat(style[`border${side}Width`]);
                    if (!(width > 0) || !painted(style[`border${side}Color`])) continue;
                    const left = side === "Left" ? rect.left : rect.right - width;
                    const box = visible(element, [left, rect.top, left + width, rect.bottom]);
                    if (box) strips.push(device(box));
                }
                for (const pseudo of ["::before", "::after"]) {
                    const after = getComputedStyle(element, pseudo);
                    const width = parseFloat(after.width);
                    if (
                        after.content === "none" ||
                        after.content === "normal" ||
                        after.position !== "absolute"
                    )
                        continue;
                    if (!(width > 0 && width <= 1) || !painted(after.backgroundColor)) continue;
                    let block: Element | null = element;
                    while (block && getComputedStyle(block).position === "static")
                        block = block.parentElement;
                    if (!block)
                        throw new Error(
                            "geometry: a positioned pseudo-element has no containing block",
                        );
                    const blockStyle = getComputedStyle(block);
                    const outer = block.getBoundingClientRect();
                    const inner = {
                        left: outer.left + parseFloat(blockStyle.borderLeftWidth),
                        right: outer.right - parseFloat(blockStyle.borderRightWidth),
                        top: outer.top + parseFloat(blockStyle.borderTopWidth),
                    };
                    const left =
                        after.left !== "auto"
                            ? inner.left + parseFloat(after.left)
                            : inner.right - parseFloat(after.right) - width;
                    const top = inner.top + parseFloat(after.top);
                    const box = visible(block, [
                        left,
                        top,
                        left + width,
                        top + parseFloat(after.height),
                    ]);
                    if (box) strips.push(device(box));
                }
            }
            // Vertical runs: renderers split the same line into different elements (per row or per hunk).
            const runs: Edges[] = [];
            for (const strip of strips.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1])) {
                const last = runs.at(-1);
                if (
                    last &&
                    last[0] === strip[0] &&
                    last[2] === strip[2] &&
                    strip[1] - last[3] <= 0.01
                )
                    last[3] = Math.max(last[3], strip[3]);
                else runs.push([...strip]);
            }
            separators[column] = runs;
        }
        const byPosition = (selector: string) =>
            [...document.querySelectorAll(selector)]
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return device([rect.left, rect.top, rect.right, rect.bottom]);
                })
                .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const toolbar = document.querySelector(".merge-toolbar")?.getBoundingClientRect();
        if (!toolbar) throw new Error("geometry: toolbar is missing");
        return {
            shellHeight: shell.height * ratio,
            toolbarHeight: toolbar.height * ratio,
            cells,
            rows,
            separators,
            ribbonColumns: byPosition(".merge-gutter"),
            ribbons: byPosition("path.merge-connector"),
        };
    });
}

/**
 * Same edges to 0.01 device px; keys and counts must match, so nothing is skipped silently.
 * Vertical edges are compared within the shared shell height, as the pixel cases compare.
 */
function expectSameEdges(
    name: string,
    main: Record<string, Edges | Edges[]>,
    workbench: Record<string, Edges | Edges[]>,
    sharedHeight: number,
) {
    expect(Object.keys(main).length, `${name}: fixture must exercise boxes`).toBeGreaterThan(0);
    expect(Object.keys(workbench).sort(), `${name}: same keys`).toEqual(Object.keys(main).sort());
    for (const [key, before] of Object.entries(main)) {
        const after = workbench[key];
        const pairs = Array.isArray(before[0]) ? (before as Edges[]) : [before as Edges];
        const others = Array.isArray(after[0]) ? (after as Edges[]) : [after as Edges];
        expect.soft(others.length, `${name} ${key}: count`).toBe(pairs.length);
        pairs.forEach((edges, index) => {
            const delta = Math.max(
                ...edges.map((edge, side) => {
                    const clip = (value: number) =>
                        side % 2 ? Math.min(value, sharedHeight) : value;
                    return Math.abs(clip(edge) - clip(others[index]?.[side] ?? Infinity));
                }),
            );
            expect
                .soft(
                    delta,
                    `${name} ${key}[${index}]: main ${edges.map((v) => v.toFixed(3))} workbench ${others[index]?.map((v) => v.toFixed(3))}`,
                )
                .toBeLessThanOrEqual(0.01);
        });
    }
}

async function geometryCase(
    mountHarness: Parameters<typeof mountWorkbenchMerge>[0],
    page: Page,
    testInfo: TestInfo,
    offset: number,
) {
    const label = `${testInfo.project.name} at scrollLeft ${offset}`;
    const data = offset ? withLongCommonLine() : undefined;
    await mountLegacyMerge(mountHarness, page, "en", { sessionKind: "gitMerge", data });
    if (offset) await scrollSideways(page, ".code-lines", `${label} main`, offset);
    const main = await geometry(page);
    await mountWorkbenchMerge(mountHarness, page, data);
    if (offset) await scrollSideways(page, ".cm-content", `${label} workbench`, offset);
    const workbench = await geometry(page);
    expect(
        main.shellHeight - workbench.shellHeight,
        "shell height difference must equal the toolbar difference",
    ).toBeCloseTo(workbench.toolbarHeight - main.toolbarHeight, 2);
    const shared = Math.min(main.shellHeight, workbench.shellHeight);
    expectSameEdges("gutter cells", main.cells, workbench.cells, shared);
    expectSameEdges("code rows", main.rows, workbench.rows, shared);
    expectSameEdges("separator runs", main.separators, workbench.separators, shared);
    expectSameEdges(
        "ribbon columns",
        { all: main.ribbonColumns },
        { all: workbench.ribbonColumns },
        shared,
    );
    expectSameEdges("ribbons", { all: main.ribbons }, { all: workbench.ribbons }, shared);
}

// 1.5 is the common Windows display scale. There the two renderers blend separator and band-edge
// pixels differently (main's code cells are composited scrollers only at this scale), so the
// boxes are compared instead of the pixels.
test.describe("at device scale factor 1.5", () => {
    test.use({ deviceScaleFactor: 1.5 });
    test("workbench geometry matches legacy", async ({ mountHarness, page }, testInfo) => {
        await geometryCase(mountHarness, page, testInfo, 0);
    });
    test("sideways-scrolled geometry matches legacy", async ({ mountHarness, page }, testInfo) => {
        await geometryCase(mountHarness, page, testInfo, SIDEWAYS_PX);
    });
});

// 2 is the Retina setting. No half-pixel offset: main's bar never holds one.
test.describe("at device scale factor 2", () => {
    test.use({ deviceScaleFactor: 2 });
    test("workbench matches legacy below the toolbar at threshold 0", async ({
        mountHarness,
        page,
    }, testInfo) => {
        await defaultCase(mountHarness, page, testInfo);
    });
    test("sideways-scrolled code never paints under a gutter", async ({
        mountHarness,
        page,
    }, testInfo) => {
        await sidewaysCase(mountHarness, page, testInfo, SIDEWAYS_PX);
    });
});

test("PNG decoding preserves every adjacent RGB byte of a real screenshot", async ({ page }) => {
    const width = 256;
    const height = 3;
    const data = Buffer.alloc(width * height * 4);
    for (let channel = 0; channel < height; channel++) {
        for (let value = 0; value < width; value++) {
            const offset = (channel * width + value) * 4;
            data[offset + channel] = value;
            data[offset + 3] = 255;
        }
    }
    // One-pixel DOM cells per value and channel, captured the way the parity tests capture.
    await page.setContent(
        `<style>body{margin:0}#ramp{display:grid;grid-template-columns:repeat(${width},1px);width:${width}px}#ramp div{height:1px}</style><div id="ramp"></div>`,
    );
    await page.locator("#ramp").evaluate(
        (ramp, { width, height }) => {
            for (let channel = 0; channel < height; channel++) {
                for (let value = 0; value < width; value++) {
                    const cell = document.createElement("div");
                    const rgb = [0, 0, 0];
                    rgb[channel] = value;
                    cell.style.background = `rgb(${rgb.join(",")})`;
                    ramp.append(cell);
                }
            }
        },
        { width, height },
    );
    const decoded = await decode(
        page,
        await page.locator("#ramp").screenshot({ animations: "disabled" }),
    );
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.data.equals(data), "PNG decoding must preserve adjacent RGB bytes exactly").toBe(
        true,
    );
});
