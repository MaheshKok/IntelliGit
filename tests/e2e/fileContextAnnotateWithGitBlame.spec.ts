import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";

import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "dirty" });

const modifier = process.platform === "darwin" ? "Meta" : "Control";

/** Reads the actual line-start decoration text rendered by Monaco, including empty lines. */
async function annotationLabels(editor: Locator): Promise<string[]> {
    return editor
        .locator(".view-line span")
        .evaluateAll((spans) =>
            spans
                .map((span) => getComputedStyle(span, "::before").content)
                .filter((content) => !["none", "normal", '""'].includes(content)),
        );
}

/** Exercises the public command rather than a test-only API. */
async function toggleFromPalette(page: Page): Promise<void> {
    await page.keyboard.press(`${modifier}+Shift+P`);
    const input = page.locator(".quick-input-widget .quick-input-box input").first();
    await expect(input).toBeVisible();
    await input.fill(">IntelliGit: Annotate with Git Blame");
    await page.getByRole("option").filter({ hasText: "Annotate with Git Blame" }).first().click();
    await expect(input).toBeHidden();
}

test("annotates source lines, follows edits and commits, and toggles across split editors", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const targetPath = "annotate-git-blame-example.ts";
    const filePath = path.join(fixtureWorkspace.workspace.root, targetPath);
    const originalText =
        'export const source = "committed-disk-content";\n\nexport const owner = "first-author";\n';
    const committedText = originalText.replace("first-author", "second-author");
    const unsavedText = committedText.replace("committed-disk-content", "unsaved-buffer-content");
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: { ...fixtureWorkspace.workspace.env, GIT_AUTHOR_NAME: "Ada Lovelace" },
    };

    await writeFile(filePath, originalText);
    execFileSync("git", ["add", targetPath], gitOptions);
    execFileSync("git", ["commit", "--only", targetPath, "-m", "Seed blame example"], gitOptions);
    await writeFile(filePath, committedText);
    execFileSync("git", ["commit", "--only", targetPath, "-m", "Second author"], {
        ...gitOptions,
        env: { ...gitOptions.env, GIT_AUTHOR_NAME: "Grace Hopper" },
    });

    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(repoRoot),
        repoRoot,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        if (await page.locator(".part.auxiliarybar:visible").count()) {
            await page.keyboard.press(`${modifier}+Alt+B`);
            await expect(page.locator(".part.auxiliarybar")).toBeHidden();
        }

        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+P`);
        const input = page.locator(".quick-input-widget .quick-input-box input").first();
        await expect(input).toBeVisible();
        await input.fill(targetPath);
        await page.getByRole("option").filter({ hasText: targetPath }).first().click();
        await expect(input).toBeHidden();

        await page.getByRole("treeitem").filter({ hasText: targetPath }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        const action = page.getByRole("menuitem", { name: /^Annotate with Git Blame(?:$|\s)/ });
        await expect(action).toBeVisible();
        await action.hover();
        await page.keyboard.press("Enter");

        const editors = page.locator(".editor-group-container .monaco-editor:visible");
        const editor = editors.first();
        await expect
            .poll(() => annotationLabels(editor))
            .toEqual([
                expect.stringContaining("Ada Lovelace"),
                expect.stringContaining("Ada Lovelace"),
                expect.stringContaining("Grace Hopper"),
            ]);
        await expect(page.getByRole("tab").filter({ hasText: ".blame" })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("blame-source-editor.png") });

        const annotationClass = await editor
            .locator(".view-line span")
            .evaluateAll(
                (spans) =>
                    spans.find((span) =>
                        getComputedStyle(span, "::before").content.includes("Ada Lovelace"),
                    )?.className,
            );
        expect(annotationClass).toBeTruthy();
        await editor.locator(`span[class="${annotationClass}"]`).first().hover();
        const hover = page.locator(".monaco-hover:visible");
        await expect(hover).toContainText("Seed blame example");
        await expect(hover).toContainText("Ada Lovelace");
        await page.screenshot({ path: testInfo.outputPath("blame-hover.png") });
        await page.keyboard.press("Escape");

        await editor.click();
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.type(unsavedText);
        await expect
            .poll(() => annotationLabels(editor))
            .toEqual([
                expect.stringContaining("Uncommitted changes"),
                expect.stringContaining("Ada Lovelace"),
                expect.stringContaining("Grace Hopper"),
            ]);
        expect(await readFile(filePath, "utf8")).toBe(committedText);
        await page.screenshot({ path: testInfo.outputPath("blame-unsaved-edit.png") });

        await page.keyboard.press(`${modifier}+S`);
        await expect.poll(() => readFile(filePath, "utf8")).toBe(unsavedText);
        execFileSync("git", ["commit", "--only", targetPath, "-m", "Commit edited source"], {
            ...gitOptions,
            env: { ...gitOptions.env, GIT_AUTHOR_NAME: "Katherine Johnson" },
        });
        const committedLabels = [
            expect.stringContaining("Katherine Johnson"),
            expect.stringContaining("Ada Lovelace"),
            expect.stringContaining("Grace Hopper"),
        ];
        await expect
            .poll(() => annotationLabels(editor), { timeout: 15_000 })
            .toEqual(committedLabels);

        await page.keyboard.press(`${modifier}+\\`);
        await expect(editors).toHaveCount(2);
        for (const splitEditor of await editors.all()) {
            await expect.poll(() => annotationLabels(splitEditor)).toEqual(committedLabels);
        }
        await page.screenshot({ path: testInfo.outputPath("blame-split-editors.png") });
        await toggleFromPalette(page);
        for (const splitEditor of await editors.all()) {
            await expect.poll(() => annotationLabels(splitEditor)).toEqual([]);
            await expect(
                splitEditor.locator(".view-line").filter({ hasText: "unsaved-buffer-content" }),
            ).toBeVisible();
        }
        expect(await readFile(filePath, "utf8")).toBe(unsavedText);

        await toggleFromPalette(page);
        for (const splitEditor of await editors.all()) {
            await expect.poll(() => annotationLabels(splitEditor)).toEqual(committedLabels);
        }
        await page.keyboard.press(`${modifier}+Shift+P`);
        await expect(input).toBeVisible();
        await input.fill(">Preferences: Color Theme");
        await page
            .getByRole("option")
            .filter({ hasText: "Preferences: Color Theme" })
            .first()
            .click();
        await input.fill("Light Modern");
        await page.getByRole("option").filter({ hasText: "Light Modern" }).first().click();
        await expect(input).toBeHidden();
        for (const splitEditor of await editors.all()) {
            await expect.poll(() => annotationLabels(splitEditor)).toEqual(committedLabels);
        }
        await page.screenshot({ path: testInfo.outputPath("blame-light-theme.png") });
    } finally {
        await app.close();
    }
});
