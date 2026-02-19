import type { Branch } from "../../../types";

export interface TreeNode {
    label: string;
    fullName?: string;
    branch?: Branch;
    children: TreeNode[];
}

export interface RemoteGroup {
    branches: Branch[];
    tree: TreeNode[];
}
