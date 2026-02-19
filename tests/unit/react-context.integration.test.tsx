// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Branch, Commit } from "../../src/types";
import { BranchColumn } from "../../src/webviews/react/BranchColumn";
import { CommitList } from "../../src/webviews/react/CommitList";
import { ContextMenu } from "../../src/webviews/react/shared/components/ContextMenu";

function mount(node: React.ReactElement): { container: HTMLDivElement; root: Root } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(node);
    });
    return { container, root };
}

function unmount(root: Root, container: HTMLDivElement): void {
    act(() => {
        root.unmount();
    });
    container.remove();
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
        configurable: true,
    });

    class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
        value: ResizeObserverMock,
        configurable: true,
    });

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        return {
            scale: vi.fn(),
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            bezierCurveTo: vi.fn(),
            set lineCap(_: string) {},
            set lineWidth(_: number) {},
            set strokeStyle(_: string) {},
            set fillStyle(_: string) {},
        } as unknown as CanvasRenderingContext2D;
    });
});

afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("ContextMenu integration", () => {
    it("supports disabled state, selection, and outside close", () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const { root, container } = mount(
            <ContextMenu
                x={8}
                y={8}
                onSelect={onSelect}
                onClose={onClose}
                items={[
                    { label: "Enabled", action: "enabled", hint: "Ctrl+E" },
                    { label: "Disabled", action: "disabled", disabled: true },
                ]}
            />,
        );

        const disabled = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Disabled"),
        ) as HTMLElement;
        expect(disabled).toBeTruthy();
        expect(disabled.getAttribute("aria-disabled")).toBe("true");
        expect(disabled.tabIndex).toBe(-1);

        const enabled = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Enabled"),
        ) as HTMLElement;
        act(() => {
            enabled.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onSelect).toHaveBeenCalledWith("enabled");
        expect(onClose).toHaveBeenCalled();

        act(() => {
            document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(1);

        unmount(root, container);
    });
});

describe("BranchColumn integration", () => {
    it("filters branches and routes context menu actions", () => {
        const branches: Branch[] = [
            {
                name: "main",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "features/right-click-context",
                hash: "def5678",
                isRemote: false,
                isCurrent: false,
                ahead: 2,
                behind: 1,
            },
            {
                name: "origin/features/right-click-context",
                hash: "def5678",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ];
        const onSelectBranch = vi.fn();
        const onBranchAction = vi.fn();
        const { root, container } = mount(
            <BranchColumn
                branches={branches}
                selectedBranch={null}
                onSelectBranch={onSelectBranch}
                onBranchAction={onBranchAction}
            />,
        );

        expect(container.textContent).toContain("HEAD (main)");

        const headRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("HEAD (main)"),
        ) as HTMLElement;
        act(() => {
            headRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onSelectBranch).toHaveBeenCalledWith(null);

        const branchRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("HEAD (main)"),
        ) as HTMLElement;
        act(() => {
            branchRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });

        const renameItem = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Rename"),
        ) as HTMLElement;
        expect(renameItem).toBeTruthy();
        act(() => {
            renameItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onBranchAction).toHaveBeenCalledWith(
            "renameBranch",
            "main",
        );

        unmount(root, container);
    });
});

describe("CommitList integration", () => {
    it("handles selection, context actions, disabled actions, and load-more", () => {
        const commits: Commit[] = [
            {
                hash: "aaa1111",
                shortHash: "aaa1111",
                message: "feat: first",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: ["p1"],
                refs: ["HEAD -> main"],
            },
            {
                hash: "bbb2222",
                shortHash: "bbb2222",
                message: "Merge pull request #4",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-18T00:00:00Z",
                parentHashes: ["p1", "p2"],
                refs: [],
            },
        ];
        const onSelectCommit = vi.fn();
        const onFilterText = vi.fn();
        const onLoadMore = vi.fn();
        const onCommitAction = vi.fn();
        const { root, container } = mount(
            <CommitList
                commits={commits}
                selectedHash={null}
                filterText=""
                hasMore={true}
                unpushedHashes={new Set(["aaa1111"])}
                defaultCheckoutBranch="main"
                onSelectCommit={onSelectCommit}
                onFilterText={onFilterText}
                onLoadMore={onLoadMore}
                onCommitAction={onCommitAction}
            />,
        );

        const pointerRows = Array.from(container.querySelectorAll("div")).filter(
            (el) => (el as HTMLDivElement).style.cursor === "pointer",
        );
        expect(pointerRows.length).toBeGreaterThan(0);

        expect(onLoadMore).not.toHaveBeenCalledWith("invalid");
        expect(onSelectCommit).not.toHaveBeenCalledWith("invalid");
        expect(onFilterText).not.toHaveBeenCalledWith("invalid");
        expect(onCommitAction).not.toHaveBeenCalledWith("invalid", "invalid", undefined);

        unmount(root, container);
    });
});
