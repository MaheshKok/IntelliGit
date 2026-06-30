// Renders the static branch sidebar sections after BranchColumn derives tree state.
// The parent keeps reducer state, persistence, and context-menu command wiring.
// This component only lays out current, local, remote, worktree, and empty-filter rows.

import React from "react";
import type { Branch, GitWorktree, ThemeFolderIconMap, ThemeTreeIcon } from "../../../types";
import type { WorktreeAction } from "../../protocol/commitGraphTypes";
import { renderHighlightedLabel } from "./highlight";
import type { RemoteGroup, TreeNode } from "./types";
import { BranchTreeNodeRow } from "./components/BranchTreeNodeRow";
import { BranchSectionHeader } from "./components/BranchSectionHeader";
import { RepoIcon, TagRightIcon, WorktreeSmallIcon } from "../shared/components/Icons";
import { JETBRAINS_UI } from "../shared/tokens";
import { t } from "../shared/i18n";
import {
    DEFAULT_BRANCH_ICON_YELLOW,
    HEAD_LABEL_STYLE,
    HEAD_ROW_STYLE,
    HEAD_WRAPPER_STYLE,
    NODE_LABEL_STYLE,
    NO_MATCH_STYLE,
    ROW_STYLE,
    TREE_INDENT_STEP,
    TREE_SECTION_STYLE,
} from "./styles";

/** Props for the presentational branch and worktree section renderer. */
export interface BranchColumnSectionsProps {
    current?: Branch;
    selectedBranch: string | null;
    expandedSections: Set<string>;
    expandedFolders: Set<string>;
    localTree: TreeNode[];
    remoteGroups: Map<string, RemoteGroup>;
    worktrees: GitWorktree[];
    filteredWorktrees: GitWorktree[];
    filterNeedle: string;
    locals: Branch[];
    remotes: Branch[];
    selectedBranchNames: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onSelectBranch: (name: string | null) => void;
    onClearSelectedBranches: () => void;
    onToggleSection: (key: string) => void;
    onToggleFolder: (key: string) => void;
    onBranchClick: (event: React.MouseEvent, branchName: string) => void;
    onBranchContextMenu: (event: React.MouseEvent, branch: Branch) => void;
    onOpenBranchContextMenuFromRow: (row: HTMLElement, branch: Branch) => void;
    onWorktreeAction?: (action: WorktreeAction, path: string) => void;
    onWorktreeContextMenu: (event: React.MouseEvent, worktree: GitWorktree) => void;
    onOpenWorktreeContextMenuFromRow: (row: HTMLElement, worktree: GitWorktree) => void;
}

/** Renders current, local, remote, worktree, and no-match branch sections. */
export function BranchColumnSections({
    current,
    selectedBranch,
    expandedSections,
    expandedFolders,
    localTree,
    remoteGroups,
    worktrees,
    filteredWorktrees,
    filterNeedle,
    locals,
    remotes,
    selectedBranchNames,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onSelectBranch,
    onClearSelectedBranches,
    onToggleSection,
    onToggleFolder,
    onBranchClick,
    onBranchContextMenu,
    onOpenBranchContextMenuFromRow,
    onWorktreeAction,
    onWorktreeContextMenu,
    onOpenWorktreeContextMenuFromRow,
}: BranchColumnSectionsProps): React.ReactElement {
    return (
        <>
            {current && (
                <div style={HEAD_WRAPPER_STYLE}>
                    <button
                        type="button"
                        className={`branch-row${selectedBranch === null ? " selected" : ""}`}
                        onClick={() => {
                            onClearSelectedBranches();
                            onSelectBranch(null);
                        }}
                        onContextMenu={(event) => onBranchContextMenu(event, current)}
                        onKeyDown={(event) => {
                            if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                            ) {
                                event.preventDefault();
                                onOpenBranchContextMenuFromRow(event.currentTarget, current);
                            }
                        }}
                        style={HEAD_ROW_STYLE}
                    >
                        <TagRightIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
                        <span style={HEAD_LABEL_STYLE}>
                            {t("branch.head.label", { name: current.name })}
                        </span>
                    </button>
                </div>
            )}

            <BranchSectionHeader
                label={t("branch.section.local")}
                expanded={expandedSections.has("local")}
                onToggle={() => onToggleSection("local")}
            />
            {expandedSections.has("local") && (
                <div style={TREE_SECTION_STYLE}>
                    {localTree.map((node) => (
                        <BranchTreeNodeRow
                            key={`local-${node.fullName ?? node.label}`}
                            node={node}
                            depth={1}
                            selectedBranch={selectedBranch}
                            selectedBranchNames={selectedBranchNames}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onBranchClick={onBranchClick}
                            onToggleFolder={onToggleFolder}
                            onContextMenu={onBranchContextMenu}
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
                onToggle={() => onToggleSection("remote")}
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
                                        onToggle={() => onToggleFolder(remoteKey)}
                                        leadingIcon={<RepoIcon />}
                                    />
                                </div>
                                {isExpanded &&
                                    group.tree.map((node) => (
                                        <BranchTreeNodeRow
                                            key={`remote-${remote}-${node.fullName ?? node.label}`}
                                            node={node}
                                            depth={2}
                                            selectedBranch={selectedBranch}
                                            selectedBranchNames={selectedBranchNames}
                                            expandedFolders={expandedFolders}
                                            onSelectBranch={onSelectBranch}
                                            onBranchClick={onBranchClick}
                                            onToggleFolder={onToggleFolder}
                                            onContextMenu={onBranchContextMenu}
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
                        onToggle={() => onToggleSection("worktrees")}
                    />
                    {expandedSections.has("worktrees") && (
                        <div style={TREE_SECTION_STYLE}>
                            {filteredWorktrees.map((worktree) => (
                                <WorktreeRow
                                    key={worktree.path}
                                    worktree={worktree}
                                    filterNeedle={filterNeedle}
                                    onAction={onWorktreeAction}
                                    onContextMenu={onWorktreeContextMenu}
                                    onOpenContextMenu={onOpenWorktreeContextMenuFromRow}
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
        </>
    );
}

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
        <button
            type="button"
            className="branch-row"
            data-worktree-path={worktree.path}
            title={worktree.path}
            onClick={activate}
            onContextMenu={(event) => onContextMenu(event, worktree)}
            onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    onOpenContextMenu(event.currentTarget, worktree);
                }
            }}
            style={{ ...ROW_STYLE, paddingLeft: TREE_INDENT_STEP }}
        >
            <WorktreeSmallIcon
                color={worktree.isCurrent ? DEFAULT_BRANCH_ICON_YELLOW : JETBRAINS_UI.color.branch}
            />
            {/* Pure label highlighter, not a component invocation. */}
            {/* react-doctor-disable-next-line react-doctor/no-render-in-render */}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(label, filterNeedle)}</span>
            {folderName !== label && (
                <span style={{ marginLeft: 6, opacity: 0.65, overflow: "hidden" }}>
                    {folderName}
                </span>
            )}
        </button>
    );
}
