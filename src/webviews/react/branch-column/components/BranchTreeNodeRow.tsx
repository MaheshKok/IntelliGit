import React from "react";
import type { Branch } from "../../../../types";
import { renderHighlightedLabel } from "../highlight";
import { ChevronIcon, FolderIcon, GitBranchIcon, StarIcon, TagIcon } from "../icons";
import {
    NODE_LABEL_STYLE,
    ROW_STYLE,
    TRACKING_BADGE_STYLE,
    TRACKING_PULL_STYLE,
    TRACKING_PUSH_STYLE,
    TREE_INDENT_STEP,
} from "../styles";
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
    if (branch.ahead <= 0 && branch.behind <= 0) return null;

    return (
        <span style={TRACKING_BADGE_STYLE}>
            {branch.ahead > 0 && (
                <span
                    className="branch-track-push"
                    style={TRACKING_PUSH_STYLE}
                    title={`Ahead by ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"} (to push)`}
                >
                    {"\u2B06"}
                    {branch.ahead}
                </span>
            )}
            {branch.behind > 0 && (
                <span
                    className="branch-track-pull"
                    style={TRACKING_PULL_STYLE}
                    title={`Behind by ${branch.behind} commit${branch.behind === 1 ? "" : "s"} (to pull)`}
                >
                    {"\u2B07"}
                    {branch.behind}
                </span>
            )}
        </span>
    );
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
    const handleActivateKey = (
        event: React.KeyboardEvent<HTMLDivElement>,
        action: () => void,
    ): void => {
        if (event.key === "Enter" || event.key === " ") {
            if (event.key === " ") event.preventDefault();
            action();
        }
    };

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
                    onKeyDown={(event) => handleActivateKey(event, () => onToggleFolder(folderKey))}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
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
    const shortName = node.branch?.name.replace(/^.*\//, "") ?? "";
    const isMainLike = !!node.branch && (shortName === "main" || shortName === "master");
    const isSelected = selectedBranch === node.fullName;
    const handleSelectBranch = (): void => {
        if (!node.fullName) return;
        onSelectBranch(node.fullName);
    };

    return (
        <div
            className={`branch-row${isSelected ? " selected" : ""}`}
            onClick={handleSelectBranch}
            onKeyDown={(event) => handleActivateKey(event, handleSelectBranch)}
            onContextMenu={(event) => {
                if (node.branch) onContextMenu(event, node.branch);
            }}
            role="button"
            tabIndex={0}
            style={rowStyle}
        >
            {isCurrent ? <TagIcon /> : isMainLike ? <StarIcon /> : <GitBranchIcon />}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(node.label, filterNeedle)}</span>
            {node.branch && <TrackingBadge branch={node.branch} />}
        </div>
    );
}
