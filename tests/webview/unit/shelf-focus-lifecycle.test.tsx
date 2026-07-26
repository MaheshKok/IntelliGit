// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfDeleteConfirmation } from "../../../src/webviews/react/commit-panel/components/ShelfTabDialogs";
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

describe("shelf dialog focus lifecycle", () => {
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
