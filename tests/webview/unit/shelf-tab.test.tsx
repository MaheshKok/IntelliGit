// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import type {
    PerEntryResult,
    ShelfEntry,
    ShelfMutationStatus,
} from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { CleanUpDialog } from "../../../src/webviews/react/commit-panel/components/CleanUpDialog";
import { formatDateTime } from "../../../src/webviews/react/shared/date";
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

const files = [
    { changeId: "change-a", worktreeBlock: { path: "src/parser.ts" } },
    { changeId: "change-b", worktreeBlock: { path: "src/lexer.ts" } },
] as ShelfFileEntry[];
const shelves: ShelfEntry[] = [
    {
        id: "shelf-a",
        generation: 7,
        files,
        metadata: { name: "Parser repair", lifecycle: "shelved" },
    },
    {
        id: "shelf-b",
        generation: 9,
        files: [],
        metadata: { name: "Old change", lifecycle: "applied" },
    },
];

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

/** Opens one shelf row's subtree through the standard tree key, as a user would. */
function expandShelf(container: ParentNode, shelfId: string): void {
    key(container.querySelector(`[data-shelf-id="${shelfId}"]`) as HTMLElement, "ArrowRight");
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

function openOverflow(container: ParentNode): void {
    click(iconButton(container, "More Options"));
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
                selectedShelfId="shelf-a"
                catalogGeneration={12}
                {...callbacks}
                {...overrides}
            />
        </ChakraProvider>,
    );
    return {
        ...mounted,
        callbacks,
        rerender: (next: Partial<React.ComponentProps<typeof ShelfTab>>) =>
            act(() =>
                mounted.root.render(
                    <ChakraProvider theme={theme}>
                        <ShelfTab
                            shelves={shelves}
                            selectedShelfId="shelf-a"
                            catalogGeneration={12}
                            {...callbacks}
                            {...overrides}
                            {...next}
                        />
                    </ChakraProvider>,
                ),
            ),
    };
}

describe("ShelfTab", () => {
    beforeEach(() => {
        installWebviewI18n();
    });

    it("renders an accessible shelf tree and active selection", () => {
        const { root, container } = renderShelfTab();
        const tree = container.querySelector('[role="tree"]') as HTMLElement;
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;

        expect(tree.getAttribute("aria-label")).toBe("Shelves");
        expect(row.getAttribute("role")).toBe("treeitem");
        expect(row.getAttribute("aria-selected")).toBe("true");
        expect(row.getAttribute("aria-expanded")).toBe("false");
        expect(row.getAttribute("aria-level")).toBe("1");
        expect(container.textContent).not.toContain("Old change");

        unmount(root, container);
    });

    it("shows PyCharm's file-count and date meta line on each shelf row", () => {
        const createdAt = Date.UTC(2026, 1, 22, 14, 55);
        const { root, container } = renderShelfTab({
            shelves: [
                {
                    ...shelves[0],
                    metadata: { ...shelves[0].metadata, createdAt },
                },
            ],
        });
        const meta = container.querySelector("[data-shelf-meta]") as HTMLElement;

        expect(meta.textContent).toBe(
            `2 files, ${formatDateTime(new Date(createdAt).toISOString())}`,
        );

        // A shelf saved before createdAt existed still reports its count alone.
        const { root: bareRoot, container: bareContainer } = renderShelfTab();
        expect((bareContainer.querySelector("[data-shelf-meta]") as HTMLElement).textContent).toBe(
            "2 files",
        );

        unmount(bareRoot, bareContainer);
        unmount(root, container);
    });

    it("selects shelves with ArrowDown and opens its keyboard context menu", () => {
        const activeShelves = [
            { ...shelves[0] },
            { ...shelves[0], id: "shelf-c", metadata: { name: "Other", lifecycle: "shelved" } },
        ];
        const { root, container, callbacks } = renderShelfTab({ shelves: activeShelves });
        const first = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        const second = container.querySelector('[data-shelf-id="shelf-c"]') as HTMLElement;

        first.focus();
        key(first, "ArrowDown");
        expect(document.activeElement).toBe(second);
        expect(callbacks.onSelect).toHaveBeenLastCalledWith({
            type: "shelfSelect",
            shelfId: "shelf-c",
        });
        key(second, "ContextMenu");
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
        expect(document.querySelectorAll('[role="menu"] hr')).toHaveLength(1);
        expect(menuItem("Restore").getAttribute("aria-disabled")).toBe("true");

        unmount(root, container);
    });

    it("gives every shelf its own files, with no cross-shelf leakage or loading step", () => {
        const nextShelf: ShelfEntry = {
            id: "shelf-c",
            generation: 10,
            files: [
                { changeId: "change-c", worktreeBlock: { path: "src/emitter.ts" } },
            ] as ShelfFileEntry[],
            metadata: { name: "New shelf", lifecycle: "shelved" as const },
        };
        const { root, container } = renderShelfTab({ shelves: [shelves[0], nextShelf] });
        const nextRow = container.querySelector('[data-shelf-id="shelf-c"]') as HTMLElement;

        click(nextRow);
        openContextMenu(nextRow);
        expect(menuItem("Unshelve…").getAttribute("aria-disabled")).toBe("false");
        key(document.body, "Escape");
        expect(iconButton(container, "Expand All").disabled).toBe(false);
        expect(iconButton(container, "Collapse All").disabled).toBe(false);

        expandShelf(container, "shelf-c");
        expect(container.querySelector('[data-shelf-file="change-c"]')).not.toBeNull();
        expect(container.querySelector('[data-shelf-file="change-a"]')).toBeNull();

        unmount(root, container);
    });

    it("keeps two expanded shelves independent when one of them collapses", () => {
        const nextShelf: ShelfEntry = {
            id: "shelf-c",
            generation: 10,
            files: [
                { changeId: "change-c", worktreeBlock: { path: "src/emitter.ts" } },
            ] as ShelfFileEntry[],
            metadata: { name: "New shelf", lifecycle: "shelved" as const },
        };
        const { root, container } = renderShelfTab({ shelves: [shelves[0], nextShelf] });

        expandShelf(container, "shelf-a");
        expandShelf(container, "shelf-c");
        expect(container.querySelector('[data-shelf-file="change-a"]')).not.toBeNull();
        expect(container.querySelector('[data-shelf-file="change-c"]')).not.toBeNull();

        // ArrowLeft closes the open row it is sent to and leaves the other alone.
        key(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement, "ArrowLeft");
        expect(container.querySelector('[data-shelf-file="change-a"]')).toBeNull();
        expect(container.querySelector('[data-shelf-file="change-c"]')).not.toBeNull();

        unmount(root, container);
    });

    it("expands and collapses every shelf and directory from the toolbar", () => {
        const { root, container } = renderShelfTab({ groupByDir: true });

        click(iconButton(container, "Expand All"));
        expect(container.querySelector('button[title="src"]')?.getAttribute("aria-expanded")).toBe(
            "true",
        );
        expect(container.querySelector('[data-shelf-file="change-a"]')).not.toBeNull();
        expect(container.querySelector('[data-shelf-file="change-b"]')).not.toBeNull();

        click(iconButton(container, "Collapse All"));
        expect(container.querySelector('button[title="src"]')).toBeNull();
        expect(container.querySelector('[data-shelf-file="change-a"]')).toBeNull();

        unmount(root, container);
    });

    it("emits exact CAS diff and compare messages from context actions", () => {
        const { root, container, callbacks } = renderShelfTab();
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Show Diff"));
        expect(callbacks.onShowDiff).toHaveBeenCalledWith({
            type: "shelfDiff",
            shelfId: "shelf-a",
            expectedGeneration: 7,
        });
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Compare with Local"));
        expect(callbacks.onCompareWithLocal).toHaveBeenCalledWith({
            type: "shelfCompareWithLocal",
            shelfId: "shelf-a",
            expectedGeneration: 7,
        });
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Unshelve Silently"));
        expect(callbacks.onUnshelveSilently).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "unshelve",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                changeIds: ["change-a", "change-b"],
                removeFromShelf: true,
                mode: "flattened",
            }),
        );

        unmount(root, container);
    });

    it("renders an expanded shelf's files in its own subtree and opens a per-file base diff", () => {
        const { root, container, callbacks } = renderShelfTab();
        expandShelf(container, "shelf-a");
        const group = container.querySelector(
            '[data-testid="shelf-list"] [role="group"]',
        ) as HTMLElement;
        const row = group.querySelector('[data-shelf-file="change-a"]') as HTMLElement;

        expect(
            (container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement).getAttribute(
                "aria-expanded",
            ),
        ).toBe("true");
        expect(group.textContent).toContain("parser.ts");
        click(row);
        expect(callbacks.onShowDiff).toHaveBeenCalledWith({
            type: "shelfDiff",
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeId: "change-a",
        });
        unmount(root, container);
    });

    it("submits selected unshelve entries, defaults removal on, and rejects an empty selection", () => {
        const { root, container, callbacks } = renderShelfTab();
        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);
        click(menuItem("Unshelve…"));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        const first = dialog.querySelector('input[aria-label="src/parser.ts"]') as HTMLInputElement;
        const remove = dialog.querySelector(
            'input[aria-label="Remove successfully applied"]',
        ) as HTMLInputElement;
        const submit = button(dialog, "Unshelve");

        expect(remove.checked).toBe(true);
        click(first);
        click(dialog.querySelector('input[aria-label="src/lexer.ts"]') as HTMLInputElement);
        expect(submit.disabled).toBe(true);
        click(first);
        expect(submit.disabled).toBe(false);
        click(submit);
        expect(callbacks.onUnshelve).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "unshelve",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                changeIds: ["change-a"],
                removeFromShelf: true,
                mode: "flattened",
            }),
        );

        unmount(root, container);
    });

    it("renames inline, shows the host rejection verbatim, and confirms deletion", () => {
        const rejection = "Name conflicts with a locked shelf.";
        const { root, container, callbacks, rerender } = renderShelfTab();
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Rename"));
        const rename = container.querySelector(
            'input[aria-label="Rename shelf"]',
        ) as HTMLInputElement;
        inputValue(rename, "  host decides  ");
        key(rename, "Enter");
        expect(callbacks.onRename).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "shelfRename",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                name: "  host decides  ",
            }),
        );
        const requestId = callbacks.onRename.mock.calls[0][0].requestId;
        rerender({ outcome: { requestId, status: "error", entries: [], message: rejection } });
        expect((container.querySelector('[role="alert"]') as HTMLElement).textContent).toBe(
            rejection,
        );
        rerender({
            shelves: [
                {
                    ...shelves[0],
                    generation: 8,
                    metadata: { ...shelves[0].metadata, name: "  host decides  " },
                },
                shelves[1],
            ],
        });
        expect(container.querySelector('input[aria-label="Rename shelf"]')).toBeNull();

        act(() =>
            (container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement).dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Delete"));
        const confirmation = document.querySelector('[role="alertdialog"]') as HTMLElement;
        click(button(confirmation, "Delete Shelf"));
        expect(callbacks.onDelete).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "shelfDelete",
                shelfId: "shelf-a",
                expectedGeneration: 8,
            }),
        );

        unmount(root, container);
    });

    it("cancels an inline rename with Escape without submitting", () => {
        const { root, container, callbacks } = renderShelfTab();
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        act(() =>
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        click(menuItem("Rename"));
        const rename = container.querySelector(
            'input[aria-label="Rename shelf"]',
        ) as HTMLInputElement;
        key(rename, "Escape");
        expect(container.querySelector('input[aria-label="Rename shelf"]')).toBeNull();
        expect(callbacks.onRename).not.toHaveBeenCalled();
        unmount(root, container);
    });

    it("reveals ghost rows only when requested and restores a ghost with its generation", () => {
        const { root, container, callbacks } = renderShelfTab();
        openOverflow(container);
        click(menuItem("Show Already Unshelved"));
        const ghost = container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement;
        expect(ghost.getAttribute("data-ghost")).toBe("true");
        act(() =>
            ghost.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
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
        expect(menuItem("Unshelve…").getAttribute("aria-disabled")).toBe("true");
        expect(menuItem("Restore").getAttribute("aria-disabled")).toBe("false");
        click(menuItem("Restore"));
        expect(callbacks.onRestoreGhost).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "shelfRestoreGhost",
                shelfId: "shelf-b",
                expectedGeneration: 9,
            }),
        );

        unmount(root, container);
    });

    it("disables patch export for a shelf that holds no files", () => {
        const { root, container } = renderShelfTab();
        openOverflow(container);
        click(menuItem("Show Already Unshelved"));
        click(container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement);

        openContextMenu(container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement);
        expect(menuItem("Create Patch…").getAttribute("aria-disabled")).toBe("true");
        unmount(root, container);
    });

    it("keeps selected-shelf controls enabled when its file list is empty", () => {
        const { root, container } = renderShelfTab({
            shelves: [{ ...shelves[0], files: [] }, shelves[1]],
        });
        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);
        expect(menuItem("Unshelve…").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Unshelve Silently").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Rename").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Delete").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Show Diff").getAttribute("aria-disabled")).toBe("false");
        unmount(root, container);
    });

    it("imports without paths and exports every selected shelf change", () => {
        const { root, container, callbacks } = renderShelfTab();

        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);
        click(menuItem("Import Patches…"));
        expect(callbacks.onImportPatch).toHaveBeenCalledWith({
            type: "shelfImportPatch",
            requestId: expect.any(String),
            idempotencyToken: expect.any(String),
            expectedCatalogGeneration: 12,
        });
        expect(callbacks.onImportPatch.mock.calls[0][0]).not.toHaveProperty("fileUris");
        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);
        click(menuItem("Create Patch…"));
        expect(callbacks.onExportPatch).toHaveBeenCalledWith({
            type: "shelfExportPatch",
            requestId: expect.any(String),
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeIds: ["change-a", "change-b"],
        });

        unmount(root, container);
    });

    it("exports the right-clicked shelf even when nothing was selected", () => {
        const { root, container, callbacks } = renderShelfTab({ selectedShelfId: null });
        openContextMenu(container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement);
        expect(menuItem("Import Patches…").getAttribute("aria-disabled")).toBe("false");
        expect(menuItem("Create Patch…").getAttribute("aria-disabled")).toBe("false");
        click(menuItem("Create Patch…"));
        expect(callbacks.onExportPatch).toHaveBeenCalledWith(
            expect.objectContaining({
                shelfId: "shelf-a",
                expectedGeneration: 7,
                changeIds: ["change-a", "change-b"],
            }),
        );
        unmount(root, container);
    });

    it("sends cleanup candidates selected by all ghosts or strictly older than days", () => {
        const now = Date.UTC(2026, 6, 23);
        const cleanupShelves = [
            {
                ...shelves[1],
                id: "old",
                metadata: {
                    ...shelves[1].metadata,
                    appliedAt: now - 3 * 86_400_000,
                },
            },
            {
                ...shelves[1],
                id: "boundary",
                metadata: {
                    ...shelves[1].metadata,
                    appliedAt: now - 2 * 86_400_000,
                },
            },
        ];
        const onSubmit = vi.fn();
        const mounted = mount(
            <ChakraProvider theme={theme}>
                <CleanUpDialog
                    shelves={cleanupShelves}
                    now={now}
                    onClose={vi.fn()}
                    onSubmit={onSubmit}
                />
            </ChakraProvider>,
        );
        const dialog = mounted.container.querySelector('[role="dialog"]') as HTMLElement;

        inputValue(
            dialog.querySelector('input[aria-label="Older than days"]') as HTMLInputElement,
            "2",
        );
        click(button(dialog, "Select older than"));
        click(button(dialog, "Clean Up Shelf"));
        expect(onSubmit).toHaveBeenLastCalledWith(["old"]);
        click(button(dialog, "All ghosts"));
        click(button(dialog, "Clean Up Shelf"));
        expect(onSubmit).toHaveBeenLastCalledWith(["old", "boundary"]);

        unmount(mounted.root, mounted.container);
    });

    it("shows an explicit cleanup empty state", () => {
        const mounted = mount(
            <ChakraProvider theme={theme}>
                <CleanUpDialog
                    shelves={shelves}
                    now={Date.UTC(2026, 6, 23)}
                    onClose={vi.fn()}
                    onSubmit={vi.fn()}
                />
            </ChakraProvider>,
        );
        expect(mounted.container.textContent).toContain(
            "No already unshelved shelves to clean up.",
        );
        unmount(mounted.root, mounted.container);
    });

    it("posts cleanup with the selected ghost IDs and catalog generation", () => {
        const { root, container, callbacks } = renderShelfTab({
            shelves: [
                shelves[0],
                {
                    ...shelves[1],
                    metadata: {
                        ...shelves[1].metadata,
                        appliedAt: Date.UTC(2026, 6, 20),
                    },
                },
            ],
        });
        openOverflow(container);
        click(menuItem("Clean Up Shelf…"));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        click(button(dialog, "Clean Up Shelf"));
        expect(callbacks.onCleanUp).toHaveBeenCalledWith({
            type: "shelfCleanUp",
            requestId: expect.any(String),
            shelfIds: ["shelf-b"],
            expectedCatalogGeneration: 12,
        });
        unmount(root, container);
    });

    it("renders every per-entry result kind and mutation status", () => {
        const results: PerEntryResult[] = [
            { kind: "applied", changeId: "a" },
            { kind: "conflicted", changeId: "b" },
            { kind: "retained", changeId: "c", reason: "keep" },
            { kind: "flattenedResidue", changeId: "d" },
            { kind: "refused", changeId: "e", reason: "no" },
            {
                kind: "structuralPending",
                changeId: "f",
                reason: "choose",
                path: "src/f.ts",
                pathFingerprint: "100644:fixture",
            },
        ];
        const statuses: ShelfMutationStatus[] = [
            "ok",
            "partial",
            "conflicts",
            "staleShelf",
            "staleCatalog",
            "busy",
            "recoveryFull",
            "error",
        ];
        const { root, container } = renderShelfTab({
            outcome: { status: statuses[0], entries: results },
        });

        for (const status of statuses) {
            act(() =>
                root.render(
                    <ChakraProvider theme={theme}>
                        <ShelfTab
                            shelves={shelves}
                            selectedShelfId="shelf-a"
                            catalogGeneration={12}
                            onSelect={vi.fn()}
                            onUnshelve={vi.fn()}
                            onRename={vi.fn()}
                            onDelete={vi.fn()}
                            onShowDiff={vi.fn()}
                            onCompareWithLocal={vi.fn()}
                            onRestoreGhost={vi.fn()}
                            onImportPatch={vi.fn()}
                            onExportPatch={vi.fn()}
                            onCleanUp={vi.fn()}
                            onOpenConflictEditor={vi.fn()}
                            onResolveStructural={vi.fn()}
                            outcome={{ status, entries: results }}
                        />
                    </ChakraProvider>,
                ),
            );
            expect(container.textContent).toContain(status);
        }
        for (const result of results) expect(container.textContent).toContain(result.kind);

        unmount(root, container);
    });

    it("posts merge launch and guarded structural choices from conflict outcomes", () => {
        const outcome: ShelfMutationOutcome = {
            requestId: "unshelve-result",
            shelfId: "shelf-a",
            status: "conflicts",
            entries: [
                { kind: "conflicted", changeId: "change-a" },
                {
                    kind: "structuralPending",
                    changeId: "change-b",
                    reason: "choose",
                    path: "src/lexer.ts",
                    pathFingerprint: "644:local",
                },
            ],
        };
        const { root, container, callbacks } = renderShelfTab({
            repositoryRoot: "/repo",
            outcome,
        });

        click(button(container, "Merge…"));
        expect(callbacks.onOpenConflictEditor).toHaveBeenCalledWith({
            type: "shelfOpenConflictEditor",
            repositoryRoot: "/repo",
            shelfId: "shelf-a",
            changeId: "change-a",
        });

        click(button(container, "Keep Local"));
        expect(callbacks.onResolveStructural).toHaveBeenCalledWith({
            type: "shelfResolveStructural",
            repositoryRoot: "/repo",
            requestId: expect.any(String),
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeId: "change-b",
            expectedPathFingerprint: "644:local",
            action: "keepLocal",
        });
        expect(button(container, "Use Shelved").disabled).toBe(true);

        unmount(root, container);
    });

    it("opens a small rename dialog and posts the guarded target path", () => {
        const outcome: ShelfMutationOutcome = {
            requestId: "unshelve-result",
            shelfId: "shelf-a",
            status: "conflicts",
            entries: [
                {
                    kind: "structuralPending",
                    changeId: "change-b",
                    reason: "choose",
                    path: "src/lexer.ts",
                    pathFingerprint: "644:local",
                },
            ],
        };
        const { root, container, callbacks } = renderShelfTab({
            repositoryRoot: "/repo",
            outcome,
        });

        click(button(container, "Rename Local…"));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        inputValue(
            dialog.querySelector('input[aria-label="Rename local path"]') as HTMLInputElement,
            "src/local-lexer.ts",
        );
        click(button(dialog, "Rename Local"));
        expect(callbacks.onResolveStructural).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "renameLocal",
                targetPath: "src/local-lexer.ts",
                expectedGeneration: 7,
                expectedPathFingerprint: "644:local",
            }),
        );

        unmount(root, container);
    });
});
