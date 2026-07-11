import { createElement } from "react";

import type { Branch, GitWorktree } from "../../../types";
import type { BranchAction, WorktreeAction } from "../../protocol/commitGraphTypes";
import type { MenuItem } from "../shared/components/ContextMenu";
import { t } from "../shared/i18n";
import { resolveIconColor } from "../shared/settings";

/** Sentinel action namespace for visual separators in branch context menus. */
type SeparatorAction = `sep-${string}`;
/** Branch menu entry type that allows separators without widening executable actions. */
type BranchMenuItem = Omit<MenuItem, "action"> & { action: BranchAction | SeparatorAction };
/** Worktree menu entry type that allows separators without widening executable actions. */
type WorktreeMenuItem = Omit<MenuItem, "action"> & { action: WorktreeAction | SeparatorAction };

const STANDARD_MENU_ICON_COLOR = "var(--vscode-menu-foreground, var(--vscode-icon-foreground))";

/** Builds the branch menu pull icon from the commit panel's pull glyph. */
function pullBranchIcon() {
    return createElement(
        "svg",
        {
            width: "14",
            height: "14",
            viewBox: "0 0 16 16",
            "aria-hidden": true,
            style: { color: resolveIconColor("#8fd5ff", STANDARD_MENU_ICON_COLOR) },
        },
        createElement("path", {
            fill: "currentColor",
            d: "M7.5 1h1v8.1l2.15-2.15.7.7L8 11 4.65 7.65l.7-.7L7.5 9.1V1z",
        }),
        createElement("path", { fill: "currentColor", d: "M3 13h10v1H3v-1z" }),
    );
}

/** Builds the branch menu push icon from the commit panel's push glyph. */
function pushBranchIcon() {
    return createElement(
        "svg",
        {
            width: "14",
            height: "14",
            viewBox: "0 0 16 16",
            "aria-hidden": true,
            style: { color: resolveIconColor("#a6e3a1", STANDARD_MENU_ICON_COLOR) },
        },
        createElement("path", {
            fill: "currentColor",
            d: "M8 1l3.35 3.35-.7.7L8.5 2.9V11h-1V2.9L5.35 5.05l-.7-.7L8 1z",
        }),
        createElement("path", { fill: "currentColor", d: "M3 13h10v1H3v-1z" }),
    );
}

/** Shortens branch names for menu labels while preserving the distinguishing suffix. */
function trim(name: string, max = 40): string {
    if (name.length <= max) return name;
    // Keep output readable for tiny max values while never expanding beyond input length.
    const safeMax = Math.min(name.length, Math.max(4, max));
    const endLen = Math.min(8, Math.max(1, safeMax - 3));
    const startLen = Math.max(0, safeMax - 3 - endLen);
    return name.slice(0, startLen) + "..." + name.slice(-endLen);
}

/** Wraps compact branch labels in quotes for menu text that embeds another ref name. */
function quoted(name: string): string {
    return `'${trim(name)}'`;
}

/** Creates typed separator rows that cannot collide with executable branch actions. */
function separator(action: SeparatorAction): BranchMenuItem {
    return { label: "", action, separator: true };
}

/** Creates typed separator rows for worktree context menus. */
function worktreeSeparator(action: SeparatorAction): WorktreeMenuItem {
    return { label: "", action, separator: true };
}

/**
 * Builds the context-menu model for command/ctrl-selected branch rows.
 *
 * Bulk actions are intentionally kept outside `BranchAction` so single-branch
 * command validation cannot accidentally accept multi-branch payloads. The
 * returned items use action identifiers that the extension host recognizes
 * through the commit-graph webview protocol.
 */
export function getBulkBranchMenuItems(): MenuItem[] {
    return [{ label: t("branch.menu.deleteBranches"), action: "deleteBranches" }];
}

/** Builds the context-menu model for one worktree row using the native tree's capability rules. */
export function getWorktreeMenuItems(worktree: GitWorktree): WorktreeMenuItem[] {
    const items: WorktreeMenuItem[] = [
        { label: t("branch.menu.openWorktree"), action: "open", disabled: worktree.isCurrent },
    ];
    const canMutate = !worktree.isMain && !worktree.isCurrent;
    if (canMutate || worktree.isLocked) {
        items.push(worktreeSeparator("sep-worktree-open"));
    }
    if (canMutate) {
        items.push({ label: t("worktree.menu.delete"), action: "delete" });
    }
    if (worktree.isLocked) {
        items.push({ label: t("worktree.menu.unlock"), action: "unlock" });
    } else if (canMutate) {
        items.push({ label: t("worktree.menu.lock"), action: "lock" });
    }
    if (canMutate) {
        items.push({ label: t("worktree.menu.move"), action: "move" });
    }
    return items;
}

/**
 * Builds the context-menu model for a single branch row.
 *
 * Current branches show update/push/rename actions. Remote branches include
 * delete and omit push/rename. Local non-current branches expose the full set:
 * checkout, rebase, merge, update, push, rename, and delete. Labels are
 * localized while action IDs stay aligned with the extension protocol's
 * `BranchAction` union so the extension host can safely switch on them.
 */
export function getBranchMenuItems(branch: Branch, currentBranchName: string): BranchMenuItem[] {
    const current = quoted(currentBranchName);
    const selected = quoted(branch.name);
    const openWorktreeItems: BranchMenuItem[] =
        branch.isCheckedOutInWorktree && !branch.isCurrentWorktree && branch.worktreePath
            ? [
                  { label: t("branch.menu.openWorktree"), action: "openWorktree" },
                  separator("sep-worktree-1"),
              ]
            : [];
    const createWorktreeItems: BranchMenuItem[] = !branch.isCheckedOutInWorktree
        ? [
              separator("sep-worktree-create-1"),
              { label: t("branch.menu.createWorktree"), action: "createWorktreeFromBranch" },
          ]
        : [];

    if (branch.isCurrent) {
        return [
            { label: t("branch.menu.newBranchFrom", { branch: current }), action: "newBranchFrom" },
            separator("sep-current-1"),
            { label: t("branch.menu.update"), action: "updateBranch", icon: pullBranchIcon() },
            { label: t("branch.menu.push"), action: "pushBranch", icon: pushBranchIcon() },
            separator("sep-current-2"),
            { label: t("branch.menu.rename"), action: "renameBranch" },
        ];
    }

    const nonCurrentBase: BranchMenuItem[] = [
        ...openWorktreeItems,
        { label: t("branch.menu.checkout"), action: "checkout" },
        { label: t("branch.menu.newBranchFrom", { branch: selected }), action: "newBranchFrom" },
        {
            label: t("branch.menu.checkoutAndRebase", { branch: current }),
            action: "checkoutAndRebase",
        },
        separator("sep-shared-1"),
        {
            label: t("branch.menu.rebaseOnto", { current, selected }),
            action: "rebaseCurrentOnto",
        },
        {
            label: t("branch.menu.mergeInto", { selected, current }),
            action: "mergeIntoCurrent",
        },
        separator("sep-shared-2"),
        { label: t("branch.menu.update"), action: "updateBranch", icon: pullBranchIcon() },
    ];

    if (branch.isRemote) {
        return [
            ...nonCurrentBase,
            separator("sep-remote-1"),
            { label: t("branch.menu.delete"), action: "deleteBranch" },
            ...createWorktreeItems,
        ];
    }

    return [
        ...nonCurrentBase,
        { label: t("branch.menu.push"), action: "pushBranch", icon: pushBranchIcon() },
        separator("sep-local-1"),
        { label: t("branch.menu.rename"), action: "renameBranch" },
        { label: t("branch.menu.delete"), action: "deleteBranch" },
        ...createWorktreeItems,
    ];
}
