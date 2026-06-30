import React from "react";
import type { Branch, ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { renderHighlightedLabel } from "../highlight";
import {
    ChevronIcon,
    GitBranchIcon,
    PullArrowIcon,
    PushArrowIcon,
    StarIcon,
    TagRightIcon,
    WorktreeSmallIcon,
} from "../../shared/components/Icons";
import { TreeFolderIcon } from "../../shared/components/TreeIcons";
import { JETBRAINS_UI } from "../../shared/tokens";
import { resolveFolderIcon } from "../../shared/utils/folderIcons";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";
import {
    BRANCH_TREE_GUIDE_BASE,
    BRANCH_TREE_INDENT_BASE,
    BRANCH_TREE_INDENT_STEP,
    DEFAULT_BRANCH_ICON_YELLOW,
    INDENT_GUIDE_STYLE,
    NODE_LABEL_STYLE,
    ROW_STYLE,
    TRACKING_BADGE_STYLE,
    TRACKING_PULL_STYLE,
    TRACKING_PUSH_STYLE,
    WORKTREE_BADGE_STYLE,
} from "../styles";
import type { TreeNode } from "../types";

const TRACKING_TOOLTIP_BASE_STYLE: React.CSSProperties = {
    position: "fixed",
    transform: "translate(-50%, -100%)",
    background: JETBRAINS_UI.color.tooltipBackground,
    color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
    border: `1px solid ${JETBRAINS_UI.color.tooltipBorder}`,
    borderRadius: JETBRAINS_UI.size.radius,
    fontSize: 12,
    lineHeight: "14px",
    padding: "3px 6px",
    whiteSpace: "nowrap",
    zIndex: 30,
    pointerEvents: "none",
    boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
};
const FOLDER_ICON_WRAPPER_STYLE: React.CSSProperties = {
    display: "inline-flex",
    marginRight: 4,
    flexShrink: 0,
};
const BRANCH_ICON_SPACER_STYLE: React.CSSProperties = {
    display: "inline-block",
    width: 14,
    marginRight: 4,
    flexShrink: 0,
};

/** Recursive branch-row inputs shared by folder rows and concrete branch rows. */
interface Props {
    node: TreeNode;
    depth: number;
    selectedBranch: string | null;
    selectedBranchNames?: Set<string>;
    expandedFolders: Set<string>;
    onSelectBranch: (name: string | null) => void;
    onBranchClick?: (event: React.MouseEvent, branchName: string) => void;
    onToggleFolder: (key: string) => void;
    onContextMenu: (event: React.MouseEvent, branch: Branch) => void;
    filterNeedle: string;
    prefix: string;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

/** Renders ahead/behind status only when the branch has remote tracking movement. */
function TrackingBadge({ branch }: { branch: Branch }): React.ReactElement | null {
    const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTooltipTimer = React.useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);
    const tooltipStyle = React.useMemo<React.CSSProperties | undefined>(
        () =>
            tooltipPos
                ? {
                      ...TRACKING_TOOLTIP_BASE_STYLE,
                      left: tooltipPos.x,
                      top: tooltipPos.y,
                  }
                : undefined,
        [tooltipPos],
    );

    React.useEffect(() => clearTooltipTimer, [clearTooltipTimer]);

    if (branch.ahead <= 0 && branch.behind <= 0) return null;
    const tooltipParts: string[] = [];
    if (branch.behind > 0) {
        tooltipParts.push(`${branch.behind} incoming commit${branch.behind === 1 ? "" : "s"}`);
    }
    if (branch.ahead > 0) {
        tooltipParts.push(`${branch.ahead} outgoing commit${branch.ahead === 1 ? "" : "s"}`);
    }
    const tooltipText = tooltipParts.join(" and ");

    /** Delays tooltip display using current settings while keeping pointer fallback positioning stable. */
    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const { hoverDelay, tooltipsEnabled } = getSettings();
        if (!tooltipsEnabled) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const newPos = {
            x: event.clientX > 0 ? event.clientX : rect.left + rect.width / 2,
            y: rect.top - 6,
        };

        if (tooltipPos) {
            setTooltipPos(newPos);
        } else {
            clearTooltipTimer();
            timerRef.current = setTimeout(() => {
                setTooltipPos(newPos);
            }, hoverDelay);
        }
    };

    /** Cancels pending tooltip work before hiding so rapid pointer movement cannot resurrect it. */
    const hideTooltip = (): void => {
        clearTooltipTimer();
        setTooltipPos(null);
    };

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
                    <PushArrowIcon />
                    {branch.ahead}
                </span>
            )}
            {branch.behind > 0 && (
                <span className="branch-track-pull" style={TRACKING_PULL_STYLE}>
                    <PullArrowIcon />
                    {branch.behind}
                </span>
            )}
            {tooltipPos && <span style={tooltipStyle}>{tooltipText}</span>}
        </span>
    );
}

/** Shows worktree occupancy without adding another branch-row action target. */
function WorktreeBadge({ branch }: { branch: Branch }): React.ReactElement | null {
    if (!branch.isCheckedOutInWorktree) return null;
    const label = branch.isCurrentWorktree
        ? t("branch.worktreeBadge.current")
        : t("branch.worktreeBadge.other");
    return (
        <span aria-label={label} title={label} style={WORKTREE_BADGE_STYLE}>
            <WorktreeSmallIcon
                color={
                    branch.isCurrentWorktree
                        ? DEFAULT_BRANCH_ICON_YELLOW
                        : JETBRAINS_UI.color.branch
                }
                style={{ marginRight: 0 }}
            />
        </span>
    );
}

/** Draws branch tree indentation guides without adding focusable elements to the row. */
function BranchIndentGuides({ depth }: { depth: number }): React.ReactElement | null {
    const guideStyles = React.useMemo<React.CSSProperties[]>(
        () =>
            Array.from({ length: Math.max(0, depth) }, (_, index) => ({
                ...INDENT_GUIDE_STYLE,
                left: BRANCH_TREE_GUIDE_BASE + index * BRANCH_TREE_INDENT_STEP,
            })),
        [depth],
    );

    if (depth <= 0) return null;
    return (
        <>
            {guideStyles.map((style, index) => (
                <span key={index} aria-hidden="true" style={style} />
            ))}
        </>
    );
}

/**
 * Recursive tree row renderer for the branch column.
 *
 * Folder nodes render as collapsible sections with chevron toggles and indent
 * guide lines. Branch nodes show the appropriate icon (current-branch tag,
 * star for main/master, or generic git-branch), highlighted search-match text,
 * and an ahead/behind tracking badge with a hover tooltip.
 *
 * Multi-select is supported through `selectedBranchNames`; when `onBranchClick`
 * is provided, single-select delegation is skipped in favor of the caller's
 * click handler. Keyboard activation uses Enter/Space with Space default-prevented
 * to avoid scroll-on-activate in webview panels.
 */
export function BranchTreeNodeRow({
    node,
    depth,
    selectedBranch,
    selectedBranchNames = new Set<string>(),
    expandedFolders,
    onSelectBranch,
    onBranchClick,
    onToggleFolder,
    onContextMenu,
    filterNeedle,
    prefix,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
}: Props): React.ReactElement {
    const isFolder = node.children.length > 0 && !node.branch;
    const folderKey = `${prefix}/${node.label}`;
    const isExpanded = expandedFolders.has(folderKey);
    const rowStyle = React.useMemo<React.CSSProperties>(
        () => ({
            ...ROW_STYLE,
            paddingLeft: BRANCH_TREE_INDENT_BASE + depth * BRANCH_TREE_INDENT_STEP,
        }),
        [depth],
    );

    if (isFolder) {
        const resolvedFolderIcon = resolveFolderIcon(
            node.label,
            isExpanded,
            folderIconsByName,
            folderIcon,
            folderExpandedIcon,
        );
        return (
            <>
                <button
                    type="button"
                    className="branch-row"
                    onClick={() => onToggleFolder(folderKey)}
                    aria-expanded={isExpanded}
                    style={rowStyle}
                >
                    <BranchIndentGuides depth={depth} />
                    <ChevronIcon expanded={isExpanded} />
                    <span data-branch-icon="folder" style={FOLDER_ICON_WRAPPER_STYLE}>
                        <TreeFolderIcon isExpanded={isExpanded} icon={resolvedFolderIcon} />
                    </span>
                    {/* Pure label highlighter, not a component invocation. */}
                    {/* react-doctor-disable-next-line react-doctor/no-render-in-render */}
                    <span>{renderHighlightedLabel(node.label, filterNeedle)}</span>
                </button>
                {isExpanded &&
                    node.children.map((child) => (
                        <BranchTreeNodeRow
                            key={`${folderKey}/${child.fullName ?? child.label}`}
                            node={child}
                            depth={depth + 1}
                            selectedBranch={selectedBranch}
                            selectedBranchNames={selectedBranchNames}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onBranchClick={onBranchClick}
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
    const isSelected =
        selectedBranch === node.fullName ||
        (node.fullName ? selectedBranchNames.has(node.fullName) : false);
    /** Delegates branch selection to multi-select handlers when present, otherwise selects directly. */
    const handleSelectBranch = (event: React.MouseEvent): void => {
        if (!node.fullName) return;
        if (onBranchClick) {
            onBranchClick(event, node.fullName);
            return;
        }
        onSelectBranch(node.fullName);
    };

    return (
        <button
            type="button"
            className={`branch-row${isSelected ? " selected" : ""}`}
            onClick={handleSelectBranch}
            onContextMenu={(event) => {
                if (node.branch) onContextMenu(event, node.branch);
            }}
            style={rowStyle}
        >
            <BranchIndentGuides depth={depth} />
            <span style={BRANCH_ICON_SPACER_STYLE} />
            {isCurrent ? (
                <TagRightIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : isMainLike ? (
                <StarIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : (
                <GitBranchIcon color={JETBRAINS_UI.color.branch} />
            )}
            {/* Pure label highlighter, not a component invocation. */}
            {/* react-doctor-disable-next-line react-doctor/no-render-in-render */}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(node.label, filterNeedle)}</span>
            {node.branch && <WorktreeBadge branch={node.branch} />}
            {node.branch && <TrackingBadge branch={node.branch} />}
        </button>
    );
}
