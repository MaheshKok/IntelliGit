import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Branch, Commit } from "../../src/types";
import { renderHighlightedLabel } from "../../src/webviews/react/branch-column/highlight";
import { getBranchMenuItems } from "../../src/webviews/react/branch-column/menu";
import { buildPrefixTree, buildRemoteGroups } from "../../src/webviews/react/branch-column/treeModel";
import {
    BRANCH_ACTION_VALUES,
    COMMIT_ACTION_VALUES,
    isBranchAction,
    isCommitAction,
} from "../../src/webviews/react/commitGraphTypes";
import { getCommitMenuItems } from "../../src/webviews/react/commit-list/commitMenu";
import { buildFileTree, collectDirPaths, countFiles } from "../../src/webviews/react/shared/fileTree";

function makeBranch(overrides: Partial<Branch> = {}): Branch {
    return {
        name: "main",
        hash: "abc1234",
        isRemote: false,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

function makeCommit(overrides: Partial<Commit> = {}): Commit {
    return {
        hash: "abcdef1234567890",
        shortHash: "abcdef1",
        message: "feat: message",
        author: "Mahesh",
        email: "mahesh@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["1234abcd"],
        refs: [],
        ...overrides,
    };
}

describe("branch menu", () => {
    it("builds current-branch menu without delete and with push/rename actions", () => {
        const items = getBranchMenuItems(makeBranch({ isCurrent: true, name: "main" }), "main");
        const actions = items.filter((item) => !item.separator).map((item) => item.action);
        expect(actions).toContain("newBranchFrom");
        expect(actions).toContain("updateBranch");
        expect(actions).toContain("pushBranch");
        expect(actions).toContain("renameBranch");
        expect(actions).not.toContain("deleteBranch");
    });

    it("builds remote-branch menu with delete and without rename/push", () => {
        const items = getBranchMenuItems(
            makeBranch({ name: "origin/feature/test", isRemote: true }),
            "main",
        );
        const actions = items.filter((item) => !item.separator).map((item) => item.action);
        expect(actions).toContain("deleteBranch");
        expect(actions).not.toContain("pushBranch");
        expect(actions).not.toContain("renameBranch");
    });

    it("trims long branch names in menu labels", () => {
        const veryLong = "feature/super-long-branch-name-that-should-be-trimmed-in-menu";
        const items = getBranchMenuItems(makeBranch({ name: veryLong }), "main");
        const newBranchFrom = items.find((item) => item.action === "newBranchFrom");
        expect(newBranchFrom?.label).toContain("...");
    });
});

describe("tree model", () => {
    it("builds a prefix tree with folders and leaf branches", () => {
        const tree = buildPrefixTree([
            makeBranch({ name: "main" }),
            makeBranch({ name: "feature/ui/list" }),
            makeBranch({ name: "feature/api" }),
        ]);

        expect(tree.some((node) => node.branch?.name === "main")).toBe(true);
        const featureFolder = tree.find((node) => node.label === "feature");
        expect(featureFolder).toBeTruthy();
        expect(featureFolder?.children.length).toBeGreaterThan(0);
    });

    it("groups remotes and strips the matching group remote prefix", () => {
        const groups = buildRemoteGroups([
            makeBranch({ name: "origin/feature/a", isRemote: true, remote: "origin" }),
            makeBranch({ name: "upstream/main", isRemote: true, remote: "upstream" }),
        ]);

        expect(groups.has("origin")).toBe(true);
        expect(groups.has("upstream")).toBe(true);
        const originTree = groups.get("origin")?.tree ?? [];
        expect(originTree[0]?.label).toBe("feature");
    });

    it("falls back to stripping first segment when remote metadata differs from name", () => {
        const groups = buildRemoteGroups([
            makeBranch({ name: "origin/feature/x", isRemote: true, remote: "upstream" }),
        ]);
        const upstreamTree = groups.get("upstream")?.tree ?? [];
        expect(upstreamTree[0]?.label).toBe("feature");
    });
});

describe("highlight rendering", () => {
    it("returns plain label when search needle is empty", () => {
        expect(renderHighlightedLabel("feature/main", "")).toBe("feature/main");
    });

    it("highlights case-insensitive matches and escapes regex characters", () => {
        const node = React.createElement(
            React.Fragment,
            null,
            renderHighlightedLabel("feature/right+click", "RIGHT+"),
        );
        const html = renderToStaticMarkup(node);
        expect(html).toContain("<mark");
        expect(html.toLowerCase()).toContain("right+");
    });
});

describe("commit menu", () => {
    it("disables history-rewrite actions for pushed merge commits", () => {
        const mergeCommit = makeCommit({ parentHashes: ["a", "b"] });
        const items = getCommitMenuItems(mergeCommit, false, "main");
        const undo = items.find((item) => item.action === "undoCommit");
        const edit = items.find((item) => item.action === "editCommitMessage");
        const drop = items.find((item) => item.action === "dropCommit");
        const rebase = items.find((item) => item.action === "interactiveRebaseFromHere");
        expect(undo?.disabled).toBe(true);
        expect(edit?.disabled).toBe(true);
        expect(drop?.disabled).toBe(true);
        expect(rebase?.disabled).toBe(true);
    });

    it("enables actions for unpushed non-merge commits", () => {
        const items = getCommitMenuItems(makeCommit({ parentHashes: ["parent"] }), true, "main");
        const disabledActions = items
            .filter((item) => !item.separator && item.disabled)
            .map((item) => item.action);
        expect(disabledActions).toEqual([]);
    });

    it("disables checkout-main when no default branch is available", () => {
        const items = getCommitMenuItems(makeCommit(), true, null);
        const checkoutMain = items.find((item) => item.action === "checkoutMain");
        expect(checkoutMain?.disabled).toBe(true);
        expect(checkoutMain?.label).toBe("Checkout");
    });
});

describe("commit graph action typing guards", () => {
    it("accepts all known branch and commit actions", () => {
        for (const action of BRANCH_ACTION_VALUES) {
            expect(isBranchAction(action)).toBe(true);
        }
        for (const action of COMMIT_ACTION_VALUES) {
            expect(isCommitAction(action)).toBe(true);
        }
    });

    it("rejects unknown actions", () => {
        expect(isBranchAction("unknown")).toBe(false);
        expect(isCommitAction("unknown")).toBe(false);
    });
});

describe("shared file tree helpers", () => {
    const files = [
        { path: "src/index.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        { path: "src/utils/math.ts", status: "A", staged: false, additions: 3, deletions: 0 },
        { path: "README.md", status: "M", staged: false, additions: 0, deletions: 1 },
    ];

    it("builds nested folder/file structure", () => {
        const tree = buildFileTree(files);
        expect(tree.some((entry) => entry.type === "folder" && entry.name === "src")).toBe(true);
        expect(tree.some((entry) => entry.type === "file" && entry.file.path === "README.md")).toBe(
            true,
        );
    });

    it("handles root-level files without creating folder entries", () => {
        const rootOnly = [
            { path: "README.md", status: "M", staged: false, additions: 1, deletions: 0 },
            { path: "LICENSE", status: "A", staged: false, additions: 1, deletions: 0 },
        ];
        const tree = buildFileTree(rootOnly);
        expect(tree.every((entry) => entry.type === "file")).toBe(true);
        expect(collectDirPaths(tree)).toEqual([]);
        expect(countFiles(tree)).toBe(2);
    });

    it("collects directory paths recursively with accumulator support", () => {
        const tree = buildFileTree(files);
        const acc: string[] = ["existing"];
        const dirs = collectDirPaths(tree, acc);
        expect(dirs).toBe(acc);
        expect(dirs).toContain("existing");
        expect(dirs).toContain("src");
        expect(dirs).toContain("src/utils");
    });

    it("counts file leaves correctly", () => {
        const tree = buildFileTree(files);
        expect(countFiles(tree)).toBe(3);
    });
});
