import { oracles } from "../oracles";
import { parseRgba } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

const { compositeOver, contrastRatio } = oracles.get("contrast");

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

    // The unit guard in tests/unit/merge/mergeScrollLayout.test.ts proves the span
    // FUNCTION stays inside the channel; it cannot see what the viewer passes it. The
    // bug that shipped was exactly a call site: the viewer handed the ribbon layer
    // `x0 = 0, x1 = viewportWidth`, so every connector ran the full width and
    // composited over both panes' code at 18% opacity. No oracle caught it -- an SVG
    // drawn on top changes no computed style, so the contrast oracle is blind to it,
    // and the pixel baselines had been recorded WITH the veil. Only a live-DOM
    // geometry assertion sits at the layer the defect lives at.
    test("diff-viewer draws every connector inside the pane gap, never over the code", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });

        await expect.poll(() => page.locator(".diff-ribbon").count()).toBeGreaterThan(0);
        const measured = await page.evaluate(() => {
            const left = document
                .querySelector('[data-testid="diff-pane-left"]')
                ?.getBoundingClientRect();
            const right = document
                .querySelector('[data-testid="diff-pane-right"]')
                ?.getBoundingClientRect();
            const ribbons = [...document.querySelectorAll<SVGPathElement>(".diff-ribbon")]
                .filter((path) => path.style.display !== "none")
                .map((path) => {
                    const box = path.getBoundingClientRect();
                    return { x0: box.left, x1: box.right, width: box.width };
                });
            return { channel: { x0: left?.right ?? 0, x1: right?.left ?? 0 }, ribbons };
        });

        // A gap that never opened would make every containment assertion below pass
        // vacuously, so assert the channel exists before asserting anything is in it.
        expect(measured.channel.x1 - measured.channel.x0).toBeGreaterThan(0);
        expect(measured.ribbons.length).toBeGreaterThan(0);
        for (const ribbon of measured.ribbons) {
            // Sub-pixel: getBoundingClientRect on a curve rounds outward by a hair.
            expect(ribbon.x0).toBeGreaterThanOrEqual(measured.channel.x0 - 1);
            expect(ribbon.x1).toBeLessThanOrEqual(measured.channel.x1 + 1);
            expect(ribbon.width).toBeGreaterThan(0);
        }
    });

    // Stripe marks are 8px slivers with no text, so the contrast oracle -- which samples
    // the foreground/background pairs around glyphs -- cannot see them at all, and a pixel
    // baseline would have recorded whatever they painted as the correct appearance. The
    // mark's whole job is to be findable against the editor background from the corner of
    // the eye, and the deleted tone in particular changed hue when the viewer stopped
    // borrowing the merge surface's conflict red for deletions. Only a live-DOM read of
    // the colour actually painted sits at the layer where that breaks.
    test("diff-viewer keeps every change-stripe mark visible against the code behind it", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });

        await expect.poll(() => page.locator(".diff-change-mark").count()).toBeGreaterThan(0);
        const measured = await page.evaluate(() => {
            // `transparent` computes to rgba(0, 0, 0, 0), which would read as pure black
            // and make every ratio look healthy, so climb to whatever actually paints.
            const backdropOf = (start: Element | null): string => {
                for (let node = start; node !== null; node = node.parentElement) {
                    const value = getComputedStyle(node).backgroundColor;
                    if (value !== "" && !value.startsWith("rgba(0, 0, 0, 0")) return value;
                }
                return "";
            };
            return {
                backdrop: backdropOf(document.querySelector(".diff-change-stripe")),
                marks: [...document.querySelectorAll<HTMLElement>(".diff-change-mark")].map(
                    (mark) => {
                        const style = getComputedStyle(mark);
                        return {
                            tone:
                                [...mark.classList].find(
                                    (name) =>
                                        name.startsWith("diff-change-") &&
                                        name !== "diff-change-mark",
                                ) ?? "(unstated)",
                            background: style.backgroundColor,
                            opacity: Number(style.opacity),
                        };
                    },
                ),
            };
        });

        expect(measured.backdrop, "no painted backdrop to measure the marks against").not.toBe("");
        const backdrop = parseRgba(measured.backdrop);

        // clean.json carries one hunk of each kind. Asserting all three tones are present
        // stops the loop below passing on the two bright marks while a washed-out one is
        // absent, which is the shape a hue regression actually has.
        const tones = measured.marks.map((mark) => mark.tone);
        expect(new Set(tones), `stripe tones rendered: ${tones.join(", ")}`).toEqual(
            new Set(["diff-change-modified", "diff-change-deleted", "diff-change-inserted"]),
        );

        for (const mark of measured.marks) {
            const colour = parseRgba(mark.background);
            const painted = compositeOver({ ...colour, a: colour.a * mark.opacity }, backdrop);
            const ratio = contrastRatio(painted, backdrop);
            // A floor, not a target: a mark drawn from a near-background wash rather than a
            // full-strength hue is the failure, and two separates those cleanly without
            // pinning a hue anyone may still retune.
            expect(
                ratio,
                `${mark.tone} paints ${mark.background} at opacity ${mark.opacity} -> ` +
                    `${ratio.toFixed(2)}:1 over ${measured.backdrop}`,
            ).toBeGreaterThanOrEqual(2);
        }
    });

    // The clipping oracle cannot see this one, structurally: it exempts any element that
    // carries `text-overflow: ellipsis` outright, and every breadcrumb carries it -- so a
    // segment cut square by the strip above it is exempted by a declaration that did nothing
    // for it. `clippingCollector.spec.ts` pins that exemption on purpose. The pixel baselines
    // record whatever shrink order shipped, the same way they once recorded a ribbon veil.
    // So the shrink rules only have an oracle if it reads live geometry, which is this.
    //
    // The squeeze is applied here rather than left to the narrow projects because the wide
    // ones would not overflow at all, and a containment assertion over content that fits is
    // a pass that proves nothing. It is a fraction of the trail's own measured width rather
    // than a pixel count, so it means the same thing in all eight projects whatever their
    // font measures.
    //
    // What this does NOT cover: `.diff-breadcrumb:last-child` also carries `flex-shrink: 1`
    // rather than `0`, so that a filename with no directories left to spend ellipsises
    // instead of being cut square. Witnessing that needs the strip narrower than the
    // filename alone, and the strip will not go there -- squeezing it directly, clamping it
    // with `max-width`, and narrowing `.diff-header` around it all floor at roughly the
    // filename's own width. So that half of the rule is argued in the CSS comment and has no
    // oracle here; only the shrink ORDER below does.
    test("diff-viewer spends a squeezed breadcrumb trail on the directories, not on the filename", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });

        await expect.poll(() => page.locator(".diff-breadcrumb").count()).toBeGreaterThan(0);
        const measured = await page.evaluate(() => {
            const strip = document.querySelector<HTMLElement>('[data-testid="diff-breadcrumbs"]');
            const row = strip?.parentElement;
            if (!strip || !row) return null;
            const natural = strip.scrollWidth;

            // The squeeze goes on the ROW, not on the strip: a width set on a flex item is
            // only a hypothetical main size that the algorithm may overrule, and measured, it
            // did -- the strip ignored both `width` and `max-width` set on itself. Narrowing
            // the container is the real case anyway, since what shrinks in production is the
            // panel, not the trail inside it.
            const at = (px: number) => {
                const target = `${Math.round(px)}px`;
                row.style.width = target;
                row.style.maxWidth = target;
                row.style.minWidth = "0";
                void row.offsetWidth;
                const box = strip.getBoundingClientRect();
                return {
                    width: box.width,
                    right: box.right,
                    segments: [...strip.querySelectorAll<HTMLElement>(".diff-breadcrumb")].map(
                        (element) => ({
                            text: element.textContent ?? "",
                            right: element.getBoundingClientRect().right,
                            // Not `textContent` length: a segment reduced to an ellipsis still
                            // reports its whole string, which is exactly the blindness that
                            // lets a truncation regression read as fine.
                            truncated: element.scrollWidth > element.clientWidth + 1,
                        }),
                    ),
                };
            };

            return { natural, roomy: at(natural * 0.6) };
        });

        expect(measured, "the viewer drew no breadcrumb strip to measure").not.toBeNull();
        const strip = measured as NonNullable<typeof measured>;

        // Anti-vacuity. A one-segment fixture has no directories to spend, and a strip that
        // never actually narrowed would satisfy every assertion below by simply fitting.
        expect(
            strip.roomy.segments.length,
            "the recorded fixture's path is not deep enough to have a shrink order at all",
        ).toBeGreaterThan(2);
        expect(
            strip.roomy.width,
            "the strip did not narrow, so nothing had to shrink",
        ).toBeLessThan(strip.natural);

        // The deficit lands on the directories. Under one shared shrink factor flex splits it
        // in proportion to content width, and the filename -- carrying the extension, usually
        // the longest segment -- would be the first thing ellipsised away.
        const filename = strip.roomy.segments[strip.roomy.segments.length - 1]!;
        expect(
            filename.truncated,
            `the filename "${filename.text}" was truncated while directories still had width to give`,
        ).toBe(false);
        expect(
            strip.roomy.segments.slice(0, -1).some((segment) => segment.truncated),
            "no directory truncated either, so the squeeze never forced a choice and the order is untested",
        ).toBe(true);

        // Nothing is painted outside the strip on the way there. `.diff-breadcrumbs` hides its
        // overflow and paints no ellipsis of its own, so a segment that runs past this edge is
        // cut off square with nothing to say it was cut.
        for (const segment of strip.roomy.segments) {
            expect(
                segment.right,
                `"${segment.text}" is painted past the strip's right edge, so it is cut square with no ellipsis`,
            ).toBeLessThanOrEqual(strip.roomy.right + 1);
        }
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
