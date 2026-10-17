import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { PartialEditorReply } from "../../src/webviews/protocol/changelists";
import { expect, test } from "./playwright/harnessPage";

function partialFile() {
    const fixture = JSON.parse(
        readFileSync(path.join(__dirname, "fixtures/partial-changes/dirty.json"), "utf8"),
    ) as {
        messages: { message: PartialEditorReply }[];
    };
    const file = fixture.messages.find(({ message }) => message.type === "partialFile")?.message;
    if (!file || file.type !== "partialFile") throw new Error("Missing recorded partial file.");
    return { ...file, canShelf: true, lastCommitMessage: "Original selected-change message" };
}

async function assertMenuFits(page: Page): Promise<void> {
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(async () => {
        const bounds = (await menu.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }).toPass({ timeout: 5000 });
}

for (const locale of ["en", "fr", "zh-cn"] as const) {
    test(`selected operations retain their identity, draft and bounded ${locale} menu`, async ({
        page,
        mountHarness,
    }, testInfo) => {
        const harness = await mountHarness("partial-changes", {
            webviewFixture: "dirty.json",
            locale,
        });
        await page.evaluate(
            (data) => window.dispatchEvent(new MessageEvent("message", { data })),
            partialFile(),
        );
        const strings = harness.i18n.catalog;
        const more = page.getByRole("button", {
            name: String(strings["changes.moreActions"]),
            exact: true,
        });
        for (const [operation, key] of [
            ["export", "changes.exportPatch"],
            ["save", "shelf.action.save"],
            ["shelve", "changes.shelveSelected"],
            ["rollback", "changes.rollbackSelected"],
        ]) {
            await more.click();
            const menu = page.getByRole("menu");
            await assertMenuFits(page);
            await menu.getByRole("menuitem", { name: String(strings[key]), exact: true }).click();
            const messages = await harness.recordedMessages();
            const sent = messages.findLast(
                (value) =>
                    typeof value === "object" &&
                    value !== null &&
                    "type" in value &&
                    value.type === "selectedOperation",
            );
            expect(sent).toMatchObject({ type: "selectedOperation", operation });
            expect(sent).toHaveProperty("selection.snapshotId");
            expect(sent).not.toHaveProperty("path");
            expect(sent).not.toHaveProperty("patch");
            await page.evaluate(() => {
                window.dispatchEvent(
                    new MessageEvent("message", { data: { type: "partialCanceled" } }),
                );
                window.dispatchEvent(
                    new MessageEvent("message", { data: { type: "partialReady" } }),
                );
            });
            await expect(more).toBeEnabled();
        }
        await page
            .getByRole("checkbox", {
                name: String(strings["changes.amendLastCommit"]),
                exact: true,
            })
            .check();
        await expect(
            page.getByRole("textbox", {
                name: String(strings["changes.commitMessage"]),
                exact: true,
            }),
        ).toHaveValue("Original selected-change message");
        await more.click();
        await assertMenuFits(page);
        await page.screenshot({ path: testInfo.outputPath(`selected-operations-${locale}.png`) });
    });
}

test("only visible large-tree rows request counts and stale replies cannot replace a new refresh", async ({
    page,
    mountHarness,
}, testInfo) => {
    const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    const fixture = JSON.parse(
        readFileSync(path.join(__dirname, "fixtures/commit-panel/dirty.json"), "utf8"),
    ) as {
        messages: { message: { type: string; [key: string]: unknown } }[];
    };
    const update = fixture.messages.findLast(({ message }) => message.type === "update")!.message;
    const files = Array.from({ length: 10_000 }, (_, i) => ({
        path: `file-${String(i).padStart(5, "0")}.txt`,
        status: "M",
        staged: false,
        additions: 0,
        deletions: 0,
        statsState: "pending",
        statsRevision: "visible-one",
    }));
    await page.evaluate(
        ({ update, files }) => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        ...update,
                        files,
                        shelves: [],
                        stashes: [],
                        changedFileCount: files.length,
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setChangelists",
                        repositoryRoot: "<ROOT>",
                        state: {
                            revision: 1,
                            activeId: "default",
                            lists: [{ id: "default", name: "Changes" }],
                            files: Object.fromEntries(files.map((file) => [file.path, "default"])),
                            changes: {},
                        },
                    },
                }),
            );
        },
        { update, files },
    );
    const tree = page.getByTestId("virtual-commit-tree");
    await expect(tree).toBeVisible();
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    const requests = async () =>
        (await harness.recordedMessages()).filter(
            (value) =>
                typeof value === "object" &&
                value !== null &&
                "type" in value &&
                value.type === "requestWorkingFileStats",
        ) as {
            type: string;
            revision: string;
            paths: string[];
        }[];
    await expect.poll(async () => (await requests()).length).toBeGreaterThan(0);
    const first = await requests();
    const requested = [...new Set(first.flatMap((request) => request.paths))];
    expect(requested.length).toBeLessThan(150);
    for (const request of first) expect(request.paths.length).toBeLessThanOrEqual(128);
    await page.evaluate(
        (files) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "workingFileStats",
                        repositoryRoot: "<ROOT>",
                        revision: "retired",
                        files: files.map((file) => ({
                            ...file,
                            additions: 999,
                            statsState: "ready",
                        })),
                    },
                }),
            ),
        files.slice(0, 40),
    );
    await expect(tree.getByText("+999", { exact: true })).toHaveCount(0);
    await page.evaluate(
        (files) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "workingFileStats",
                        repositoryRoot: "<ROOT>",
                        revision: "visible-one",
                        files: files.map((file) => ({
                            ...file,
                            additions: 3,
                            statsState: "ready",
                        })),
                    },
                }),
            ),
        files.filter((file) => requested.includes(file.path)),
    );
    await expect(tree.getByText("+3", { exact: true }).first()).toBeVisible();
    await tree.locator("[data-virtual-row-index]").first().focus();
    await tree.locator("[data-virtual-row-index]").first().press("End");
    await expect(tree.locator('[data-virtual-row-index="9999"]')).toBeVisible();
    await expect
        .poll(async () =>
            (await requests()).some((request) => request.paths.includes("file-09999.txt")),
        )
        .toBe(true);
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    await page.screenshot({ path: testInfo.outputPath("visible-statistics.png") });
});
