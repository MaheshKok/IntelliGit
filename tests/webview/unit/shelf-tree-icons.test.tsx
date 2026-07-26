// @vitest-environment jsdom

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShelfFileView } from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfFileTree } from "../../../src/webviews/react/commit-panel/components/ShelfFileTree";
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

function renderTree(props: Partial<React.ComponentProps<typeof ShelfFileTree>> = {}) {
    return mount(
        <ChakraProvider theme={theme}>
            <ShelfFileTree
                entries={entries}
                groupByDir={true}
                depth={0}
                selectedChangeId={null}
                isDirectoryCollapsed={() => false}
                onToggleDirectory={() => undefined}
                onFileSelect={() => undefined}
                onFileActivate={() => undefined}
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
