import { oracles } from "../oracles";
import { parseRgba } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

const { compositeOver, contrastRatio } = oracles.get("contrast");

test.describe("workbench hierarchy", () => {
    for (const locale of ["en", "de", "ru"]) {
        test(`commit composer keeps its label, editor and actions usable in ${locale}`, async ({
            mountHarness,
            page,
        }, testInfo) => {
            await mountHarness("commit-panel", { webviewFixture: "dirty.json", locale });
            const editor = page.locator("textarea");
            await expect(editor).toBeVisible();
            const label = await editor.evaluate((element: HTMLTextAreaElement) => {
                const associated = element.labels?.[0];
                if (!associated) return null;
                const labelBox = associated.getBoundingClientRect();
                const editorBox = element.getBoundingClientRect();
                return {
                    text: associated.textContent?.trim(),
                    width: labelBox.width,
                    height: labelBox.height,
                    bottom: labelBox.bottom,
                    editorTop: editorBox.top,
                };
            });
            expect(label, "commit message must have a visible associated label").not.toBeNull();
            expect(label?.text).toBeTruthy();
            expect(label?.width).toBeGreaterThan(0);
            expect(label?.height).toBeGreaterThan(0);
            expect(label?.bottom).toBeLessThanOrEqual(label?.editorTop ?? 0);

            await page.getByRole("checkbox", { name: "binary.bin", exact: true }).check();
            await editor.fill("Refine workbench layout");
            const commit = page.getByTestId("commit-action-commit");
            await expect(commit).toBeEnabled();
            await editor.press("Tab");
            await expect(commit).toBeFocused();

            const layout = await page.locator("[data-commit-area]").evaluate((area) => {
                const editorBox = area.querySelector("textarea")!.getBoundingClientRect();
                const actionBoxes = [...area.querySelectorAll("button")].map((button) => {
                    const box = button.getBoundingClientRect();
                    return {
                        label: button.getAttribute("aria-label") ?? button.textContent,
                        left: box.left,
                        right: box.right,
                        top: box.top,
                        bottom: box.bottom,
                        width: box.width,
                        height: box.height,
                        intersectsEditor:
                            box.left < editorBox.right &&
                            box.right > editorBox.left &&
                            box.top < editorBox.bottom &&
                            box.bottom > editorBox.top,
                    };
                });
                return { actionBoxes, width: window.innerWidth, height: window.innerHeight };
            });
            expect(layout.actionBoxes.length).toBeGreaterThanOrEqual(3);
            for (const button of layout.actionBoxes) {
                expect(button.width, button.label ?? "").toBeGreaterThan(0);
                expect(button.height, button.label ?? "").toBeGreaterThan(0);
                expect(button.left, button.label ?? "").toBeGreaterThanOrEqual(0);
                expect(button.right, button.label ?? "").toBeLessThanOrEqual(layout.width);
                expect(button.bottom, button.label ?? "").toBeLessThanOrEqual(layout.height);
                expect(button.intersectsEditor, button.label ?? "").toBe(false);
            }
            await page.screenshot({ path: testInfo.outputPath("composer.png") });
        });
    }

    test("search hints remain readable on the active host theme", async ({
        mountHarness,
        page,
    }) => {
        // Both search controls are present in this surface only at the wide viewport.
        test.skip(
            (page.viewportSize()?.width ?? 0) < 1200,
            "Both search controls need the wide graph",
        );
        await mountHarness("commit-graph-card", { webviewFixture: "clean.json" });
        const hints = await page.locator("input[placeholder]").evaluateAll((inputs) =>
            inputs.map((input) => ({
                label: input.getAttribute("placeholder"),
                foreground: getComputedStyle(input, "::placeholder").color,
                opacity: Number(getComputedStyle(input, "::placeholder").opacity),
                background: getComputedStyle(input).backgroundColor,
            })),
        );
        expect(hints).toHaveLength(2);
        for (const hint of hints) {
            const foreground = parseRgba(hint.foreground);
            const background = parseRgba(hint.background);
            expect(foreground, hint.label ?? "").not.toBeNull();
            expect(background, hint.label ?? "").not.toBeNull();
            if (!foreground || !background) throw new Error("Unmeasurable search hint color");
            const painted = compositeOver(
                { ...foreground, a: foreground.a * hint.opacity },
                background,
            );
            expect(contrastRatio(painted, background), hint.label ?? "").toBeGreaterThanOrEqual(
                4.5,
            );
        }
    });

    test("undocked default retains history emphasis after a narrow viewport widens", async ({
        mountHarness,
        page,
    }, testInfo) => {
        test.skip(
            (page.viewportSize()?.width ?? 0) < 1200,
            "Full workbench requires a wide viewport",
        );
        await page.setViewportSize({ width: 320, height: 800 });
        await mountHarness("undocked", { webviewFixture: "mid-rebase.json" });
        await page.setViewportSize({ width: 1200, height: 800 });
        await expect(page.getByTestId("undocked-graph-section")).toHaveCSS("width", "316px");
        const sizes = await page.evaluate(() => {
            const width = (id: string): number =>
                document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().width;
            return {
                graph: width("undocked-graph-section"),
                branches: width("undocked-branch-section"),
                info: width("undocked-info-section"),
                composer: width("undocked-commit-panel-section"),
                overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
        });
        expect(sizes.graph, "history must have more space than branch navigation").toBeGreaterThan(
            sizes.branches,
        );
        expect(sizes.graph, "history must have more space than commit details").toBeGreaterThan(
            sizes.info,
        );
        expect(
            sizes.composer,
            "composer must retain its usable default width",
        ).toBeGreaterThanOrEqual(260);
        expect(sizes.overflow).toBe(false);
        const messageAndRefsCell = page
            .getByTestId("undocked-graph-section")
            .locator("[data-commit-tooltip]")
            .first();
        await expect
            .poll(() =>
                messageAndRefsCell.evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeGreaterThanOrEqual(180);
        await page.screenshot({ path: testInfo.outputPath("workbench.png") });

        await page.setViewportSize({ width: 1800, height: 800 });
        await expect(page.getByTestId("undocked-graph-section")).toHaveCSS("width", "916px");
        for (const [id, width] of [
            ["undocked-repository-section", 168],
            ["undocked-branch-section", 220],
            ["undocked-info-section", 220],
            ["undocked-commit-panel-section", 260],
        ] as const) {
            await expect(page.getByTestId(id)).toHaveCSS("width", `${width}px`);
        }
    });
});
