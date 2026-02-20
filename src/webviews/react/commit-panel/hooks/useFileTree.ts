// Transforms a flat list of WorkingFile[] into a nested tree structure
// for directory-grouped display. Uses useMemo for efficient recomputation.

import { useMemo } from "react";
import type { WorkingFile } from "../../../../types";
import type { TreeEntry, TreeNode } from "../types";
import type {
    TreeEntry as GenericTreeEntry,
    TreeFolder as GenericTreeFolder,
} from "../../shared/fileTree";
import { buildFileTree } from "../../shared/fileTree";

function withMetadata(entries: GenericTreeEntry<WorkingFile>[]): TreeEntry[] {
    return entries.map((entry) => {
        if (entry.type === "file") {
            return entry;
        }
        return withFolderMetadata(entry);
    });
}

function withFolderMetadata(folder: GenericTreeFolder<WorkingFile>): TreeNode {
    const children = withMetadata(folder.children);
    const descendantFiles: WorkingFile[] = [];
    for (const child of children) {
        if (child.type === "file") descendantFiles.push(child.file);
        else descendantFiles.push(...child.descendantFiles);
    }
    return {
        type: "folder",
        name: folder.name,
        path: folder.path,
        children,
        descendantFiles,
    };
}

export function useFileTree(files: WorkingFile[], groupByDir: boolean): TreeEntry[] {
    return useMemo(() => {
        if (!groupByDir) {
            return files.map((file) => ({ type: "file" as const, file }));
        }
        return withMetadata(buildFileTree(files));
    }, [files, groupByDir]);
}

/** Collect all directory paths in a tree. */
export { collectDirPaths as collectAllDirPaths } from "../../shared/fileTree";
