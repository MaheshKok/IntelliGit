import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import type { IconThemeService } from "../../../src/views/shared/IconThemeService";
import {
    decorateShelfFiles,
    shelfFilePath,
    shelfFilePaths,
} from "../../../src/views/shelfIconDecoration";

/** Resolves one icon per path so a decorated entry can be traced back to its path. */
function iconThemeStub(): IconThemeService {
    return {
        decorateFilePaths: async <T extends { path: string; icon?: unknown }>(items: T[]) =>
            items.map((item) => ({ ...item, icon: { uri: `icon:${item.path}` } })),
    } as unknown as IconThemeService;
}

function shelf(files: ShelfEntry["files"]): ShelfEntry {
    return { id: "shelf-a", generation: 1, metadata: { name: "Parser repair" }, files };
}

describe("shelf file icon decoration", () => {
    it("displays the worktree path, falling back to the index path then the change id", () => {
        expect(
            shelfFilePath({
                changeId: "c1",
                worktreeBlock: { path: "src/worktree.ts" },
                indexBlock: { path: "src/index.ts" },
            } as ShelfEntry["files"][number]),
        ).toBe("src/worktree.ts");
        expect(
            shelfFilePath({
                changeId: "c2",
                indexBlock: { path: "src/index.ts" },
            } as ShelfEntry["files"][number]),
        ).toBe("src/index.ts");
        expect(shelfFilePath({ changeId: "c3" } as ShelfEntry["files"][number])).toBe("c3");
    });

    it("collects every displayed path across shelves for folder-icon resolution", () => {
        const shelves = [
            shelf([{ changeId: "c1", worktreeBlock: { path: "src/a.ts" } }] as ShelfEntry["files"]),
            shelf([
                { changeId: "c2", indexBlock: { path: "docs/b.md" } },
                { changeId: "c3" },
            ] as ShelfEntry["files"]),
        ];

        expect(shelfFilePaths(shelves)).toEqual(["src/a.ts", "docs/b.md", "c3"]);
    });

    it("attaches each file the icon its own path resolved to", async () => {
        const shelves = [
            shelf([
                { changeId: "c1", worktreeBlock: { path: "src/a.ts" } },
                { changeId: "c2", indexBlock: { path: "docs/b.md" } },
            ] as ShelfEntry["files"]),
        ];

        const decorated = await decorateShelfFiles(iconThemeStub(), shelves);

        expect(decorated[0].files.map((file) => file.icon?.uri)).toEqual([
            "icon:src/a.ts",
            "icon:docs/b.md",
        ]);
        // Decoration copies rather than mutating the shelves it was handed.
        expect(shelves[0].files[0].icon).toBeUndefined();
    });

    it("leaves shelves intact when the theme resolves no icons", async () => {
        const noIcons = {
            decorateFilePaths: async <T>(items: T[]) => items,
        } as unknown as IconThemeService;
        const shelves = [
            shelf([{ changeId: "c1", worktreeBlock: { path: "src/a.ts" } }] as ShelfEntry["files"]),
        ];

        const decorated = await decorateShelfFiles(noIcons, shelves);

        expect(decorated[0].files[0].icon).toBeUndefined();
        expect(decorated[0].files[0].changeId).toBe("c1");
    });
});
