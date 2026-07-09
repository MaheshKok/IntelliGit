// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, CommitChecksSnapshot, CommitDetail } from "../../../src/types";
import { BranchColumn } from "../../../src/webviews/react/BranchColumn";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { CommitRow } from "../../../src/webviews/react/commit-list/CommitRow";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { MAX_NONE_REFRESH_ATTEMPTS } from "../../../src/webviews/react/commit-list/checksRefresh";
import { useDragResize } from "../../../src/webviews/react/commit-panel/hooks/useDragResize";
import { ContextMenu } from "../../../src/webviews/react/shared/components/ContextMenu";
import {
    flush,
    initReactDomTestEnvironment,
    mount,
    unmount,
} from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

beforeEach(() => {
    installWebviewI18n();
});

describe("low coverage components", () => {
    it("CommitInfoPane shows aggregate changed-file stats in the header", () => {
        const detail: CommitDetail = {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "Update files",
            body: "",
            author: "Mahesh Kokare",
            email: "mahesh@example.com",
            date: "2026-07-08T12:00:00.000Z",
            parentHashes: [],
            refs: [],
            files: [
                { path: "src/a.ts", status: "M", additions: 2, deletions: 1 },
                { path: "README.md", status: "A", additions: 5, deletions: 0 },
            ],
        };

        const { root, container } = mount(<CommitInfoPane detail={detail} />);
        const changedFilesHeader = Array.from(container.querySelectorAll('[role="button"]')).find(
            (element) => element.textContent?.includes("Changed Files"),
        );

        expect(changedFilesHeader?.textContent).toContain("+7");
        expect(changedFilesHeader?.textContent).toContain("-1");

        unmount(root, container);
    });

    it("useDragResize clamps initial height to container bounds", () => {
        function Harness(): React.ReactElement {
            const ref = useRef<HTMLDivElement | null>(null);
            const { height } = useDragResize(220, 80, ref, {
                maxReservedHeight: 50,
            });
            return (
                <div
                    ref={(node) => {
                        if (node) {
                            Object.defineProperty(node, "clientHeight", {
                                value: 140,
                                configurable: true,
                            });
                        }
                        ref.current = node;
                    }}
                    data-host="1"
                >
                    <span data-height>{height}</span>
                </div>
            );
        }

        const { root, container } = mount(<Harness />);
        const heightText = container.querySelector("[data-height]")?.textContent ?? "";
        expect(Number(heightText)).toBe(90);

        unmount(root, container);
    });

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

    it("CommitRow renders compact ref count and handles row events", () => {
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

        const branchCount = container.querySelector('span[title="3 branch labels"]');
        expect(branchCount).toBeTruthy();
        expect(container.textContent).toContain("v1.0.0");
        const messageCell = container.querySelector(
            'span[title="feat: row coverage"]',
        ) as HTMLElement;
        expect(messageCell).toBeTruthy();
        const compactRefCell = container.querySelector("[data-commit-tooltip]") as HTMLElement;
        expect(compactRefCell?.getAttribute("data-commit-tooltip")).toContain(
            "Branches: HEAD -> main",
        );

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
        const localHeader = Array.from(container.querySelectorAll("button")).find(
            (el) => el.textContent?.trim() === "Local",
        ) as HTMLElement;
        act(() => {
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const remoteFolderHeader = Array.from(container.querySelectorAll("button")).find(
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
        const rename = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Rename"),
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

    it("BranchColumn persists and restores expansion/filter state", async () => {
        mockVscodeApi.getState.mockReturnValue({
            branchColumn: {
                branchFilter: "main",
                expandedSections: ["local"],
                expandedFolders: [],
            },
        });

        try {
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
                    name: "origin/main",
                    hash: "feed1234",
                    isRemote: true,
                    isCurrent: false,
                    remote: "origin",
                    ahead: 0,
                    behind: 0,
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
            await flush();

            const searchInput = container.querySelector(
                'input[placeholder="Search branches"]',
            ) as HTMLInputElement;
            expect(searchInput.value).toBe("main");
            expect(mockVscodeApi.setState).toHaveBeenCalledWith(
                expect.objectContaining({
                    branchColumn: expect.objectContaining({
                        branchFilter: "main",
                    }),
                }),
            );

            unmount(root, container);
        } finally {
            mockVscodeApi.getState.mockReturnValue(undefined);
            mockVscodeApi.setState.mockClear();
        }
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
        expect(push?.textContent).toBe("2");
        expect(pull?.textContent).toBe("3");
        expect(push.querySelector("svg")).toBeTruthy();
        expect(pull.querySelector("svg")).toBeTruthy();
        expect(push?.style.color).toBe(
            "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
        );
        expect(pull?.style.color).toBe(
            "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
        );
        const badge = branchRow.querySelector("[data-branch-tooltip]") as HTMLElement;
        expect(badge?.getAttribute("data-branch-tooltip")).toBe(
            "3 incoming commits and 2 outgoing commits",
        );

        unmount(root, container);
    });

    it("CommitList triggers context action, load-more, and visible check requests", async () => {
        const onCommitAction = vi.fn();
        const onLoadMore = vi.fn();
        const onRequestCommitChecks = vi.fn();
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
                selectedBranch="main"
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={onLoadMore}
                onCommitAction={onCommitAction}
                commitChecks={new Map()}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
            />,
        );
        await flush();
        expect(onRequestCommitChecks).toHaveBeenCalledWith("aa11bb22");

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
        const action = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Copy Revision Number"),
        ) as HTMLElement;
        act(() => {
            action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenCalledWith("copyRevision", "aa11bb22");

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

    it("CommitList retries visible pending check snapshots", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const commit: Commit = {
            hash: "aa11bb22",
            shortHash: "aa11bb22",
            message: "feat: pending checks",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["p1"],
            refs: [],
        };
        const pending: CommitChecksSnapshot = {
            hash: "aa11bb22",
            state: "pending",
            summary: "Checks pending",
            items: [],
        };
        const { root, container } = mount(
            <CommitList
                commits={[commit]}
                selectedHash={null}
                filterText=""
                hasMore={false}
                unpushedHashes={new Set()}
                selectedBranch={null}
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={vi.fn()}
                onCommitAction={vi.fn()}
                commitChecks={new Map([["aa11bb22", pending]])}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
            />,
        );
        await flush();
        expect(onRequestCommitChecks).not.toHaveBeenCalled();

        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(onRequestCommitChecks).toHaveBeenCalledWith("aa11bb22");
        unmount(root, container);
        vi.useRealTimers();
    });

    const noChecksCommit: Commit = {
        hash: "aa11bb22",
        shortHash: "aa11bb22",
        message: "feat: pushed, checks not registered yet",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["p1"],
        refs: [],
    };
    const noChecksSnapshot: CommitChecksSnapshot = {
        hash: "aa11bb22",
        state: "none",
        summary: "No checks found",
        items: [],
    };

    it("CommitList retries none-state checks for a pushed commit", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const { root, container } = mount(
            <CommitList
                commits={[noChecksCommit]}
                selectedHash={null}
                filterText=""
                hasMore={false}
                unpushedHashes={new Set()}
                selectedBranch={null}
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={vi.fn()}
                onCommitAction={vi.fn()}
                commitChecks={new Map([["aa11bb22", noChecksSnapshot]])}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
            />,
        );
        await flush();
        expect(onRequestCommitChecks).not.toHaveBeenCalled();

        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(onRequestCommitChecks).toHaveBeenCalledWith("aa11bb22");
        unmount(root, container);
        vi.useRealTimers();
    });

    it("CommitList does not retry none-state checks for an unpushed commit", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const { root, container } = mount(
            <CommitList
                commits={[noChecksCommit]}
                selectedHash={null}
                filterText=""
                hasMore={false}
                unpushedHashes={new Set(["aa11bb22"])}
                selectedBranch={null}
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={vi.fn()}
                onCommitAction={vi.fn()}
                commitChecks={new Map([["aa11bb22", noChecksSnapshot]])}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
            />,
        );
        await flush();
        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(onRequestCommitChecks).not.toHaveBeenCalled();
        unmount(root, container);
        vi.useRealTimers();
    });

    it("CommitList stops retrying none-state checks after the retry budget", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const renderTree = () => (
            <CommitList
                commits={[noChecksCommit]}
                selectedHash={null}
                filterText=""
                hasMore={false}
                unpushedHashes={new Set()}
                selectedBranch={null}
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={vi.fn()}
                onCommitAction={vi.fn()}
                commitChecks={new Map([["aa11bb22", noChecksSnapshot]])}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
            />
        );
        const { root, container } = mount(renderTree());
        // Each cycle fires one scheduled retry, then re-renders so the effect re-evaluates
        // the budget. One extra cycle proves polling stops once the budget is exhausted.
        for (let i = 0; i < MAX_NONE_REFRESH_ATTEMPTS + 1; i++) {
            await flush();
            act(() => {
                vi.runOnlyPendingTimers();
            });
            act(() => {
                root.render(renderTree());
            });
        }

        expect(onRequestCommitChecks).toHaveBeenCalledTimes(MAX_NONE_REFRESH_ATTEMPTS);
        unmount(root, container);
        vi.useRealTimers();
    });
});
