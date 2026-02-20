// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useMemo, useState, useCallback, useEffect } from "react";
import type { Branch, ThemeFolderIconMap, ThemeTreeIcon } from "../../types";
import { isBranchAction, type BranchAction } from "./commitGraphTypes";
import { ContextMenu } from "./shared/components/ContextMenu";
import { getBranchMenuItems } from "./branch-column/menu";
import { buildPrefixTree, buildRemoteGroups } from "./branch-column/treeModel";
import { BranchTreeNodeRow } from "./branch-column/components/BranchTreeNodeRow";
import { BranchSectionHeader } from "./branch-column/components/BranchSectionHeader";
import { BranchSearchBar } from "./branch-column/components/BranchSearchBar";
import { RepoIcon, TagIcon } from "./branch-column/icons";
import { getVsCodeApi } from "./shared/vscodeApi";
import {
    BRANCH_ROW_CLASS_CSS,
    HEAD_LABEL_STYLE,
    HEAD_ROW_STYLE,
    HEAD_WRAPPER_STYLE,
    NO_MATCH_STYLE,
    PANEL_STYLE,
    TREE_INDENT_STEP,
    TREE_SECTION_STYLE,
} from "./branch-column/styles";

interface Props {
    branches: Branch[];
    selectedBranch: string | null;
    onSelectBranch: (name: string | null) => void;
    onBranchAction: (action: BranchAction, branchName: string) => void;
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

const DEFAULT_EXPANDED_SECTIONS = ["local", "remote"];

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

export function BranchColumn({
    branches,
    selectedBranch,
    onSelectBranch,
    onBranchAction,
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
    } | null>(null);

    const filterNeedle = branchFilter.trim().toLowerCase();
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

    const handleBranchContextMenu = useCallback((event: React.MouseEvent, branch: Branch) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.currentTarget as HTMLElement;
        const { anchorX, anchorY } = computeAnchorPosition(row, event.clientX + 2);
        setContextMenu({ x: anchorX, y: anchorY, branch });
    }, []);

    const openBranchContextMenuFromRow = useCallback((row: HTMLElement, branch: Branch): void => {
        const rowRect = row.getBoundingClientRect();
        const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
        setContextMenu({ x: anchorX, y: anchorY, branch });
    }, []);

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            if (!isBranchAction(action)) return;
            onBranchAction(action, contextMenu.branch.name);
        },
        [contextMenu, onBranchAction],
    );

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

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
                        onClick={() => onSelectBranch(null)}
                        onContextMenu={(event) => handleBranchContextMenu(event, current)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                if (event.key === " ") event.preventDefault();
                                onSelectBranch(null);
                                return;
                            }
                            if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                            ) {
                                event.preventDefault();
                                openBranchContextMenuFromRow(
                                    event.currentTarget as HTMLElement,
                                    current,
                                );
                            }
                        }}
                        style={HEAD_ROW_STYLE}
                    >
                        <TagIcon />
                        <span style={HEAD_LABEL_STYLE}>HEAD ({current.name})</span>
                    </div>
                </div>
            )}

            <BranchSectionHeader
                label="Local"
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
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
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
                label="Remote"
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
                                            expandedFolders={expandedFolders}
                                            onSelectBranch={onSelectBranch}
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

            {filterNeedle && locals.length === 0 && remotes.length === 0 && !current && (
                <div style={NO_MATCH_STYLE}>No matching branches</div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getBranchMenuItems(contextMenu.branch, actualCurrent?.name ?? "HEAD")}
                    minWidth={310}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                />
            )}
        </div>
    );
}
