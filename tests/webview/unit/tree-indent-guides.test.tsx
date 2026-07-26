// @vitest-environment jsdom

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkingFile } from "../../../src/types";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ChangesFileTree } from "../../../src/webviews/react/shared/components/ChangesFileTree";
import { FileTreeRows } from "../../../src/webviews/react/shared/components/FileTreeRows";
import { buildFileTree } from "../../../src/webviews/react/shared/fileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const entries = [
    { changeId: "root", worktreeBlock: { path: "CHANGELOG.md", status: "M" } },
    { changeId: "nested", worktreeBlock: { path: "src/app.ts", status: "M" } },
] as ShelfFileEntry[];

type ShelfDisplayFile = WorkingFile & { shelfEntry: ShelfFileEntry };

function displayFile(entry: ShelfFileEntry): ShelfDisplayFile {
    const block = entry.worktreeBlock ?? entry.indexBlock;
    return {
        path: block?.path ?? entry.changeId,
        status: block?.status === "T" ? "M" : (block?.status ?? (entry.untracked ? "?" : "M")),
        staged: entry.indexBlock !== undefined,
        additions: 0,
        deletions: 0,
        icon: entry.icon,
        shelfEntry: entry,
    };
}

/** Left offsets, in render order, of the vertical rules a row draws for tree depth. */
function guideOffsets(row: HTMLElement): number[] {
    return Array.from(row.querySelectorAll("span"))
        .filter((span) => getComputedStyle(span).position === "absolute")
        .map((span) => Number.parseFloat(getComputedStyle(span).left));
}

/** Counts the absolutely positioned vertical rules a row draws for tree depth. */
function guideCount(row: HTMLElement): number {
    return guideOffsets(row).length;
}

function renderTree(groupByDir: boolean) {
    return mount(
        <ChakraProvider theme={theme}>
            <ChangesFileTree
                files={entries.map(displayFile)}
                groupByDir={groupByDir}
                depth={0}
                selectedId={null}
                getId={(file) => file.shelfEntry.changeId}
                isDirectoryCollapsed={() => false}
                onToggleDirectory={() => undefined}
                onSelect={() => undefined}
                dataAttributes={(file) => ({ "shelf-file": file.shelfEntry.changeId })}
            />
        </ChakraProvider>,
    );
}

describe("shelf file rows draw one indent guide per real ancestor", () => {
    beforeEach(() => installWebviewI18n());

    it("draws a single guide for the owning entry row, not the deleted section header", () => {
        const { root, container } = renderTree(false);

        for (const changeId of ["root", "nested"]) {
            const row = container.querySelector(`[data-shelf-file="${changeId}"]`) as HTMLElement;
            expect(guideCount(row)).toBe(1);
        }

        unmount(root, container);
    });

    it("adds exactly one more guide for a file nested inside a grouped directory", () => {
        const { root, container } = renderTree(true);
        const topLevel = container.querySelector('[data-shelf-file="root"]') as HTMLElement;
        const inDirectory = container.querySelector('[data-shelf-file="nested"]') as HTMLElement;

        expect(guideCount(topLevel)).toBe(1);
        expect(guideCount(inDirectory)).toBe(2);

        unmount(root, container);
    });

    // The Shelf and Stash subtrees hang off an entry row whose chevron sits further
    // right than a section header's. Their guides have to move with it, or the first
    // two lines end up touching where the Changed Files tree keeps them apart.
    it("spaces its first two guides the same as the Changed Files tree does", () => {
        const shelf = renderTree(true);
        const shelfRow = shelf.container.querySelector('[data-shelf-file="nested"]') as HTMLElement;
        const shelfGap = gapBetweenFirstTwoGuides(shelfRow);
        unmount(shelf.root, shelf.container);

        const changed = mount(
            <ChakraProvider theme={theme}>
                <FileTreeRows
                    entries={buildFileTree([
                        { path: "src/app.ts", status: "M", additions: 0, deletions: 0 },
                    ])}
                    depth={0}
                    isDirectoryExpanded={() => true}
                    onToggleDirectory={() => undefined}
                    fileWiring={() => ({ isSelected: false, onSelect: () => undefined })}
                />
            </ChakraProvider>,
        );
        const changedRow = changed.container.querySelector('[title="src/app.ts"]') as HTMLElement;
        const changedGap = gapBetweenFirstTwoGuides(changedRow);
        unmount(changed.root, changed.container);

        expect(changedGap).toBeGreaterThan(4);
        expect(shelfGap).toBe(changedGap);
    });
});

/** Distance between a row's parent-level guide and its own first depth guide. */
function gapBetweenFirstTwoGuides(row: HTMLElement): number {
    const [parentGuide, firstDepthGuide] = guideOffsets(row);
    return firstDepthGuide - parentGuide;
}
