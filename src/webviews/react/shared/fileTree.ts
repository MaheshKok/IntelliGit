// Generic tree-building utilities shared by the commit panel (WorkingFile)
// and commit info (CommitFile) webviews. Parametric over any file type
// that has a `path` property.

export interface TreeFolder<F> {
    type: "folder";
    name: string;
    path: string;
    children: TreeEntry<F>[];
}

export interface TreeLeaf<F> {
    type: "file";
    file: F;
}

export type TreeEntry<F> = TreeFolder<F> | TreeLeaf<F>;

interface DirBuild<F> {
    name: string;
    path: string;
    dirs: Map<string, DirBuild<F>>;
    files: F[];
}

/** Build a nested directory tree from a flat list of files with `path` properties. */
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

/** Collect all directory paths in a tree. */
export function collectDirPaths<F>(entries: TreeEntry<F>[], acc: string[] = []): string[] {
    for (const entry of entries) {
        if (entry.type === "folder") {
            acc.push(entry.path);
            collectDirPaths(entry.children, acc);
        }
    }
    return acc;
}

/** Count total files (leaves) in a tree. */
export function countFiles<F>(entries: TreeEntry<F>[]): number {
    let c = 0;
    for (const entry of entries) {
        if (entry.type === "file") c += 1;
        else c += countFiles(entry.children);
    }
    return c;
}
