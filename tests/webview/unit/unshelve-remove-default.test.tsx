// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { UnshelveDialog } from "../../../src/webviews/react/commit-panel/components/UnshelveDialog";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { useShelfDrag } from "../../../src/webviews/react/commit-panel/hooks/useShelfDrag";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const shelfEntry: ShelfFileEntry = {
    changeId: "change-a",
    worktreeBlock: { path: "a.ts", status: "M" },
    binary: false,
    untracked: false,
    baseAvailability: "none",
    exactReconstruction: true,
    lifecycle: "shelved",
};

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function buttonByText(container: HTMLElement, text: string): HTMLElement {
    const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === text,
    );
    if (!button) throw new Error(`Button "${text}" not found`);
    return button;
}

type ShelfDrag = ReturnType<typeof useShelfDrag>;

function DragHarness({
    onMessage,
    removeOnUnshelve,
    capture,
}: {
    onMessage: ReturnType<typeof vi.fn>;
    removeOnUnshelve: boolean;
    capture: (drag: ShelfDrag) => void;
}): React.ReactElement {
    capture(
        useShelfDrag({
            repositoryRoot: "/repo",
            catalogGeneration: 12,
            onMessage,
            removeOnUnshelve,
        }),
    );
    return <div />;
}

function renderDrag(removeOnUnshelve: boolean) {
    let drag: ShelfDrag | undefined;
    const onMessage = vi.fn();
    const mounted = mount(
        <DragHarness
            onMessage={onMessage}
            removeOnUnshelve={removeOnUnshelve}
            capture={(next) => {
                drag = next;
            }}
        />,
    );
    if (!drag) throw new Error("Shelf drag hook did not render");
    return { ...mounted, drag, onMessage };
}

function createDataTransfer(): DataTransfer {
    const values = new Map<string, string>();
    const transfer = {
        types: [] as string[],
        effectAllowed: "none",
        dropEffect: "none",
        setData: vi.fn((type: string, value: string) => {
            values.set(type, value);
            transfer.types = Array.from(values.keys());
        }),
        getData: vi.fn((type: string) => values.get(type) ?? ""),
    };
    return transfer as unknown as DataTransfer;
}

function dragEvent(dataTransfer: DataTransfer, ctrlKey = false): React.DragEvent<HTMLElement> {
    return {
        dataTransfer,
        ctrlKey,
        preventDefault: vi.fn(),
    } as unknown as React.DragEvent<HTMLElement>;
}

describe("unshelve remove-on-success default", () => {
    it("posts removeFromShelf false from a dialog seeded with the disabled setting", () => {
        const onSubmit = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <UnshelveDialog
                    entries={[shelfEntry]}
                    defaultRemoveFromShelf={false}
                    onClose={vi.fn()}
                    onSubmit={onSubmit}
                />
            </ChakraProvider>,
        );
        click(buttonByText(container, "Unshelve"));
        expect(onSubmit).toHaveBeenCalledWith({ changeIds: ["change-a"], removeFromShelf: false });
        unmount(root, container);
    });

    it("posts the snapshot setting from the silent unshelve toolbar action", () => {
        installWebviewI18n();
        const shelves: ShelfEntry[] = [
            { id: "shelf-a", generation: 7, metadata: { name: "A", lifecycle: "shelved" } },
        ];
        const onUnshelveSilently = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ShelfTab
                    shelves={shelves}
                    shelfFiles={[shelfEntry]}
                    selectedShelfId="shelf-a"
                    catalogGeneration={12}
                    shelfRemoveOnUnshelve={false}
                    onSelect={vi.fn()}
                    onUnshelve={vi.fn()}
                    onUnshelveSilently={onUnshelveSilently}
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
                />
            </ChakraProvider>,
        );
        const row = container.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        act(() =>
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })),
        );
        const silentUnshelve = Array.from(document.querySelectorAll<HTMLElement>(".intelligit-context-item")).find(
            (candidate) => candidate.textContent?.trim().startsWith("Unshelve Silently"),
        );
        if (!silentUnshelve) throw new Error('Menu item "Unshelve Silently" not found');
        click(silentUnshelve);
        expect(onUnshelveSilently).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "unshelve",
                shelfId: "shelf-a",
                changeIds: ["change-a"],
                removeFromShelf: false,
            }),
        );
        unmount(root, container);
    });

    it("posts the setting value on commit-drop and always keeps with Ctrl", () => {
        const disabled = renderDrag(false);
        const disabledTransfer = createDataTransfer();
        act(() =>
            disabled.drag.onShelfEntryDragStart(dragEvent(disabledTransfer), {
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-a"],
            }),
        );
        act(() => disabled.drag.onCommitDrop(dragEvent(disabledTransfer)));
        expect(disabled.onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ type: "unshelve", removeFromShelf: false }),
        );
        act(() => disabled.drag.onCommitDrop(dragEvent(disabledTransfer, true)));
        expect(disabled.onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ removeFromShelf: false }),
        );
        unmount(disabled.root, disabled.container);

        const enabled = renderDrag(true);
        const enabledTransfer = createDataTransfer();
        act(() =>
            enabled.drag.onShelfEntryDragStart(dragEvent(enabledTransfer), {
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-a"],
            }),
        );
        act(() => enabled.drag.onCommitDrop(dragEvent(enabledTransfer)));
        expect(enabled.onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ removeFromShelf: true }),
        );
        act(() => enabled.drag.onCommitDrop(dragEvent(enabledTransfer, true)));
        expect(enabled.onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ removeFromShelf: false }),
        );
        unmount(enabled.root, enabled.container);
    });
});
