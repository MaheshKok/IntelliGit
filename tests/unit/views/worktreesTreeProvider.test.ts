import { describe, expect, it, vi } from "vitest";
import type { GitWorktree } from "../../../src/types";
import { WorktreesTreeProvider } from "../../../src/views/WorktreesTreeProvider";
import type { WorktreeService } from "../../../src/services/worktreeService";

vi.mock("vscode", () => {
    /** EventEmitter mock used by WorktreesTreeProvider refresh assertions. */
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];
        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return { dispose: vi.fn() };
        };
        /** Emits tree-provider change events synchronously for provider assertions. */
        fire(event: T): void {
            for (const listener of this.listeners) listener(event);
        }
        /** Clears registered listeners between provider tests. */
        dispose(): void {
            this.listeners = [];
        }
    }
    /** TreeItem mock with only fields the provider writes in tests. */
    class TreeItem {
        description?: string;
        tooltip?: string;
        contextValue?: string;
        iconPath?: unknown;
        id?: string;
        constructor(
            public label: string,
            public collapsibleState: number,
        ) {}
    }
    /** ThemeIcon mock preserving icon ID and optional color for assertions. */
    class ThemeIcon {
        constructor(
            public id: string,
            public color?: unknown,
        ) {}
    }
    /** ThemeColor mock preserving VS Code color IDs for assertions. */
    class ThemeColor {
        constructor(public id: string) {}
    }
    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        ThemeColor,
        TreeItemCollapsibleState: { None: 0 },
        l10n: { t: (message: string) => message },
    };
});

const currentWorktree: GitWorktree = {
    path: "/repo",
    head: "1111111111111111111111111111111111111111",
    branch: "main",
    state: "main",
    isMain: true,
    isCurrent: true,
    isLocked: false,
    isPrunable: false,
};

const detachedWorktree: GitWorktree = {
    path: "/worktrees/linked one",
    head: "2222222222222222222222222222222222222222",
    branch: null,
    state: "detached",
    isMain: false,
    isCurrent: false,
    isLocked: true,
    lockedReason: "deploy freeze",
    isPrunable: true,
    prunableReason: "gone",
};

/** Creates a minimal worktree service stub for native tree-provider tests. */
function createService(worktrees: GitWorktree[]): WorktreeService {
    return {
        listWorktrees: vi.fn(async () => worktrees),
        refresh: vi.fn(async () => worktrees),
        onDidChangeWorktrees: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as WorktreeService;
}

describe("WorktreesTreeProvider", () => {
    it("maps worktrees to flat tree items with labels and status context", async () => {
        const provider = new WorktreesTreeProvider(createService([currentWorktree, detachedWorktree]));

        await expect(provider.getChildren()).resolves.toEqual([currentWorktree, detachedWorktree]);

        const currentItem = provider.getTreeItem(currentWorktree);
        expect(currentItem.label).toBe("main");
        expect(currentItem.description).toBe("repo");
        expect(currentItem.contextValue).toContain("current");

        const detachedItem = provider.getTreeItem(detachedWorktree);
        expect(detachedItem.label).toBe("2222222");
        expect(detachedItem.description).toBe("linked one");
        expect(detachedItem.contextValue).toContain("detached");
        expect(detachedItem.contextValue).toContain("locked");
        expect(detachedItem.contextValue).toContain("prunable");
        expect(detachedItem.contextValue).toContain("deletable");
        expect(detachedItem.contextValue).not.toContain("lockable");
        expect(
            provider.getTreeItem({
                ...detachedWorktree,
                isLocked: false,
                lockedReason: undefined,
                isPrunable: false,
                prunableReason: undefined,
            }).contextValue,
        ).toContain("lockable");
        expect(currentItem.contextValue).not.toContain("deletable");
    });

    it("refreshes through the service", async () => {
        const service = createService([currentWorktree]);
        const provider = new WorktreesTreeProvider(service);

        await provider.refresh();

        expect(service.refresh).toHaveBeenCalledTimes(1);
    });

    it("keeps the worktree list flat", async () => {
        const provider = new WorktreesTreeProvider(createService([]));

        await expect(provider.getChildren()).resolves.toEqual([]);
        await expect(provider.getChildren(currentWorktree)).resolves.toEqual([]);
    });
});
