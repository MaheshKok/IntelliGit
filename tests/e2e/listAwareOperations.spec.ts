import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ShelfStore } from "../../src/shelf/store";
import { resolveShelfPaths } from "../../src/shelf/paths";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw as runGit } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "whole-save-名前.txt";
const OTHER = "keep-staged.txt";

test.describe("List-aware operations", () => {
    test.use({ scenario: "clean" });

    test("list and explicit whole-file Save preserve local layers and cancellation creates no shelf", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await writeFile(path.join(workspace.root, FILE), "base\n");
        await writeFile(path.join(workspace.root, OTHER), "other base\n");
        await runGit(workspace.root, ["add", "--", FILE, OTHER], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "Save fixture"], workspace.env);
        await writeFile(path.join(workspace.root, FILE), "base\nstaged\n");
        await writeFile(path.join(workspace.root, OTHER), "other staged\n");
        await runGit(workspace.root, ["add", "--", FILE, OTHER], workspace.env);
        await writeFile(path.join(workspace.root, FILE), "base\nstaged\nworking\n");
        const shelfStorageRoot = path.join(workspace.profileDir, "list-save-storage");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace: { ...workspace, shelfStorageRoot },
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await new IntelliGitView(page).reveal();
            await expect(
                frame.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await frame.getByRole("checkbox", { name: OTHER, exact: true }).first().uncheck();
            await frame.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            const indexBefore = await readFile(path.join(workspace.root, ".git/index"));
            const headBefore = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
            const statePath = path.join(workspace.root, ".git/intelligit/changelists/state.json");
            const before = JSON.parse(await readFile(statePath, "utf8")).state;
            const shelves = new ShelfStore(
                await resolveShelfPaths({
                    repositoryRoot: workspace.root,
                    globalStoragePath: shelfPath,
                    overridePath: shelfPath,
                }),
            );
            const input = page.locator(".quick-input-widget .quick-input-box input");
            const whole = frame.getByRole("button", {
                name: "Save Selected Whole Files to Shelf",
                exact: true,
            });
            await whole.focus();
            await page.keyboard.press("Enter");
            await expect(input).toBeVisible();
            await input.press("Escape");
            await expect(
                frame.getByRole("status").filter({ hasText: "Save cancelled." }),
            ).toBeVisible();
            expect((await shelves.listShelves()).shelfIds).toEqual([]);

            await whole.focus();
            await page.keyboard.press("Enter");
            await expect(input).toBeVisible();
            await input.fill("Whole file 名前");
            await input.press("Enter");
            await expect(
                frame.getByRole("status").filter({ hasText: "Local changes are unchanged." }),
            ).toBeVisible();
            const [wholeId] = (await shelves.listShelves()).shelfIds;
            const wholeManifest = await shelves.readCurrentShelfManifest(wholeId!);
            expect(wholeManifest.metadata.name).toBe("Whole file 名前");
            expect(wholeManifest.metadata.selection?.scope).toBe("files");
            expect(
                wholeManifest.files.map(
                    (file) => file.worktreeBlock?.path ?? file.indexBlock?.path,
                ),
            ).toEqual([FILE]);
            expect(wholeManifest.files[0].indexBlock).toBeDefined();
            expect(wholeManifest.files[0].worktreeBlock).toBeDefined();

            await frame
                .getByRole("button", {
                    name: `Actions for ${before.lists.find((list: { id: string; name: string }) => list.id === before.activeId).name}`,
                    exact: true,
                })
                .click();
            await page.screenshot({ path: testInfo.outputPath("list-save-menu-after-notice.png") });
            await frame.getByRole("menuitem", { name: "Save to Shelf", exact: true }).click();
            await expect(input).toBeVisible();
            await input.fill("Complete default list");
            await input.press("Enter");
            await expect.poll(async () => (await shelves.listShelves()).shelfIds.length).toBe(2);
            const listId = (await shelves.listShelves()).shelfIds.find((id) => id !== wholeId)!;
            const listManifest = await shelves.readCurrentShelfManifest(listId);
            expect(listManifest.metadata.name).toBe("Complete default list");
            expect(listManifest.metadata.selection?.scope).toBe("list");
            expect(
                listManifest.files
                    .map((file) => file.worktreeBlock?.path ?? file.indexBlock?.path)
                    .sort(),
            ).toEqual([FILE, OTHER].sort());
            expect(await readFile(path.join(workspace.root, ".git/index"))).toEqual(indexBefore);
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(
                headBefore,
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(
                "base\nstaged\nworking\n",
            );
            expect(await readFile(path.join(workspace.root, OTHER), "utf8")).toBe("other staged\n");
            const after = JSON.parse(await readFile(statePath, "utf8")).state;
            expect(after.lists).toEqual(before.lists);
            expect(after.activeId).toBe(before.activeId);
            expect(after.files).toEqual(before.files);
            expect(after.changes).toEqual(before.changes);
            await page.screenshot({ path: testInfo.outputPath("list-file-shelf-saved.png") });
        } finally {
            await app.close();
        }
    });
});
