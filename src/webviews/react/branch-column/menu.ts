import type { Branch } from "../../../types";
import type { BranchAction } from "../../protocol/commitGraphTypes";
import type { MenuItem } from "../shared/components/ContextMenu";
import { t } from "../shared/i18n";

type SeparatorAction = `sep-${string}`;
type BranchMenuItem = Omit<MenuItem, "action"> & { action: BranchAction | SeparatorAction };

function trim(name: string, max = 40): string {
    if (name.length <= max) return name;
    // Keep output readable for tiny max values while never expanding beyond input length.
    const safeMax = Math.min(name.length, Math.max(4, max));
    const endLen = Math.min(8, Math.max(1, safeMax - 3));
    const startLen = Math.max(0, safeMax - 3 - endLen);
    return name.slice(0, startLen) + "..." + name.slice(-endLen);
}

function quoted(name: string): string {
    return `'${trim(name)}'`;
}

function separator(action: SeparatorAction): BranchMenuItem {
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
              { label: t("branch.menu.createWorktree"), action: "createWorktreeFromBranch" },
              separator("sep-worktree-create-1"),
          ]
        : [];

    if (branch.isCurrent) {
        return [
            { label: t("branch.menu.newBranchFrom", { branch: current }), action: "newBranchFrom" },
            separator("sep-current-1"),
            { label: t("branch.menu.update"), action: "updateBranch" },
            { label: t("branch.menu.push"), action: "pushBranch" },
            separator("sep-current-2"),
            { label: t("branch.menu.rename"), action: "renameBranch" },
        ];
    }

    const nonCurrentBase: BranchMenuItem[] = [
        ...openWorktreeItems,
        ...createWorktreeItems,
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
        { label: t("branch.menu.update"), action: "updateBranch" },
    ];

    if (branch.isRemote) {
        return [
            ...nonCurrentBase,
            separator("sep-remote-1"),
            { label: t("branch.menu.delete"), action: "deleteBranch" },
        ];
    }

    return [
        ...nonCurrentBase,
        { label: t("branch.menu.push"), action: "pushBranch" },
        separator("sep-local-1"),
        { label: t("branch.menu.rename"), action: "renameBranch" },
        { label: t("branch.menu.delete"), action: "deleteBranch" },
    ];
}
