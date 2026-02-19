import type { Branch } from "../../../types";
import type { BranchAction } from "../commitGraphTypes";
import type { MenuItem } from "../shared/components/ContextMenu";

type SeparatorAction = `sep-${string}`;
type BranchMenuItem = Omit<MenuItem, "action"> & { action: BranchAction | SeparatorAction };

function trim(name: string, max = 40): string {
    if (name.length <= max) return name;
    const safeMax = Math.max(4, max);
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

export function getBranchMenuItems(branch: Branch, currentBranchName: string): BranchMenuItem[] {
    const current = quoted(currentBranchName);
    const selected = quoted(branch.name);

    if (branch.isCurrent) {
        return [
            { label: `New Branch from ${current}...`, action: "newBranchFrom" },
            separator("sep-current-1"),
            { label: "Update", action: "updateBranch" },
            { label: "Push...", action: "pushBranch" },
            separator("sep-current-2"),
            { label: "Rename...", action: "renameBranch" },
        ];
    }

    const nonCurrentBase: BranchMenuItem[] = [
        { label: "Checkout", action: "checkout" },
        { label: `New Branch from ${selected}...`, action: "newBranchFrom" },
        { label: `Checkout and Rebase onto ${current}`, action: "checkoutAndRebase" },
        separator("sep-shared-1"),
        { label: `Rebase ${current} onto ${selected}`, action: "rebaseCurrentOnto" },
        { label: `Merge ${selected} into ${current}`, action: "mergeIntoCurrent" },
        separator("sep-shared-2"),
        { label: "Update", action: "updateBranch" },
    ];

    if (branch.isRemote) {
        return [
            ...nonCurrentBase,
            separator("sep-remote-1"),
            { label: "Delete", action: "deleteBranch" },
        ];
    }

    return [
        ...nonCurrentBase,
        { label: "Push...", action: "pushBranch" },
        separator("sep-local-1"),
        { label: "Rename...", action: "renameBranch" },
        { label: "Delete", action: "deleteBranch" },
    ];
}
