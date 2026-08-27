// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, CommitChecksSnapshot, CommitDetail } from "../../../src/types";
import { GitHubRequestGate } from "../../../src/services/commitChecks/requestGate";
import { BranchColumn } from "../../../src/webviews/react/BranchColumn";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { ROW_HEIGHT } from "../../../src/webviews/react/graph";
import { CommitRow } from "../../../src/webviews/react/commit-list/CommitRow";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import {
    commitHashesMatch,
    HEAD_NONE_CHECK_RETRY_DELAYS_MS,
    MAX_COMMIT_CHECK_RETRIES_PER_HASH,
    PENDING_CHECK_RETRY_DELAYS_MS,
} from "../../../src/webviews/react/commit-list/checksRefresh";
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

    it("aligns Changed Files guides to the section and chevron centers", () => {
        const detail: CommitDetail = {
            hash: "guides123",
            shortHash: "guides1",
            message: "Guide alignment",
            body: "",
            author: "Mahesh Kokare",
            email: "mahesh@example.com",
            date: "2026-07-08T12:00:00.000Z",
            parentHashes: [],
            refs: [],
            files: [
                {
                    path: "src/nested/leaf.ts",
                    status: "M",
                    additions: 0,
                    deletions: 0,
                },
            ],
        };

        const { root, container } = mount(<CommitInfoPane detail={detail} />);
        const leaf = container.querySelector('[title="src/nested/leaf.ts"]') as HTMLElement;
        const guideOffsets = Array.from(leaf.querySelectorAll<HTMLElement>("span"))
            .filter((element) => getComputedStyle(element).position === "absolute")
            .map((element) => getComputedStyle(element).left);

        expect(guideOffsets).toEqual(["16px", "26px", "40px"]);

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
        expect(onRequestCommitChecks).toHaveBeenCalledWith(["aa11bb22"], false);

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

    it("CommitList requests checks only for the exact viewport", async () => {
        const onRequestCommitChecks = vi.fn();
        const commits: Commit[] = Array.from({ length: 30 }, (_, index) => ({
            hash: `hash-${index.toString().padStart(2, "0")}`,
            shortHash: `hash-${index.toString().padStart(2, "0")}`,
            message: `Commit ${index}`,
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
        }));
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * 3);

        try {
            const { root, container } = mount(
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
                    commitChecks={new Map()}
                    onRequestCommitChecks={onRequestCommitChecks}
                    onOpenCommitCheckUrl={vi.fn()}
                />,
            );
            await flush();
            onRequestCommitChecks.mockClear();

            const viewport = container.querySelector(
                '[data-testid="commit-list-viewport"]',
            ) as HTMLDivElement;
            Object.defineProperty(viewport, "scrollTop", {
                value: ROW_HEIGHT * 10,
                configurable: true,
            });
            act(() => {
                viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
            });
            await flush();

            expect(onRequestCommitChecks).toHaveBeenCalledTimes(1);
            expect(onRequestCommitChecks).toHaveBeenLastCalledWith(
                [commits[10].hash, commits[11].hash, commits[12].hash],
                false,
            );
            expect(onRequestCommitChecks.mock.calls.flatMap(([hashes]) => hashes)).not.toContain(
                commits[9].hash,
            );
            expect(onRequestCommitChecks.mock.calls.flatMap(([hashes]) => hashes)).not.toContain(
                commits[13].hash,
            );
            expect(onRequestCommitChecks.mock.calls).not.toContainEqual([[], false]);

            unmount(root, container);
            expect(onRequestCommitChecks).toHaveBeenLastCalledWith([], false);
            expect(onRequestCommitChecks).toHaveBeenCalledTimes(2);
        } finally {
            clientHeight.mockRestore();
        }
    });

    it("CommitList deduplicates exact-viewport check demand", async () => {
        const onRequestCommitChecks = vi.fn();
        const commits: Commit[] = ["duplicate-hash", "duplicate-hash", "unique-hash"].map(
            (hash, index) => ({
                hash,
                shortHash: hash,
                message: `Commit ${index}`,
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: [],
                refs: [],
            }),
        );
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * 3);
        const originalConsoleError = console.error;
        const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            if (String(args[0]).includes("Encountered two children with the same key")) return;
            originalConsoleError(...args);
        });

        try {
            const { root, container } = mount(
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
                    commitChecks={new Map()}
                    onRequestCommitChecks={onRequestCommitChecks}
                    onOpenCommitCheckUrl={vi.fn()}
                />,
            );
            await flush();

            expect(onRequestCommitChecks).toHaveBeenLastCalledWith(
                ["duplicate-hash", "unique-hash"],
                false,
            );

            unmount(root, container);
        } finally {
            consoleError.mockRestore();
            clientHeight.mockRestore();
        }
    });

    it("CommitList force-refreshes only the commit whose popover action was clicked", async () => {
        const onRequestCommitChecks = vi.fn();
        const commits: Commit[] = ["1111111", "2222222"].map((hash, index) => ({
            hash,
            shortHash: hash,
            message: `Commit ${index}`,
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
        }));
        const snapshots = new Map(
            commits.map((commit) => [
                commit.hash,
                {
                    hash: commit.hash,
                    state: "success" as const,
                    summary: "All checks passed",
                    items: [
                        {
                            name: "CI / build",
                            state: "success" as const,
                            source: "check-run" as const,
                        },
                    ],
                },
            ]),
        );
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * commits.length);
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
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
                    commitChecks={snapshots}
                    onRequestCommitChecks={onRequestCommitChecks}
                    onOpenCommitCheckUrl={vi.fn()}
                />,
            );
            await flush();
            expect(onRequestCommitChecks).toHaveBeenLastCalledWith(
                commits.map((commit) => commit.hash),
                false,
            );
            onRequestCommitChecks.mockClear();

            const trigger = mounted.container.querySelector(
                `[data-testid="commit-checks-button-${commits[0].hash}"]`,
            ) as HTMLButtonElement;
            act(() => trigger.click());
            const refreshButton = document.body.querySelector(
                'button[aria-label="Refresh"]',
            ) as HTMLButtonElement;
            expect(refreshButton).not.toBeNull();
            act(() => refreshButton.click());

            expect(onRequestCommitChecks.mock.calls).toEqual([[[commits[0].hash], true]]);
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            clientHeight.mockRestore();
        }
    });

    it("CommitList clears previous demand when check callbacks are disabled", async () => {
        const onRequestCommitChecks = vi.fn();
        const commit: Commit = {
            hash: "aa11bb22",
            shortHash: "aa11bb22",
            message: "feat: callback lifecycle",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
        };
        const renderTree = (
            callback?: (hashes: string[], force?: boolean) => void,
        ): React.ReactElement => (
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
                commitChecks={new Map()}
                onRequestCommitChecks={callback}
                onOpenCommitCheckUrl={vi.fn()}
            />
        );
        const { root, container } = mount(renderTree(onRequestCommitChecks));
        await flush();
        expect(onRequestCommitChecks).toHaveBeenLastCalledWith([commit.hash], false);
        onRequestCommitChecks.mockClear();

        act(() => {
            root.render(renderTree());
        });
        await flush();

        expect(onRequestCommitChecks.mock.calls).toEqual([[[], false]]);
        unmount(root, container);
        expect(onRequestCommitChecks).toHaveBeenCalledTimes(1);
    });

    const retryCommit: Commit = {
        hash: "aa11bb22",
        shortHash: "aa11bb22",
        message: "feat: bounded checks retry",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["p1"],
        refs: [],
    };

    const checksSnapshot = (
        hash: string,
        state: CommitChecksSnapshot["state"],
    ): CommitChecksSnapshot => ({
        hash,
        state,
        summary: `Checks ${state}`,
        items: [],
    });

    const renderRetryCommitList = (options: {
        commits?: Commit[];
        snapshots: CommitChecksSnapshot[];
        currentBranchHeadHash?: string | null;
        unpushedHashes?: Set<string>;
        onRequestCommitChecks: (hashes: string[], force?: boolean) => void;
    }): React.ReactElement => (
        <CommitList
            commits={options.commits ?? [retryCommit]}
            selectedHash={null}
            filterText=""
            hasMore={false}
            unpushedHashes={options.unpushedHashes ?? new Set()}
            selectedBranch={null}
            currentBranchHeadHash={options.currentBranchHeadHash}
            onSelectCommit={vi.fn()}
            onFilterText={vi.fn()}
            onLoadMore={vi.fn()}
            onCommitAction={vi.fn()}
            commitChecks={new Map(options.snapshots.map((snapshot) => [snapshot.hash, snapshot]))}
            onRequestCommitChecks={options.onRequestCommitChecks}
            onOpenCommitCheckUrl={vi.fn()}
        />
    );

    it("CommitList emits automatic current-HEAD none retry protocol across the bounded retry ladder", async () => {
        vi.useFakeTimers();
        const commits = Array.from({ length: 12 }, (_, index) => ({
            ...retryCommit,
            hash: index.toString(16).padStart(40, "0"),
            shortHash: index.toString(16).padStart(7, "0"),
        }));
        const head = commits[0].hash;
        const fetchJson = vi.fn(async (url: string) =>
            url.includes("/check-runs") ? { check_runs: [] } : [],
        );
        const gate = new GitHubRequestGate(4);
        const providerFetches: string[] = [];
        const cachedSnapshots = new Map<string, CommitChecksSnapshot>();
        const inFlightSnapshots = new Map<string, Promise<CommitChecksSnapshot>>();
        const snapshots: CommitChecksSnapshot[] = [];
        const requests: Promise<void>[] = [];
        const getSnapshot = async (hash: string, force: boolean | undefined) => {
            const cached = !force ? cachedSnapshots.get(hash) : undefined;
            if (cached) return cached;
            const inFlight = !force ? inFlightSnapshots.get(hash) : undefined;
            if (inFlight) return inFlight;
            const fetch = (async () => {
                providerFetches.push(hash);
                await Promise.all([
                    gate.run(() => fetchJson(`/check-runs/${hash}`, {})),
                    gate.run(() => fetchJson(`/statuses/${hash}`, {})),
                ]);
                const snapshot: CommitChecksSnapshot = {
                    hash,
                    state: "none",
                    summary: "No checks found",
                    items: [],
                };
                cachedSnapshots.set(hash, snapshot);
                return snapshot;
            })();
            if (!force) inFlightSnapshots.set(hash, fetch);
            try {
                return await fetch;
            } finally {
                if (!force) inFlightSnapshots.delete(hash);
            }
        };
        const onRequestCommitChecks = vi.fn((hashes: string[], force?: boolean) => {
            const request = Promise.all(
                hashes.map(async (hash) => {
                    snapshots.push(await getSnapshot(hash, force));
                }),
            ).then(() => undefined);
            requests.push(request);
        });
        const settleRequests = async (): Promise<void> => {
            await flush();
            await Promise.all(requests.splice(0));
            await flush();
        };
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * commits.length);
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    commits,
                    snapshots: commits.map((commit) => checksSnapshot(commit.hash, "none")),
                    currentBranchHeadHash: head,
                    onRequestCommitChecks,
                }),
            );
            await settleRequests();

            for (const delay of HEAD_NONE_CHECK_RETRY_DELAYS_MS) {
                act(() => vi.advanceTimersByTime(delay));
                await settleRequests();
            }

            expect(onRequestCommitChecks.mock.calls).toEqual([
                [[head], false],
                [commits.map((commit) => commit.hash), false],
                ...HEAD_NONE_CHECK_RETRY_DELAYS_MS.map(() => [[head], true]),
            ]);
            // This relay consumes the emitted protocol only. GitHub provider/HTTP totals are
            // asserted by the paired extension-host composition test.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            clientHeight.mockRestore();
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList emits automatic visible pending retries through the final 120-second delay", async () => {
        vi.useFakeTimers();
        const commits = Array.from({ length: 12 }, (_, index) => ({
            ...retryCommit,
            hash: (index + 16).toString(16).padStart(40, "0"),
            shortHash: (index + 16).toString(16).padStart(7, "0"),
        }));
        const fetchJson = vi.fn(async () => ({ check_runs: [] }));
        const gate = new GitHubRequestGate(4);
        const providerFetches: string[] = [];
        const cachedSnapshots = new Map<string, CommitChecksSnapshot>();
        const inFlightSnapshots = new Map<string, Promise<CommitChecksSnapshot>>();
        const snapshots: CommitChecksSnapshot[] = [];
        const requests: Promise<void>[] = [];
        const getSnapshot = async (hash: string, force: boolean | undefined) => {
            const cached = !force ? cachedSnapshots.get(hash) : undefined;
            if (cached) return cached;
            const inFlight = !force ? inFlightSnapshots.get(hash) : undefined;
            if (inFlight) return inFlight;
            const fetch = (async () => {
                providerFetches.push(hash);
                await Promise.all([
                    gate.run(() => fetchJson(`/check-runs/${hash}`, {})),
                    gate.run(() => fetchJson(`/statuses/${hash}`, {})),
                ]);
                const snapshot: CommitChecksSnapshot = {
                    hash,
                    state: "pending",
                    summary: "Checks pending",
                    items: [],
                };
                cachedSnapshots.set(hash, snapshot);
                return snapshot;
            })();
            if (!force) inFlightSnapshots.set(hash, fetch);
            try {
                return await fetch;
            } finally {
                if (!force) inFlightSnapshots.delete(hash);
            }
        };
        const onRequestCommitChecks = vi.fn((hashes: string[], force?: boolean) => {
            const request = Promise.all(
                hashes.map(async (hash) => snapshots.push(await getSnapshot(hash, force))),
            ).then(() => undefined);
            requests.push(request);
        });
        const settleRequests = async (): Promise<void> => {
            await flush();
            await Promise.all(requests.splice(0));
            await flush();
        };
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * commits.length);
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    commits,
                    snapshots: commits.map((commit) => checksSnapshot(commit.hash, "pending")),
                    onRequestCommitChecks,
                }),
            );
            await settleRequests();

            for (const delay of PENDING_CHECK_RETRY_DELAYS_MS) {
                act(() => vi.advanceTimersByTime(delay));
                await settleRequests();
            }

            expect(PENDING_CHECK_RETRY_DELAYS_MS.at(-1)).toBe(120_000);
            expect(onRequestCommitChecks.mock.calls.filter(([, force]) => force === true)).toEqual(
                PENDING_CHECK_RETRY_DELAYS_MS.map(() => [
                    commits.map((commit) => commit.hash),
                    true,
                ]),
            );
            expect(vi.getTimerCount()).toBe(0);

            const callsAfterFinalRetry = onRequestCommitChecks.mock.calls.length;
            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            await settleRequests();
            expect(onRequestCommitChecks).toHaveBeenCalledTimes(callsAfterFinalRetry);
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            clientHeight.mockRestore();
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList retries a visible pending snapshot at bounded cumulative intervals", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    snapshots: [checksSnapshot(retryCommit.hash, "pending")],
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            let cumulativeCalls = 0;
            for (const delay of PENDING_CHECK_RETRY_DELAYS_MS) {
                act(() => vi.advanceTimersByTime(delay));
                cumulativeCalls += 1;
                expect(onRequestCommitChecks.mock.calls).toEqual(
                    Array.from({ length: cumulativeCalls }, () => [[retryCommit.hash], true]),
                );
            }
            expect(vi.getTimerCount()).toBe(0);

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).toHaveBeenCalledTimes(
                PENDING_CHECK_RETRY_DELAYS_MS.length,
            );
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList bounds automatic retries per hash across a repeated pending/none state flap", async () => {
        // Reproduces the unbounded-polling defect: aggregateState can flap pending -> none
        // -> pending forever (e.g. one GitHub endpoint intermittently failing empties
        // `items` for a single poll), and both ladders in checksRefresh.ts open at rung 0.
        // A per-state attempt counter that resets on every flap re-arms rung 0 forever;
        // MAX_COMMIT_CHECK_RETRIES_PER_HASH must survive the resets and cut it off.
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const renderFlap = (state: CommitChecksSnapshot["state"]): React.ReactElement =>
            renderRetryCommitList({
                snapshots: [checksSnapshot(retryCommit.hash, state)],
                currentBranchHeadHash: retryCommit.hash,
                onRequestCommitChecks,
            });
        try {
            const { root, container } = mount(renderFlap("pending"));
            await flush();
            onRequestCommitChecks.mockClear();
            // Captured while a retry rung IS armed, so the exhaustion check below measures
            // the rung rather than whatever else the component happens to have scheduled.
            const timersWhileArmed = vi.getTimerCount();

            let state: CommitChecksSnapshot["state"] = "pending";
            // Drive well past the retry budget. Each round fires whatever retry is
            // currently armed, then flips the snapshot the way an intermittently
            // failing endpoint does, which is exactly the input that re-armed rung 0
            // forever pre-fix.
            const flapRounds = MAX_COMMIT_CHECK_RETRIES_PER_HASH + 5;
            for (let i = 0; i < flapRounds; i++) {
                const delay =
                    state === "pending"
                        ? PENDING_CHECK_RETRY_DELAYS_MS[0]
                        : HEAD_NONE_CHECK_RETRY_DELAYS_MS[0];
                act(() => vi.advanceTimersByTime(delay));
                state = state === "pending" ? "none" : "pending";
                act(() => {
                    root.render(renderFlap(state));
                });
            }

            const retryCallsForHash = onRequestCommitChecks.mock.calls.filter(
                ([hashes, force]) => force === true && hashes.includes(retryCommit.hash),
            );
            expect(retryCallsForHash).toHaveLength(MAX_COMMIT_CHECK_RETRIES_PER_HASH);

            // Advancing well past the last rung, through more flaps, must not re-arm
            // the loop: total survives the state resets, so the hash stays exhausted.
            onRequestCommitChecks.mockClear();
            for (let i = 0; i < 5; i++) {
                act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
                state = state === "pending" ? "none" : "pending";
                act(() => {
                    root.render(renderFlap(state));
                });
            }

            expect(
                onRequestCommitChecks.mock.calls.filter(
                    ([hashes, force]) => force === true && hashes.includes(retryCommit.hash),
                ),
            ).toHaveLength(0);

            // Pins the scheduling half of the bound, which suppressing the request alone
            // does not: an exhausted hash that still contributes its rung to nextDelay
            // leaves the component waking every three seconds forever with nothing to do.
            // Quieter than the original defect, but the same loop.
            expect(vi.getTimerCount()).toBe(timersWhileArmed - 1);

            unmount(root, container);
        } finally {
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not re-fire an exhausted hash riding another commit's retry rung", async () => {
        // The scheduler-loop exhaustion check only stops an exhausted hash from ARMING a
        // timer. Any other commit's rung still fires, and the fire loop selects on
        // `schedule[attempt.attempt] === dueDelay` -- so since both ladders open at the
        // same delay, an exhausted hash rides along on every coincidence unless the fire
        // loop checks exhaustion too. In a viewport of many commits that is most of them.
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const other: Commit = { ...retryCommit, hash: "cc33dd44", shortHash: "cc33dd44" };
        const renderPair = (
            headState: CommitChecksSnapshot["state"],
            withOther: boolean,
        ): React.ReactElement =>
            renderRetryCommitList({
                commits: withOther ? [retryCommit, other] : [retryCommit],
                snapshots: withOther
                    ? [
                          checksSnapshot(retryCommit.hash, headState),
                          checksSnapshot(other.hash, "pending"),
                      ]
                    : [checksSnapshot(retryCommit.hash, headState)],
                currentBranchHeadHash: retryCommit.hash,
                onRequestCommitChecks,
            });
        // jsdom reports clientHeight 0, which leaves the virtualizer with a viewport that
        // never reaches the second row -- so without this the other commit is never
        // requested at all and the test proves nothing.
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * 2);
        try {
            const { root, container } = mount(renderPair("pending", false));
            await flush();

            // Spend the HEAD commit's whole budget through the pending/none flap.
            let state: CommitChecksSnapshot["state"] = "pending";
            for (let round = 0; round < MAX_COMMIT_CHECK_RETRIES_PER_HASH; round++) {
                const delay =
                    state === "pending"
                        ? PENDING_CHECK_RETRY_DELAYS_MS[0]
                        : HEAD_NONE_CHECK_RETRY_DELAYS_MS[0];
                act(() => vi.advanceTimersByTime(delay));
                state = state === "pending" ? "none" : "pending";
                act(() => {
                    root.render(renderPair(state, false));
                });
            }
            onRequestCommitChecks.mockClear();

            // A second commit scrolls into the viewport and arms the opening rung that the
            // exhausted commit is no longer allowed to arm for itself.
            act(() => {
                root.render(renderPair(state, true));
            });
            await flush();
            onRequestCommitChecks.mockClear();
            act(() => vi.advanceTimersByTime(PENDING_CHECK_RETRY_DELAYS_MS[0]));

            const firedHashes = onRequestCommitChecks.mock.calls
                .filter(([, force]) => force === true)
                .flatMap(([hashes]) => hashes as string[]);
            expect(firedHashes).toEqual([other.hash]);

            unmount(root, container);
        } finally {
            clientHeight.mockRestore();
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not retry a pending snapshot outside the exact viewport", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const offscreenCommit = { ...retryCommit, hash: "offscreen", shortHash: "offscreen" };
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT);
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    commits: [retryCommit, offscreenCommit],
                    snapshots: [checksSnapshot(offscreenCommit.hash, "pending")],
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).not.toHaveBeenCalled();
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            clientHeight.mockRestore();
            vi.useRealTimers();
        }
    });

    it("CommitList clears demand and disarms retries when the host reports hidden", async () => {
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
        const renderTree = (isViewVisible: boolean): React.ReactElement => (
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
                commitChecks={new Map([[commit.hash, pending]])}
                onRequestCommitChecks={onRequestCommitChecks}
                onOpenCommitCheckUrl={vi.fn()}
                isViewVisible={isViewVisible}
            />
        );

        try {
            // Visible mount posts demand for the viewport and arms a pending retry timer.
            const { root, container } = mount(renderTree(true));
            await flush();
            expect(onRequestCommitChecks).toHaveBeenLastCalledWith([commit.hash], false);
            onRequestCommitChecks.mockClear();

            // Host reports the surface hidden: demand is withheld (posts []) and the
            // pending retry timer is disarmed so no hidden demand is ever published.
            act(() => {
                root.render(renderTree(false));
            });
            await flush();
            act(() => {
                vi.runOnlyPendingTimers();
            });

            expect(onRequestCommitChecks.mock.calls).toEqual([[[], false]]);

            unmount(root, container);
        } finally {
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList retries none only for the visible current HEAD", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    snapshots: [checksSnapshot(retryCommit.hash, "none")],
                    currentBranchHeadHash: retryCommit.hash,
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            let cumulativeCalls = 0;
            for (const delay of HEAD_NONE_CHECK_RETRY_DELAYS_MS) {
                act(() => vi.advanceTimersByTime(delay));
                cumulativeCalls += 1;
                expect(onRequestCommitChecks.mock.calls).toEqual(
                    Array.from({ length: cumulativeCalls }, () => [[retryCommit.hash], true]),
                );
            }
            expect(vi.getTimerCount()).toBe(0);

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).toHaveBeenCalledTimes(
                HEAD_NONE_CHECK_RETRY_DELAYS_MS.length,
            );
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList matches an abbreviated current HEAD to a full commit hash", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const fullHash = "c61d044fd4aa852166c3c385fbf31aed980967cf";
        const commit = { ...retryCommit, hash: fullHash, shortHash: fullHash.slice(0, 7) };
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            expect(commitHashesMatch(fullHash, fullHash.slice(0, 1))).toBe(false);
            mounted = mount(
                renderRetryCommitList({
                    commits: [commit],
                    snapshots: [checksSnapshot(fullHash, "none")],
                    currentBranchHeadHash: commit.shortHash,
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            let cumulativeCalls = 0;
            for (const delay of HEAD_NONE_CHECK_RETRY_DELAYS_MS) {
                act(() => vi.advanceTimersByTime(delay));
                cumulativeCalls += 1;
                expect(onRequestCommitChecks.mock.calls).toEqual(
                    Array.from({ length: cumulativeCalls }, () => [[fullHash], true]),
                );
            }
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not retry none for a non-HEAD commit", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    snapshots: [checksSnapshot(retryCommit.hash, "none")],
                    currentBranchHeadHash: "different-head",
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).not.toHaveBeenCalled();
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not retry none for an unpushed current HEAD", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    snapshots: [checksSnapshot(retryCommit.hash, "none")],
                    currentBranchHeadHash: retryCommit.hash,
                    unpushedHashes: new Set([retryCommit.hash]),
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).not.toHaveBeenCalled();
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not retry unavailable snapshots", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    snapshots: [checksSnapshot(retryCommit.hash, "unavailable")],
                    currentBranchHeadHash: retryCommit.hash,
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).not.toHaveBeenCalled();
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            vi.useRealTimers();
        }
    });

    it("CommitList does not retry terminal snapshots", async () => {
        vi.useFakeTimers();
        const onRequestCommitChecks = vi.fn();
        const commits = (["success", "failure", "skipped"] as const).map((state) => ({
            ...retryCommit,
            hash: state,
            shortHash: state,
        }));
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(ROW_HEIGHT * commits.length);
        let mounted: ReturnType<typeof mount> | undefined;
        try {
            mounted = mount(
                renderRetryCommitList({
                    commits,
                    snapshots: commits.map((commit) =>
                        checksSnapshot(commit.hash, commit.hash as CommitChecksSnapshot["state"]),
                    ),
                    currentBranchHeadHash: commits[0].hash,
                    onRequestCommitChecks,
                }),
            );
            await flush();
            onRequestCommitChecks.mockClear();

            act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
            expect(onRequestCommitChecks).not.toHaveBeenCalled();
        } finally {
            if (mounted) unmount(mounted.root, mounted.container);
            act(() => vi.runOnlyPendingTimers());
            clientHeight.mockRestore();
            vi.useRealTimers();
        }
    });
});
