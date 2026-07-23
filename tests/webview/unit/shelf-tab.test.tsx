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

function key(element: Element, value: string): void {
    act(() => element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })));
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
    ).find((candidate) => candidate.textContent?.trim() === label);
    if (!found) throw new Error(`Missing menu item: ${label}`);
    return found;
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
        onCleanUp: vi.fn(),
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
    return {
        ...mounted,
        callbacks,
        rerender: (next: Partial<React.ComponentProps<typeof ShelfTab>>) =>
            act(() =>
                mounted.root.render(
                    <ChakraProvider theme={theme}>
                        <ShelfTab
                            shelves={shelves}
                            shelfFiles={files}
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

    it("renders an accessible shelf list and active selection", () => {
        const { root, container } = renderShelfTab();
        const list = container.querySelector('[role="listbox"]') as HTMLElement;
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;

        expect(list.getAttribute("aria-label")).toBe("Shelves");
        expect(row.getAttribute("role")).toBe("option");
        expect(row.getAttribute("aria-selected")).toBe("true");
        expect(container.textContent).not.toContain("Old change");

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
        expect(
            Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) =>
                item.textContent?.trim(),
            ),
        ).toEqual([
            "Unshelve…",
            "Unshelve Silently",
            "Rename",
            "Delete",
            "Show Diff",
            "Compare with Local",
        ]);

        unmount(root, container);
    });

    it("does not use prior shelf entries while a newly selected shelf is loading", () => {
        const nextShelf = {
            id: "shelf-c",
            generation: 10,
            metadata: { name: "New shelf", lifecycle: "shelved" as const },
        };
        const { root, container } = renderShelfTab({ shelves: [shelves[0], nextShelf] });
        const nextRow = container.querySelector('[data-shelf-id="shelf-c"]') as HTMLElement;

        click(nextRow);
        expect(button(container, "Unshelve").disabled).toBe(true);
        expect(container.querySelector('[data-testid="shelf-file-pane"]')).toBeNull();
        expect(container.textContent).toContain("Loading shelf files…");

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

        click(button(container, "Compare with Local"));
        expect(callbacks.onCompareWithLocal).toHaveBeenCalledWith({
            type: "shelfCompareWithLocal",
            shelfId: "shelf-a",
            expectedGeneration: 7,
        });

        unmount(root, container);
    });

    it("renders selected shelf files in the shared file-row pane and opens a per-file base diff", () => {
        const { root, container, callbacks } = renderShelfTab();
        const pane = container.querySelector('[data-testid="shelf-file-pane"]') as HTMLElement;
        const row = pane.querySelector('[data-shelf-file="change-a"]') as HTMLElement;

        expect(pane.getAttribute("role")).toBe("region");
        expect(pane.textContent).toContain("parser.ts");
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
        click(button(container, "Unshelve"));
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
        click(button(container, "Show Already Unshelved"));
        const ghost = container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement;
        expect(ghost.getAttribute("data-ghost")).toBe("true");
        act(() =>
            ghost.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            ),
        );
        expect(
            Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) =>
                item.textContent?.trim(),
            ),
        ).toEqual(["Restore", "Show Diff", "Compare with Local", "Delete"]);
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

    it("disables patch export while a newly selected shelf is still loading its files", () => {
        const { root, container } = renderShelfTab();
        click(button(container, "Show Already Unshelved"));
        click(container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement);

        expect(button(container, "Create Patch…").disabled).toBe(true);
        unmount(root, container);
    });

    it("keeps selected-shelf controls enabled when its file list is empty", () => {
        const { root, container } = renderShelfTab({ shelfFiles: [] });
        expect(button(container, "Rename").disabled).toBe(false);
        expect(button(container, "Delete").disabled).toBe(false);
        expect(button(container, "Show Diff").disabled).toBe(false);
        unmount(root, container);
    });

    it("imports without paths and exports every selected shelf change", () => {
        const { root, container, callbacks } = renderShelfTab();

        click(button(container, "Import Patches…"));
        expect(callbacks.onImportPatch).toHaveBeenCalledWith({
            type: "shelfImportPatch",
            requestId: expect.any(String),
            idempotencyToken: expect.any(String),
            expectedCatalogGeneration: 12,
        });
        expect(callbacks.onImportPatch.mock.calls[0][0]).not.toHaveProperty("fileUris");
        click(button(container, "Create Patch…"));
        expect(callbacks.onExportPatch).toHaveBeenCalledWith({
            type: "shelfExportPatch",
            requestId: expect.any(String),
            shelfId: "shelf-a",
            expectedGeneration: 7,
            changeIds: ["change-a", "change-b"],
        });

        unmount(root, container);
    });

    it("disables patch export when no shelf is selected", () => {
        const { root, container } = renderShelfTab({ selectedShelfId: null });
        expect(button(container, "Create Patch…").disabled).toBe(true);
        expect(button(container, "Import Patches…").disabled).toBe(false);
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
        click(button(container, "Clean Up Shelf…"));
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
                            shelfFiles={files}
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
