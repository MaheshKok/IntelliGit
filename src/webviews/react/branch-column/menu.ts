import type { Branch } from "../../../types";
import type { MenuItem } from "../shared/components/ContextMenu";

function trim(name: string, max = 40): string {
    if (name.length <= max) return name;
    const endLen = Math.min(8, name.length);
    const startLen = max - 3 - endLen;
    return name.slice(0, startLen) + "..." + name.slice(-endLen);
}

function quoted(name: string): string {
    return `'${trim(name)}'`;
}

function separator(action: string): MenuItem {
    return { label: "", action, separator: true };
}

export function getBranchMenuItems(branch: Branch, currentBranchName: string): MenuItem[] {
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

    const nonCurrentBase: MenuItem[] = [
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
