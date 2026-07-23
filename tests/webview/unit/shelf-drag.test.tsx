// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import { FileTree } from "../../../src/webviews/react/commit-panel/components/FileTree";
import { ShelfRow } from "../../../src/webviews/react/commit-panel/components/ShelfRow";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import theme from "../../../src/webviews/react/commit-panel/theme";
import {
    SHELF_ENTRIES_DRAG_MIME,
    SHELF_FILES_DRAG_MIME,
    useShelfDrag,
} from "../../../src/webviews/react/commit-panel/hooks/useShelfDrag";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

type ShelfDrag = ReturnType<typeof useShelfDrag>;

function createDataTransfer(): DataTransfer {
    const values = new Map<string, string>();
    const transfer = {
        types: [],
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

function createProtectedDataTransfer(
    mime: string,
    payload: string,
    types: string[] = [mime],
): { dataTransfer: DataTransfer; revealPayload: () => void } {
    let canReadPayload = false;
    return {
        dataTransfer: {
            types,
            effectAllowed: "none",
            dropEffect: "none",
            setData: vi.fn(),
            getData: vi.fn(() => (canReadPayload ? payload : "")),
        } as unknown as DataTransfer,
        revealPayload: () => {
            canReadPayload = true;
        },
    };
}

function dispatchDragStart(element: HTMLElement, dataTransfer: DataTransfer): void {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => element.dispatchEvent(event));
}

function Harness({
    onMessage,
    capture,
}: {
    onMessage: ReturnType<typeof vi.fn>;
    capture: (drag: ShelfDrag) => void;
}): React.ReactElement {
    capture(useShelfDrag({ repositoryRoot: "/repo", catalogGeneration: 12, onMessage }));
    return <div />;
}

function renderDrag() {
    let drag: ShelfDrag | undefined;
    const onMessage = vi.fn();
    const mounted = mount(
        <Harness
            onMessage={onMessage}
            capture={(next) => {
                drag = next;
            }}
        />,
    );
    if (!drag) throw new Error("Shelf drag hook did not render");
    return { ...mounted, drag, onMessage };
}

describe("useShelfDrag", () => {
    const file: WorkingFile = {
        path: "src/parser.ts",
        status: "M",
        staged: false,
        additions: 1,
        deletions: 0,
    };

    it("posts silent shelve messages for checked commit rows and uses Ctrl as keep-local", () => {
        const { root, container, drag, onMessage } = renderDrag();
        const transfer = createDataTransfer();
        act(() =>
            drag.onCommitFileDragStart(
                dragEvent(transfer),
                file,
                new Set([file.path, "src/lexer.ts"]),
            ),
        );

        expect(JSON.parse(transfer.getData(SHELF_FILES_DRAG_MIME))).toEqual({
            repositoryRoot: "/repo",
            paths: ["src/parser.ts", "src/lexer.ts"],
        });

        act(() => drag.onShelfDrop(dragEvent(transfer)));
        expect(onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelveSave",
                repositoryRoot: "/repo",
                paths: ["src/parser.ts", "src/lexer.ts"],
                silent: true,
                keepLocal: false,
                expectedCatalogGeneration: 12,
                requestId: expect.any(String),
                idempotencyToken: expect.any(String),
            }),
        );

        act(() => drag.onShelfDrop(dragEvent(transfer, true)));
        expect(onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ keepLocal: true }));
        unmount(root, container);
    });

    it("posts flattened unshelve messages for whole shelves and individual entries", () => {
        const { root, container, drag, onMessage } = renderDrag();
        const whole = createDataTransfer();
        act(() =>
            drag.onShelfEntryDragStart(dragEvent(whole), {
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-a", "change-b"],
            }),
        );
        expect(JSON.parse(whole.getData(SHELF_ENTRIES_DRAG_MIME))).toEqual({
            repositoryRoot: "/repo",
            shelfId: "shelf-a",
            generation: 7,
            changeIds: ["change-a", "change-b"],
        });
        act(() => drag.onCommitDrop(dragEvent(whole)));
        expect(onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "unshelve",
                repositoryRoot: "/repo",
                shelfId: "shelf-a",
                expectedGeneration: 7,
                changeIds: ["change-a", "change-b"],
                removeFromShelf: true,
                mode: "flattened",
            }),
        );

        const entry = createDataTransfer();
        act(() =>
            drag.onShelfEntryDragStart(dragEvent(entry), {
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-b"],
            }),
        );
        act(() => drag.onCommitDrop(dragEvent(entry, true)));
        expect(onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                changeIds: ["change-b"],
                removeFromShelf: false,
            }),
        );
        unmount(root, container);
    });

    it("refuses cross-repository drops without posting a message", () => {
        const { root, container, drag, onMessage } = renderDrag();
        const files = createDataTransfer();
        files.setData(
            SHELF_FILES_DRAG_MIME,
            JSON.stringify({ repositoryRoot: "/other", paths: [file.path] }),
        );
        const shelfEvent = dragEvent(files);
        act(() => drag.onShelfDrop(shelfEvent));
        expect(shelfEvent.preventDefault).not.toHaveBeenCalled();

        const entries = createDataTransfer();
        entries.setData(
            SHELF_ENTRIES_DRAG_MIME,
            JSON.stringify({
                repositoryRoot: "/other",
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-a"],
            }),
        );
        const commitEvent = dragEvent(entries);
        act(() => drag.onCommitDrop(commitEvent));
        expect(commitEvent.preventDefault).not.toHaveBeenCalled();
        expect(onMessage).not.toHaveBeenCalled();
        unmount(root, container);
    });

    it("accepts matching protected-mode dragovers and validates payloads only at drop", () => {
        const { root, container, drag, onMessage } = renderDrag();
        const files = createProtectedDataTransfer(
            SHELF_FILES_DRAG_MIME,
            JSON.stringify({ repositoryRoot: "/repo", paths: [file.path] }),
        );
        const shelfDragOver = dragEvent(files.dataTransfer);
        act(() => drag.onShelfDragOver(shelfDragOver));
        expect(shelfDragOver.preventDefault).toHaveBeenCalledTimes(1);

        const entries = createProtectedDataTransfer(
            SHELF_ENTRIES_DRAG_MIME,
            JSON.stringify({
                repositoryRoot: "/repo",
                shelfId: "shelf-a",
                generation: 7,
                changeIds: ["change-a"],
            }),
        );
        const commitDragOver = dragEvent(entries.dataTransfer);
        act(() => drag.onCommitDragOver(commitDragOver));
        expect(commitDragOver.preventDefault).toHaveBeenCalledTimes(1);

        const foreignType = createProtectedDataTransfer(
            SHELF_FILES_DRAG_MIME,
            JSON.stringify({ repositoryRoot: "/repo", paths: [file.path] }),
            ["text/plain"],
        );
        const foreignTypeDragOver = dragEvent(foreignType.dataTransfer);
        act(() => drag.onShelfDragOver(foreignTypeDragOver));
        expect(foreignTypeDragOver.preventDefault).not.toHaveBeenCalled();

        files.revealPayload();
        act(() => drag.onShelfDrop(dragEvent(files.dataTransfer)));
        expect(onMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelveSave",
                repositoryRoot: "/repo",
                paths: [file.path],
                silent: true,
                keepLocal: false,
                expectedCatalogGeneration: 12,
            }),
        );

        const crossRepository = createProtectedDataTransfer(
            SHELF_FILES_DRAG_MIME,
            JSON.stringify({ repositoryRoot: "/other", paths: [file.path] }),
        );
        crossRepository.revealPayload();
        act(() => drag.onShelfDrop(dragEvent(crossRepository.dataTransfer)));
        expect(onMessage).toHaveBeenCalledTimes(1);
        unmount(root, container);
    });

    it("does not start a shelf drag until the selected shelf files are current", () => {
        installWebviewI18n();
        const shelves: ShelfEntry[] = [
            { id: "shelf-a", generation: 7, metadata: { name: "A", lifecycle: "shelved" } },
            { id: "shelf-b", generation: 8, metadata: { name: "B", lifecycle: "shelved" } },
        ];
        const shelfAFiles: ShelfFileEntry[] = [
            {
                changeId: "change-a",
                worktreeBlock: { path: "a.ts", status: "M" },
                binary: false,
                untracked: false,
                baseAvailability: "none",
                exactReconstruction: true,
                lifecycle: "shelved",
            },
        ];
        const shelfBFiles: ShelfFileEntry[] = [{ ...shelfAFiles[0], changeId: "change-b" }];
        const onShelfEntryDragStart = vi.fn();
        const renderTab = (selectedShelfId: string, shelfFiles: ShelfFileEntry[]) => (
            <ChakraProvider theme={theme}>
                <ShelfTab
                    shelves={shelves}
                    shelfFiles={shelfFiles}
                    selectedShelfId={selectedShelfId}
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
                    onShelfEntryDragStart={onShelfEntryDragStart}
                />
            </ChakraProvider>
        );
        const mounted = mount(renderTab("shelf-a", shelfAFiles));
        const row = mounted.container.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement;
        act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(row.draggable).toBe(false);
        expect(mounted.container.querySelector('[data-shelf-file="change-a"]')).toBeNull();
        dispatchDragStart(row, createDataTransfer());
        expect(onShelfEntryDragStart).not.toHaveBeenCalled();

        act(() => mounted.root.render(renderTab("shelf-b", shelfBFiles)));
        const currentRow = mounted.container.querySelector(
            '[data-shelf-id="shelf-b"]',
        ) as HTMLElement;
        const transfer = createDataTransfer();
        expect(currentRow.draggable).toBe(true);
        dispatchDragStart(currentRow, transfer);
        expect(onShelfEntryDragStart).toHaveBeenCalledWith(expect.anything(), {
            shelfId: "shelf-b",
            generation: 8,
            changeIds: ["change-b"],
        });
        const currentFileRow = mounted.container.querySelector(
            '[data-shelf-file="change-b"]',
        ) as HTMLElement;
        expect(currentFileRow.draggable).toBe(true);
        dispatchDragStart(currentFileRow, createDataTransfer());
        expect(onShelfEntryDragStart).toHaveBeenLastCalledWith(expect.anything(), {
            shelfId: "shelf-b",
            generation: 8,
            changeIds: ["change-b"],
        });
        unmount(mounted.root, mounted.container);
    });

    it("keeps the unversioned drag payload and makes ghost rows non-draggable", () => {
        const transfer = createDataTransfer();
        const mounted = mount(
            <ChakraProvider theme={theme}>
                <FileTree
                    files={[
                        { path: "new.ts", status: "?", staged: false, additions: 1, deletions: 0 },
                    ]}
                    groupByDir={false}
                    showIgnoredFiles={false}
                    checkedPaths={new Set()}
                    onToggleFile={vi.fn()}
                    onToggleFolder={vi.fn()}
                    onToggleSection={vi.fn()}
                    isAllChecked={() => false}
                    isSomeChecked={() => false}
                    onFileClick={vi.fn()}
                    onTrackUnversionedFiles={vi.fn()}
                    expandAllSignal={0}
                    collapseAllSignal={0}
                />
            </ChakraProvider>,
        );
        const row = mounted.container.querySelector("[data-vscode-context]") as HTMLElement;
        const event = new Event("dragstart", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        act(() => row.dispatchEvent(event));
        expect(
            JSON.parse(transfer.getData("application/vnd.intelligit.unversioned-files")),
        ).toEqual(["new.ts"]);
        unmount(mounted.root, mounted.container);

        const ghost: ShelfEntry = {
            id: "ghost",
            generation: 1,
            metadata: { name: "Ghost", lifecycle: "applied" },
        };
        const ghostMounted = mount(
            <ChakraProvider theme={theme}>
                <ShelfRow
                    shelf={ghost}
                    selected={false}
                    isGhost
                    isRenaming={false}
                    onSelect={vi.fn()}
                    onNavigate={vi.fn()}
                    onContextMenu={vi.fn()}
                    onRenameSubmit={vi.fn()}
                    onRenameCancel={vi.fn()}
                    onRestore={vi.fn()}
                    onDragStart={vi.fn()}
                />
            </ChakraProvider>,
        );
        expect(
            (ghostMounted.container.querySelector('[data-shelf-id="ghost"]') as HTMLElement)
                .draggable,
        ).toBe(false);
        unmount(ghostMounted.root, ghostMounted.container);
    });
});
