// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useMemo, useState, useCallback } from "react";
import type { Branch } from "../../types";
import { isBranchAction, type BranchAction } from "./commitGraphTypes";
import { ContextMenu } from "./shared/components/ContextMenu";
import { getBranchMenuItems } from "./branch-column/menu";
import { buildPrefixTree, buildRemoteGroups } from "./branch-column/treeModel";
import { BranchTreeNodeRow } from "./branch-column/components/BranchTreeNodeRow";
import { BranchSectionHeader } from "./branch-column/components/BranchSectionHeader";
import { BranchSearchBar } from "./branch-column/components/BranchSearchBar";
import { RepoIcon, TagIcon } from "./branch-column/icons";
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
}

export function BranchColumn({
    branches,
    selectedBranch,
    onSelectBranch,
    onBranchAction,
}: Props): React.ReactElement {
    const [branchFilter, setBranchFilter] = useState("");
    const [expandedSections, setExpandedSections] = useState<Set<string>>(
        () => new Set(["local", "remote"]),
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set<string>());
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

    const toggleSection = useCallback((key: string) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const toggleFolder = useCallback((key: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const handleBranchContextMenu = useCallback((event: React.MouseEvent, branch: Branch) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.currentTarget as HTMLElement;
        const rowRect = row.getBoundingClientRect();
        const firstIcon = row.querySelector("svg");
        const iconAnchorX = firstIcon
            ? firstIcon.getBoundingClientRect().right + 2
            : rowRect.left + 20;
        const anchorX = Math.max(iconAnchorX, event.clientX + 2);
        const anchorY = rowRect.top + 1;
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
                        onClick={() => onSelectBranch(null)}
                        onContextMenu={(event) => handleBranchContextMenu(event, current)}
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
