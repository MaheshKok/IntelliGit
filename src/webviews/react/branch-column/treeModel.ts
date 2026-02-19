import type { Branch } from "../../../types";
import type { RemoteGroup, TreeNode } from "./types";

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
            let folder = current.find((n) => n.label === part && !n.branch);
            if (!folder) {
                folder = { label: part, children: [] };
                current.push(folder);
            }
            current = folder.children;
        }
    }

    return root;
}

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
