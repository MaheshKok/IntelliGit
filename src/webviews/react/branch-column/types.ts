import type { Branch } from "../../../types";

/**
 * Node in the branch prefix tree used by the branch column.
 *
 * Folder nodes omit `branch` and carry children only; leaf nodes include the
 * original branch plus the full backend branch name for stable command routing.
 */
export interface TreeNode {
    label: string;
    fullName?: string;
    branch?: Branch;
    children: TreeNode[];
}

/** Remote branch group with both flat and prefix-tree representations. */
export interface RemoteGroup {
    branches: Branch[];
    tree: TreeNode[];
}
