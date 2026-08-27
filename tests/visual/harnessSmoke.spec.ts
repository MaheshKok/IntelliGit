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

    // A pixel baseline is captured with nothing focused, so it can never witness a focus ring:
    // the pane only rings once a reader clicks it, and by then no screenshot is being taken.
    // The contrast oracle is blind to it too -- an outline changes no foreground/background
    // pair around a glyph. So the only oracle that sits at this layer is a live focus.
    //
    // The focus is taken by a real POINTER CLICK, not `element.focus()`. The claim in the test
    // name is that clicking a line places a caret there, and a programmatic focus cannot say
    // anything about the click: it reaches the pane whether or not the code under the pointer
    // does. Anything painted over the text -- an action strip, a hunk control, a decoration --
    // would swallow the click and leave a `focus()` version of this test green.
    //
    // Both halves are asserted, in this order, because they fail in opposite directions and a
    // single count could not tell them apart. Losing `contentEditable` takes the caret away
    // and the pane stops being focusable; losing `outline: 0` brings the ring back. Asserting
    // focusability FIRST means the ring assertion can never pass vacuously on an element that
    // was never focused in the first place.
    test("diff-viewer gives a read-only pane a caret without ringing the whole pane", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });

        const paneLocator = page.locator('[data-testid="diff-pane-left"]');
        await expect.poll(() => paneLocator.count()).toBe(1);
        // A line carrying actual glyphs, so the caret lands in text rather than in the empty
        // run past the end of a blank row, where a hit test has nothing to resolve against.
        await paneLocator.locator(".code-line-content").filter({ hasText: /\S/ }).first().click();

        const measured = await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>('[data-testid="diff-pane-left"]');
            if (!pane) return null;
            const style = getComputedStyle(pane);
            const anchor = document.getSelection()?.anchorNode ?? null;
            return {
                editable: pane.isContentEditable,
                focused: document.activeElement === pane,
                // Where the click actually left the caret. `focused` alone cannot answer that:
                // a click intercepted by an overlay inside the pane still focuses the pane.
                caretInPane: anchor !== null && pane.contains(anchor),
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
            };
        });

        expect(measured, "the left pane never rendered").not.toBeNull();
        expect(
            measured?.editable,
            "the read-only pane is not contentEditable, so clicking it places no caret",
        ).toBe(true);
        expect(
            measured?.focused,
            "the pane did not take focus, so any outline assertion below would be vacuous",
        ).toBe(true);
        expect(
            measured?.caretInPane,
            "the click focused the pane but left the caret outside it",
        ).toBe(true);
        // Chromium's default ring on a focused contentEditable computes to `auto`; suppressed
        // it computes to `none`. Width is asserted too because a UA that rings with a plain
        // solid border would leave the style readable but the width non-zero.
        expect(
            measured?.outlineStyle,
            `a focused read-only pane paints outline-style: ${measured?.outlineStyle ?? "(none)"}`,
        ).toBe("none");
        expect(measured?.outlineWidth).toBe("0px");
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
