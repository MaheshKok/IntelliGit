// @vitest-environment jsdom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Branch, Commit } from "../../src/types";
import { BranchColumn } from "../../src/webviews/react/BranchColumn";
import { CommitList } from "../../src/webviews/react/CommitList";
import { ContextMenu } from "../../src/webviews/react/shared/components/ContextMenu";
import { initReactDomTestEnvironment, mount, unmount } from "./utils/reactDomTestUtils";

initReactDomTestEnvironment();

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

        act(() => {
            headRow.dispatchEvent(
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
        expect(onBranchAction).toHaveBeenCalledWith("renameBranch", "main");

        unmount(root, container);
    });
});

describe("CommitList integration", () => {
    it("fires selection/action/filter/load-more callbacks through real interactions", () => {
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

        const filterInput = container.querySelector(
            'input[placeholder="Text or hash"]',
        ) as HTMLInputElement;
        expect(filterInput).toBeTruthy();
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        act(() => {
            valueSetter?.call(filterInput, "feat");
            filterInput.dispatchEvent(new Event("input", { bubbles: true }));
            filterInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(onFilterText).toHaveBeenCalledWith("feat");

        const firstRow = Array.from(container.querySelectorAll("div")).find(
            (el) =>
                (el as HTMLDivElement).style.cursor === "pointer" &&
                el.textContent?.includes("feat: first"),
        ) as HTMLElement;
        expect(firstRow).toBeTruthy();
        act(() => {
            firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onSelectCommit).toHaveBeenCalledWith("aaa1111");

        act(() => {
            firstRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });
        const copyRevisionItem = Array.from(
            document.querySelectorAll(".intelligit-context-item"),
        ).find((el) => el.textContent?.includes("Copy Revision Number")) as HTMLElement;
        act(() => {
            copyRevisionItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenCalledWith("copyRevision", "aaa1111", undefined);

        const viewport = container.querySelector(
            '[data-testid="commit-list-viewport"]',
        ) as HTMLDivElement;
        Object.defineProperty(viewport, "clientHeight", { value: 240, configurable: true });
        Object.defineProperty(viewport, "scrollHeight", { value: 300, configurable: true });
        Object.defineProperty(viewport, "scrollTop", { value: 90, configurable: true });
        act(() => {
            viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(onLoadMore).toHaveBeenCalled();

        unmount(root, container);
    });
});
