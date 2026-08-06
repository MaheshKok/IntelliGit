// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import { ShelfTab } from "../../../src/webviews/react/commit-panel/components/ShelfTab";
import { RefreshButton } from "../../../src/webviews/react/shared/components/RefreshButton";
import { ICON_ACCENTS } from "../../../src/webviews/react/shared/tokens";
import { StashTab } from "../../../src/webviews/react/commit-panel/components/StashTab";
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
    { id: "shelf-a", generation: 1, files: [], metadata: { name: "Parser repair" } },
];

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function refreshButton(container: ParentNode): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>('[data-testid="refresh-button"]');
    if (!found) throw new Error("Missing refresh button");
    return found;
}

function refreshGlyphStyle(container: ParentNode): string {
    const found = container.querySelector('[data-testid="refresh-button"] svg');
    if (!found) throw new Error("Missing refresh glyph");
    return found.getAttribute("style") ?? "";
}

function expectDirectRefreshCodicon(container: ParentNode): void {
    const glyphs = refreshButton(container).querySelectorAll<SVGElement>("svg");
    expect(glyphs).toHaveLength(1);
    const glyph = glyphs[0];
    if (!glyph) throw new Error("Missing refresh glyph");
    expect(glyph.getAttribute("width")).toBe("16");
    expect(glyph.getAttribute("height")).toBe("16");
    expect(glyph.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(glyph.getAttribute("fill")).toBe("currentColor");
}

function renderShelf(isRefreshing: boolean, onRefresh: () => void = vi.fn()) {
    return mount(
        <ChakraProvider theme={theme}>
            <ShelfTab
                repositoryRoot="/repo"
                shelves={shelves}
                selectedShelfId={null}
                catalogGeneration={1}
                isRefreshing={isRefreshing}
                onRefresh={onRefresh}
                onSelect={vi.fn()}
                onUnshelve={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
                onShowDiff={vi.fn()}
                onCompareWithLocal={vi.fn()}
                onRestoreGhost={vi.fn()}
                onImportPatch={vi.fn()}
                onExportPatch={vi.fn()}
                onCopyPatch={vi.fn()}
                onCleanUp={vi.fn()}
                onToggleGroupBy={vi.fn()}
            />
        </ChakraProvider>,
    );
}

function renderStash(isRefreshing: boolean) {
    return mount(
        <ChakraProvider theme={theme}>
            <StashTab
                repositoryRoot="/repo"
                currentBranchName="main"
                stashes={[]}
                stashFiles={[]}
                selectedIndex={null}
                groupByDir={false}
                isRefreshing={isRefreshing}
                onToggleGroupBy={vi.fn()}
            />
        </ChakraProvider>,
    );
}

describe("shelf and stash toolbars expose the same refresh control as commit", () => {
    beforeEach(() => {
        installWebviewI18n();
        vscode.postMessage.mockClear();
    });

    // The shelf routes every host message through a callback prop; the stash
    // posts its own. Each tab is checked at the seam it actually owns.
    it("raises the shelf toolbar refresh through its host callback", () => {
        const onRefresh = vi.fn();
        const { root, container } = renderShelf(false, onRefresh);

        click(refreshButton(container));

        expect(onRefresh).toHaveBeenCalledTimes(1);
        // The icon keeps spinning on its own so a refresh that finishes before
        // the next paint still reads as having done something.
        expect(refreshButton(container).getAttribute("data-refreshing")).toBe("true");
        unmount(root, container);
    });

    it("asks the host to refresh this repository from the stash toolbar", () => {
        const { root, container } = renderStash(false);

        click(refreshButton(container));

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "refresh",
            repositoryRoot: "/repo",
        });
        expect(refreshButton(container).getAttribute("data-refreshing")).toBe("true");
        unmount(root, container);
    });

    it("keeps the accent-coloured glyph while the host is refreshing", () => {
        // Colour icons are the shipped default, so the refresh glyph is blue at rest.
        // Spinning must not fade it to the disabled grey — a refresh in progress is
        // exactly when the icon has the most to say.
        (window as Window & { intelligitSettings?: unknown }).intelligitSettings = {
            iconStyle: "color",
        };
        try {
            const idle = renderShelf(false);
            expectDirectRefreshCodicon(idle.container);
            const idleStyle = refreshGlyphStyle(idle.container);
            unmount(idle.root, idle.container);

            const busy = renderShelf(true);
            expectDirectRefreshCodicon(busy.container);
            const busyStyle = refreshGlyphStyle(busy.container);

            expect(idleStyle).toContain(ICON_ACCENTS.cyan);
            expect(busyStyle).toContain(ICON_ACCENTS.cyan);
            expect(busyStyle).not.toContain("disabledForeground");
            expect(busyStyle).toContain("intelligit-spin");
            unmount(busy.root, busy.container);
        } finally {
            delete (window as Window & { intelligitSettings?: unknown }).intelligitSettings;
        }
    });

    it("holds the spin briefly after a host refresh ends so a fast one is still seen", () => {
        vi.useFakeTimers();
        try {
            const { root, container } = mount(
                <ChakraProvider theme={theme}>
                    <RefreshButton isRefreshing onRefresh={vi.fn()} />
                </ChakraProvider>,
            );
            expect(refreshButton(container).getAttribute("data-refreshing")).toBe("true");

            // The undocked host does not pad its refresh span, so the flag can clear
            // within a frame. The spin has to outlive it to be seen at all.
            act(() =>
                root.render(
                    <ChakraProvider theme={theme}>
                        <RefreshButton isRefreshing={false} onRefresh={vi.fn()} />
                    </ChakraProvider>,
                ),
            );
            expect(refreshButton(container).getAttribute("data-refreshing")).toBe("true");

            act(() => void vi.advanceTimersByTime(700));
            expect(refreshButton(container).getAttribute("data-refreshing")).toBeNull();
            unmount(root, container);
        } finally {
            vi.useRealTimers();
        }
    });

    it("spins and refuses further clicks while the shelf host is refreshing", () => {
        const onRefresh = vi.fn();
        const { root, container } = renderShelf(true, onRefresh);
        const button = refreshButton(container);

        expect(button.getAttribute("data-refreshing")).toBe("true");
        expect(button.disabled).toBe(true);

        click(button);

        expect(onRefresh).not.toHaveBeenCalled();
        unmount(root, container);
    });

    it("spins and refuses further clicks while the stash host is refreshing", () => {
        const { root, container } = renderStash(true);
        const button = refreshButton(container);

        expect(button.getAttribute("data-refreshing")).toBe("true");
        expect(button.disabled).toBe(true);

        click(button);

        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "refresh" }),
        );
        unmount(root, container);
    });
});
