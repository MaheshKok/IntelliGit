import React from "react";
import type { Branch } from "../../../../types";
import { renderHighlightedLabel } from "../highlight";
import { ChevronIcon, FolderIcon, GitBranchIcon, StarIcon, TagIcon } from "../icons";
import { NODE_LABEL_STYLE, ROW_STYLE, TRACKING_BADGE_STYLE, TREE_INDENT_STEP } from "../styles";
import type { TreeNode } from "../types";

interface Props {
    node: TreeNode;
    depth: number;
    selectedBranch: string | null;
    expandedFolders: Set<string>;
    onSelectBranch: (name: string | null) => void;
    onToggleFolder: (key: string) => void;
    onContextMenu: (event: React.MouseEvent, branch: Branch) => void;
    filterNeedle: string;
    prefix: string;
}

function TrackingBadge({ branch }: { branch: Branch }): React.ReactElement | null {
    const parts: string[] = [];
    if (branch.ahead > 0) parts.push(`\u2191${branch.ahead}`);
    if (branch.behind > 0) parts.push(`\u2193${branch.behind}`);
    if (parts.length === 0) return null;

    return <span style={TRACKING_BADGE_STYLE}>{parts.join(" ")}</span>;
}

export function BranchTreeNodeRow({
    node,
    depth,
    selectedBranch,
    expandedFolders,
    onSelectBranch,
    onToggleFolder,
    onContextMenu,
    filterNeedle,
    prefix,
}: Props): React.ReactElement {
    const isFolder = node.children.length > 0 && !node.branch;
    const folderKey = `${prefix}/${node.label}`;
    const isExpanded = expandedFolders.has(folderKey);
    const rowStyle = { ...ROW_STYLE, paddingLeft: depth * TREE_INDENT_STEP };

    if (isFolder) {
        return (
            <>
                <div
                    className="branch-row"
                    onClick={() => onToggleFolder(folderKey)}
                    style={rowStyle}
                >
                    <ChevronIcon expanded={isExpanded} />
                    <FolderIcon />
                    <span>{renderHighlightedLabel(node.label, filterNeedle)}</span>
                </div>
                {isExpanded &&
                    node.children.map((child, index) => (
                        <BranchTreeNodeRow
                            key={`${folderKey}/${child.branch?.name ?? child.label}-${index}`}
                            node={child}
                            depth={depth + 1}
                            selectedBranch={selectedBranch}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onToggleFolder={onToggleFolder}
                            onContextMenu={onContextMenu}
                            filterNeedle={filterNeedle}
                            prefix={folderKey}
                        />
                    ))}
            </>
        );
    }

    const isCurrent = node.branch?.isCurrent;
    const isMainLike =
        node.branch && (node.branch.name === "main" || node.branch.name === "master");
    const isSelected = selectedBranch === node.fullName;

    return (
        <div
            className={`branch-row${isSelected ? " selected" : ""}`}
            onClick={() => onSelectBranch(node.fullName!)}
            onContextMenu={(event) => {
                if (node.branch) onContextMenu(event, node.branch);
            }}
            style={rowStyle}
        >
            {isCurrent ? <TagIcon /> : isMainLike ? <StarIcon /> : <GitBranchIcon />}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(node.label, filterNeedle)}</span>
            {node.branch && <TrackingBadge branch={node.branch} />}
        </div>
    );
}
