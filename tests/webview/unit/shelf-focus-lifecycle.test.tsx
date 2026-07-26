// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfDeleteConfirmation } from "../../../src/webviews/react/commit-panel/components/ShelfTabDialogs";
import { RenameStructuralDialog } from "../../../src/webviews/react/commit-panel/components/RenameStructuralDialog";
import { ShelfRow } from "../../../src/webviews/react/commit-panel/components/ShelfRow";
import { UnshelveDialog } from "../../../src/webviews/react/commit-panel/components/UnshelveDialog";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();
installWebviewI18n();

const entry: ShelfFileEntry = {
    changeId: "change-a",
    worktreeBlock: { path: "a.ts", status: "M" },
    binary: false,
    untracked: false,
    baseAvailability: "none",
    exactReconstruction: true,
    lifecycle: "shelved",
};

function escape(element: HTMLElement): void {
    act(() =>
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
}

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function changeInput(input: HTMLInputElement, value: string): void {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Missing native input value setter");
    act(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

describe("shelf dialog focus lifecycle", () => {
    it("trims a renamed target path and restores launcher focus after Escape", () => {
        const launcher = document.createElement("button");
        document.body.append(launcher);
        launcher.focus();
        const onClose = vi.fn();
        const onConfirm = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <RenameStructuralDialog
                    path="src/original.ts"
                    returnFocusTarget={launcher}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />
            </ChakraProvider>,
        );
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        const input = dialog.querySelector("input") as HTMLInputElement;
        const submit = dialog.querySelectorAll<HTMLButtonElement>("button").item(1);

        expect(input.value).toBe("src/original.ts");
        expect(submit.disabled).toBe(false);
        changeInput(input, "   ");
        expect(submit.disabled).toBe(true);
        changeInput(input, "  src/renamed.ts  ");
        expect(submit.disabled).toBe(false);
        click(submit);
        expect(onConfirm).toHaveBeenCalledWith("src/renamed.ts");

        escape(dialog);
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(launcher);
        unmount(root, container);
        launcher.remove();
    });

    it("focuses the rename input opened from a shelf row", () => {
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ShelfRow
                    shelf={{
                        id: "shelf-a",
                        generation: 1,
                        files: [],
                        metadata: { name: "A", lifecycle: "shelved" },
                    }}
                    state={{
                        selected: true,
                        isFocusTarget: true,
                        isGhost: false,
                        isExpanded: false,
                        isRenaming: true,
                    }}
                    onSelect={vi.fn()}
                    onToggleExpand={vi.fn()}
                    onNavigate={vi.fn()}
                    onContextMenu={vi.fn()}
                    onRenameSubmit={vi.fn()}
                    onRenameCancel={vi.fn()}
                    onRestore={vi.fn()}
                />
            </ChakraProvider>,
        );
        const input = container.querySelector<HTMLInputElement>('[aria-label="Rename shelf"]');
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        unmount(root, container);
    });

    it("returns Unshelve focus to its launcher after Escape", () => {
        const launcher = document.createElement("button");
        document.body.append(launcher);
        launcher.focus();
        const onClose = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <UnshelveDialog
                    entries={[entry]}
                    returnFocusTarget={launcher}
                    onClose={onClose}
                    onSubmit={vi.fn()}
                />
            </ChakraProvider>,
        );
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        expect(document.activeElement).toBe(dialog.querySelector("button"));
        escape(dialog);
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(launcher);
        unmount(root, container);
        launcher.remove();
    });

    it("returns Delete focus to its launcher after Escape", () => {
        const launcher = document.createElement("button");
        document.body.append(launcher);
        launcher.focus();
        const onClose = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ShelfDeleteConfirmation
                    shelf={{
                        id: "shelf-a",
                        generation: 1,
                        metadata: { name: "A", lifecycle: "shelved" },
                    }}
                    returnFocusTarget={launcher}
                    onClose={onClose}
                    onConfirm={vi.fn()}
                />
            </ChakraProvider>,
        );
        const dialog = container.querySelector('[role="alertdialog"]') as HTMLElement;
        expect(document.activeElement).toBe(dialog.querySelector("button"));
        escape(dialog);
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(launcher);
        unmount(root, container);
        launcher.remove();
    });
});
