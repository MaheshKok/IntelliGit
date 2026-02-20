// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Branch, Commit } from "../../src/types";
import { BranchColumn } from "../../src/webviews/react/BranchColumn";
import { CommitList } from "../../src/webviews/react/CommitList";
import { CommitRow } from "../../src/webviews/react/commit-list/CommitRow";
import { useDragResize } from "../../src/webviews/react/commit-panel/hooks/useDragResize";
import { ContextMenu } from "../../src/webviews/react/shared/components/ContextMenu";
import {
    flush,
    initReactDomTestEnvironment,
    mount,
    unmount,
} from "./utils/reactDomTestUtils";

initReactDomTestEnvironment();

describe("low coverage components", () => {
    it("useDragResize updates and clamps height", () => {
        const onResize = vi.fn();
        function Harness(): React.ReactElement {
            const ref = useRef<HTMLDivElement>(null);
            const { height, onMouseDown } = useDragResize(120, 80, ref, {
                maxReservedHeight: 50,
                onResize,
            });
            return (
                <div ref={ref} data-host="1">
                    <span data-height>{height}</span>
                    <div data-handle="1" onMouseDown={onMouseDown} />
                </div>
            );
        }

        const { root, container } = mount(<Harness />);
        const host = container.querySelector("[data-host='1']") as HTMLDivElement;
        Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });

        const handle = container.querySelector("[data-handle='1']") as HTMLElement;
        act(() => {
            handle.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 300 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 200 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        expect(onResize).toHaveBeenCalled();

        act(() => {
            handle.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 300 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 800 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        const heightText = container.querySelector("[data-height]")?.textContent ?? "";
        expect(Number(heightText)).toBeGreaterThanOrEqual(80);

        unmount(root, container);
    });

    it("CommitRow renders ref badges and handles row events", () => {
        const onSelect = vi.fn();
        const onContextMenu = vi.fn();
        const commit: Commit = {
            hash: "a1b2c3d4",
            shortHash: "a1b2c3d4",
            message: "feat: row coverage",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["p1"],
            refs: ["HEAD -> main", "tag:v1.0.0", "origin/main", "feature/demo"],
        };

        const { root, container } = mount(
            <CommitRow
                commit={commit}
                graphWidth={100}
                isSelected={false}
                isUnpushed={true}
                laneColor="#00ff00"
                onSelect={onSelect}
                onContextMenu={onContextMenu}
            />,
        );

        expect(container.textContent).toContain("HEAD -> main");
        expect(container.textContent).toContain("tag:v1.0.0");
        expect(container.textContent).toContain("origin/main");

        const row = container.querySelector("div") as HTMLDivElement;
        act(() => {
            row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            row.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 20,
                    clientY: 20,
                }),
            );
        });
        expect(onSelect).toHaveBeenCalledWith("a1b2c3d4");
        expect(onContextMenu).toHaveBeenCalled();

        act(() => {
            root.render(
                <CommitRow
                    commit={commit}
                    graphWidth={100}
                    isSelected={true}
                    isUnpushed={false}
                    laneColor="#00ff00"
                    onSelect={onSelect}
                    onContextMenu={onContextMenu}
                />,
            );
        });

        unmount(root, container);
    });

    it("ContextMenu supports keyboard activation and escape close", () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const { root, container } = mount(
            <ContextMenu
                x={6}
                y={6}
                onSelect={onSelect}
                onClose={onClose}
                items={[
                    { label: "Open", action: "open" },
                    { label: "Submenu", action: "submenu", submenu: true },
                ]}
            />,
        );

        const item = Array.from(document.querySelectorAll(".intelligit-context-item")).find((el) =>
            el.textContent?.includes("Open"),
        ) as HTMLElement;
        act(() => {
            item.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "Enter",
                }),
            );
        });
        expect(onSelect).toHaveBeenCalledWith("open");

        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });
        expect(onClose).toHaveBeenCalled();

        unmount(root, container);
    });

    it("BranchColumn handles remote expansion, filtering, and context actions", async () => {
        const branches: Branch[] = [
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature/demo",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 1,
                behind: 0,
            },
            {
                name: "origin/feature/demo",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ];
        const onBranchAction = vi.fn();
        const { root, container } = mount(
            <BranchColumn
                branches={branches}
                selectedBranch={null}
                onSelectBranch={vi.fn()}
                onBranchAction={onBranchAction}
            />,
        );
        const localHeader = Array.from(container.querySelectorAll("div")).find((el) =>
            el.textContent?.trim() === "Local",
        ) as HTMLElement;
        act(() => {
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const remoteFolderHeader = Array.from(container.querySelectorAll("div")).find(
            (el) => el.textContent?.trim() === "origin",
        ) as HTMLElement;
        act(() => {
            remoteFolderHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const headRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("HEAD (main)"),
        ) as HTMLElement;
        // Force the no-icon fallback path so anchor math uses rowRect.left + 20.
        Object.defineProperty(headRow, "querySelector", {
            value: () => null,
            configurable: true,
        });
        act(() => {
            headRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 10,
                    clientY: 10,
                }),
            );
        });
        const rename = Array.from(document.querySelectorAll(".intelligit-context-item")).find((el) =>
            el.textContent?.includes("Rename"),
        ) as HTMLElement;
        act(() => {
            rename.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onBranchAction).toHaveBeenCalledWith("renameBranch", "main");

        const searchInput = container.querySelector(
            'input[placeholder="Search branches"]',
        ) as HTMLInputElement;
        act(() => {
            // React-controlled inputs in jsdom need the native value setter + input/change events.
            const valueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )?.set;
            valueSetter?.call(searchInput, "zzz-no-match");
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await flush();
        expect(container.textContent).toContain("No matching branches");

        unmount(root, container);
    });

    it("BranchColumn shows ahead/behind counts with push/pull colors", () => {
        const branches: Branch[] = [
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature-demo",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 2,
                behind: 3,
            },
        ];
        const { root, container } = mount(
            <BranchColumn
                branches={branches}
                selectedBranch={null}
                onSelectBranch={vi.fn()}
                onBranchAction={vi.fn()}
            />,
        );

        const branchRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("feature-demo"),
        ) as HTMLElement;
        expect(branchRow).toBeTruthy();

        const push = branchRow.querySelector(".branch-track-push") as HTMLElement;
        const pull = branchRow.querySelector(".branch-track-pull") as HTMLElement;
        expect(push?.textContent).toBe("\u2B062");
        expect(pull?.textContent).toBe("\u2B073");
        expect(push?.style.color).toBe("rgb(95, 156, 230)");
        expect(pull?.style.color).toBe("rgb(146, 86, 78)");
        expect(push?.getAttribute("title")).toContain("Ahead by 2 commits");
        expect(pull?.getAttribute("title")).toContain("Behind by 3 commits");

        unmount(root, container);
    });

    it("CommitList triggers context action and load-more", () => {
        const onCommitAction = vi.fn();
        const onLoadMore = vi.fn();
        const commits: Commit[] = [
            {
                hash: "aa11bb22",
                shortHash: "aa11bb22",
                message: "feat: commit list coverage",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: ["p1"],
                refs: [],
            },
        ];
        const { root, container } = mount(
            <CommitList
                commits={commits}
                selectedHash={null}
                filterText=""
                hasMore={true}
                unpushedHashes={new Set(["aa11bb22"])}
                defaultCheckoutBranch="main"
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={onLoadMore}
                onCommitAction={onCommitAction}
            />,
        );

        const row = Array.from(container.querySelectorAll("div")).find(
            (el) =>
                (el as HTMLDivElement).style.cursor === "pointer" &&
                el.textContent?.includes("feat: commit list coverage"),
        ) as HTMLElement;
        act(() => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        const action = Array.from(document.querySelectorAll(".intelligit-context-item")).find((el) =>
            el.textContent?.includes("Copy Revision Number"),
        ) as HTMLElement;
        act(() => {
            action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenCalledWith("copyRevision", "aa11bb22", undefined);

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
