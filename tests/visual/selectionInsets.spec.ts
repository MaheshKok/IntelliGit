import { expect, test } from "./playwright/harnessPage";

/**
 * A selected row's ring must wrap the row's content, not the whole pane.
 *
 * Two rows painted the ring at their box edge. A nested branch row is indented with
 * padding, so its ring ran from the pane edge across the indent guides. A commit
 * row had no left padding, so the message text touched the ring's left edge while
 * the right edge kept `ROW_SIDE_PADDING`. Both are measured here in the layout
 * the screenshot reported: the undocked workbench at the wide viewport.
 */

/** Room the text or icon keeps from the ring's edge. Matches `ROW_SIDE_PADDING`. */
const INSET = 8;

interface Box {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

test.describe("selection ring insets", () => {
    test.beforeEach(({ page }) => {
        test.skip(
            (page.viewportSize()?.width ?? 0) < 1200,
            "the undocked workbench shows both panes only at the wide viewport",
        );
    });

    test("a nested branch row rings its content, not the pane", async ({ mountHarness, page }) => {
        await mountHarness("undocked", { webviewFixture: "mid-rebase.json" });
        const section = page.getByTestId("undocked-branch-section");
        // Folders start collapsed; open one so a depth-2 row exists. Depth >= 1 is what
        // makes the defect visible: a top-level row has no guides to cross.
        await section.locator("button.branch-row", { hasText: "conflict" }).first().click();
        const row = section.locator("button.branch-row", { hasText: "with-main" }).first();
        await row.click();
        await expect(row).toHaveClass(/selected/);

        const measured = await row.evaluate(
            (
                element,
            ): {
                readonly ring: Box;
                readonly icon: Box;
                readonly guides: readonly number[];
            } => {
                const rect = (target: Element | null): Box => {
                    if (!target) throw new Error("selection ring measurement lost its target");
                    const r = target.getBoundingClientRect();
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                };
                const box = rect(element);
                const after = getComputedStyle(element, "::after");
                // The ring is on the pseudo-element when it hugs the content and on the
                // row itself when it spans the pane; measure whichever paints it.
                const ringOnAfter = after.boxShadow !== "none" && after.content !== "none";
                const ring: Box = ringOnAfter
                    ? {
                          left: box.left + Number.parseFloat(after.left),
                          right: box.right - Number.parseFloat(after.right),
                          top: box.top,
                          bottom: box.bottom,
                      }
                    : box;
                const icon = rect(element.querySelector("svg"));
                const guides = Array.from(element.querySelectorAll('span[aria-hidden="true"]'))
                    .map((guide) => guide.getBoundingClientRect())
                    .filter((guide) => guide.width > 0)
                    .map((guide) => guide.left);
                return { ring, icon, guides };
            },
        );

        expect(
            measured.icon.left - measured.ring.left,
            "the branch icon should sit INSET px inside the ring's left edge",
        ).toBeGreaterThanOrEqual(INSET);
        expect(
            measured.icon.left - measured.ring.left,
            "the ring's left edge should not run further left than one indent step before the icon",
        ).toBeLessThan(INSET * 3);
        for (const guideLeft of measured.guides) {
            expect(
                guideLeft,
                "an indent guide should stay outside the ring, not be crossed by it",
            ).toBeLessThan(measured.ring.left);
        }
    });

    test("a selected commit row keeps room between its ring and the message", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("undocked", { webviewFixture: "mid-rebase.json" });
        const row = page.locator(".commit-row").first();
        await row.click();
        await expect(row).toHaveAttribute("aria-current", "true");

        const measured = await row.evaluate((element): { readonly gap: number } => {
            const text = element.querySelector("span[title]");
            if (!text) throw new Error("commit row rendered no message span");
            const ringLeft = element.getBoundingClientRect().left;
            return { gap: text.getBoundingClientRect().left - ringLeft };
        });

        expect(
            measured.gap,
            "the commit message should start INSET px inside the ring's left edge",
        ).toBeGreaterThanOrEqual(INSET);
    });
});
