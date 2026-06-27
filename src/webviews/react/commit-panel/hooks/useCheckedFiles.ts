// Manages the set of checked file paths with 3-level checkbox logic
// (file, folder, section). Persists state via vscode.getState/setState.

import { useState, useCallback, useEffect, useMemo } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type { WorkingFile } from "../../../../types";

interface CheckedFilesAPI {
    checkedPaths: Set<string>;
    toggleFile: (path: string) => void;
    toggleFolder: (files: WorkingFile[]) => void;
    toggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
}

function pruneToKnownPaths(paths: Set<string>, validPaths: Set<string>): Set<string> {
    const next = new Set<string>();
    for (const path of paths) {
        if (validPaths.has(path)) next.add(path);
    }
    return next.size === paths.size ? paths : next;
}

/**
 * Tracks selected working-tree paths for commit, rollback, shelve, and diff actions.
 *
 * Selection is persisted in VS Code webview state, pruned when the host sends a
 * new file snapshot, and toggled by exact path so grouped folders and top-level
 * sections can share the same all-or-none behavior.
 */
export function useCheckedFiles(allFiles: WorkingFile[]): CheckedFilesAPI {
    const [checkedPaths, setCheckedPaths] = useState<Set<string>>(() => {
        const vscode = getVsCodeApi();
        const saved = vscode.getState();
        const arr = (saved as { checked?: string[] } | undefined)?.checked;
        return new Set(arr ?? []);
    });
    const validPaths = useMemo(() => new Set(allFiles.map((file) => file.path)), [allFiles]);
    const currentCheckedPaths = useMemo(
        () => pruneToKnownPaths(checkedPaths, validPaths),
        [checkedPaths, validPaths],
    );

    useEffect(() => {
        // Host file snapshots invalidate stale selections after render; backing state must be pruned.
        // react-doctor-disable-next-line react-doctor/no-derived-state
        setCheckedPaths((prev) => pruneToKnownPaths(prev, validPaths));
    }, [validPaths]);

    // Persist to vscode state on every change (merge to preserve other keys)
    useEffect(() => {
        const vscode = getVsCodeApi();
        const prev = vscode.getState() ?? {};
        vscode.setState({ ...prev, checked: Array.from(currentCheckedPaths) });
    }, [currentCheckedPaths]);

    const toggleFile = useCallback(
        (path: string) => {
            if (!validPaths.has(path)) return;
            setCheckedPaths((prev) => {
                const next = new Set(pruneToKnownPaths(prev, validPaths));
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
            });
        },
        [validPaths],
    );

    const toggleMany = useCallback(
        (paths: string[]) => {
            const knownPaths = paths.filter((path) => validPaths.has(path));
            if (knownPaths.length === 0) return;
            setCheckedPaths((prev) => {
                const next = new Set(pruneToKnownPaths(prev, validPaths));
                const allChecked = knownPaths.every((path) => next.has(path));
                for (const path of knownPaths) {
                    if (allChecked) next.delete(path);
                    else next.add(path);
                }
                return next;
            });
        },
        [validPaths],
    );

    const toggleGroup = useCallback(
        (files: WorkingFile[]) => {
            toggleMany(files.map((file) => file.path));
        },
        [toggleMany],
    );

    // Intentional aliases for call-site clarity. If folder/section behavior diverges,
    // split these into separate callbacks to keep memo/dependency behavior explicit.
    const toggleFolder = toggleGroup;
    const toggleSection = toggleGroup;

    const isAllChecked = useCallback(
        (files: WorkingFile[]) =>
            files.length > 0 && files.every((f) => currentCheckedPaths.has(f.path)),
        [currentCheckedPaths],
    );

    const isSomeChecked = useCallback(
        (files: WorkingFile[]) =>
            files.some((f) => currentCheckedPaths.has(f.path)) &&
            !files.every((f) => currentCheckedPaths.has(f.path)),
        [currentCheckedPaths],
    );

    return {
        checkedPaths: currentCheckedPaths,
        toggleFile,
        toggleFolder,
        toggleSection,
        isAllChecked,
        isSomeChecked,
    };
}
