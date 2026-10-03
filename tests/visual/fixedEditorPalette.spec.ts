import { expect, test } from "./playwright/harnessPage";
import { mountLegacyMerge } from "./legacyMerge";
import type { Page } from "@playwright/test";

/** Resolves the host's editor token to the browser's RGB format for rendered comparisons. */
async function editorBackground(page: Page): Promise<string> {
    return page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--vscode-editor-background)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
    });
}

for (const editable of [false, true]) {
    test(`${editable ? "editable" : "read-only"} diff follows the host background and change highlights`, async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
        await page.evaluate((isEditable) => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setDiffData",
                        data: {
                            path: "palette.ts",
                            languageId: "typescript",
                            leftLabel: "HEAD",
                            rightLabel: "Working tree",
                            left: { eol: "lf", terminalNewline: true },
                            right: { eol: "lf", terminalNewline: true },
                            segments: [
                                {
                                    type: "common",
                                    left: ["const same = 1;"],
                                    right: ["const same = 1;"],
                                },
                                {
                                    type: "changed",
                                    left: ["const old = 2;"],
                                    right: ["const next = 3;"],
                                },
                            ],
                            ...(isEditable
                                ? {
                                      editablePane: "right",
                                      editableText: "const same = 1;\nconst next = 3;\n",
                                      documentVersion: 1,
                                      editableReseedToken: 0,
                                  }
                                : {}),
                        },
                    },
                }),
            );
        }, editable);
        await expect(page.locator(".diff-content")).toHaveCSS(
            "background-color",
            await editorBackground(page),
        );
        const leftArea = page.locator(".diff-pane-left .diff-segment-modified");
        const rightArea = page.locator(".diff-pane-right .diff-segment-modified");
        const hostColor = (expression: string) =>
            page.evaluate((value) => {
                const probe = document.createElement("span");
                probe.style.backgroundColor = value;
                document.body.append(probe);
                const resolved = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return resolved;
            }, expression);
        await expect(leftArea).toHaveCSS(
            "background-color",
            await hostColor(
                "var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground, transparent))",
            ),
        );
        await expect(rightArea).toHaveCSS(
            "background-color",
            await hostColor(
                "var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground, transparent))",
            ),
        );
        await expect(rightArea).toHaveCSS(
            "box-shadow",
            await leftArea.evaluate((area) => getComputedStyle(area).boxShadow),
        );
        await expect(leftArea.locator(".word-diff-change").first()).toHaveCSS(
            "background-color",
            await hostColor("var(--vscode-diffEditor-removedTextBackground, transparent)"),
        );
        await expect(rightArea.locator(".word-diff-change").first()).toHaveCSS(
            "background-color",
            await hostColor("var(--vscode-diffEditor-insertedTextBackground, transparent)"),
        );
        const highContrast = await page
            .locator("body")
            .evaluate(
                (body) =>
                    body.classList.contains("vscode-high-contrast") ||
                    body.classList.contains("vscode-high-contrast-light"),
            );
        if (highContrast) {
            for (const [area, direction] of [
                [leftArea, "removed"],
                [rightArea, "inserted"],
            ] as const) {
                const border = await page.evaluate((side) => {
                    const probe = document.createElement("span");
                    probe.style.color = `var(--vscode-diffEditor-${side}TextBorder)`;
                    document.body.append(probe);
                    const color = getComputedStyle(probe).color;
                    probe.remove();
                    return color;
                }, direction);
                await expect(area.locator(".word-diff-change").first()).toHaveCSS(
                    "outline-color",
                    border,
                );
            }
        }
        const isLight = await page
            .locator("body")
            .evaluate(
                (body) =>
                    body.classList.contains("vscode-light") ||
                    body.classList.contains("vscode-high-contrast-light"),
            );
        await expect(
            page
                .locator('.diff-pane-left .diff-segment-modified span[style*="color"]')
                .filter({ hasText: /^const$/ })
                .first(),
        ).toHaveCSS("color", isLight ? "rgb(0, 0, 255)" : "rgb(86, 156, 214)");
    });
}

test("merge palette and first-row actions stay consistent across host themes", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountLegacyMerge(mountHarness, page);
    await expect(page.locator(".merge-editor")).toHaveCSS(
        "background-color",
        await editorBackground(page),
    );
    await expect(page.locator(".conflict-ours .code-line").first()).toHaveCSS(
        "color",
        "rgb(171, 178, 191)",
    );
    await expect(page.locator(".conflict-result .code-line").first()).toHaveCSS(
        "color",
        "rgb(171, 178, 191)",
    );
    const discard = page.locator(".conflict-actions-left .discard-btn").first();
    const accept = page.locator(".conflict-actions-left .accept-btn").first();
    await expect(discard).toHaveCSS("color", "rgb(251, 31, 73)");
    await expect(accept).toHaveCSS("color", "rgb(102, 187, 106)");
    await expect(page.locator(".conflict-actions-right .discard-btn").first()).toHaveCSS(
        "color",
        "rgb(251, 31, 73)",
    );
    await expect(page.locator(".conflict-actions-right .accept-btn").first()).toHaveCSS(
        "color",
        "rgb(102, 187, 106)",
    );
    await expect(page.locator(".merge-connector.change-conflict").first()).toHaveCSS(
        "fill",
        "rgb(75, 21, 21)",
    );
    const conflictBand = page
        .locator('[data-conflict-id="0"] .conflict-ours .real-code-line')
        .first();
    await expect
        .poll(() =>
            conflictBand.evaluate((row) => getComputedStyle(row, "::before").backgroundColor),
        )
        .toBe("rgb(59, 42, 50)");
    const insertedBand = page
        .locator('[data-conflict-id="1"] .conflict-theirs .real-code-line')
        .first();
    await expect
        .poll(() =>
            insertedBand.evaluate((row) => getComputedStyle(row, "::before").backgroundColor),
        )
        .toBe("rgb(38, 75, 51)");
    const offset = await discard.evaluate((button) => {
        const hunk = button.closest("[data-conflict-id]");
        const row = hunk?.querySelector(".real-code-line");
        if (!row) throw new Error("Missing first conflict code row");
        const iconBox = button.querySelector("svg")!.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return Math.abs(iconBox.top + iconBox.height / 2 - (rowBox.top + rowBox.height / 2));
    });
    expect(offset, "merge controls must center on the first affected row").toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("merge-palette.png") });
    await page.locator(".result-editable").first().dblclick();
    await expect(page.locator(".result-edit-textarea")).toHaveCSS(
        "background-color",
        await editorBackground(page),
    );
    await expect(page.locator(".result-edit-textarea")).toHaveCSS(
        "color",
        await page.locator(".merge-content").evaluate((element) => getComputedStyle(element).color),
    );
    await page.locator(".result-edit-textarea").press("Escape");
});
