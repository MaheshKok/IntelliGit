import { expect, test } from "./playwright/harnessPage";

for (const position of ["left", "right"]) {
    test(`single repository reclaims its column with the commit panel on the ${position}`, async ({
        mountHarness,
        page,
    }, testInfo) => {
        test.skip(
            (page.viewportSize()?.width ?? 0) < 1200,
            "Multi-column layout needs a wide viewport",
        );
        const { recordedMessages } = await mountHarness("undocked", {
            webviewFixture: "mid-rebase.json",
        });
        const repository = page.getByTestId("undocked-repository-section");
        const divider = page.getByTestId("undocked-repository-divider");
        await page.evaluate((commitWindowPosition) => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "settings", commitWindowPosition } }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "repositories",
                        repositories: [{ root: "/repo-a", label: "Repo A" }],
                        selectedRepositoryRoot: "/repo-a",
                    },
                }),
            );
        }, position);
        await expect(repository).toHaveCount(0);
        await expect(divider).toHaveCount(0);
        const sections = [
            "undocked-branch-section",
            "undocked-graph-section",
            "undocked-info-section",
            "undocked-commit-panel-section",
        ];
        const occupied = await page.evaluate(
            (ids) =>
                ids.reduce(
                    (sum, id) =>
                        sum +
                        document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
                            .width,
                    0,
                ),
            sections,
        );
        expect(
            occupied + 12,
            "remaining panes and three dividers consume the full width",
        ).toBeCloseTo(1200, 0);
        await page.screenshot({ path: testInfo.outputPath("single-repository.png") });

        await page.evaluate(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "repositories",
                        repositories: [
                            { root: "/repo-a", label: "Repo A" },
                            { root: "/repo-b", label: "Repo B" },
                        ],
                        selectedRepositoryRoot: "/repo-a",
                    },
                }),
            );
        });
        await expect(repository).toBeVisible();
        await expect(divider).toBeVisible();
        await expect(page.getByTestId("undocked-repository-row")).toHaveCount(2);
        await divider.focus();
        await expect(divider).toBeFocused();
        const before = (await repository.boundingBox())!.width;
        await divider.press("ArrowLeft");
        await expect.poll(async () => (await repository.boundingBox())!.width).toBeLessThan(before);
        await page.locator('[data-repository-root="/repo-b"]').click();
        await expect
            .poll(recordedMessages)
            .toContainEqual({ type: "selectRepository", repositoryRoot: "/repo-b" });
        await page.screenshot({ path: testInfo.outputPath("multiple-repositories.png") });

        await page.evaluate(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "repositories",
                        repositories: [{ root: "/repo-b", label: "Repo B" }],
                        selectedRepositoryRoot: "/repo-b",
                    },
                }),
            );
        });
        await expect(repository).toHaveCount(0);
        await expect(divider).toHaveCount(0);
        await page.setViewportSize({ width: 320, height: 800 });
        await expect(page.getByTestId("undocked-graph-section")).toHaveCSS("width", "320px");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        await page.screenshot({ path: testInfo.outputPath("single-repository-narrow.png") });
    });
}
