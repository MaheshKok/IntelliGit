// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfFilePane } from "../../../src/webviews/react/commit-panel/components/ShelfFilePane";
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

function renderPane(overrides: Partial<React.ComponentProps<typeof ShelfFilePane>> = {}) {
    const onFileActivate = vi.fn();
    const onDragStart = vi.fn();
    const mounted = mount(
        <ChakraProvider theme={theme}>
            <ShelfFilePane
                entries={entries}
                groupByDir={false}
                onFileActivate={onFileActivate}
                onDragStart={onDragStart}
                {...overrides}
            />
        </ChakraProvider>,
    );
    return { ...mounted, onFileActivate, onDragStart };
}

describe("ShelfFilePane boundary behavior", () => {
    beforeEach(() => installWebviewI18n());

    it("uses index-only paths, normalizes type changes, and activates the owning shelf entry", () => {
        const { root, container, onFileActivate } = renderPane();
        const row = container.querySelector('[data-shelf-file="type-change"]') as HTMLElement;

        expect(row.getAttribute("title")).toBe("src/index-only.ts");
        expect(row.getAttribute("data-vscode-context")).toBeNull();
        act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));

        expect(onFileActivate).toHaveBeenCalledWith(entries[0]);
        expect(row.getAttribute("aria-current")).toBe("true");
        unmount(root, container);
    });

    it("uses the change id for an untracked entry, supports dragging, and renders the empty state", () => {
        const { root, container, onDragStart } = renderPane();
        const row = container.querySelector('[data-shelf-file="untracked"]') as HTMLElement;

        expect(row.getAttribute("title")).toBe("untracked");
        act(() => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
        expect(onDragStart).toHaveBeenCalledWith(expect.anything(), entries[1]);
        unmount(root, container);

        const empty = renderPane({ entries: [], onDragStart: undefined });
        expect(empty.container.textContent).toContain("No shelf files.");
        unmount(empty.root, empty.container);
    });

    it("renders and collapses grouped directories while retaining keyboard-style file activation", () => {
        const { root, container, onFileActivate } = renderPane({ groupByDir: true });
        const section = container.querySelector(
            '[data-testid="shelf-file-pane"] > div',
        ) as HTMLElement;
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
        act(() => section.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(container.querySelector('[data-shelf-file="type-change"]')).toBeNull();
        unmount(root, container);
    });
});
