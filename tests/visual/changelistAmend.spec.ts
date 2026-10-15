import { expect, test } from "./playwright/harnessPage";
import type { Page } from "@playwright/test";
import dirtyFixture from "./fixtures/commit-panel/dirty.json";

/** Hydrates the real commit app with metadata and no checked files, preserving its normal controllers. */
async function hydrateEmpty(page: Page, hasCommits = true): Promise<void> {
    const update = dirtyFixture.messages.find(({ message }) => message.type === "update")!.message;
    await page.evaluate(
        ({ hasCommits, update }) => {
            for (const data of [
                {
                    ...update,
                    type: "update",
                    repositoryRoot: "<ROOT>",
                    files: [],
                    hasCommits,
                    refreshing: false,
                    wholeIndexOperationInProgress: false,
                },
                {
                    type: "setChangelists",
                    repositoryRoot: "<ROOT>",
                    state: {
                        revision: 1,
                        activeId: "default",
                        allDraft: "",
                        lists: [{ id: "default", name: "Changes", draft: "" }],
                        files: {},
                        changes: {},
                    },
                },
            ])
                window.dispatchEvent(new MessageEvent("message", { data }));
        },
        { hasCommits, update },
    );
}

for (const push of [false, true]) {
    test(`All message-only amend submits the scoped draft (push=${push})`, async ({
        page,
        mountHarness,
    }) => {
        const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
        await hydrateEmpty(page);
        await expect(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
        await page.getByRole("checkbox", { name: "Amend commit", exact: true }).check();
        const amend = page.getByRole("button", { name: "Amend commit", exact: true });
        await expect(amend).toBeEnabled();
        // Empty replacement text reuses HEAD's message; it must still travel through All.
        await expect(page.locator("#commit-area-message")).toHaveValue("");
        if (push) await page.getByTestId("commit-action-push").click();
        else await amend.click();
        expect(await harness.recordedMessages()).toContainEqual({
            type: "commitChangelist",
            repositoryRoot: "<ROOT>",
            revision: 1,
            listId: "all",
            paths: [],
            message: "",
            amend: true,
            push,
        });
    });
}

test("All amend generation sends an empty path request while named lists and unborn HEAD stay blocked", async ({
    page,
    mountHarness,
}) => {
    const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    await hydrateEmpty(page);
    await page.getByRole("checkbox", { name: "Amend commit", exact: true }).check();
    await page.getByRole("button", { name: "Generate commit message", exact: true }).click();
    expect(await harness.recordedMessages()).toContainEqual(
        expect.objectContaining({
            type: "generateCommitMessage",
            repositoryRoot: "<ROOT>",
            paths: [],
            amend: true,
        }),
    );
    await page.getByRole("combobox", { name: "Changelists", exact: true }).selectOption("default");
    await expect(
        page.getByRole("checkbox", { name: "Amend commit", exact: true }),
    ).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
    await page.getByRole("combobox", { name: "Changelists", exact: true }).selectOption("all");
    await hydrateEmpty(page, false);
    await expect(page.getByRole("checkbox", { name: "Amend commit", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
});
