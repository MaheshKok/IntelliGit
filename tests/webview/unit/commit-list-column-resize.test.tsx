// @vitest-environment jsdom

// Issue #155: the Author and Date columns of the commit list resize by dragging
// the divider in the header, the width applies to every row, survives a
// remount, and double-clicking the divider restores the default.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { META_COLUMN_WIDTHS_STORAGE_KEY } from "../../../src/webviews/react/commit-list/metaColumnResize";
import { AUTHOR_COL_WIDTH, DATE_COL_WIDTH } from "../../../src/webviews/react/commit-list/styles";
import {
    flush,
    initReactDomTestEnvironment,
    mount,
    unmount,
} from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => ({ postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() }),
}));

initReactDomTestEnvironment();

const VIEWPORT_WIDTH = 800;
const originalRect = HTMLElement.prototype.getBoundingClientRect;

const commits: Commit[] = [
    {
        hash: "aa11bb22",
        shortHash: "aa11bb22",
        message: "feat: resizable columns",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["p1"],
        refs: [],
    },
];

function renderList() {
    return mount(
        <CommitList
            commits={commits}
            selectedHash={null}
            filterText=""
            hasMore={false}
            unpushedHashes={new Set()}
            selectedBranch={null}
            onSelectCommit={vi.fn()}
            onFilterText={vi.fn()}
            onLoadMore={vi.fn()}
            onCommitAction={vi.fn()}
        />,
    );
}

function authorCell(container: HTMLElement): HTMLElement {
    const cell = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Mahesh",
    );
    if (!cell) throw new Error("author cell not rendered");
    return cell as HTMLElement;
}

function handle(container: HTMLElement, column: "author" | "date"): HTMLElement {
    const el = container.querySelector(`[data-testid="commit-column-resize-${column}"]`);
    if (!el) throw new Error(`${column} resize handle not rendered`);
    return el as HTMLElement;
}

function drag(el: HTMLElement, fromX: number, toX: number, release = true): void {
    act(() => {
        el.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: fromX }),
        );
    });
    act(() => {
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: toX }));
    });
    if (release) {
        act(() => {
            document.dispatchEvent(new MouseEvent("mouseup", { clientX: toX }));
        });
    }
}

beforeEach(() => {
    installWebviewI18n();
    localStorage.clear();
    HTMLElement.prototype.getBoundingClientRect = () =>
        ({ width: VIEWPORT_WIDTH, height: 400, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
});

afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
});

describe("commit list column resize", () => {
    it("renders a labelled divider for each metadata column at the default width", async () => {
        const { root, container } = renderList();
        await flush();

        const author = handle(container, "author");
        expect(author.tagName).toBe("BUTTON");
        expect(author.getAttribute("aria-label")).toBe("Resize Author column");
        expect(handle(container, "date").getAttribute("aria-label")).toBe("Resize Date column");
        expect(authorCell(container).style.width).toBe(`${AUTHOR_COL_WIDTH}px`);

        unmount(root, container);
    });

    it("dragging the author divider left widens the author column in header and rows", async () => {
        const { root, container } = renderList();
        await flush();

        drag(handle(container, "author"), 500, 460, false);

        expect(authorCell(container).style.width).toBe(`${AUTHOR_COL_WIDTH + 40}px`);
        expect(document.body.style.cursor).toBe("col-resize");
        expect(localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY)).toBeNull();

        act(() => {
            document.dispatchEvent(new MouseEvent("mouseup", { clientX: 460 }));
        });
        expect(document.body.style.cursor).toBe("");
        expect(JSON.parse(localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY) ?? "{}")).toEqual({
            author: AUTHOR_COL_WIDTH + 40,
            date: DATE_COL_WIDTH,
        });

        unmount(root, container);
    });

    it("restores the persisted width on remount and resets it on double-click", async () => {
        localStorage.setItem(
            META_COLUMN_WIDTHS_STORAGE_KEY,
            JSON.stringify({ author: 160, date: DATE_COL_WIDTH }),
        );
        const { root, container } = renderList();
        await flush();

        expect(authorCell(container).style.width).toBe("160px");

        act(() => {
            handle(container, "author").dispatchEvent(
                new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
            );
        });
        expect(authorCell(container).style.width).toBe(`${AUTHOR_COL_WIDTH}px`);
        expect(JSON.parse(localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY) ?? "{}")).toEqual({
            author: AUTHOR_COL_WIDTH,
            date: DATE_COL_WIDTH,
        });

        unmount(root, container);
    });

    it("a plain click on the divider prevents text selection and writes nothing", async () => {
        const { root, container } = renderList();
        await flush();

        const event = new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            clientX: 500,
        });
        act(() => {
            handle(container, "date").dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(true);
        act(() => {
            document.dispatchEvent(new MouseEvent("mouseup", { clientX: 500 }));
        });
        expect(localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY)).toBeNull();

        unmount(root, container);
    });

    it("arrow keys on a focused divider resize the column and persist it", async () => {
        const { root, container } = renderList();
        await flush();

        const key = (name: string) =>
            act(() => {
                handle(container, "author").dispatchEvent(
                    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
                );
            });

        key("ArrowLeft");
        expect(authorCell(container).style.width).toBe(`${AUTHOR_COL_WIDTH + 8}px`);
        expect(JSON.parse(localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY) ?? "{}")).toEqual({
            author: AUTHOR_COL_WIDTH + 8,
            date: DATE_COL_WIDTH,
        });

        key("ArrowRight");
        key("ArrowRight");
        expect(authorCell(container).style.width).toBe(`${AUTHOR_COL_WIDTH - 8}px`);

        unmount(root, container);
    });
});
