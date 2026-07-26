// @vitest-environment jsdom

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ThemeTreeIcon, WorkingFile } from "../../../src/types";
import type { ShelfFileView } from "../../../src/webviews/protocol/commitPanelMessages";
import { ChangesFileTree } from "../../../src/webviews/react/shared/components/ChangesFileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const entries = [
    {
        changeId: "themed",
        worktreeBlock: { path: "src/app.tsx", status: "M" },
        icon: { uri: "https://icons.test/react.svg" },
    },
    { changeId: "plain", worktreeBlock: { path: "src/notes.md", status: "M" } },
] as ShelfFileView[];

type ShelfDisplayFile = WorkingFile & { shelfEntry: ShelfFileView };

function displayFile(entry: ShelfFileView): ShelfDisplayFile {
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

function renderTree(
    props: { folderIcon?: ThemeTreeIcon; folderExpandedIcon?: ThemeTreeIcon } = {},
) {
    return mount(
        <ChakraProvider theme={theme}>
            <ChangesFileTree
                files={entries.map(displayFile)}
                groupByDir={true}
                depth={0}
                selectedId={null}
                getId={(file) => file.shelfEntry.changeId}
                isDirectoryCollapsed={() => false}
                onToggleDirectory={() => undefined}
                onSelect={() => undefined}
                dataAttributes={(file) => ({ "shelf-file": file.shelfEntry.changeId })}
                {...props}
            />
        </ChakraProvider>,
    );
}

describe("shelf file rows use the same theme icons as the Changed Files tree", () => {
    beforeEach(() => installWebviewI18n());

    it("renders the theme file icon a shelf entry carries", () => {
        const { root, container } = renderTree();
        const row = container.querySelector('[data-shelf-file="themed"]') as HTMLElement;

        const icon = row.querySelector('img[data-tree-icon="file"]') as HTMLImageElement;
        expect(icon).toBeTruthy();
        expect(icon.getAttribute("src")).toBe("https://icons.test/react.svg");

        unmount(root, container);
    });

    it("falls back to the generic glyph for an entry with no resolved icon", () => {
        const { root, container } = renderTree();
        const row = container.querySelector('[data-shelf-file="plain"]') as HTMLElement;

        expect(row.querySelector('img[data-tree-icon="file"]')).toBeNull();
        expect(row.querySelector('[data-tree-icon="file"]')).toBeTruthy();

        unmount(root, container);
    });

    it("renders theme folder icons for the directories it groups files under", () => {
        const { root, container } = renderTree({
            folderIcon: { uri: "https://icons.test/folder.svg" },
            folderExpandedIcon: { uri: "https://icons.test/folder-open.svg" },
        });

        const folderIcon = container.querySelector(
            'img[data-tree-icon="folder"]',
        ) as HTMLImageElement;
        expect(folderIcon).toBeTruthy();
        // The tree renders directories expanded, so the open variant is the one shown.
        expect(folderIcon.getAttribute("src")).toBe("https://icons.test/folder-open.svg");

        unmount(root, container);
    });
});
