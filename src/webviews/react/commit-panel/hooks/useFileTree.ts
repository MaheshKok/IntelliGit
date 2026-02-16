// Transforms a flat list of WorkingFile[] into a nested tree structure
// for directory-grouped display. Uses useMemo for efficient recomputation.

import { useMemo } from "react";
import type { WorkingFile } from "../../../../types";
import type { TreeEntry, TreeNode } from "../types";

export function useFileTree(files: WorkingFile[], groupByDir: boolean): TreeEntry[] {
    return useMemo(() => {
        if (!groupByDir) {
            return files.map((file) => ({ type: "file" as const, file }));
        }
        return buildTree(files);
    }, [files, groupByDir]);
}

function buildTree(files: WorkingFile[]): TreeEntry[] {
    const root: { dirs: Map<string, DirBuild>; files: WorkingFile[] } = {
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

    return convertDirBuild(root);
}

interface DirBuild {
    name: string;
    path: string;
    dirs: Map<string, DirBuild>;
    files: WorkingFile[];
}

function convertDirBuild(node: { dirs: Map<string, DirBuild>; files: WorkingFile[] }): TreeEntry[] {
    const entries: TreeEntry[] = [];

    for (const [, dir] of node.dirs) {
        const children = convertDirBuild(dir);
        const treeNode: TreeNode = {
            type: "folder",
            name: dir.name,
            path: dir.path,
            children,
        };
        entries.push(treeNode);
    }

    for (const file of node.files) {
        entries.push({ type: "file", file });
    }

    return entries;
}

/** Collect all file paths under a tree node recursively. */
export function collectTreeFiles(entries: TreeEntry[]): WorkingFile[] {
    const result: WorkingFile[] = [];
    for (const entry of entries) {
        if (entry.type === "file") {
            result.push(entry.file);
        } else {
            result.push(...collectTreeFiles(entry.children));
        }
    }
    return result;
}

/** Collect all directory paths in a tree. */
export function collectAllDirPaths(entries: TreeEntry[]): string[] {
    const dirs: string[] = [];
    for (const entry of entries) {
        if (entry.type === "folder") {
            dirs.push(entry.path);
            dirs.push(...collectAllDirPaths(entry.children));
        }
    }
    return dirs;
}
