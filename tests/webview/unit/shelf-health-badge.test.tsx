// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import type {
    ShelfEntry,
    ShelfHealthWarning,
} from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { TabBar } from "../../../src/webviews/react/commit-panel/components/TabBar";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

function renderTabBar(shelfWarningCount: number) {
    installWebviewI18n();
    return mount(
        <ChakraProvider theme={theme}>
            <TabBar
                stashCount={0}
                shelfWarningCount={shelfWarningCount}
                commitContent={<div />}
                stashContent={<div />}
                shelfContent={<div />}
            />
        </ChakraProvider>,
    );
}

function renderShelfTab(shelfHealth: ShelfHealthWarning[]) {
    installWebviewI18n();
    const shelves: ShelfEntry[] = [
        { id: "shelf-a", generation: 7, metadata: { name: "A", lifecycle: "shelved" } },
    ];
    const shelfFiles: ShelfFileEntry[] = [
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
    return mount(
        <ChakraProvider theme={theme}>
            <ShelfTab
                shelves={shelves}
                shelfFiles={shelfFiles}
                selectedShelfId="shelf-a"
                catalogGeneration={12}
                shelfHealth={shelfHealth}
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
            />
        </ChakraProvider>,
    );
}

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

describe("shelf health badge and banner", () => {
    it("renders no shelf-tab badge when there are no warnings", () => {
        const { root, container } = renderTabBar(0);
        expect(container.querySelector('[aria-label$="shelf warnings"]')).toBeNull();
        unmount(root, container);
    });

    it("renders a labelled count badge on the shelf tab when warnings exist", () => {
        const { root, container } = renderTabBar(3);
        const badge = container.querySelector('[aria-label="3 shelf warnings"]');
        expect(badge).not.toBeNull();
        expect(badge?.textContent).toBe("3");
        unmount(root, container);
    });

    it("shows the warning banner, opens details listing kind and detail, and closes", () => {
        const { root, container } = renderShelfTab([
            { kind: "corruptShelf", detail: "shelf-a" },
            { kind: "lockBusy", detail: "repository lock is busy" },
        ]);
        const banner = container.querySelector('[role="alert"]');
        expect(banner?.textContent).toContain("Shelf has 2 warnings.");

        click(buttonByText(container, "Details"));
        const dialog = container.querySelector('[aria-labelledby="shelf-health-title"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain("corruptShelf: shelf-a");
        expect(dialog?.textContent).toContain("lockBusy: repository lock is busy");

        click(buttonByText(container, "Close"));
        expect(container.querySelector('[aria-labelledby="shelf-health-title"]')).toBeNull();
        unmount(root, container);
    });

    it("renders no banner when shelf health is empty", () => {
        const { root, container } = renderShelfTab([]);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        unmount(root, container);
    });
});
