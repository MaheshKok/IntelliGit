// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useMemo, useState, useCallback, useEffect } from "react";
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
import { renderHighlightedLabel } from "./branch-column/highlight";
import { BranchTreeNodeRow } from "./branch-column/components/BranchTreeNodeRow";
import { BranchSectionHeader } from "./branch-column/components/BranchSectionHeader";
import { BranchSearchBar } from "./branch-column/components/BranchSearchBar";
import { GitBranchIcon, RepoIcon, TagRightIcon } from "./shared/components";
import { JETBRAINS_UI } from "./shared/tokens";
import { getVsCodeApi } from "./shared/vscodeApi";
import { t } from "./shared/i18n";
import {
    BRANCH_ROW_CLASS_CSS,
    HEAD_LABEL_STYLE,
    HEAD_ROW_STYLE,
    HEAD_WRAPPER_STYLE,
    NODE_LABEL_STYLE,
    NO_MATCH_STYLE,
    PANEL_STYLE,
    ROW_STYLE,
    TREE_INDENT_STEP,
    TREE_SECTION_STYLE,
} from "./branch-column/styles";

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

/** Returns a compact stable label for a worktree row. */
function getWorktreeLabel(worktree: GitWorktree): string {
    if (worktree.branch) return worktree.branch;
    if (worktree.head) return worktree.head.slice(0, 7);
    return getPathBasename(worktree.path);
}

/** Extracts a folder name from Git's absolute worktree path in the webview. */
function getPathBasename(value: string): string {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? value) : value;
}

/** Matches worktrees against the same branch-list filter input. */
function worktreeMatches(worktree: GitWorktree, needle: string): boolean {
    if (!needle) return true;
    return [worktree.branch, worktree.head, worktree.path].some((value) =>
        value?.toLowerCase().includes(needle),
    );
}

/** Renders one linked worktree under the branch list without mutating branch filters. */
function WorktreeRow({
    worktree,
    filterNeedle,
    onAction,
    onContextMenu,
    onOpenContextMenu,
}: {
    worktree: GitWorktree;
    filterNeedle: string;
    onAction?: (action: WorktreeAction, path: string) => void;
    onContextMenu: (event: React.MouseEvent, worktree: GitWorktree) => void;
    onOpenContextMenu: (row: HTMLElement, worktree: GitWorktree) => void;
}): React.ReactElement {
    const label = getWorktreeLabel(worktree);
    const folderName = getPathBasename(worktree.path);
    const activate = (): void => onAction?.("open", worktree.path);
    return (
        <div
            className="branch-row"
            data-worktree-path={worktree.path}
            role="button"
            tabIndex={0}
            title={worktree.path}
            onClick={activate}
            onContextMenu={(event) => onContextMenu(event, worktree)}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    if (event.key === " ") event.preventDefault();
                    activate();
                    return;
                }
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    onOpenContextMenu(event.currentTarget, worktree);
                }
            }}
            style={{ ...ROW_STYLE, paddingLeft: TREE_INDENT_STEP }}
        >
            {worktree.isCurrent ? (
                <TagRightIcon color={JETBRAINS_UI.color.currentBranch} />
            ) : (
                <GitBranchIcon />
            )}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(label, filterNeedle)}</span>
            {folderName !== label && (
                <span style={{ marginLeft: 6, opacity: 0.65, overflow: "hidden" }}>
                    {folderName}
                </span>
            )}
        </div>
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

function toggleSetKey(
    setState: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
): void {
    setState((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });
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
    const [persistedState] = useState(readPersistedBranchColumnState);
    const [branchFilter, setBranchFilter] = useState(() => persistedState?.branchFilter ?? "");
    const [expandedSections, setExpandedSections] = useState<Set<string>>(
        () =>
            new Set(
                Array.isArray(persistedState?.expandedSections)
                    ? persistedState.expandedSections
                    : DEFAULT_EXPANDED_SECTIONS,
            ),
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        () => new Set(persistedState?.expandedFolders ?? []),
    );
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        branch: Branch;
        branches?: Branch[];
    } | null>(null);
    const [worktreeContextMenu, setWorktreeContextMenu] = useState<{
        x: number;
        y: number;
        worktree: GitWorktree;
    } | null>(null);

    const filterNeedle = branchFilter.trim().toLowerCase();
    const [selectedBranchNames, setSelectedBranchNames] = useState<Set<string>>(() => new Set());
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

    const toggleSection = useCallback(
        (key: string) => {
            toggleSetKey(setExpandedSections, key);
        },
        [setExpandedSections],
    );
    const toggleFolder = useCallback(
        (key: string) => {
            toggleSetKey(setExpandedFolders, key);
        },
        [setExpandedFolders],
    );

    const handleBranchRowClick = useCallback(
        (event: React.MouseEvent, branchName: string): void => {
            if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                setSelectedBranchNames((prev) => {
                    const next = new Set(prev);
                    if (next.has(branchName)) {
                        next.delete(branchName);
                    } else {
                        next.add(branchName);
                    }
                    return next;
                });
                return;
            }

            setSelectedBranchNames(new Set());
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
            setWorktreeContextMenu(null);
            setContextMenu({
                x: anchorX,
                y: anchorY,
                branch,
                branches: getBulkBranches(branch),
            });
        },
        [getBulkBranches],
    );

    const openBranchContextMenuFromRow = useCallback(
        (row: HTMLElement, branch: Branch): void => {
            const rowRect = row.getBoundingClientRect();
            const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
            setWorktreeContextMenu(null);
            setContextMenu({
                x: anchorX,
                y: anchorY,
                branch,
                branches: getBulkBranches(branch),
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
            setContextMenu(null);
            setWorktreeContextMenu({ x: anchorX, y: anchorY, worktree });
        },
        [],
    );

    const openWorktreeContextMenuFromRow = useCallback(
        (row: HTMLElement, worktree: GitWorktree): void => {
            const rowRect = row.getBoundingClientRect();
            const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
            setContextMenu(null);
            setWorktreeContextMenu({ x: anchorX, y: anchorY, worktree });
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
        setContextMenu(null);
        setWorktreeContextMenu(null);
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
                onChange={setBranchFilter}
                onClear={() => setBranchFilter("")}
            />

            {current && (
                <div style={HEAD_WRAPPER_STYLE}>
                    <div
                        className={`branch-row${selectedBranch === null ? " selected" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                            setSelectedBranchNames(new Set());
                            onSelectBranch(null);
                        }}
                        onContextMenu={(event) => handleBranchContextMenu(event, current)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                if (event.key === " ") event.preventDefault();
                                setSelectedBranchNames(new Set());
                                onSelectBranch(null);
                                return;
                            }
                            if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                            ) {
                                event.preventDefault();
                                openBranchContextMenuFromRow(event.currentTarget, current);
                            }
                        }}
                        style={HEAD_ROW_STYLE}
                    >
                        <TagRightIcon color={JETBRAINS_UI.color.currentBranch} />
                        <span style={HEAD_LABEL_STYLE}>
                            {t("branch.head.label", { name: current.name })}
                        </span>
                    </div>
                </div>
            )}

            <BranchSectionHeader
                label={t("branch.section.local")}
                expanded={expandedSections.has("local")}
                onToggle={() => toggleSection("local")}
            />
            {expandedSections.has("local") && (
                <div style={TREE_SECTION_STYLE}>
                    {localTree.map((node, index) => (
                        <BranchTreeNodeRow
                            key={`local-${node.branch?.name ?? node.label}-${index}`}
                            node={node}
                            depth={1}
                            selectedBranch={selectedBranch}
                            selectedBranchNames={selectedBranchNames}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onBranchClick={handleBranchRowClick}
                            onToggleFolder={toggleFolder}
                            onContextMenu={handleBranchContextMenu}
                            filterNeedle={filterNeedle}
                            prefix="local"
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                        />
                    ))}
                </div>
            )}

            <BranchSectionHeader
                label={t("branch.section.remote")}
                expanded={expandedSections.has("remote")}
                onToggle={() => toggleSection("remote")}
            />
            {expandedSections.has("remote") && (
                <div style={TREE_SECTION_STYLE}>
                    {Array.from(remoteGroups.entries()).map(([remote, group]) => {
                        const remoteKey = `remote-${remote}`;
                        const isExpanded = expandedFolders.has(remoteKey);
                        return (
                            <div key={remote}>
                                <div style={{ paddingLeft: TREE_INDENT_STEP }}>
                                    <BranchSectionHeader
                                        label={remote}
                                        expanded={isExpanded}
                                        onToggle={() => toggleFolder(remoteKey)}
                                        leadingIcon={<RepoIcon />}
                                    />
                                </div>
                                {isExpanded &&
                                    group.tree.map((node, index) => (
                                        <BranchTreeNodeRow
                                            key={`remote-${remote}-${node.branch?.name ?? node.label}-${index}`}
                                            node={node}
                                            depth={2}
                                            selectedBranch={selectedBranch}
                                            selectedBranchNames={selectedBranchNames}
                                            expandedFolders={expandedFolders}
                                            onSelectBranch={onSelectBranch}
                                            onBranchClick={handleBranchRowClick}
                                            onToggleFolder={toggleFolder}
                                            onContextMenu={handleBranchContextMenu}
                                            filterNeedle={filterNeedle}
                                            prefix={`remote/${remote}`}
                                            folderIcon={folderIcon}
                                            folderExpandedIcon={folderExpandedIcon}
                                            folderIconsByName={folderIconsByName}
                                        />
                                    ))}
                            </div>
                        );
                    })}
                </div>
            )}

            {worktrees.length > 0 && (
                <>
                    <BranchSectionHeader
                        label={t("branch.section.worktrees")}
                        expanded={expandedSections.has("worktrees")}
                        onToggle={() => toggleSection("worktrees")}
                    />
                    {expandedSections.has("worktrees") && (
                        <div style={TREE_SECTION_STYLE}>
                            {filteredWorktrees.map((worktree) => (
                                <WorktreeRow
                                    key={worktree.path}
                                    worktree={worktree}
                                    filterNeedle={filterNeedle}
                                    onAction={onWorktreeAction}
                                    onContextMenu={handleWorktreeContextMenu}
                                    onOpenContextMenu={openWorktreeContextMenuFromRow}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}

            {filterNeedle &&
                locals.length === 0 &&
                remotes.length === 0 &&
                filteredWorktrees.length === 0 &&
                !current && <div style={NO_MATCH_STYLE}>{t("branch.noMatches")}</div>}

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
