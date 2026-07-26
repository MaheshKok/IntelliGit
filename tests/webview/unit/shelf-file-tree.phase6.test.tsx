// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ChangesFileTree } from "../../../src/webviews/react/shared/components/ChangesFileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const entries = [
    {
        changeId: "type-change",
        indexBlock: { path: "src/index-only.ts", status: "T" },
    },
    {
        changeId: "untracked",
        untracked: true,
    },
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

function renderTree(
    overrides: { entries?: ShelfFileEntry[]; groupByDir?: boolean; onDragStart?: boolean } = {},
) {
    const onFileActivate = vi.fn();
    const onDragStart = vi.fn();
    const ControlledShelfFileTree = (): React.ReactElement => {
        const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
        const [selectedChangeId, setSelectedChangeId] = React.useState<string | null>(null);
        const files = (overrides.entries ?? entries).map(displayFile);
        return (
            <ChangesFileTree
                files={files}
                groupByDir={overrides.groupByDir ?? false}
                depth={1}
                selectedId={selectedChangeId}
                getId={(file) => file.shelfEntry.changeId}
                onSelect={(file) => {
                    setSelectedChangeId(file.shelfEntry.changeId);
                    onFileActivate(file.shelfEntry);
                }}
                onActivate={(file) => onFileActivate(file.shelfEntry)}
                onDragStart={
                    overrides.onDragStart === false
                        ? undefined
                        : (event, file) => onDragStart(event, file.shelfEntry)
                }
                dataAttributes={(file) => ({ "shelf-file": file.shelfEntry.changeId })}
                emptyState={<span>No shelf files.</span>}
                isDirectoryCollapsed={(path) => collapsed.has(path)}
                onToggleDirectory={(path) =>
                    setCollapsed((current) => {
                        const next = new Set(current);
                        if (!next.delete(path)) next.add(path);
                        return next;
                    })
                }
            />
        );
    };
    const mounted = mount(
        <ChakraProvider theme={theme}>
            <ControlledShelfFileTree />
        </ChakraProvider>,
    );
    return { ...mounted, onFileActivate, onDragStart };
}

describe("ChangesFileTree shelf configuration", () => {
    beforeEach(() => installWebviewI18n());

    it("uses index-only paths, normalizes type changes, and activates the owning shelf entry", () => {
        const { root, container, onFileActivate } = renderTree();
        const row = container.querySelector('[data-shelf-file="type-change"]') as HTMLElement;

        expect(row.getAttribute("title")).toBe("src/index-only.ts");
        expect(row.getAttribute("data-vscode-context")).toBeNull();
        act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));

        expect(onFileActivate).toHaveBeenCalledWith(entries[0]);
        expect(row.getAttribute("aria-current")).toBe("true");
        unmount(root, container);
    });

    it("uses the change id for an untracked entry, supports dragging, and renders the empty state", () => {
        const { root, container, onDragStart } = renderTree();
        const row = container.querySelector('[data-shelf-file="untracked"]') as HTMLElement;

        expect(row.getAttribute("title")).toBe("untracked");
        act(() => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
        expect(onDragStart).toHaveBeenCalledWith(expect.anything(), entries[1]);
        unmount(root, container);

        const empty = renderTree({ entries: [], onDragStart: false });
        expect(empty.container.textContent).toContain("No shelf files.");
        unmount(empty.root, empty.container);
    });

    it("renders and collapses grouped directories while retaining keyboard-style file activation", () => {
        const { root, container, onFileActivate } = renderTree({ groupByDir: true });
        const folder = container.querySelector('button[title="src"]') as HTMLElement;

        expect(folder.getAttribute("aria-expanded")).toBe("true");
        act(() => folder.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(folder.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelector('[data-shelf-file="type-change"]')).toBeNull();
        act(() => folder.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(container.querySelector('[data-shelf-file="type-change"]')).not.toBeNull();

        const restoredFile = container.querySelector(
            '[data-shelf-file="type-change"]',
        ) as HTMLElement;
        act(() => restoredFile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        expect(onFileActivate).toHaveBeenCalledWith(entries[0]);
        unmount(root, container);
    });
});
