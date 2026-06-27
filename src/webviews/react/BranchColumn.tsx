// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useMemo, useCallback, useEffect, useReducer } from "react";
import type { Branch, GitWorktree, ThemeFolderIconMap, ThemeTreeIcon } from "../../types";
import {
    isBranchAction,
    isWorktreeAction,
    type BranchAction,
    type WorktreeAction,
} from "../protocol/commitGraphTypes";
import { ContextMenu } from "./shared/components/ContextMenu";
import {
    getBranchMenuItems,
    getBulkBranchMenuItems,
    getWorktreeMenuItems,
} from "./branch-column/menu";
import { buildPrefixTree, buildRemoteGroups } from "./branch-column/treeModel";
import { BranchColumnSections } from "./branch-column/BranchColumnSections";
import { BranchSearchBar } from "./branch-column/components/BranchSearchBar";
import { getVsCodeApi } from "./shared/vscodeApi";
import { BRANCH_ROW_CLASS_CSS, PANEL_STYLE } from "./branch-column/styles";

interface Props {
    branches: Branch[];
    worktrees?: GitWorktree[];
    selectedBranch: string | null;
    onSelectBranch: (name: string | null) => void;
    onBranchAction: (action: BranchAction, branchName: string) => void;
    onDeleteBranches?: (branches: Branch[]) => void;
    onWorktreeAction?: (action: WorktreeAction, path: string) => void;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

interface BranchColumnPersistState {
    branchFilter: string;
    expandedSections: string[];
    expandedFolders: string[];
}

interface CommitGraphViewState {
    branchColumn?: BranchColumnPersistState;
}

const DEFAULT_EXPANDED_SECTIONS = ["local", "remote", "worktrees"];

interface BranchContextMenuState {
    x: number;
    y: number;
    branch: Branch;
    branches?: Branch[];
}

interface WorktreeContextMenuState {
    x: number;
    y: number;
    worktree: GitWorktree;
}

interface BranchColumnState {
    branchFilter: string;
    expandedSections: Set<string>;
    expandedFolders: Set<string>;
    contextMenu: BranchContextMenuState | null;
    worktreeContextMenu: WorktreeContextMenuState | null;
    selectedBranchNames: Set<string>;
}

type BranchColumnAction =
    | { type: "setBranchFilter"; value: string }
    | { type: "toggleSection"; key: string }
    | { type: "toggleFolder"; key: string }
    | { type: "toggleSelectedBranch"; name: string }
    | { type: "clearSelectedBranches" }
    | { type: "openBranchContextMenu"; menu: BranchContextMenuState }
    | { type: "openWorktreeContextMenu"; menu: WorktreeContextMenuState }
    | { type: "closeContextMenu" };

function toggleSetValue(values: Set<string>, key: string): Set<string> {
    const next = new Set(values);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
}

function createInitialBranchColumnState(): BranchColumnState {
    const persistedState = readPersistedBranchColumnState();
    return {
        branchFilter: persistedState?.branchFilter ?? "",
        expandedSections: new Set(
            Array.isArray(persistedState?.expandedSections)
                ? persistedState.expandedSections
                : DEFAULT_EXPANDED_SECTIONS,
        ),
        expandedFolders: new Set(persistedState?.expandedFolders ?? []),
        contextMenu: null,
        worktreeContextMenu: null,
        selectedBranchNames: new Set(),
    };
}

function branchColumnReducer(
    state: BranchColumnState,
    action: BranchColumnAction,
): BranchColumnState {
    switch (action.type) {
        case "setBranchFilter":
            return { ...state, branchFilter: action.value };
        case "toggleSection":
            return {
                ...state,
                expandedSections: toggleSetValue(state.expandedSections, action.key),
            };
        case "toggleFolder":
            return {
                ...state,
                expandedFolders: toggleSetValue(state.expandedFolders, action.key),
            };
        case "toggleSelectedBranch":
            return {
                ...state,
                selectedBranchNames: toggleSetValue(state.selectedBranchNames, action.name),
            };
        case "clearSelectedBranches":
            return { ...state, selectedBranchNames: new Set() };
        case "openBranchContextMenu":
            return { ...state, contextMenu: action.menu, worktreeContextMenu: null };
        case "openWorktreeContextMenu":
            return { ...state, contextMenu: null, worktreeContextMenu: action.menu };
        case "closeContextMenu":
            return { ...state, contextMenu: null, worktreeContextMenu: null };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}

/** Matches worktrees against the same branch-list filter input. */
function worktreeMatches(worktree: GitWorktree, needle: string): boolean {
    if (!needle) return true;
    return [worktree.branch, worktree.head, worktree.path].some((value) =>
        value?.toLowerCase().includes(needle),
    );
}
function readPersistedBranchColumnState(): BranchColumnPersistState | null {
    try {
        const api = getVsCodeApi<unknown, CommitGraphViewState>();
        return api.getState()?.branchColumn ?? null;
    } catch {
        return null;
    }
}

function persistBranchColumnState(state: BranchColumnPersistState): void {
    try {
        const api = getVsCodeApi<unknown, CommitGraphViewState>();
        const prev = api.getState() ?? {};
        api.setState({
            ...prev,
            branchColumn: state,
        });
    } catch {
        // Ignore persistence errors and keep runtime interaction unaffected.
    }
}

function getIconAnchorX(row: HTMLElement): number {
    const rowRect = row.getBoundingClientRect();
    const firstIcon = row.querySelector("[data-branch-icon], svg, img");
    return firstIcon ? firstIcon.getBoundingClientRect().right + 2 : rowRect.left + 20;
}

function computeAnchorPosition(
    row: HTMLElement,
    minimumX: number,
): { anchorX: number; anchorY: number } {
    const rowRect = row.getBoundingClientRect();
    const anchorX = Math.max(getIconAnchorX(row), minimumX);
    const anchorY = rowRect.top + 1;
    return { anchorX, anchorY };
}

/**
 * Renders the branch sidebar, grouping local and remote branches while persisting
 * filter text and expanded folders in VS Code webview state.
 */
export function BranchColumn({
    branches,
    worktrees = [],
    selectedBranch,
    onSelectBranch,
    onBranchAction,
    onDeleteBranches,
    onWorktreeAction,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
}: Props): React.ReactElement {
    const [state, dispatch] = useReducer(
        branchColumnReducer,
        undefined,
        createInitialBranchColumnState,
    );
    const {
        branchFilter,
        expandedSections,
        expandedFolders,
        contextMenu,
        worktreeContextMenu,
        selectedBranchNames,
    } = state;

    const filterNeedle = branchFilter.trim().toLowerCase();
    const branchesByName = useMemo(
        () => new Map(branches.map((branch) => [branch.name, branch])),
        [branches],
    );

    const actualCurrent = useMemo(() => branches.find((b) => b.isCurrent), [branches]);

    const filteredBranches = useMemo(() => {
        if (!filterNeedle) return branches;
        return branches.filter((branch) => branch.name.toLowerCase().includes(filterNeedle));
    }, [branches, filterNeedle]);

    const current = useMemo(() => {
        if (!actualCurrent) return undefined;
        if (!filterNeedle) return actualCurrent;
        return actualCurrent.name.toLowerCase().includes(filterNeedle) ? actualCurrent : undefined;
    }, [actualCurrent, filterNeedle]);

    const locals = useMemo(() => filteredBranches.filter((b) => !b.isRemote), [filteredBranches]);
    const remotes = useMemo(() => filteredBranches.filter((b) => b.isRemote), [filteredBranches]);
    const filteredWorktrees = useMemo(
        () => worktrees.filter((worktree) => worktreeMatches(worktree, filterNeedle)),
        [filterNeedle, worktrees],
    );
    const localTree = useMemo(() => buildPrefixTree(locals), [locals]);
    const remoteGroups = useMemo(() => buildRemoteGroups(remotes), [remotes]);

    const toggleSection = useCallback((key: string) => {
        dispatch({ type: "toggleSection", key });
    }, []);
    const toggleFolder = useCallback((key: string) => {
        dispatch({ type: "toggleFolder", key });
    }, []);

    const handleBranchRowClick = useCallback(
        (event: React.MouseEvent, branchName: string): void => {
            if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                dispatch({ type: "toggleSelectedBranch", name: branchName });
                return;
            }

            dispatch({ type: "clearSelectedBranches" });
            onSelectBranch(branchName);
        },
        [onSelectBranch],
    );

    const getBulkBranches = useCallback(
        (branch: Branch): Branch[] | undefined => {
            if (!selectedBranchNames.has(branch.name) || selectedBranchNames.size < 2)
                return undefined;
            const selectedBranches = Array.from(selectedBranchNames)
                .map((name) => branchesByName.get(name))
                .filter((selected): selected is Branch => Boolean(selected));
            return selectedBranches.length === selectedBranchNames.size
                ? selectedBranches
                : undefined;
        },
        [branchesByName, selectedBranchNames],
    );

    const handleBranchContextMenu = useCallback(
        (event: React.MouseEvent, branch: Branch) => {
            event.preventDefault();
            event.stopPropagation();
            const row = event.currentTarget as HTMLElement;
            const { anchorX, anchorY } = computeAnchorPosition(row, event.clientX + 2);
            dispatch({
                type: "openBranchContextMenu",
                menu: {
                    x: anchorX,
                    y: anchorY,
                    branch,
                    branches: getBulkBranches(branch),
                },
            });
        },
        [getBulkBranches],
    );

    const openBranchContextMenuFromRow = useCallback(
        (row: HTMLElement, branch: Branch): void => {
            const rowRect = row.getBoundingClientRect();
            const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
            dispatch({
                type: "openBranchContextMenu",
                menu: {
                    x: anchorX,
                    y: anchorY,
                    branch,
                    branches: getBulkBranches(branch),
                },
            });
        },
        [getBulkBranches],
    );

    const handleWorktreeContextMenu = useCallback(
        (event: React.MouseEvent, worktree: GitWorktree): void => {
            event.preventDefault();
            event.stopPropagation();
            const row = event.currentTarget as HTMLElement;
            const { anchorX, anchorY } = computeAnchorPosition(row, event.clientX + 2);
            dispatch({
                type: "openWorktreeContextMenu",
                menu: { x: anchorX, y: anchorY, worktree },
            });
        },
        [],
    );

    const openWorktreeContextMenuFromRow = useCallback(
        (row: HTMLElement, worktree: GitWorktree): void => {
            const rowRect = row.getBoundingClientRect();
            const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
            dispatch({
                type: "openWorktreeContextMenu",
                menu: { x: anchorX, y: anchorY, worktree },
            });
        },
        [],
    );

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            if (action === "deleteBranches" && contextMenu.branches) {
                onDeleteBranches?.(contextMenu.branches);
                return;
            }
            if (!isBranchAction(action)) return;
            onBranchAction(action, contextMenu.branch.name);
        },
        [contextMenu, onBranchAction, onDeleteBranches],
    );

    const handleWorktreeContextMenuAction = useCallback(
        (action: string) => {
            if (!worktreeContextMenu || !isWorktreeAction(action)) return;
            onWorktreeAction?.(action, worktreeContextMenu.worktree.path);
        },
        [onWorktreeAction, worktreeContextMenu],
    );

    const closeContextMenu = useCallback(() => {
        dispatch({ type: "closeContextMenu" });
    }, []);

    useEffect(() => {
        persistBranchColumnState({
            branchFilter,
            expandedSections: Array.from(expandedSections),
            expandedFolders: Array.from(expandedFolders),
        });
    }, [branchFilter, expandedSections, expandedFolders]);

    return (
        <div style={PANEL_STYLE}>
            <style>{BRANCH_ROW_CLASS_CSS}</style>

            <BranchSearchBar
                value={branchFilter}
                onChange={(value) => dispatch({ type: "setBranchFilter", value })}
                onClear={() => dispatch({ type: "setBranchFilter", value: "" })}
            />

            <BranchColumnSections
                current={current}
                selectedBranch={selectedBranch}
                expandedSections={expandedSections}
                expandedFolders={expandedFolders}
                localTree={localTree}
                remoteGroups={remoteGroups}
                worktrees={worktrees}
                filteredWorktrees={filteredWorktrees}
                filterNeedle={filterNeedle}
                locals={locals}
                remotes={remotes}
                selectedBranchNames={selectedBranchNames}
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
                onSelectBranch={onSelectBranch}
                onClearSelectedBranches={() => dispatch({ type: "clearSelectedBranches" })}
                onToggleSection={toggleSection}
                onToggleFolder={toggleFolder}
                onBranchClick={handleBranchRowClick}
                onBranchContextMenu={handleBranchContextMenu}
                onOpenBranchContextMenuFromRow={openBranchContextMenuFromRow}
                onWorktreeAction={onWorktreeAction}
                onWorktreeContextMenu={handleWorktreeContextMenu}
                onOpenWorktreeContextMenuFromRow={openWorktreeContextMenuFromRow}
            />

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={
                        contextMenu.branches
                            ? getBulkBranchMenuItems()
                            : getBranchMenuItems(contextMenu.branch, actualCurrent?.name ?? "HEAD")
                    }
                    minWidth={310}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                />
            )}
            {worktreeContextMenu && (
                <ContextMenu
                    x={worktreeContextMenu.x}
                    y={worktreeContextMenu.y}
                    items={getWorktreeMenuItems(worktreeContextMenu.worktree)}
                    minWidth={220}
                    onSelect={handleWorktreeContextMenuAction}
                    onClose={closeContextMenu}
                />
            )}
        </div>
    );
}
