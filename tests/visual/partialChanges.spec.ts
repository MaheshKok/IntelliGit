import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChangelistState } from "../../src/webviews/protocol/changeSelection";
import { expect, test } from "./playwright/harnessPage";

test("split files retain separate group scopes, empty inclusion and distinct commit drafts", async ({
    page,
    mountHarness,
}, testInfo) => {
    const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    const state: ChangelistState = {
        revision: 2,
        activeId: "default",
        allDraft: "Aggregate draft",
        lists: [
            { id: "default", name: "Changes", description: "General work", draft: "General draft" },
            {
                id: "feature",
                name: "Feature",
                description: "Calculation work",
                draft: "Feature draft",
            },
        ],
        files: {
            "mutable.txt": "default",
            "binary.bin": "default",
            "topic-renamed.txt": "default",
            "crlf.txt": "default",
            "untracked.txt": "default",
        },
        changes: {
            "mutable.txt": {
                contentId: "content",
                totalChanges: 4,
                lines: { fingerprint: "feature" },
                selections: { feature: { contentId: "content", lineIds: [], total: 4 } },
            },
        },
    };
    await page.evaluate(
        (state) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setChangelists", repositoryRoot: "<ROOT>", state },
                }),
            ),
        state,
    );
    const scope = page.getByRole("combobox", { name: "Changelists", exact: true });
    const composer = page.getByRole("textbox", { name: /^Commit Message · / });
    await expect(composer).toHaveValue("Aggregate draft");
    await scope.selectOption("feature");
    await expect(composer).toHaveValue("Feature draft");
    const feature = page.locator('[data-changelist-id="feature"]');
    const general = page.locator('[data-changelist-id="default"]');
    await expect(feature.getByText("mutable.txt", { exact: true }).first()).toBeVisible();
    await expect(general.getByText("mutable.txt", { exact: true }).first()).toBeVisible();
    await expect(general.getByText("Active", { exact: true })).toBeVisible();
    await feature.getByRole("checkbox", { name: "Include Feature in commit", exact: true }).click();
    await expect(
        feature.getByRole("checkbox", { name: "Include Feature in commit", exact: true }),
    ).toHaveJSProperty("indeterminate", true);
    await expect(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
    expect(
        (await harness.recordedMessages()).some(
            (value) =>
                typeof value === "object" &&
                value !== null &&
                "action" in value &&
                value.action === "activate",
        ),
    ).toBe(false);
    await expect(composer).toHaveAccessibleName("Commit Message · Feature");
    const cancelled = await feature
        .locator("[data-vscode-context]")
        .first()
        .evaluate(
            (element) =>
                !element.dispatchEvent(
                    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
                ),
        );
    expect(cancelled).toBe(false);
    await page.getByRole("button", { name: "Collapse All", exact: true }).click();
    await expect(feature.getByRole("group", { name: "Feature", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    await expect(feature.getByRole("group", { name: "Feature", exact: true })).toBeVisible();
    await expect(feature.getByText("mutable.txt", { exact: true }).first()).toBeVisible();
    await expect(general.getByText("mutable.txt", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("grouped-changelists.png") });
    await scope.selectOption("all");
    await expect(composer).toHaveValue("Aggregate draft");
    await scope.selectOption("default");
    await expect(composer).toHaveValue("General draft");
    const removed: ChangelistState = {
        ...state,
        revision: 3,
        activeId: "feature",
        lists: [state.lists[1]],
        files: Object.fromEntries(Object.keys(state.files).map((file) => [file, "feature"])),
        removedScopes: { default: "feature" },
    };
    await page.evaluate(
        (state) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setChangelists", repositoryRoot: "<ROOT>", state },
                }),
            ),
        removed,
    );
    await expect(scope).toHaveValue("feature");
    await expect(composer).toHaveValue("Feature draft");
});

test("recovery review is explicitly routed to the captured repository", async ({
    page,
    mountHarness,
}) => {
    const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "setChangelists",
                    repositoryRoot: "<ROOT>",
                    busy: false,
                    hasRecoveryIssues: true,
                    state: {
                        revision: 1,
                        activeId: "default",
                        lists: [{ id: "default", name: "Default" }],
                        files: {},
                        changes: {},
                    },
                },
            }),
        ),
    );
    const button = page.getByRole("button", { name: "Review partial-index recovery", exact: true });
    await expect(button).toBeVisible();
    await button.click();
    expect(await harness.recordedMessages()).toContainEqual({
        type: "changelistAction",
        repositoryRoot: "<ROOT>",
        revision: 1,
        action: "reviewRecovery",
        listId: "all",
    });
});
test("partial selections preserve their IDs, read-only preview and commit draft after a failure", async ({
    page,
    mountHarness,
}) => {
    const harness = await mountHarness("partial-changes", { webviewFixture: "dirty.json" });
    const lines = page.locator(".partial-line input[type=checkbox]");
    expect(await lines.count()).toBeGreaterThan(0);
    await lines.first().uncheck();
    await page.getByRole("textbox", { name: "Commit message", exact: true }).fill("Selected draft");
    await page.getByRole("button", { name: "Stage selected", exact: true }).click();
    const messages = await harness.recordedMessages();
    const selected = messages.findLast(
        (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "stageSelection",
    );
    expect(selected).toHaveProperty("selection.snapshotId");
    expect(selected).not.toHaveProperty("patch");
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "partialError", message: "Index changed; review the selection." },
            }),
        ),
    );
    await expect(page.getByRole("alert")).toContainText("Index changed");
    await expect(lines.first()).not.toBeChecked();
    await expect(page.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue(
        "Selected draft",
    );
    const preview = page.getByLabel("Selection preview", { exact: true });
    const toggle = page.getByRole("button", { name: "Show selection preview", exact: true });
    await expect(preview).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(preview).toHaveAttribute("contenteditable", "false");
    await toggle.click();
    await expect(preview).toHaveCount(0);
});

test("a thousand-file commit queue stays bounded and reachable by scroll and keyboard", async ({
    page,
    mountHarness,
}, testInfo) => {
    await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    const fixture = JSON.parse(
        readFileSync(path.join(__dirname, "fixtures/commit-panel/dirty.json"), "utf8"),
    ) as {
        messages: { message: { type: string; files?: unknown[]; [key: string]: unknown } }[];
    };
    const update = fixture.messages.findLast(({ message }) => message.type === "update")!.message;
    const files = Array.from({ length: 1000 }, (_, i) => ({
        path: `file-${String(i).padStart(4, "0")}.txt`,
        status: "M",
        staged: false,
        additions: 1,
        deletions: 0,
    }));
    const state: ChangelistState = {
        revision: 1,
        activeId: "default",
        lists: [{ id: "default", name: "Default" }],
        files: Object.fromEntries(files.map((file) => [file.path, "default"])),
        changes: {},
    };
    await page.evaluate(
        ({ update, files, state }) => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        ...update,
                        files,
                        stashes: [],
                        shelves: [],
                        changedFileCount: files.length,
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setChangelists", repositoryRoot: "<ROOT>", state, busy: false },
                }),
            );
        },
        { update, files, state },
    );
    const tree = page.getByTestId("virtual-commit-tree");
    await expect(tree).toHaveCount(1);
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    const first = tree.locator("[data-virtual-row-index]").first();
    await first.focus();
    await first.press("End");
    const last = tree.locator('[data-virtual-row-index="999"]');
    await expect(last).toBeVisible();
    await expect(last.getByRole("checkbox")).toBeFocused();
    await last.getByRole("checkbox").press("Home");
    await expect(tree.locator('[data-virtual-row-index="0"]')).toBeVisible();
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    await page.screenshot({ path: testInfo.outputPath("virtual-changelists.png") });
});
