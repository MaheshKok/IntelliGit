// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { getShelfMenuItems } from "../../../src/webviews/react/commit-panel/components/shelfMenu";
import { Toolbar } from "../../../src/webviews/react/commit-panel/components/Toolbar";
import { ContextMenu } from "../../../src/webviews/react/shared/components/ContextMenu";
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
    { id: "shelf-a", generation: 7, metadata: { name: "Parser repair", lifecycle: "shelved" } },
    { id: "shelf-b", generation: 9, metadata: { name: "Old change", lifecycle: "applied" } },
];
const files = [
    { changeId: "change-a", worktreeBlock: { path: "src/parser.ts" } },
    { changeId: "change-b", worktreeBlock: { path: "src/lexer.ts" } },
] as ShelfFileEntry[];

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function key(element: Element, value: string, init: KeyboardEventInit = {}): void {
    act(() =>
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value, ...init })),
    );
}

function inputValue(input: HTMLInputElement, value: string): void {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Missing native input setter");
    act(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

function button(container: ParentNode, label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
}

function menuItem(label: string): HTMLElement {
    const found = Array.from(
        document.querySelectorAll<HTMLElement>(".intelligit-context-item"),
    ).find((candidate) => candidate.textContent?.trim().startsWith(label));
    if (!found) throw new Error(`Missing menu item: ${label}`);
    return found;
}

function iconButton(container: ParentNode, label: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Missing icon button: ${label}`);
    return found;
}

function openContextMenu(element: HTMLElement): void {
    act(() =>
        element.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
        ),
    );
}

function contextMenuLabels(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => {
        const children = Array.from(item.children);
        return (children.length === 3 ? children[1] : children[0])?.textContent?.trim() ?? "";
    });
}

function contextMenuSequence(): string[] {
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    return Array.from(menu.children).map((child) => {
        if (child.tagName === "HR") return "separator";
        const item = child as HTMLElement;
        const children = Array.from(item.children);
        return (children.length === 3 ? children[1] : children[0])?.textContent?.trim() ?? "";
    });
}

function renderShelfTab(overrides: Partial<React.ComponentProps<typeof ShelfTab>> = {}) {
    const callbacks = {
        onSelect: vi.fn(),
        onUnshelve: vi.fn(),
        onUnshelveSilently: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onShowDiff: vi.fn(),
        onCompareWithLocal: vi.fn(),
        onRestoreGhost: vi.fn(),
        onImportPatch: vi.fn(),
        onExportPatch: vi.fn(),
        onCopyPatch: vi.fn(),
        onCleanUp: vi.fn(),
        onToggleGroupBy: vi.fn(),
        onOpenConflictEditor: vi.fn(),
        onResolveStructural: vi.fn(),
    };
    const mounted = mount(
        <ChakraProvider theme={theme}>
            <ShelfTab
                shelves={shelves}
                shelfFiles={files}
                selectedShelfId="shelf-a"
                catalogGeneration={12}
                {...callbacks}
                {...overrides}
            />
        </ChakraProvider>,
    );
    return { ...mounted, callbacks };
}

function SharedGroupingHarness(): React.ReactElement {
    const [groupByDir, setGroupByDir] = React.useState(false);
    const toggleGroupBy = (): void => setGroupByDir((value) => !value);
    const noop = (): void => undefined;
    return (
        <>
            <Toolbar
                onRefresh={noop}
                groupByDir={groupByDir}
                showIgnoredFiles={false}
                onRollback={noop}
                onToggleGroupBy={toggleGroupBy}
                onToggleShowIgnoredFiles={noop}
                onStash={noop}
                onShowDiff={noop}
                onExpandAll={noop}
                onCollapseAll={noop}
                showAbortMerge={false}
                onAbortMerge={noop}
            />
            <ShelfTab
                shelves={shelves}
                shelfFiles={files}
                selectedShelfId="shelf-a"
                catalogGeneration={12}
                groupByDir={groupByDir}
                onSelect={noop as React.ComponentProps<typeof ShelfTab>["onSelect"]}
                onUnshelve={noop as React.ComponentProps<typeof ShelfTab>["onUnshelve"]}
                onRename={noop as React.ComponentProps<typeof ShelfTab>["onRename"]}
                onDelete={noop as React.ComponentProps<typeof ShelfTab>["onDelete"]}
                onShowDiff={noop as React.ComponentProps<typeof ShelfTab>["onShowDiff"]}
                onCompareWithLocal={
                    noop as React.ComponentProps<typeof ShelfTab>["onCompareWithLocal"]
                }
                onRestoreGhost={noop as React.ComponentProps<typeof ShelfTab>["onRestoreGhost"]}
                onImportPatch={noop as React.ComponentProps<typeof ShelfTab>["onImportPatch"]}
                onExportPatch={noop as React.ComponentProps<typeof ShelfTab>["onExportPatch"]}
                onCopyPatch={noop as React.ComponentProps<typeof ShelfTab>["onCopyPatch"]}
                onCleanUp={noop as React.ComponentProps<typeof ShelfTab>["onCleanUp"]}
                onToggleGroupBy={toggleGroupBy}
                onOpenConflictEditor={
                    noop as React.ComponentProps<typeof ShelfTab>["onOpenConflictEditor"]
                }
                onResolveStructural={
                    noop as React.ComponentProps<typeof ShelfTab>["onResolveStructural"]
                }
            />
        </>
    );
}

describe("Shelf menu and toolbar parity", () => {
    beforeEach(() => {
        installWebviewI18n();
    });

    it("renders platform-correct Delete hints from the shared menu builder", () => {
        expect(
            getShelfMenuItems({
                shelf: shelves[0],
                shelfFilesAreCurrent: true,
                canUnshelve: true,
                canExportPatch: true,
                isMac: true,
            }).find((item) => item.action === "delete")?.hint,
        ).toBe("⌫");
        expect(
            getShelfMenuItems({
                shelf: shelves[0],
                shelfFilesAreCurrent: true,
                canUnshelve: true,
                canExportPatch: true,
                isMac: false,
            }).find((item) => item.action === "delete")?.hint,
        ).toBe("Del");

        for (const [isMac, expectedHints] of [
            [true, ["⇧⌘U", "⌘D", "F2", "⌫"]],
            [false, ["Ctrl+Shift+U", "Ctrl+D", "F2", "Del"]],
        ] as const) {
            const mounted = mount(
                <ContextMenu
                    x={0}
                    y={0}
                    items={getShelfMenuItems({
                        shelf: shelves[0],
                        shelfFilesAreCurrent: true,
                        canUnshelve: true,
                        canExportPatch: true,
                        isMac,
                    })}
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />,
            );
            const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
            for (const [label, hint] of [
                ["Unshelve…", expectedHints[0]],
                ["Show Diff", expectedHints[1]],
                ["Rename", expectedHints[2]],
                ["Delete", expectedHints[3]],
            ] as const) {
                expect(
                    items.find((item) => item.textContent?.startsWith(label))?.lastElementChild
                        ?.textContent,
                ).toBe(hint);
            }
            unmount(mounted.root, mounted.container);
        }
    });

    it("keeps the Commit and Shelf group-by controls on one controlled state", () => {
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <SharedGroupingHarness />
            </ChakraProvider>,
        );
        const shelfGroupBy = iconButton(container, "Group by Directory");

        expect(shelfGroupBy.getAttribute("aria-pressed")).toBe("false");
        click(shelfGroupBy);
        expect(shelfGroupBy.getAttribute("aria-pressed")).toBe("true");
        click(iconButton(container, "View Options"));
        click(menuItem("Directory"));
        expect(shelfGroupBy.getAttribute("aria-pressed")).toBe("false");

        unmount(root, container);
    });

    it("renders the active Shelf menu in exact order with its separator before Rename", () => {
        const { root, container } = renderShelfTab();
        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);

        expect(contextMenuSequence()).toEqual([
            "Unshelve…",
            "Unshelve Silently",
            "Restore",
            "Show Diff",
            "Show Diff in a New Tab",
            "Compare with Local",
            "Create Patch…",
            "Copy as Patch to Clipboard",
            "Import Patches…",
            "separator",
            "Rename",
            "Delete",
        ]);
        expect(menuItem("Unshelve…").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Restore").getAttribute("aria-disabled")).toBe("true");

        unmount(root, container);
    });

    it("scopes file-row context actions to its change ID for mouse and keyboard gestures", () => {
        const { root, container, callbacks } = renderShelfTab();
        const file = container.querySelector('[data-shelf-file="change-a"]') as HTMLElement;
        const secondFile = container.querySelector('[data-shelf-file="change-b"]') as HTMLElement;

        openContextMenu(file);
        expect(file.getAttribute("aria-current")).toBe("true");
        click(menuItem("Compare with Local"));
        expect(callbacks.onCompareWithLocal).toHaveBeenLastCalledWith({
            type: "shelfCompareWithLocal",
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeId: "change-a",
        });
        key(file, "ContextMenu");
        click(menuItem("Show Diff"));
        expect(callbacks.onShowDiff).toHaveBeenLastCalledWith({
            type: "shelfDiff",
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeId: "change-a",
        });
        key(secondFile, "ContextMenu");
        expect(secondFile.getAttribute("aria-current")).toBe("true");
        key(document.body, "Escape");
        key(file, "ContextMenu");
        click(menuItem("Show Diff in a New Tab"));
        expect(callbacks.onShowDiff).toHaveBeenLastCalledWith({
            type: "shelfDiff",
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeId: "change-a",
            newTab: true,
        });
        key(file, "ContextMenu");
        click(menuItem("Create Patch…"));
        expect(callbacks.onExportPatch).toHaveBeenLastCalledWith(
            expect.objectContaining({ changeIds: ["change-a"] }),
        );
        key(file, "F10", { shiftKey: true });
        click(menuItem("Copy as Patch to Clipboard"));
        expect(callbacks.onCopyPatch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelfCopyPatchToClipboard",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                changeIds: ["change-a"],
            }),
        );
        key(file, "F10", { shiftKey: true });
        click(menuItem("Rename"));
        const rename = container.querySelector(
            'input[aria-label="Rename shelf"]',
        ) as HTMLInputElement;
        expect(rename).not.toBeNull();
        inputValue(rename, "file menu rename");
        key(rename, "Enter");
        expect(callbacks.onRename).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelfRename",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                name: "file menu rename",
            }),
        );
        key(file, "ContextMenu");
        click(menuItem("Delete"));
        const confirmation = document.querySelector('[role="alertdialog"]') as HTMLElement;
        click(button(confirmation, "Delete Shelf"));
        expect(callbacks.onDelete).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelfDelete",
                shelfId: "shelf-a",
                expectedGeneration: 7,
            }),
        );

        unmount(root, container);
    });

    it("renders only the three Shelf icon controls plus overflow, and opens its two-item menu", () => {
        const { root, container, callbacks } = renderShelfTab();
        const toolbar = container.querySelector('[data-testid="shelf-toolbar"]') as HTMLElement;
        expect(toolbar.querySelectorAll("button")).toHaveLength(4);
        expect(iconButton(container, "Group by Directory").getAttribute("aria-pressed")).toBe(
            "false",
        );
        expect(iconButton(container, "Expand All")).toBeTruthy();
        expect(iconButton(container, "Collapse All")).toBeTruthy();
        const overflow = iconButton(container, "More Options");
        vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({
            left: 31,
            bottom: 47,
        } as DOMRect);
        click(overflow);
        expect(contextMenuLabels()).toEqual(["Show Already Unshelved", "Clean Up Shelf…"]);
        expect((document.querySelector('[role="menu"]') as HTMLElement).style.left).toBe("31px");
        expect((document.querySelector('[role="menu"]') as HTMLElement).style.top).toBe("47px");
        for (const label of [
            "Import Patches…",
            "Create Patch…",
            "Unshelve",
            "Unshelve Silently",
            "Show Diff",
            "Compare with Local",
            "Rename",
            "Delete",
        ]) {
            expect(toolbar.querySelector(`[aria-label="${label}"]`)).toBeNull();
            expect(toolbar.textContent).not.toContain(label);
        }
        click(iconButton(container, "Group by Directory"));
        expect(callbacks.onToggleGroupBy).toHaveBeenCalledTimes(1);

        unmount(root, container);
    });

    it("expands and collapses the controlled Shelf file pane", () => {
        const { root, container } = renderShelfTab({ groupByDir: true });

        click(iconButton(container, "Collapse All"));
        expect(container.querySelector('[data-shelf-file="change-a"]')).toBeNull();
        expect(container.querySelector('[data-shelf-file="change-b"]')).toBeNull();
        click(container.querySelector('[data-testid="shelf-file-pane"] > div') as HTMLElement);
        expect(container.querySelector('button[title="src"]')).not.toBeNull();
        expect(container.querySelector('[data-shelf-file="change-a"]')).toBeNull();
        expect(container.querySelector('[data-shelf-file="change-b"]')).toBeNull();
        click(iconButton(container, "Expand All"));
        expect(container.querySelector('[data-shelf-file="change-a"]')).not.toBeNull();
        expect(container.querySelector('[data-shelf-file="change-b"]')).not.toBeNull();

        unmount(root, container);
    });

    it("runs Shelf shortcuts from list and file-pane focus but guards rename and dialog fields", () => {
        const { root, container, callbacks } = renderShelfTab();
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        const file = container.querySelector('[data-shelf-file="change-a"]') as HTMLElement;

        key(row, "d", { ctrlKey: true });
        expect(callbacks.onShowDiff).toHaveBeenLastCalledWith({
            type: "shelfDiff",
            shelfId: "shelf-a",
            expectedGeneration: 7,
        });
        key(file, "u", { ctrlKey: true, shiftKey: true });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        key(row, "F2");
        expect(container.querySelector('input[aria-label="Rename shelf"]')).toBeNull();

        unmount(root, container);
    });

    it("wires F2, Delete, and Backspace shortcuts while guarding inline rename", () => {
        const first = renderShelfTab();
        const firstRow = first.container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        key(firstRow, "F2");
        const rename = first.container.querySelector(
            'input[aria-label="Rename shelf"]',
        ) as HTMLElement;
        expect(rename).not.toBeNull();
        key(rename, "d", { ctrlKey: true });
        expect(first.callbacks.onShowDiff).not.toHaveBeenCalled();
        key(rename, "Escape");
        key(firstRow, "Delete");
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
        unmount(first.root, first.container);

        const second = renderShelfTab();
        key(
            second.container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement,
            "Backspace",
        );
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
        unmount(second.root, second.container);
    });

    it("restores shelf-row focus after cancelling a keyboard-invoked delete", () => {
        const { root, container } = renderShelfTab();
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        act(() => row.focus());
        key(row, "Delete");
        click(button(document.querySelector('[role="alertdialog"]') as HTMLElement, "Cancel"));
        expect(document.activeElement).toBe(row);
        unmount(root, container);
    });
});
