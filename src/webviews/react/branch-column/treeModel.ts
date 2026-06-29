import type { Branch } from "../../../types";
import type { RemoteGroup, TreeNode } from "./types";

/**
 * Builds a slash-delimited prefix tree for branch names.
 *
 * The optional mapper can strip a remote prefix or otherwise change only the
 * displayed path; leaf nodes still retain the original branch name for commands.
 */
export function buildPrefixTree(
    branches: Branch[],
    nameMapper?: (b: Branch) => string,
): TreeNode[] {
    const root: TreeNode[] = [];

    for (const branch of branches) {
        const displayName = nameMapper ? nameMapper(branch) : branch.name;
        const parts = displayName.split("/");

        if (parts.length === 1) {
            root.push({ label: displayName, fullName: branch.name, branch, children: [] });
            continue;
        }

        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLeaf = i === parts.length - 1;
            if (isLeaf) {
                current.push({ label: part, fullName: branch.name, branch, children: [] });
                continue;
            }
            // Path sibling counts are small and insertion order is the tree order contract.
            // react-doctor-disable-next-line react-doctor/js-index-maps
            let folder = current.find((n) => n.label === part && !n.branch);
            if (!folder) {
                folder = { label: part, children: [] };
                current.push(folder);
            }
            current = folder.children;
        }
    }

    sortBranchTree(root);
    return root;
}

/**
 * Groups remote branches by remote name and builds display trees without remote prefixes.
 *
 * The resulting map preserves first-seen remote ordering, which keeps branch
 * column sections stable across refreshes when Git returns branches consistently.
 */
export function buildRemoteGroups(remotes: Branch[]): Map<string, RemoteGroup> {
    const groups = new Map<string, RemoteGroup>();
    for (const branch of remotes) {
        const remote = branch.remote ?? branch.name.split("/")[0];
        if (!groups.has(remote)) {
            groups.set(remote, { branches: [], tree: [] });
        }
        groups.get(remote)!.branches.push(branch);
    }

    for (const [remote, group] of groups) {
        const remotePrefix = `${remote}/`;
        const stripRemote = (b: Branch): string => {
            if (b.name.startsWith(remotePrefix)) {
                return b.name.slice(remotePrefix.length);
            }
            const firstSlash = b.name.indexOf("/");
            return firstSlash >= 0 ? b.name.slice(firstSlash + 1) : b.name;
        };
        group.tree = buildPrefixTree(group.branches, stripRemote);
    }

    return groups;
}

interface TreeSortMeta {
    isDefault: boolean;
    isCurrent: boolean;
    newestCommitterDate?: number;
}

function getTreeSortMeta(node: TreeNode): TreeSortMeta {
    const childMeta = node.children.map(getTreeSortMeta);
    const branchDate = node.branch?.committerDate;
    const childDates = childMeta
        .map((meta) => meta.newestCommitterDate)
        .filter((date): date is number => date !== undefined);
    const dates = branchDate === undefined ? childDates : [branchDate, ...childDates];
    return {
        isDefault: node.branch?.isDefault === true || childMeta.some((meta) => meta.isDefault),
        isCurrent: node.branch?.isCurrent === true,
        newestCommitterDate: dates.length > 0 ? Math.max(...dates) : undefined,
    };
}

function compareTreeNodes(
    left: TreeNode,
    right: TreeNode,
    sortMetaByNode: ReadonlyMap<TreeNode, TreeSortMeta>,
): number {
    const leftMeta = sortMetaByNode.get(left)!;
    const rightMeta = sortMetaByNode.get(right)!;
    if (leftMeta.isDefault !== rightMeta.isDefault) return leftMeta.isDefault ? -1 : 1;
    if (leftMeta.isCurrent !== rightMeta.isCurrent) return leftMeta.isCurrent ? -1 : 1;
    if (
        leftMeta.newestCommitterDate !== undefined &&
        rightMeta.newestCommitterDate !== undefined &&
        leftMeta.newestCommitterDate !== rightMeta.newestCommitterDate
    ) {
        return rightMeta.newestCommitterDate - leftMeta.newestCommitterDate;
    }
    if (leftMeta.newestCommitterDate !== rightMeta.newestCommitterDate) {
        return leftMeta.newestCommitterDate === undefined ? 1 : -1;
    }
    return left.label.localeCompare(right.label);
}

function sortBranchTree(nodes: TreeNode[]): void {
    for (const node of nodes) {
        sortBranchTree(node.children);
    }
    const sortMetaByNode = new Map(nodes.map((node) => [node, getTreeSortMeta(node)]));
    nodes.sort((left, right) => compareTreeNodes(left, right, sortMetaByNode));
}
