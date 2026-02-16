// Manages the set of checked file paths with 3-level checkbox logic
// (file, folder, section). Persists state via vscode.getState/setState.

import { useState, useCallback, useEffect } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type { WorkingFile } from "../../../../types";

interface CheckedFilesAPI {
    checkedPaths: Set<string>;
    toggleFile: (path: string) => void;
    toggleFolder: (dirPrefix: string, files: WorkingFile[]) => void;
    toggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
}

export function useCheckedFiles(allFiles: WorkingFile[]): CheckedFilesAPI {
    const [checkedPaths, setCheckedPaths] = useState<Set<string>>(() => {
        const vscode = getVsCodeApi();
        const saved = vscode.getState();
        const arr = (saved as { checked?: string[] } | undefined)?.checked;
        return new Set(arr ?? []);
    });

    // Prune stale paths when file list changes
    useEffect(() => {
        const validPaths = new Set(allFiles.map((f) => f.path));
        setCheckedPaths((prev) => {
            const next = new Set<string>();
            for (const p of prev) {
                if (validPaths.has(p)) next.add(p);
            }
            if (next.size === prev.size) return prev;
            return next;
        });
    }, [allFiles]);

    // Persist to vscode state on every change
    useEffect(() => {
        const vscode = getVsCodeApi();
        vscode.setState({ checked: Array.from(checkedPaths) });
    }, [checkedPaths]);

    const toggleFile = useCallback((path: string) => {
        setCheckedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const toggleFolder = useCallback((dirPrefix: string, files: WorkingFile[]) => {
        const dirFiles = files.filter((f) => f.path.startsWith(dirPrefix + "/"));
        setCheckedPaths((prev) => {
            const next = new Set(prev);
            const allChecked = dirFiles.every((f) => next.has(f.path));
            for (const f of dirFiles) {
                if (allChecked) next.delete(f.path);
                else next.add(f.path);
            }
            return next;
        });
    }, []);

    const toggleSection = useCallback((files: WorkingFile[]) => {
        setCheckedPaths((prev) => {
            const next = new Set(prev);
            const allChecked = files.every((f) => next.has(f.path));
            for (const f of files) {
                if (allChecked) next.delete(f.path);
                else next.add(f.path);
            }
            return next;
        });
    }, []);

    const isAllChecked = useCallback(
        (files: WorkingFile[]) => files.length > 0 && files.every((f) => checkedPaths.has(f.path)),
        [checkedPaths],
    );

    const isSomeChecked = useCallback(
        (files: WorkingFile[]) =>
            files.some((f) => checkedPaths.has(f.path)) &&
            !files.every((f) => checkedPaths.has(f.path)),
        [checkedPaths],
    );

    return {
        checkedPaths,
        toggleFile,
        toggleFolder,
        toggleSection,
        isAllChecked,
        isSomeChecked,
    };
}
