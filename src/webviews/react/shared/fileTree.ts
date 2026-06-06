// Generic tree-building utilities shared by the commit panel (WorkingFile)
// and commit info (CommitFile) webviews. Parametric over any file type
// that has a `path` property.

/**
 * Directory node produced by the shared file-tree builders.
 *
 * Folder paths use Git-style `/` separators; converted children list directories
 * first, then file leaves, preserving insertion order within each group.
 */
export interface TreeFolder<F> {
    type: "folder";
    name: string;
    path: string;
    children: TreeEntry<F>[];
}

/** File leaf that carries the original file payload without cloning it. */
export interface TreeLeaf<F> {
    type: "file";
    file: F;
}

/** Discriminated tree entry consumed by shared commit-info and commit-panel renderers. */
export type TreeEntry<F> = TreeFolder<F> | TreeLeaf<F>;

interface DirBuild<F> {
    name: string;
    path: string;
    dirs: Map<string, DirBuild<F>>;
    files: F[];
}

/**
 * Builds a nested directory tree from a flat list of files with `path` properties.
 *
 * The helper treats `/` as the path separator, mutates only temporary build maps,
 * and returns entries that reference the original file objects.
 */
export function buildFileTree<F extends { path: string }>(files: F[]): TreeEntry<F>[] {
    const root: { dirs: Map<string, DirBuild<F>>; files: F[] } = {
        dirs: new Map(),
        files: [],
    };

    for (const file of files) {
        const parts = file.path.split("/");
        if (parts.length === 1) {
            root.files.push(file);
            continue;
        }

        let current = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            if (!current.dirs.has(dirName)) {
                current.dirs.set(dirName, {
                    name: dirName,
                    path: parts.slice(0, i + 1).join("/"),
                    dirs: new Map(),
                    files: [],
                });
            }
            current = current.dirs.get(dirName)!;
        }
        current.files.push(file);
    }

    return convertBuild(root);
}

function convertBuild<F>(node: { dirs: Map<string, DirBuild<F>>; files: F[] }): TreeEntry<F>[] {
    const entries: TreeEntry<F>[] = [];
    for (const dir of node.dirs.values()) {
        entries.push({
            type: "folder",
            name: dir.name,
            path: dir.path,
            children: convertBuild(dir),
        });
    }
    for (const file of node.files) {
        entries.push({ type: "file", file });
    }
    return entries;
}

/**
 * Collects directory paths from a tree in traversal order.
 *
 * The optional accumulator is mutated so callers that recursively compose trees
 * can reuse the same array without additional allocations.
 */
export function collectDirPaths<F>(entries: TreeEntry<F>[], acc: string[] = []): string[] {
    for (const entry of entries) {
        if (entry.type === "folder") {
            acc.push(entry.path);
            collectDirPaths(entry.children, acc);
        }
    }
    return acc;
}

/** Counts total file leaves without counting folder nodes. */
export function countFiles<F>(entries: TreeEntry<F>[]): number {
    let c = 0;
    for (const entry of entries) {
        if (entry.type === "file") c += 1;
        else c += countFiles(entry.children);
    }
    return c;
}
