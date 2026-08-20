// Manages the set of checked file paths with 3-level checkbox logic
// (file, folder, section). Persists state via vscode.getState/setState.

import { useState, useCallback, useEffect, useMemo } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type { WorkingFile } from "../../../../types";
import { getSettings, type CommitFileCheckMode } from "../../shared/settings";

interface CheckedFilesAPI {
    checkedPaths: Set<string>;
    toggleFile: (path: string) => void;
    toggleFolder: (files: WorkingFile[]) => void;
    toggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
}

type SavedWebviewState = Record<string, unknown> | undefined;

interface CheckedFilesState {
    repositoryRoot?: string;
    hydrated: boolean;
    checkedPaths: Set<string>;
    knownPaths: Set<string>;
}

function pruneToKnownPaths(paths: Set<string>, validPaths: Set<string>): Set<string> {
    const next = new Set<string>();
    for (const path of paths) {
        if (validPaths.has(path)) next.add(path);
    }
    return next.size === paths.size ? paths : next;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

function savedCheckedPaths(saved: SavedWebviewState, repositoryRoot: string): string[] {
    const byRepository = saved?.checkedByRepository;
    if (byRepository && typeof byRepository === "object" && !Array.isArray(byRepository)) {
        return stringArray((byRepository as Record<string, unknown>)[repositoryRoot]);
    }
    return [];
}

function savedCheckedByRepository(saved: SavedWebviewState): Record<string, unknown> {
    const byRepository = saved?.checkedByRepository;
    return byRepository && typeof byRepository === "object" && !Array.isArray(byRepository)
        ? { ...byRepository }
        : {};
}

function buildSelectablePathSet(files: WorkingFile[]): Set<string> {
    const paths = new Set<string>();
    for (const file of files) {
        if (file.status !== "!") paths.add(file.path);
    }
    return paths;
}

function setsAreEqual(left: Set<string>, right: Set<string>): boolean {
    return left.size === right.size && Array.from(left).every((path) => right.has(path));
}

function initialCheckedPaths(
    mode: CommitFileCheckMode,
    repositoryRoot: string,
    validPaths: Set<string>,
): Set<string> {
    if (mode === "allChecked") return new Set(validPaths);
    if (mode === "noneChecked") return new Set();
    const saved = getVsCodeApi().getState();
    return pruneToKnownPaths(new Set(savedCheckedPaths(saved, repositoryRoot)), validPaths);
}

/**
 * Tracks selected working-tree paths for commit, rollback, stash, and diff actions.
 *
 * Selection is repository-scoped and begins only after the host marks its file
 * snapshot authoritative. The configured mode controls initial and newly
 * discovered paths while explicit choices survive same-repository refreshes.
 */
export function useCheckedFiles(
    allFiles: WorkingFile[],
    repositoryRoot: string | undefined,
    filesHydrated: boolean,
): CheckedFilesAPI {
    const [mode] = useState<CommitFileCheckMode>(() => getSettings().commitCheckState);
    const [state, setState] = useState<CheckedFilesState>(() => ({
        repositoryRoot,
        hydrated: false,
        checkedPaths: new Set(),
        knownPaths: new Set(),
    }));
    const validPaths = useMemo(() => buildSelectablePathSet(allFiles), [allFiles]);
    const currentCheckedPaths = useMemo(() => {
        if (
            !repositoryRoot ||
            !filesHydrated ||
            state.repositoryRoot !== repositoryRoot ||
            !state.hydrated
        ) {
            return new Set<string>();
        }
        return pruneToKnownPaths(state.checkedPaths, validPaths);
    }, [filesHydrated, repositoryRoot, state, validPaths]);

    useEffect(() => {
        if (!repositoryRoot) {
            // react-doctor-disable-next-line react-doctor/no-derived-state
            setState((previous) => {
                if (
                    previous.repositoryRoot === undefined &&
                    !previous.hydrated &&
                    previous.checkedPaths.size === 0 &&
                    previous.knownPaths.size === 0
                ) {
                    return previous;
                }
                return {
                    repositoryRoot: undefined,
                    hydrated: false,
                    checkedPaths: new Set(),
                    knownPaths: new Set(),
                };
            });
            return;
        }
        if (!filesHydrated) return;

        // react-doctor-disable-next-line react-doctor/no-derived-state
        setState((previous) => {
            if (previous.repositoryRoot !== repositoryRoot || !previous.hydrated) {
                return {
                    repositoryRoot,
                    hydrated: true,
                    checkedPaths: initialCheckedPaths(mode, repositoryRoot, validPaths),
                    knownPaths: new Set(validPaths),
                };
            }

            const nextCheckedPaths = new Set(pruneToKnownPaths(previous.checkedPaths, validPaths));
            if (mode === "allChecked") {
                for (const path of validPaths) {
                    if (!previous.knownPaths.has(path)) nextCheckedPaths.add(path);
                }
            }
            if (
                setsAreEqual(previous.checkedPaths, nextCheckedPaths) &&
                setsAreEqual(previous.knownPaths, validPaths)
            ) {
                return previous;
            }
            return {
                repositoryRoot,
                hydrated: true,
                checkedPaths: nextCheckedPaths,
                knownPaths: new Set(validPaths),
            };
        });
    }, [filesHydrated, mode, repositoryRoot, validPaths]);

    // Persist to vscode state on every change (merge to preserve other keys).
    useEffect(() => {
        if (
            !repositoryRoot ||
            !filesHydrated ||
            state.repositoryRoot !== repositoryRoot ||
            !state.hydrated
        ) {
            return;
        }
        const vscode = getVsCodeApi();
        const prev = vscode.getState() ?? {};
        // react-doctor-disable-next-line react-doctor/no-event-handler
        vscode.setState({
            ...prev,
            checkedByRepository: {
                ...savedCheckedByRepository(prev),
                [repositoryRoot]: Array.from(currentCheckedPaths),
            },
        });
    }, [currentCheckedPaths, filesHydrated, repositoryRoot, state]);

    const toggleFile = useCallback(
        (path: string) => {
            if (!repositoryRoot || !filesHydrated || !validPaths.has(path)) return;
            setState((previous) => {
                if (previous.repositoryRoot !== repositoryRoot || !previous.hydrated) {
                    return previous;
                }
                const next = new Set(pruneToKnownPaths(previous.checkedPaths, validPaths));
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return { ...previous, checkedPaths: next };
            });
        },
        [filesHydrated, repositoryRoot, validPaths],
    );

    const toggleMany = useCallback(
        (paths: string[]) => {
            if (!repositoryRoot || !filesHydrated) return;
            const knownPaths = paths.filter((path) => validPaths.has(path));
            if (knownPaths.length === 0) return;
            setState((previous) => {
                if (previous.repositoryRoot !== repositoryRoot || !previous.hydrated) {
                    return previous;
                }
                const next = new Set(pruneToKnownPaths(previous.checkedPaths, validPaths));
                const allChecked = knownPaths.every((path) => next.has(path));
                for (const path of knownPaths) {
                    if (allChecked) next.delete(path);
                    else next.add(path);
                }
                return { ...previous, checkedPaths: next };
            });
        },
        [filesHydrated, repositoryRoot, validPaths],
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
