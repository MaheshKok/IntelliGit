// @vitest-environment jsdom

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, GitWorktree, WorkingFile } from "../../../src/types";
import { BranchColumn } from "../../../src/webviews/react/BranchColumn";
import { FileTree } from "../../../src/webviews/react/commit-panel/components/FileTree";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { ContextMenu } from "../../../src/webviews/react/shared/components/ContextMenu";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockWebviewState = vi.hoisted(() => ({ current: undefined as unknown }));
const mockSetWebviewState = vi.hoisted(() =>
    vi.fn((state: unknown) => {
        mockWebviewState.current = state;
    }),
);

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => ({
        getState: () => mockWebviewState.current,
        setState: mockSetWebviewState,
        postMessage: vi.fn(),
    }),
}));

initReactDomTestEnvironment();

beforeEach(() => {
    mockWebviewState.current = undefined;
    mockSetWebviewState.mockClear();
    installWebviewI18n();
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
            name: "feature-one",
            hash: "def5678",
            isRemote: false,
            isCurrent: false,
            ahead: 2,
            behind: 1,
        },
        {
            name: "feature-two",
            hash: "987fedc",
            isRemote: false,
            isCurrent: false,
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/feature-one",
            hash: "def5678",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/remote-alpha",
            hash: "13579bd",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/remote-beta",
            hash: "2468ace",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
    ];

    function renderBranchColumn(options: { branches?: Branch[]; worktrees?: GitWorktree[] } = {}) {
        const onSelectBranch = vi.fn();
        const onBranchAction = vi.fn();
        const onDeleteBranches = vi.fn();
        const onWorktreeAction = vi.fn();
        const mounted = mount(
            <BranchColumn
                branches={options.branches ?? branches}
                worktrees={options.worktrees}
                selectedBranch={null}
                onSelectBranch={onSelectBranch}
                onBranchAction={onBranchAction}
                onDeleteBranches={onDeleteBranches}
                onWorktreeAction={onWorktreeAction}
            />,
        );
        return { ...mounted, onSelectBranch, onBranchAction, onDeleteBranches, onWorktreeAction };
    }

    function branchRow(container: HTMLElement, text: string): HTMLElement {
        const row = branchRows(container, text)[0];
        expect(row).toBeTruthy();
        return row;
    }

    function branchRows(container: HTMLElement, text: string): HTMLElement[] {
        return Array.from(container.querySelectorAll(".branch-row")).filter((candidate) =>
            candidate.textContent?.includes(text),
        ) as HTMLElement[];
    }

    function textElement(container: HTMLElement, text: string): HTMLElement {
        const element = Array.from(container.querySelectorAll<HTMLElement>("*")).find(
            (candidate) => candidate.textContent?.trim() === text,
        );
        if (!element) throw new Error(`Missing element containing ${text}`);
        return element;
    }

    function contextMenuItems(): HTMLElement[] {
        return Array.from(document.querySelectorAll(".intelligit-context-item")) as HTMLElement[];
    }

    it("filters branches and routes context menu actions", () => {
        const { root, container, onSelectBranch, onBranchAction } = renderBranchColumn();

        expect(container.textContent).toContain("HEAD (main)");

        const headRow = branchRow(container, "HEAD (main)");
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

        const renameItem = contextMenuItems().find((el) => el.textContent?.includes("Rename"));
        expect(renameItem).toBeTruthy();
        act(() => {
            renameItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onBranchAction).toHaveBeenCalledWith("renameBranch", "main");

        unmount(root, container);
    });

    it("keeps command-click branch selection separate from graph filtering", () => {
        const { root, container, onSelectBranch } = renderBranchColumn();
        const featureOne = branchRow(container, "feature-one");

        act(() => {
            featureOne.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });

        expect(onSelectBranch).not.toHaveBeenCalled();
        expect(featureOne.classList.contains("selected")).toBe(true);

        unmount(root, container);
    });

    it("clears branch row multi-selection on plain graph-filter clicks", () => {
        const { root, container, onSelectBranch } = renderBranchColumn();
        const featureOne = branchRow(container, "feature-one");
        const featureTwo = branchRow(container, "feature-two");

        act(() => {
            featureOne.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        expect(featureOne.classList.contains("selected")).toBe(true);

        act(() => {
            featureTwo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(onSelectBranch).toHaveBeenLastCalledWith("feature-two");
        expect(featureOne.classList.contains("selected")).toBe(false);

        unmount(root, container);
    });

    it("shows only the bulk delete branch action for selected branch context menus", () => {
        const { root, container, onBranchAction, onDeleteBranches } = renderBranchColumn();
        const featureOne = branchRow(container, "feature-one");
        const featureTwo = branchRow(container, "feature-two");

        act(() => {
            featureOne.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
            featureTwo.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        act(() => {
            featureTwo.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });

        const labels = contextMenuItems().map((item) => item.textContent?.trim());
        expect(labels).toEqual(["Delete Branches"]);

        act(() => {
            contextMenuItems()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onDeleteBranches).toHaveBeenCalledWith([branches[1], branches[2]]);
        expect(onBranchAction).not.toHaveBeenCalled();

        unmount(root, container);
    });

    it("supports command-click bulk delete selection for remote branch rows", () => {
        mockWebviewState.current = {
            branchColumn: {
                branchFilter: "",
                expandedSections: ["local", "remote"],
                expandedFolders: ["remote-origin"],
            },
        };
        const { root, container, onSelectBranch, onBranchAction, onDeleteBranches } =
            renderBranchColumn();
        const remoteAlpha = branchRow(container, "remote-alpha");
        const remoteBeta = branchRow(container, "remote-beta");

        act(() => {
            remoteAlpha.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
            remoteBeta.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        expect(onSelectBranch).not.toHaveBeenCalled();
        expect(remoteAlpha.classList.contains("selected")).toBe(true);
        expect(remoteBeta.classList.contains("selected")).toBe(true);

        act(() => {
            remoteBeta.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        const labels = contextMenuItems().map((item) => item.textContent?.trim());
        expect(labels).toEqual(["Delete Branches"]);

        act(() => {
            contextMenuItems()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onDeleteBranches).toHaveBeenCalledWith([branches[4], branches[5]]);
        expect(onBranchAction).not.toHaveBeenCalled();

        unmount(root, container);
    });

    it("renders worktrees below remote branches and opens rows by path", () => {
        const worktrees: GitWorktree[] = [
            {
                path: "/tmp/intelligit-feature",
                head: "abc1234",
                branch: "feature-one",
                state: "linked",
                isMain: false,
                isCurrent: false,
                isLocked: false,
                isPrunable: false,
            },
            {
                path: "/tmp/intelligit-locked",
                head: "def5678",
                branch: "locked-worktree",
                state: "linked",
                isMain: false,
                isCurrent: false,
                isLocked: true,
                isPrunable: false,
            },
        ];
        const { root, container, onWorktreeAction } = renderBranchColumn({ worktrees });
        const text = container.textContent ?? "";
        const remoteIndex = text.indexOf("Remote");
        const worktreesIndex = text.indexOf("Worktrees");
        expect(remoteIndex).toBeGreaterThanOrEqual(0);
        expect(worktreesIndex).toBeGreaterThanOrEqual(0);
        expect(remoteIndex).toBeLessThan(worktreesIndex);

        const row = container.querySelector(
            '[data-worktree-path="/tmp/intelligit-feature"]',
        ) as HTMLElement;
        expect(row).toBeTruthy();
        act(() => {
            row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onWorktreeAction).toHaveBeenCalledWith("open", "/tmp/intelligit-feature");

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
        const labels = contextMenuItems().map((item) => item.textContent?.trim());
        expect(labels).toEqual([
            "Open Worktree",
            "Delete Worktree",
            "Lock Worktree",
            "Move Worktree…",
        ]);

        const moveItem = contextMenuItems().find((item) => item.textContent?.includes("Move"));
        act(() => {
            moveItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onWorktreeAction).toHaveBeenCalledWith("move", "/tmp/intelligit-feature");

        const lockedRow = container.querySelector(
            '[data-worktree-path="/tmp/intelligit-locked"]',
        ) as HTMLElement;
        act(() => {
            lockedRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        const lockedLabels = contextMenuItems().map((item) => item.textContent?.trim());
        expect(lockedLabels).toEqual([
            "Open Worktree",
            "Delete Worktree",
            "Unlock Worktree",
            "Move Worktree…",
        ]);

        unmount(root, container);
    });

    it("shows the worktree icon only for the active worktree, not branch rows", () => {
        const worktreeBranches: Branch[] = [
            {
                name: "checked-out-here",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                isCheckedOutInWorktree: true,
                isCurrentWorktree: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "checked-out-there",
                hash: "def5678",
                isRemote: false,
                isCurrent: false,
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                ahead: 0,
                behind: 0,
            },
        ];
        const worktrees: GitWorktree[] = [
            {
                path: "/tmp/intelligit-current",
                head: "abc1234",
                branch: "checked-out-here",
                state: "linked",
                isMain: false,
                isCurrent: true,
                isLocked: false,
                isPrunable: false,
            },
            {
                path: "/tmp/intelligit-other",
                head: "def5678",
                branch: "checked-out-there",
                state: "linked",
                isMain: false,
                isCurrent: false,
                isLocked: false,
                isPrunable: false,
            },
        ];
        const { root, container } = renderBranchColumn({ branches: worktreeBranches, worktrees });

        for (const name of ["checked-out-here", "checked-out-there"]) {
            const row = branchRows(container, name).find(
                (candidate) => candidate.textContent === name,
            );
            expect(row?.querySelector("[aria-label]")).toBeNull();
        }
        expect(
            container.querySelector('[data-worktree-path="/tmp/intelligit-current"] svg'),
        ).toBeTruthy();
        expect(
            container.querySelector('[data-worktree-path="/tmp/intelligit-other"] svg'),
        ).toBeNull();

        unmount(root, container);
    });

    it("does not show a context menu for the active worktree", () => {
        const worktrees: GitWorktree[] = [
            {
                path: "/tmp/intelligit-current",
                head: "abc1234",
                branch: "main",
                state: "linked",
                isMain: false,
                isCurrent: true,
                isLocked: false,
                isPrunable: false,
            },
        ];
        const { root, container } = renderBranchColumn({ worktrees });
        const row = container.querySelector(
            '[data-worktree-path="/tmp/intelligit-current"]',
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
        expect(contextMenuItems()).toHaveLength(0);

        act(() => {
            row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" }));
        });
        expect(contextMenuItems()).toHaveLength(0);

        unmount(root, container);
    });
});

describe("CommitList integration", () => {
    const selectableCommits: Commit[] = [
        {
            hash: "aaa1111",
            shortHash: "aaa1111",
            message: "feat: head",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["bbb2222"],
            refs: ["HEAD -> main"],
        },
        {
            hash: "bbb2222",
            shortHash: "bbb2222",
            message: "feat: middle",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-18T00:00:00Z",
            parentHashes: ["ccc3333"],
            refs: [],
        },
        {
            hash: "ccc3333",
            shortHash: "ccc3333",
            message: "feat: oldest selected",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-17T00:00:00Z",
            parentHashes: ["ddd4444"],
            refs: [],
        },
        {
            hash: "ddd4444",
            shortHash: "ddd4444",
            message: "feat: outside selection",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-16T00:00:00Z",
            parentHashes: ["eee5555"],
            refs: [],
        },
    ];

    function commitRow(container: HTMLElement, message: string): HTMLElement {
        const row = Array.from(container.querySelectorAll<HTMLElement>(".commit-row")).find(
            (candidate) => candidate.textContent?.includes(message),
        );
        if (!row) throw new Error(`Missing commit row containing ${message}`);
        return row;
    }

    function commitMenuItem(label: string): HTMLElement {
        const item = Array.from(
            document.querySelectorAll<HTMLElement>(".intelligit-context-item"),
        ).find((candidate) => candidate.textContent?.includes(label));
        if (!item) throw new Error(`Missing commit menu item containing ${label}`);
        return item;
    }

    function renderSelectableCommits(
        options: {
            commits?: Commit[];
            currentBranchHeadHash?: string;
            initialSelectedHash?: string;
            unpushedHashes?: Set<string>;
        } = {},
    ) {
        const commits = options.commits ?? selectableCommits;
        const onSelectCommit = vi.fn();
        const onCommitAction = vi.fn();

        function StatefulCommitList(): React.ReactElement {
            const [selectedHash, setSelectedHash] = React.useState(
                options.initialSelectedHash ?? commits[0]?.hash ?? null,
            );
            return (
                <CommitList
                    commits={commits}
                    selectedHash={selectedHash}
                    filterText=""
                    hasMore={false}
                    unpushedHashes={
                        options.unpushedHashes ?? new Set(commits.map((commit) => commit.hash))
                    }
                    selectedBranch="main"
                    currentBranchName="main"
                    currentBranchHeadHash={
                        options.currentBranchHeadHash ?? commits[0]?.hash ?? null
                    }
                    onSelectCommit={(hash) => {
                        onSelectCommit(hash);
                        setSelectedHash(hash);
                    }}
                    onFilterText={vi.fn()}
                    onLoadMore={vi.fn()}
                    onCommitAction={onCommitAction}
                    showSearch={false}
                    showAuthorDate={false}
                />
            );
        }

        return { ...mount(<StatefulCommitList />), onSelectCommit, onCommitAction };
    }

    it("supports additive, anchored-range, plain, and keyboard commit selection", () => {
        const { root, container, onSelectCommit } = renderSelectableCommits();
        const head = commitRow(container, "feat: head");
        const middle = commitRow(container, "feat: middle");
        const oldest = commitRow(container, "feat: oldest selected");
        const outside = commitRow(container, "feat: outside selection");

        act(() => {
            middle.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        expect(head.getAttribute("aria-pressed")).toBe("true");
        expect(middle.getAttribute("aria-pressed")).toBe("true");
        expect(middle.getAttribute("aria-current")).toBe("true");
        expect(onSelectCommit).toHaveBeenLastCalledWith("bbb2222");

        act(() => {
            middle.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        expect(head.getAttribute("aria-pressed")).toBe("true");
        expect(middle.getAttribute("aria-pressed")).toBe("false");
        expect(head.getAttribute("aria-current")).toBe("true");
        expect(onSelectCommit).toHaveBeenLastCalledWith("aaa1111");

        act(() => {
            middle.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        });
        expect(head.getAttribute("aria-pressed")).toBe("true");
        expect(middle.getAttribute("aria-pressed")).toBe("true");

        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        expect([head, middle, oldest].map((row) => row.getAttribute("aria-pressed"))).toEqual([
            "true",
            "true",
            "true",
        ]);
        expect(outside.getAttribute("aria-pressed")).toBe("false");
        expect(oldest.getAttribute("aria-current")).toBe("true");

        act(() => {
            outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect([head, middle, oldest].map((row) => row.getAttribute("aria-pressed"))).toEqual([
            "false",
            "false",
            "false",
        ]);
        expect(outside.getAttribute("aria-pressed")).toBe("true");

        act(() => {
            outside.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        });
        expect(outside.getAttribute("aria-pressed")).toBe("true");

        act(() => {
            head.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
        });
        expect(head.getAttribute("aria-pressed")).toBe("true");
        expect(outside.getAttribute("aria-pressed")).toBe("false");

        unmount(root, container);
    });

    it("preserves a selected context group and squashes from its oldest commit", () => {
        const { root, container, onCommitAction } = renderSelectableCommits();
        const middle = commitRow(container, "feat: middle");
        const oldest = commitRow(container, "feat: oldest selected");

        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        act(() => {
            middle.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });

        const squash = commitMenuItem("Squash Commits");
        expect(squash.getAttribute("aria-disabled")).not.toBe("true");
        expect(middle.getAttribute("aria-pressed")).toBe("true");
        expect(oldest.getAttribute("aria-current")).toBe("true");
        act(() => {
            squash.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenCalledWith("squashCommits", "ccc3333");

        unmount(root, container);
    });

    it("enables a contiguous current-HEAD selection below a newer other-branch row", () => {
        const otherBranchCommit: Commit = {
            ...selectableCommits[0]!,
            hash: "zzz9999",
            shortHash: "zzz9999",
            message: "feat: newer on another branch",
            refs: ["other-branch"],
        };
        const { root, container, onCommitAction } = renderSelectableCommits({
            commits: [otherBranchCommit, ...selectableCommits],
            currentBranchHeadHash: "aaa1111",
            initialSelectedHash: "aaa1111",
        });
        const otherBranch = commitRow(container, "feat: newer on another branch");
        const middle = commitRow(container, "feat: middle");
        const oldest = commitRow(container, "feat: oldest selected");

        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        act(() => {
            middle.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });

        expect(otherBranch.getAttribute("aria-pressed")).toBe("false");
        const squash = commitMenuItem("Squash Commits");
        expect(squash.getAttribute("aria-disabled")).not.toBe("true");
        act(() => {
            squash.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenLastCalledWith("squashCommits", "ccc3333");

        unmount(root, container);
    });

    it("enables a modifier-selected parent chain across interleaved branch rows", () => {
        const interleavedCommit: Commit = {
            ...selectableCommits[1]!,
            hash: "xxx8888",
            shortHash: "xxx8888",
            message: "feat: unselected interleaved commit",
            parentHashes: ["yyy7777"],
            refs: ["other-branch"],
        };
        const { root, container, onCommitAction } = renderSelectableCommits({
            commits: [selectableCommits[0]!, interleavedCommit, ...selectableCommits.slice(1)],
            currentBranchHeadHash: "aaa1111",
            initialSelectedHash: "aaa1111",
        });
        const interleaved = commitRow(container, "feat: unselected interleaved commit");
        const middle = commitRow(container, "feat: middle");
        const oldest = commitRow(container, "feat: oldest selected");

        act(() => {
            middle.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
        });
        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        });
        act(() => {
            middle.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });

        expect(interleaved.getAttribute("aria-pressed")).toBe("false");
        const squash = commitMenuItem("Squash Commits");
        expect(squash.getAttribute("aria-disabled")).not.toBe("true");
        act(() => {
            squash.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenLastCalledWith("squashCommits", "ccc3333");

        unmount(root, container);
    });

    it("disables squash when a displayed selected row is not the prior commit's parent", () => {
        const interleavedCommit: Commit = {
            ...selectableCommits[1]!,
            hash: "xxx8888",
            shortHash: "xxx8888",
            message: "feat: interleaved other-branch commit",
            parentHashes: ["yyy7777"],
            refs: ["other-branch"],
        };
        const { root, container } = renderSelectableCommits({
            commits: [selectableCommits[0]!, interleavedCommit, ...selectableCommits.slice(1)],
            currentBranchHeadHash: "aaa1111",
            initialSelectedHash: "aaa1111",
        });
        const middle = commitRow(container, "feat: middle");
        const oldest = commitRow(container, "feat: oldest selected");

        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        act(() => {
            middle.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });

        expect(commitMenuItem("Squash Commits").getAttribute("aria-disabled")).toBe("true");
        unmount(root, container);
    });

    it.each([
        {
            name: "gapped",
            select: (rows: HTMLElement[]) =>
                rows[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })),
            commits: selectableCommits,
            unpushedHashes: new Set(selectableCommits.map((commit) => commit.hash)),
            contextIndex: 0,
        },
        {
            name: "off HEAD",
            select: (rows: HTMLElement[]) =>
                rows[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
            commits: selectableCommits,
            unpushedHashes: new Set(selectableCommits.map((commit) => commit.hash)),
            initialSelectedHash: "bbb2222",
            contextIndex: 1,
        },
        {
            name: "pushed",
            select: (rows: HTMLElement[]) =>
                rows[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
            commits: selectableCommits,
            unpushedHashes: new Set(["aaa1111", "ccc3333", "ddd4444"]),
            contextIndex: 0,
        },
        {
            name: "merge",
            select: (rows: HTMLElement[]) =>
                rows[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
            commits: [
                selectableCommits[0]!,
                { ...selectableCommits[1]!, parentHashes: ["ccc3333", "side9999"] },
                ...selectableCommits.slice(2),
            ],
            unpushedHashes: new Set(selectableCommits.map((commit) => commit.hash)),
            contextIndex: 0,
        },
    ])(
        "disables multi-row squash for a $name selection",
        ({ select, commits, unpushedHashes, initialSelectedHash, contextIndex }) => {
            const { root, container } = renderSelectableCommits({
                commits,
                unpushedHashes,
                initialSelectedHash,
            });
            const rows = Array.from(container.querySelectorAll<HTMLElement>(".commit-row"));

            act(() => {
                select(rows);
            });
            act(() => {
                rows[contextIndex]?.dispatchEvent(
                    new MouseEvent("contextmenu", {
                        bubbles: true,
                        cancelable: true,
                        clientX: 140,
                        clientY: 42,
                    }),
                );
            });

            expect(commitMenuItem("Squash Commits").getAttribute("aria-disabled")).toBe("true");
            unmount(root, container);
        },
    );

    it("collapses selection when opening an unselected row context menu", () => {
        const { root, container, onSelectCommit, onCommitAction } = renderSelectableCommits();
        const oldest = commitRow(container, "feat: oldest selected");
        const outside = commitRow(container, "feat: outside selection");

        act(() => {
            oldest.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        act(() => {
            outside.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 140,
                    clientY: 42,
                }),
            );
        });

        expect(outside.getAttribute("aria-pressed")).toBe("true");
        expect(oldest.getAttribute("aria-pressed")).toBe("false");
        expect(onSelectCommit).toHaveBeenLastCalledWith("ddd4444");
        const squash = commitMenuItem("Squash Commits");
        expect(squash.getAttribute("aria-disabled")).not.toBe("true");
        act(() => {
            squash.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenLastCalledWith("squashCommits", "ddd4444");

        unmount(root, container);
    });

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
                selectedBranch="main"
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
        expect(onCommitAction).toHaveBeenCalledWith("copyRevision", "aaa1111");

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

describe("FileTree drag-to-track integration", () => {
    const files: WorkingFile[] = [
        { path: "tracked.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        { path: "new-file.txt", status: "?", staged: false, additions: 0, deletions: 0 },
    ];

    function renderFileTree(checkedPaths = new Set<string>(), treeFiles = files) {
        const onTrackUnversionedFiles = vi.fn();
        const mounted = mount(
            <FileTree
                files={treeFiles}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={checkedPaths}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
                onTrackUnversionedFiles={onTrackUnversionedFiles}
            />,
        );
        return { ...mounted, onTrackUnversionedFiles };
    }

    function createDragDataTransfer() {
        const values = new Map<string, string>();
        let readable = true;
        const types: string[] = [];
        return {
            effectAllowed: "",
            dropEffect: "",
            types,
            setDragImage: vi.fn(),
            setReadable: (nextReadable: boolean) => {
                readable = nextReadable;
            },
            setData: vi.fn((type: string, value: string) => {
                if (!types.includes(type)) types.push(type);
                values.set(type, value);
            }),
            getData: vi.fn((type: string) => (readable ? (values.get(type) ?? "") : "")),
        };
    }

    function dispatchDrag(
        target: Element,
        type: string,
        dataTransfer: ReturnType<typeof createDragDataTransfer>,
    ) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        act(() => {
            target.dispatchEvent(event);
        });
        return event;
    }

    function textElement(container: HTMLElement, text: string): HTMLElement {
        const element = Array.from(container.querySelectorAll<HTMLElement>("*")).find((candidate) =>
            candidate.textContent?.includes(text),
        );
        if (!element) throw new Error(`Missing element containing ${text}`);
        return element;
    }

    it("only sends trackUnversionedFiles for valid unversioned drops onto Changes", () => {
        const { root, container, onTrackUnversionedFiles } = renderFileTree();
        const changesHeader = textElement(container, "Changes");

        const trackedTransfer = createDragDataTransfer();
        dispatchDrag(textElement(container, "tracked.ts"), "dragstart", trackedTransfer);
        dispatchDrag(changesHeader, "drop", trackedTransfer);
        expect(onTrackUnversionedFiles).not.toHaveBeenCalled();

        const unversionedTransfer = createDragDataTransfer();
        dispatchDrag(textElement(container, "new-file.txt"), "dragstart", unversionedTransfer);
        dispatchDrag(changesHeader, "drop", unversionedTransfer);
        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["new-file.txt"]);

        unmount(root, container);
    });

    function dispatchClick(
        target: Element,
        options: Pick<MouseEventInit, "metaKey" | "ctrlKey"> = {},
    ) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
        act(() => {
            target.dispatchEvent(event);
        });
        return event;
    }

    it("drags command-selected unversioned files with a count badge", () => {
        const onTrackUnversionedFiles = vi.fn();
        const { root, container } = mount(
            <FileTree
                files={[
                    ...files,
                    { path: "second.txt", status: "?", staged: false, additions: 0, deletions: 0 },
                ]}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
                onTrackUnversionedFiles={onTrackUnversionedFiles}
            />,
        );

        const transfer = createDragDataTransfer();
        dispatchClick(textElement(container, "new-file.txt"), { metaKey: true });
        dispatchClick(textElement(container, "second.txt"), { metaKey: true });
        dispatchDrag(textElement(container, "new-file.txt"), "dragstart", transfer);
        dispatchDrag(textElement(container, "Changes"), "drop", transfer);

        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["new-file.txt", "second.txt"]);
        const [dragImage] = transfer.setDragImage.mock.calls[0] ?? [];
        expect((dragImage as HTMLElement | undefined)?.textContent).toBe("2");
        unmount(root, container);
    });

    it("drags control-selected unversioned files on Windows and Linux", () => {
        const onTrackUnversionedFiles = vi.fn();
        const { root, container } = mount(
            <FileTree
                files={[
                    ...files,
                    { path: "second.txt", status: "?", staged: false, additions: 0, deletions: 0 },
                ]}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
                onTrackUnversionedFiles={onTrackUnversionedFiles}
            />,
        );

        const transfer = createDragDataTransfer();
        dispatchClick(textElement(container, "new-file.txt"), { ctrlKey: true });
        dispatchClick(textElement(container, "second.txt"), { ctrlKey: true });
        dispatchDrag(textElement(container, "second.txt"), "dragstart", transfer);
        dispatchDrag(textElement(container, "Changes"), "drop", transfer);

        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["new-file.txt", "second.txt"]);
        const [dragImage] = transfer.setDragImage.mock.calls[0] ?? [];
        expect((dragImage as HTMLElement | undefined)?.textContent).toBe("2");
        unmount(root, container);
    });

    it("does not use checked unversioned files as the drag selection", () => {
        const checkedPaths = new Set(["new-file.txt", "second.txt"]);
        const onTrackUnversionedFiles = vi.fn();
        const { root, container } = mount(
            <FileTree
                files={[
                    ...files,
                    { path: "second.txt", status: "?", staged: false, additions: 0, deletions: 0 },
                    { path: "third.txt", status: "?", staged: false, additions: 0, deletions: 0 },
                ]}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={checkedPaths}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
                onTrackUnversionedFiles={onTrackUnversionedFiles}
            />,
        );

        const transfer = createDragDataTransfer();
        dispatchDrag(textElement(container, "third.txt"), "dragstart", transfer);
        dispatchDrag(textElement(container, "Changes"), "drop", transfer);

        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["third.txt"]);
        expect(transfer.setDragImage).not.toHaveBeenCalled();
        unmount(root, container);
    });

    it("accepts dragover when Chromium hides custom drag data until drop", () => {
        const { root, container, onTrackUnversionedFiles } = renderFileTree();
        const changesHeader = textElement(container, "Changes");
        const transfer = createDragDataTransfer();

        dispatchDrag(textElement(container, "new-file.txt"), "dragstart", transfer);
        transfer.setReadable(false);
        const dragOver = dispatchDrag(changesHeader, "dragover", transfer);
        transfer.setReadable(true);
        dispatchDrag(changesHeader, "drop", transfer);

        expect(dragOver.defaultPrevented).toBe(true);
        expect(transfer.dropEffect).toBe("move");
        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["new-file.txt"]);
        unmount(root, container);
    });

    it("keeps Changes as a drop target when only unversioned files exist", () => {
        const { root, container, onTrackUnversionedFiles } = renderFileTree(new Set(), [
            { path: "new-only.txt", status: "?", staged: false, additions: 0, deletions: 0 },
        ]);
        const transfer = createDragDataTransfer();

        dispatchDrag(textElement(container, "new-only.txt"), "dragstart", transfer);
        dispatchDrag(textElement(container, "Changes"), "drop", transfer);

        expect(onTrackUnversionedFiles).toHaveBeenCalledWith(["new-only.txt"]);
        unmount(root, container);
    });
});
