// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StashEntry, WorkingFile } from "../../../src/types";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { StashTab } from "../../../src/webviews/react/commit-panel/components/StashTab";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const vscode = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => vscode,
}));

initReactDomTestEnvironment();

const shelves: ShelfEntry[] = [
    {
        id: "shelf-a",
        generation: 7,
        files: [
            { changeId: "change-a", worktreeBlock: { path: "src/parser.ts", status: "M" } },
            { changeId: "change-b", worktreeBlock: { path: "src/lexer.ts", status: "M" } },
        ],
        metadata: { name: "Parser repair", lifecycle: "shelved" },
    },
    {
        id: "shelf-b",
        generation: 9,
        files: [{ changeId: "change-c", worktreeBlock: { path: "src/writer.ts", status: "M" } }],
        metadata: { name: "Writer tweak", lifecycle: "shelved" },
    },
];

const stashes: StashEntry[] = [
    { index: 0, message: "On main: Fix stash layout", date: "2026-07-21 10:00", hash: "abc" },
];
const stashFiles: WorkingFile[] = [
    { path: "src/first.ts", status: "M", staged: false, additions: 1, deletions: 0 },
    { path: "src/second.ts", status: "A", staged: false, additions: 2, deletions: 0 },
];

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function pressArrowRight(element: Element): void {
    act(() =>
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );
}

function query(container: ParentNode, selector: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`Missing element: ${selector}`);
    return found;
}

/**
 * Every node the tree currently marks as selected. A tree has exactly one, so the
 * count is what these tests assert on rather than any single row's attribute.
 */
function selectedNodes(container: ParentNode): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[aria-selected="true"]'));
}

function renderShelfTab() {
    return mount(
        <ChakraProvider theme={theme}>
            <ShelfTab
                repositoryRoot="/repo"
                shelves={shelves}
                selectedShelfId="shelf-a"
                catalogGeneration={1}
                onRefresh={vi.fn()}
                onSelect={vi.fn()}
                onUnshelve={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
                onShowDiff={vi.fn()}
                onCompareWithLocal={vi.fn()}
                onRestoreGhost={vi.fn()}
                onImportPatch={vi.fn()}
                onExportPatch={vi.fn()}
                onCopyPatch={vi.fn()}
                onCleanUp={vi.fn()}
                onToggleGroupBy={vi.fn()}
            />
        </ChakraProvider>,
    );
}

function renderStashTab() {
    return mount(
        <ChakraProvider theme={theme}>
            <StashTab
                repositoryRoot="/repo"
                currentBranchName="main"
                stashes={stashes}
                stashFiles={stashFiles}
                selectedIndex={0}
                groupByDir={false}
                onToggleGroupBy={vi.fn()}
            />
        </ChakraProvider>,
    );
}

describe("the Shelf tree keeps exactly one node selected", () => {
    beforeEach(() => {
        installWebviewI18n();
        vscode.postMessage.mockClear();
    });

    it("moves the indicator off the previous file, including across shelves", () => {
        const { root, container } = renderShelfTab();
        pressArrowRight(query(container, '[data-shelf-id="shelf-a"]'));
        pressArrowRight(query(container, '[data-shelf-id="shelf-b"]'));

        click(query(container, '[data-shelf-file="change-a"]'));
        expect(selectedNodes(container).map((node) => node.dataset.shelfFile)).toEqual([
            "change-a",
        ]);

        click(query(container, '[data-shelf-file="change-b"]'));
        expect(selectedNodes(container).map((node) => node.dataset.shelfFile)).toEqual([
            "change-b",
        ]);

        // A second shelf's subtree is a separate component; its selection has to
        // displace the first one's rather than sit alongside it.
        click(query(container, '[data-shelf-file="change-c"]'));
        expect(selectedNodes(container).map((node) => node.dataset.shelfFile)).toEqual([
            "change-c",
        ]);

        unmount(root, container);
    });

    it("takes the indicator off the shelf row while a file owns it, and back on click", () => {
        const { root, container } = renderShelfTab();
        expect(selectedNodes(container).map((node) => node.dataset.shelfId)).toEqual(["shelf-a"]);

        pressArrowRight(query(container, '[data-shelf-id="shelf-a"]'));
        click(query(container, '[data-shelf-file="change-a"]'));
        expect(selectedNodes(container).map((node) => node.dataset.shelfId)).toEqual([undefined]);

        click(query(container, '[data-shelf-id="shelf-a"]'));
        expect(selectedNodes(container).map((node) => node.dataset.shelfId)).toEqual(["shelf-a"]);

        unmount(root, container);
    });

    it("returns the selection to the shelf row when the file's subtree collapses", () => {
        const { root, container } = renderShelfTab();
        const shelfRow = query(container, '[data-shelf-id="shelf-a"]');
        pressArrowRight(shelfRow);
        click(query(container, '[data-shelf-file="change-a"]'));

        act(() =>
            shelfRow.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
            ),
        );

        expect(selectedNodes(container).map((node) => node.dataset.shelfId)).toEqual(["shelf-a"]);

        unmount(root, container);
    });
});

describe("the Stash tree keeps exactly one node selected", () => {
    beforeEach(() => {
        installWebviewI18n();
        vscode.postMessage.mockClear();
    });

    it("takes the indicator off the stash row while a file owns it, and back on click", () => {
        const { root, container } = renderStashTab();
        expect(selectedNodes(container).map((node) => node.dataset.stashIndex)).toEqual(["0"]);

        pressArrowRight(query(container, '[data-stash-index="0"]'));
        click(query(container, '[data-stash-file="src/first.ts"]'));
        expect(selectedNodes(container).map((node) => node.dataset.stashFile)).toEqual([
            "src/first.ts",
        ]);

        click(query(container, '[data-stash-file="src/second.ts"]'));
        expect(selectedNodes(container).map((node) => node.dataset.stashFile)).toEqual([
            "src/second.ts",
        ]);

        // Clicking the already-selected stash row still has to reclaim the selection.
        click(query(container, '[data-stash-index="0"]'));
        expect(selectedNodes(container).map((node) => node.dataset.stashIndex)).toEqual(["0"]);

        unmount(root, container);
    });
});
