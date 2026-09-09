// @vitest-environment jsdom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { BranchColumnSections } from "../../../src/webviews/react/branch-column/BranchColumnSections";
import type { GitWorktree } from "../../../src/types";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();
installWebviewI18n();

const CURRENT: GitWorktree = {
    path: "/repo/worktrees/active",
    head: "a".repeat(40),
    branch: "active",
    state: "linked",
    isMain: false,
    isCurrent: true,
    isLocked: false,
    isPrunable: false,
};

const OTHER: GitWorktree = {
    ...CURRENT,
    path: "/repo/worktrees/other",
    branch: "other",
    isCurrent: false,
};

function renderWorktrees(): {
    container: HTMLDivElement;
    root: ReturnType<typeof mount>["root"];
    onWorktreeAction: ReturnType<typeof vi.fn>;
} {
    const onWorktreeAction = vi.fn();
    const view = mount(
        <BranchColumnSections
            selectedBranch={null}
            expandedSections={new Set(["worktrees"])}
            expandedFolders={new Set()}
            localTree={[]}
            remoteGroups={new Map()}
            worktrees={[CURRENT, OTHER]}
            filteredWorktrees={[CURRENT, OTHER]}
            filterNeedle=""
            locals={[]}
            remotes={[]}
            selectedBranchNames={new Set()}
            onSelectBranch={vi.fn()}
            onClearSelectedBranches={vi.fn()}
            onToggleSection={vi.fn()}
            onToggleFolder={vi.fn()}
            onBranchClick={vi.fn()}
            onBranchContextMenu={vi.fn()}
            onOpenBranchContextMenuFromRow={vi.fn()}
            onWorktreeAction={onWorktreeAction}
            onWorktreeContextMenu={vi.fn()}
            onOpenWorktreeContextMenuFromRow={vi.fn()}
        />,
    );
    return { ...view, onWorktreeAction };
}

function clickWorktree(container: HTMLDivElement, path: string): void {
    const row = container.querySelector<HTMLElement>(`[data-worktree-path="${path}"]`);
    if (!row) throw new Error(`No worktree row rendered for ${path}`);
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("worktree rows", () => {
    // `open` is what raises the "Open in Current Window / Open in New Window" picker. Offering
    // that for the worktree already open is a choice between reloading the window onto itself
    // and opening a second window onto the same folder (#150). The right-click and keyboard
    // menu handlers on this row already refuse for the current worktree; the click did not.
    it("does not raise the open action for the worktree already checked out", () => {
        const { container, root, onWorktreeAction } = renderWorktrees();
        try {
            clickWorktree(container, CURRENT.path);
            expect(
                onWorktreeAction,
                "clicking the active worktree asked which window to open it in",
            ).not.toHaveBeenCalled();
        } finally {
            unmount(root, container);
        }
    });

    // The control for the mutation above: without this, disabling the click outright would
    // still pass, and the section would become inert for every worktree.
    it("still opens another worktree on click", () => {
        const { container, root, onWorktreeAction } = renderWorktrees();
        try {
            clickWorktree(container, OTHER.path);
            expect(onWorktreeAction).toHaveBeenCalledWith("open", OTHER.path);
        } finally {
            unmount(root, container);
        }
    });
});
