// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import { ChangesFileTree } from "../../../src/webviews/react/shared/components/ChangesFileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

type StashFile = {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    stashPath: string;
};

type ShelfFile = {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    shelfEntry: { changeId: string };
};

describe("ChangesFileTree", () => {
    it("preserves stash identity, selection, activation, and context-menu wiring", () => {
        installWebviewI18n();
        const file: StashFile = {
            path: "notes/todo.md",
            status: "M",
            additions: 1,
            deletions: 0,
            stashPath: "stash:todo",
        };
        const onSelect = vi.fn();
        const onActivate = vi.fn();
        const onContextMenu = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ChangesFileTree
                    files={[file]}
                    groupByDir={false}
                    depth={1}
                    selectedId="stash:todo"
                    getId={(entry) => entry.stashPath}
                    isDirectoryCollapsed={() => false}
                    onToggleDirectory={vi.fn()}
                    onSelect={onSelect}
                    onActivate={onActivate}
                    onContextMenu={onContextMenu}
                    dataAttributes={(entry) => ({ "stash-file": entry.stashPath })}
                />
            </ChakraProvider>,
        );
        const row = container.querySelector('[data-stash-file="stash:todo"]') as HTMLElement;

        expect(row.getAttribute("aria-current")).toBe("true");
        expect(row.getAttribute("aria-level")).toBe("3");
        expect(row.draggable).toBe(false);
        act(() => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        expect(onActivate).toHaveBeenCalledWith(file);
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 34 }),
            ),
        );
        expect(onContextMenu).toHaveBeenCalledWith(file, 12, 34, row);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(onSelect).toHaveBeenCalledWith(file);
        unmount(root, container);
    });

    it("preserves shelf drag wiring and collapses grouped directories", () => {
        installWebviewI18n();
        const file: ShelfFile = {
            path: "src/shelf.ts",
            status: "M",
            additions: 0,
            deletions: 0,
            shelfEntry: { changeId: "shelf-change" },
        };
        const onDragStart = vi.fn();
        const onToggleDirectory = vi.fn();
        const ControlledShelfTree = (): React.ReactElement => {
            const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
            return (
                <ChangesFileTree
                    files={[file]}
                    groupByDir={true}
                    depth={0}
                    selectedId={null}
                    getId={(entry) => entry.shelfEntry.changeId}
                    isDirectoryCollapsed={(path) => collapsed.has(path)}
                    onToggleDirectory={(path) => {
                        onToggleDirectory(path);
                        setCollapsed((current) => {
                            const next = new Set(current);
                            if (!next.delete(path)) next.add(path);
                            return next;
                        });
                    }}
                    onSelect={vi.fn()}
                    dataAttributes={(entry) => ({ "shelf-file": entry.shelfEntry.changeId })}
                    onDragStart={onDragStart}
                />
            );
        };
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ControlledShelfTree />
            </ChakraProvider>,
        );
        const folder = container.querySelector('button[title="src"]') as HTMLElement;
        const row = container.querySelector('[data-shelf-file="shelf-change"]') as HTMLElement;

        expect(row.draggable).toBe(true);
        act(() => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
        expect(onDragStart).toHaveBeenCalledWith(expect.anything(), file);
        expect(folder.getAttribute("aria-expanded")).toBe("true");
        act(() => folder.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(onToggleDirectory).toHaveBeenCalledWith("src");
        expect(folder.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelector('[data-shelf-file="shelf-change"]')).toBeNull();
        unmount(root, container);
    });

    it("renders only caller-provided empty UI and no tree content for empty files", () => {
        installWebviewI18n();
        const empty = mount(
            <ChakraProvider theme={theme}>
                <ChangesFileTree
                    files={[] as StashFile[]}
                    groupByDir={false}
                    depth={0}
                    selectedId={null}
                    getId={(entry) => entry.stashPath}
                    isDirectoryCollapsed={() => false}
                    onToggleDirectory={vi.fn()}
                    onSelect={vi.fn()}
                    dataAttributes={(entry) => ({ "stash-file": entry.stashPath })}
                    emptyState={<span data-empty-stash="true" />}
                />
            </ChakraProvider>,
        );
        expect(empty.container.querySelector('[data-empty-stash="true"]')).not.toBeNull();
        unmount(empty.root, empty.container);

        const absent = mount(
            <ChakraProvider theme={theme}>
                <ChangesFileTree
                    files={[] as ShelfFile[]}
                    groupByDir={false}
                    depth={0}
                    selectedId={null}
                    getId={(entry) => entry.shelfEntry.changeId}
                    isDirectoryCollapsed={() => false}
                    onToggleDirectory={vi.fn()}
                    onSelect={vi.fn()}
                    dataAttributes={(entry) => ({ "shelf-file": entry.shelfEntry.changeId })}
                />
            </ChakraProvider>,
        );
        expect(absent.container.textContent).toBe("");
        expect(absent.container.querySelector('[role="treeitem"]')).toBeNull();
        unmount(absent.root, absent.container);
    });
});
