import React from "react";
import type { Branch, ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { renderHighlightedLabel } from "../highlight";
import { ChevronIcon, GitBranchIcon, StarIcon, TagRightIcon } from "../icons";
import { TreeFolderIcon } from "../../shared/components";
import { resolveFolderIcon } from "../../shared/utils";
import {
    NODE_LABEL_STYLE,
    ROW_STYLE,
    TRACKING_BADGE_STYLE,
    TRACKING_PULL_STYLE,
    TRACKING_PUSH_STYLE,
    TREE_INDENT_STEP,
} from "../styles";
import type { TreeNode } from "../types";

const BRANCH_TREE_ICON_BLUE = "var(--vscode-charts-blue, #58a6ff)";
const CURRENT_BRANCH_ICON_TEAL = "#7fd4cf";
const DEFAULT_BRANCH_ICON_YELLOW = "#f2c94c";

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
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

function TrackingBadge({ branch }: { branch: Branch }): React.ReactElement | null {
    if (branch.ahead <= 0 && branch.behind <= 0) return null;
    const tooltipParts: string[] = [];
    if (branch.behind > 0) {
        tooltipParts.push(`${branch.behind} incoming commit${branch.behind === 1 ? "" : "s"}`);
    }
    if (branch.ahead > 0) {
        tooltipParts.push(`${branch.ahead} outgoing commit${branch.ahead === 1 ? "" : "s"}`);
    }
    const tooltipText = tooltipParts.join(" and ");
    const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);

    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        setTooltipPos({
            x: event.clientX > 0 ? event.clientX : rect.left + rect.width / 2,
            y: rect.top - 6,
        });
    };

    const hideTooltip = (): void => setTooltipPos(null);

    return (
        <span
            style={TRACKING_BADGE_STYLE}
            data-branch-tooltip={tooltipText}
            onPointerEnter={showTooltip}
            onPointerMove={showTooltip}
            onPointerLeave={hideTooltip}
        >
            {branch.ahead > 0 && (
                <span className="branch-track-push" style={TRACKING_PUSH_STYLE}>
                    {"\u2B06"}
                    {branch.ahead}
                </span>
            )}
            {branch.behind > 0 && (
                <span className="branch-track-pull" style={TRACKING_PULL_STYLE}>
                    {"\u2B07"}
                    {branch.behind}
                </span>
            )}
            {tooltipPos && (
                <span
                    style={{
                        position: "fixed",
                        left: tooltipPos.x,
                        top: tooltipPos.y,
                        transform: "translate(-50%, -100%)",
                        background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                        color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                        border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                        borderRadius: 4,
                        fontSize: 11,
                        lineHeight: "14px",
                        padding: "3px 6px",
                        whiteSpace: "nowrap",
                        zIndex: 9999,
                        pointerEvents: "none",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                    }}
                >
                    {tooltipText}
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
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
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
    const resolvedFolderIcon = resolveFolderIcon(
        node.label,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );

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
                    <span
                        data-branch-icon="folder"
                        style={{ display: "inline-flex", marginRight: 4, flexShrink: 0 }}
                    >
                        <TreeFolderIcon isExpanded={isExpanded} icon={resolvedFolderIcon} />
                    </span>
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
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
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
            <span style={{ display: "inline-block", width: 14, marginRight: 4, flexShrink: 0 }} />
            {isCurrent ? (
                <TagRightIcon color={CURRENT_BRANCH_ICON_TEAL} />
            ) : isMainLike ? (
                <StarIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : (
                <GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />
            )}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(node.label, filterNeedle)}</span>
            {node.branch && <TrackingBadge branch={node.branch} />}
        </div>
    );
}
