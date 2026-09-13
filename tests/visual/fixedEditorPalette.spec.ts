import { expect, test } from "./playwright/harnessPage";
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
    test(`${editable ? "editable" : "read-only"} diff follows the host background with fixed change highlights`, async ({
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
        await expect(leftArea).toHaveCSS("background-color", "rgb(59, 42, 50)");
        await expect(
            rightArea,
            "both modified areas must use the same classification fill",
        ).toHaveCSS("background-color", "rgb(59, 42, 50)");
        await expect(rightArea).toHaveCSS(
            "box-shadow",
            await leftArea.evaluate((area) => getComputedStyle(area).boxShadow),
        );
        for (const area of [leftArea, rightArea]) {
            await expect(
                area.locator(".word-diff-change").first(),
                "red modified areas must contain dark red word highlights on both panes",
            ).toHaveCSS("background-color", "rgb(75, 21, 21)");
        }
        // Dark-plus keyword blue must stay readable even when the host fixture is light.
        await expect(
            page
                .locator('.diff-pane-left span[style*="color"]')
                .filter({ hasText: /^const$/ })
                .first(),
        ).toHaveCSS("color", "rgb(86, 156, 214)");
    });
}

test("merge palette and first-row actions stay consistent across host themes", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
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
    await expect(page.locator(".result-edit-textarea")).toHaveCSS("color", "rgb(171, 178, 191)");
    await page.locator(".result-edit-textarea").press("Escape");
});
