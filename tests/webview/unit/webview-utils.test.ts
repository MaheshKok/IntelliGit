import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Branch, Commit } from "../../../src/types";
import { renderHighlightedLabel } from "../../../src/webviews/react/branch-column/highlight";
import { getBranchMenuItems } from "../../../src/webviews/react/branch-column/menu";
import {
    buildPrefixTree,
    buildRemoteGroups,
} from "../../../src/webviews/react/branch-column/treeModel";
import {
    BRANCH_ACTION_VALUES,
    COMMIT_ACTION_VALUES,
    isBranchAction,
    isCommitAction,
} from "../../../src/webviews/protocol/commitGraphTypes";
import { canCherryPickFromBranchScope } from "../../../src/webviews/react/CommitList";
import { getCommitMenuItems } from "../../../src/webviews/react/commit-list/commitMenu";
import {
    buildFileTree,
    collectDirPaths,
    countFiles,
} from "../../../src/webviews/react/shared/fileTree";

/** Builds a branch fixture for menu and branch-scope utility tests. */
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

/** Builds a commit fixture with a realistic parent/ref shape for menu tests. */
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

    it("shows Open Worktree only for branches checked out in another worktree", () => {
        const checkedOutElsewhere = getBranchMenuItems(
            makeBranch({
                name: "feature/worktree",
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                worktreePath: "/repo-feature",
            }),
            "main",
        )
            .filter((item) => !item.separator)
            .map((item) => item.action);
        const checkedOutHere = getBranchMenuItems(
            makeBranch({
                name: "main",
                isCurrent: true,
                isCheckedOutInWorktree: true,
                isCurrentWorktree: true,
                worktreePath: "/repo",
            }),
            "main",
        )
            .filter((item) => !item.separator)
            .map((item) => item.action);

        expect(checkedOutElsewhere[0]).toBe("openWorktree");
        expect(checkedOutHere).not.toContain("openWorktree");
    });

    it("shows Create Worktree only for branches not already checked out in a worktree", () => {
        const freeBranch = getBranchMenuItems(makeBranch({ name: "feature/free" }), "main")
            .filter((item) => !item.separator)
            .map((item) => item.action);
        const checkedOutElsewhere = getBranchMenuItems(
            makeBranch({
                name: "feature/worktree",
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                worktreePath: "/repo-feature",
            }),
            "main",
        )
            .filter((item) => !item.separator)
            .map((item) => item.action);

        expect(freeBranch).toContain("createWorktreeFromBranch");
        expect(checkedOutElsewhere).not.toContain("createWorktreeFromBranch");
    });

    it("trims long branch names in menu labels", () => {
        const veryLong = "feature/super-long-branch-name-that-should-be-trimmed-in-menu";
        const items = getBranchMenuItems(makeBranch({ name: veryLong }), "main");
        const newBranchFrom = items.find((item) => item.action === "newBranchFrom");
        expect(newBranchFrom?.label).not.toContain(veryLong);
        const untrimmedLabel = `New Branch from '${veryLong}'...`;
        expect((newBranchFrom?.label ?? "").length).toBeLessThan(untrimmedLabel.length);
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

    it("pins defaults and sorts branch folders by current branch then chronology", () => {
        const tree = buildPrefixTree([
            makeBranch({ name: "codex/older", committerDate: 10 }),
            makeBranch({ name: "codex/newer", committerDate: 30 }),
            makeBranch({ name: "main", isDefault: true, committerDate: 20 }),
            makeBranch({ name: "codex/current", isCurrent: true, committerDate: 15 }),
        ]);

        expect(tree[0]?.label).toBe("main");
        const codexFolder = tree.find((node) => node.label === "codex");
        expect(codexFolder?.children.map((child) => child.label)).toEqual([
            "current",
            "newer",
            "older",
        ]);
    });

    it("does not promote a folder because a child branch is current", () => {
        const tree = buildPrefixTree([
            makeBranch({ name: "codex/current", isCurrent: true, committerDate: 10 }),
            makeBranch({ name: "feature/newer", committerDate: 30 }),
        ]);

        expect(tree.map((node) => node.label)).toEqual(["feature", "codex"]);
        expect(tree.find((node) => node.label === "codex")?.children[0]?.label).toBe("current");
    });

    it("pins remote default branches at the top of each remote group", () => {
        const groups = buildRemoteGroups([
            makeBranch({
                name: "origin/codex/newer",
                isRemote: true,
                remote: "origin",
                committerDate: 30,
            }),
            makeBranch({
                name: "origin/main",
                isRemote: true,
                remote: "origin",
                isDefault: true,
                committerDate: 20,
            }),
            makeBranch({
                name: "origin/codex/current",
                isRemote: true,
                remote: "origin",
                isCurrent: true,
                committerDate: 10,
            }),
        ]);

        const originTree = groups.get("origin")?.tree ?? [];
        expect(originTree[0]?.label).toBe("main");
        expect(originTree.find((node) => node.label === "codex")?.children[0]?.label).toBe(
            "current",
        );
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
        const items = getCommitMenuItems(mergeCommit, false, false);
        const pushUpToHere = items.find((item) => item.action === "pushAllUpToHere");
        const undo = items.find((item) => item.action === "undoCommit");
        const edit = items.find((item) => item.action === "editCommitMessage");
        const squash = items.find((item) => item.action === "squashCommits");
        const drop = items.find((item) => item.action === "dropCommit");
        const rebase = items.find((item) => item.action === "interactiveRebaseFromHere");
        expect(pushUpToHere?.disabled).toBe(true);
        expect(undo?.disabled).toBe(true);
        expect(edit?.disabled).toBe(true);
        expect(squash?.disabled).toBe(true);
        expect(drop?.disabled).toBe(true);
        expect(rebase?.disabled).toBe(true);
    });

    it("enables actions for unpushed non-merge commits", () => {
        const items = getCommitMenuItems(makeCommit({ parentHashes: ["parent"] }), true, true);
        const disabledActions = items
            .filter((item) => !item.separator && item.disabled)
            .map((item) => item.action);
        expect(disabledActions).toEqual([]);
    });

    it("keeps checkout revision action in commit menu", () => {
        const items = getCommitMenuItems(makeCommit(), true, false);
        const checkoutRevision = items.find((item) => item.action === "checkoutRevision");
        const pushUpToHere = items.find((item) => item.action === "pushAllUpToHere");
        const squash = items.find((item) => item.action === "squashCommits");
        expect(checkoutRevision).toBeDefined();
        expect(pushUpToHere).toBeDefined();
        expect(squash).toBeDefined();
        expect(items.some((item) => item.action === "checkoutMain")).toBe(false);
    });

    it("only enables cherry-pick when the selected graph scope can be cherry-picked", () => {
        const disabledItems = getCommitMenuItems(makeCommit(), true, false);
        const enabledItems = getCommitMenuItems(makeCommit(), true, true);

        expect(disabledItems.find((item) => item.action === "cherryPick")?.disabled).toBe(true);
        expect(enabledItems.find((item) => item.action === "cherryPick")?.disabled).toBe(false);
    });

    it("allows cherry-pick only when viewing a non-current branch scope", () => {
        expect(canCherryPickFromBranchScope(null, "main")).toBe(false);
        expect(canCherryPickFromBranchScope("main", "main")).toBe(false);
        expect(canCherryPickFromBranchScope("feature/work", "main")).toBe(true);
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
