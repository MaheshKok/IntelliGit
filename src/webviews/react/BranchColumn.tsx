// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useState, useMemo, useCallback } from "react";
import { LuSearch, LuX } from "react-icons/lu";
import type { Branch } from "../../types";
import { ContextMenu, type MenuItem } from "./shared/components/ContextMenu";

const TREE_INDENT_STEP = 18;

interface Props {
    branches: Branch[];
    selectedBranch: string | null;
    onSelectBranch: (name: string | null) => void;
    onBranchAction: (action: string, branchName: string) => void;
}

interface TreeNode {
    label: string;
    fullName?: string;
    branch?: Branch;
    children: TreeNode[];
    isExpanded?: boolean;
}

function buildPrefixTree(branches: Branch[], nameMapper?: (b: Branch) => string): TreeNode[] {
    const root: TreeNode[] = [];
    for (const b of branches) {
        const displayName = nameMapper ? nameMapper(b) : b.name;
        const parts = displayName.split("/");
        if (parts.length === 1) {
            root.push({ label: displayName, fullName: b.name, branch: b, children: [] });
        } else {
            let current = root;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    current.push({ label: part, fullName: b.name, branch: b, children: [] });
                } else {
                    let folder = current.find((n) => n.label === part && !n.branch);
                    if (!folder) {
                        folder = { label: part, children: [], isExpanded: true };
                        current.push(folder);
                    }
                    current = folder.children;
                }
            }
        }
    }
    return root;
}

// --- Context menu items ---

// Middle-ellipsis: keeps start and end of branch name
function trim(name: string, max = 40): string {
    if (name.length <= max) return name;
    const endLen = Math.min(8, name.length);
    const startLen = max - 3 - endLen;
    return name.slice(0, startLen) + "..." + name.slice(-endLen);
}

function q(name: string): string {
    return `'${trim(name)}'`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedLabel(label: string, needle: string): React.ReactNode {
    if (!needle) return label;
    const regex = new RegExp(`(${escapeRegExp(needle)})`, "ig");
    const parts = label.split(regex);
    return (
        <>
            {parts.map((part, idx) =>
                part.toLowerCase() === needle.toLowerCase() ? (
                    <mark
                        key={`${part}-${idx}`}
                        style={{
                            background: "rgba(227, 196, 93, 0.95)",
                            color: "#1b1b1b",
                            borderRadius: 3,
                            padding: "0 1px",
                        }}
                    >
                        {part}
                    </mark>
                ) : (
                    <React.Fragment key={`${part}-${idx}`}>{part}</React.Fragment>
                ),
            )}
        </>
    );
}

function getMenuItems(branch: Branch, currentBranchName: string): MenuItem[] {
    const cur = q(currentBranchName);
    const sel = q(branch.name);

    if (branch.isCurrent) {
        return [
            { label: `New Branch from ${cur}...`, action: "newBranchFrom" },
            { label: "", action: "", separator: true },
            { label: "Update", action: "updateBranch" },
            { label: "Push...", action: "pushBranch" },
            { label: "", action: "", separator: true },
            { label: "Rename...", action: "renameBranch" },
        ];
    }

    if (branch.isRemote) {
        return [
            { label: "Checkout", action: "checkout" },
            { label: `New Branch from ${sel}...`, action: "newBranchFrom" },
            { label: `Checkout and Rebase onto ${cur}`, action: "checkoutAndRebase" },
            { label: "", action: "", separator: true },
            { label: `Rebase ${cur} onto ${sel}`, action: "rebaseCurrentOnto" },
            { label: `Merge ${sel} into ${cur}`, action: "mergeIntoCurrent" },
            { label: "", action: "", separator: true },
            { label: "Update", action: "updateBranch" },
            { label: "", action: "", separator: true },
            { label: "Delete", action: "deleteBranch" },
        ];
    }

    // Local non-current branch
    return [
        { label: "Checkout", action: "checkout" },
        { label: `New Branch from ${sel}...`, action: "newBranchFrom" },
        { label: `Checkout and Rebase onto ${cur}`, action: "checkoutAndRebase" },
        { label: "", action: "", separator: true },
        { label: `Rebase ${cur} onto ${sel}`, action: "rebaseCurrentOnto" },
        { label: `Merge ${sel} into ${cur}`, action: "mergeIntoCurrent" },
        { label: "", action: "", separator: true },
        { label: "Update", action: "updateBranch" },
        { label: "Push...", action: "pushBranch" },
        { label: "", action: "", separator: true },
        { label: "Rename...", action: "renameBranch" },
        { label: "Delete", action: "deleteBranch" },
    ];
}

// --- Main component ---

export function BranchColumn({
    branches,
    selectedBranch,
    onSelectBranch,
    onBranchAction,
}: Props): React.ReactElement {
    const [branchFilter, setBranchFilter] = useState("");
    const filterNeedle = branchFilter.trim().toLowerCase();
    const actualCurrent = useMemo(() => branches.find((b) => b.isCurrent), [branches]);

    const filteredBranches = useMemo(() => {
        if (!filterNeedle) return branches;
        return branches.filter((b) => b.name.toLowerCase().includes(filterNeedle));
    }, [branches, filterNeedle]);

    const current = useMemo(() => {
        if (!actualCurrent) return undefined;
        if (!filterNeedle) return actualCurrent;
        return actualCurrent.name.toLowerCase().includes(filterNeedle) ? actualCurrent : undefined;
    }, [actualCurrent, filterNeedle]);

    const locals = useMemo(() => filteredBranches.filter((b) => !b.isRemote), [filteredBranches]);
    const remotes = useMemo(() => filteredBranches.filter((b) => b.isRemote), [filteredBranches]);

    const localTree = useMemo(() => buildPrefixTree(locals), [locals]);

    const remoteGroups = useMemo(() => {
        const groups = new Map<string, { branches: Branch[]; tree: TreeNode[] }>();
        for (const b of remotes) {
            const remote = b.remote ?? b.name.split("/")[0];
            if (!groups.has(remote)) groups.set(remote, { branches: [], tree: [] });
            groups.get(remote)!.branches.push(b);
        }
        for (const [, group] of groups) {
            const stripRemote = (b: Branch) => b.name.split("/").slice(1).join("/");
            group.tree = buildPrefixTree(group.branches, stripRemote);
        }
        return groups;
    }, [remotes]);

    const [expandedSections, setExpandedSections] = useState<Set<string>>(
        () => new Set(["local", "remote"]),
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set<string>());
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        branch: Branch;
    } | null>(null);

    const toggleSection = (key: string) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const toggleFolder = (key: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const handleBranchContextMenu = useCallback((e: React.MouseEvent, branch: Branch) => {
        e.preventDefault();
        e.stopPropagation();
        const row = e.currentTarget as HTMLElement;
        const rowRect = row.getBoundingClientRect();
        const firstIcon = row.querySelector("svg");
        const iconAnchorX = firstIcon
            ? firstIcon.getBoundingClientRect().right + 2
            : rowRect.left + 20;
        const anchorX = Math.max(iconAnchorX, e.clientX + 2);
        const anchorY = rowRect.top + 1;
        setContextMenu({ x: anchorX, y: anchorY, branch });
    }, []);

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (contextMenu) {
                onBranchAction(action, contextMenu.branch.name);
            }
        },
        [contextMenu, onBranchAction],
    );

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    return (
        <div
            style={{
                height: "100%",
                overflow: "auto",
                fontSize: "12px",
                borderRight: "1px solid var(--vscode-panel-border)",
                userSelect: "none",
            }}
        >
            <style>{`
                .branch-row:hover {
                    background: var(--vscode-list-hoverBackground) !important;
                }
                .branch-row.selected {
                    background: rgba(120, 138, 179, 0.32) !important;
                    color: var(--vscode-list-activeSelectionForeground) !important;
                    border-radius: 7px;
                }
                .branch-row.selected:hover {
                    background: rgba(120, 138, 179, 0.32) !important;
                    color: var(--vscode-list-activeSelectionForeground) !important;
                }
            `}</style>
            <div
                style={{
                    minHeight: 22,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "1px 8px",
                    color: "#77d4cf",
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
            >
                <LuSearch size={16} style={{ opacity: 0.95, flexShrink: 0 }} />
                <input
                    type="text"
                    aria-label="Search branches"
                    placeholder="Search branches"
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    style={{
                        flex: 1,
                        minWidth: 0,
                        height: 18,
                        borderRadius: 3,
                        border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.15))",
                        background: "var(--vscode-input-background, rgba(0,0,0,0.22))",
                        color: "var(--vscode-input-foreground, #d8dbe2)",
                        padding: "0 6px",
                        fontSize: 12,
                        outline: "none",
                    }}
                />
                {branchFilter.length > 0 && (
                    <button
                        type="button"
                        aria-label="Clear branch search"
                        title="Clear"
                        onClick={() => setBranchFilter("")}
                        style={{
                            width: 16,
                            height: 16,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--vscode-descriptionForeground, #9ea4b3)",
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            flexShrink: 0,
                            lineHeight: "14px",
                        }}
                    >
                        <LuX size={14} />
                    </button>
                )}
            </div>
            {/* HEAD */}
            {current && (
                <div style={{ padding: "2px 10px 1px" }}>
                    <div
                        className={`branch-row${selectedBranch === null ? " selected" : ""}`}
                        onClick={() => onSelectBranch(null)}
                        onContextMenu={(e) => handleBranchContextMenu(e, current)}
                        style={{
                            ...rowStyle,
                            fontWeight: 600,
                            fontSize: "13px",
                            paddingLeft: 8,
                        }}
                    >
                        <TagIcon />
                        <span style={{ opacity: 0.95 }}>HEAD ({current.name})</span>
                    </div>
                </div>
            )}

            {/* Local */}
            <SectionHeader
                label="Local"
                expanded={expandedSections.has("local")}
                onToggle={() => toggleSection("local")}
            />
            {expandedSections.has("local") && (
                <div style={{ paddingLeft: 4 }}>
                    {localTree.map((node, index) => (
                        <TreeNodeRow
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

            {/* Remote */}
            <SectionHeader
                label="Remote"
                expanded={expandedSections.has("remote")}
                onToggle={() => toggleSection("remote")}
            />
            {expandedSections.has("remote") && (
                <div style={{ paddingLeft: 4 }}>
                    {Array.from(remoteGroups.entries()).map(([remote, group]) => {
                        const remoteKey = `remote-${remote}`;
                        const isExpanded = expandedFolders.has(remoteKey);
                        return (
                            <div key={remote}>
                                <div
                                    className="branch-row"
                                    onClick={() => toggleFolder(remoteKey)}
                                    style={{ ...rowStyle, paddingLeft: TREE_INDENT_STEP }}
                                >
                                    <ChevronIcon expanded={isExpanded} />
                                    <RepoIcon />
                                    <span>{remote}</span>
                                </div>
                                {isExpanded &&
                                    group.tree.map((node, index) => (
                                        <TreeNodeRow
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
                <div
                    style={{
                        padding: "6px 12px",
                        fontSize: 11,
                        opacity: 0.7,
                    }}
                >
                    No matching branches
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getMenuItems(contextMenu.branch, actualCurrent?.name ?? "HEAD")}
                    minWidth={340}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                />
            )}
        </div>
    );
}

function TreeNodeRow({
    node,
    depth,
    selectedBranch,
    expandedFolders,
    onSelectBranch,
    onToggleFolder,
    onContextMenu,
    filterNeedle,
    prefix,
}: {
    node: TreeNode;
    depth: number;
    selectedBranch: string | null;
    expandedFolders: Set<string>;
    onSelectBranch: (name: string | null) => void;
    onToggleFolder: (key: string) => void;
    onContextMenu: (e: React.MouseEvent, branch: Branch) => void;
    filterNeedle: string;
    prefix: string;
}): React.ReactElement {
    const isFolder = node.children.length > 0 && !node.branch;
    const folderKey = `${prefix}/${node.label}`;
    const isExpanded = expandedFolders.has(folderKey);

    if (isFolder) {
        return (
            <>
                <div
                    className="branch-row"
                    onClick={() => onToggleFolder(folderKey)}
                    style={{ ...rowStyle, paddingLeft: depth * TREE_INDENT_STEP }}
                >
                    <ChevronIcon expanded={isExpanded} />
                    <FolderIcon />
                    <span>{renderHighlightedLabel(node.label, filterNeedle)}</span>
                </div>
                {isExpanded &&
                    node.children.map((child, index) => (
                        <TreeNodeRow
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
            onContextMenu={(e) => {
                if (node.branch) onContextMenu(e, node.branch);
            }}
            style={{
                ...rowStyle,
                paddingLeft: depth * TREE_INDENT_STEP,
            }}
        >
            {isCurrent ? (
                <TagIcon />
            ) : isMainLike ? (
                <StarIcon />
            ) : (
                <GitBranchIcon color="#59c3ff" />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                {renderHighlightedLabel(node.label, filterNeedle)}
            </span>
            {node.branch && <TrackingBadge branch={node.branch} />}
        </div>
    );
}

function SectionHeader({
    label,
    expanded,
    onToggle,
}: {
    label: string;
    expanded: boolean;
    onToggle: () => void;
}): React.ReactElement {
    return (
        <div
            onClick={onToggle}
            style={{
                ...rowStyle,
                fontWeight: 600,
                fontSize: "11px",
                opacity: 0.82,
                paddingLeft: 8,
                marginTop: 1,
                marginBottom: 0,
            }}
        >
            <ChevronIcon expanded={expanded} />
            <span>{label}</span>
        </div>
    );
}

function TrackingBadge({ branch }: { branch: Branch }): React.ReactElement | null {
    const parts: string[] = [];
    if (branch.ahead > 0) parts.push(`\u2191${branch.ahead}`);
    if (branch.behind > 0) parts.push(`\u2193${branch.behind}`);
    if (parts.length === 0) return null;
    return (
        <span style={{ marginLeft: "auto", fontSize: "10px", opacity: 0.6, flexShrink: 0 }}>
            {parts.join(" ")}
        </span>
    );
}

function GitBranchIcon({ color }: { color?: string }): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" style={{ flexShrink: 0, marginRight: 4 }}>
            <path
                fill={color ?? "currentColor"}
                d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6.5a.5.5 0 0 1-.5.5H9.25a1.75 1.75 0 0 0-1.75 1.75v.872a2.25 2.25 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.256A3.25 3.25 0 0 1 9.25 6.5H12V5.372a2.25 2.25 0 0 1-2.5-2.122zM4.25 3.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM4.25 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"
            />
        </svg>
    );
}

function TagIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" style={{ flexShrink: 0, marginRight: 4 }}>
            <path
                fill="#86d8cf"
                d="M9.28 1.5H5.5A2.5 2.5 0 0 0 3 4v8a2.5 2.5 0 0 0 2.5 2.5h3.78a1.5 1.5 0 0 0 1.06-.44l3.72-3.72a1.5 1.5 0 0 0 0-2.12L10.34 1.94a1.5 1.5 0 0 0-1.06-.44zM5.5 3h3.78l3.72 3.72-3.72 3.72H5.5A1 1 0 0 1 4.5 9.44V4A1 1 0 0 1 5.5 3zm1.25 2a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
            />
        </svg>
    );
}

function StarIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" style={{ flexShrink: 0, marginRight: 4 }}>
            <path
                fill="#ebd25d"
                d="M8 1.5l1.8 3.64 4.02.58-2.91 2.83.69 4-3.6-1.9-3.6 1.9.69-4L2.18 5.72l4.02-.58L8 1.5z"
            />
        </svg>
    );
}

function ChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            style={{
                flexShrink: 0,
                marginRight: 4,
                opacity: 0.68,
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.1s",
            }}
        >
            <path fill="currentColor" d="M6 4l4 4-4 4z" />
        </svg>
    );
}

function FolderIcon(): React.ReactElement {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            style={{ flexShrink: 0, marginRight: 4, opacity: 0.7 }}
        >
            <path
                fill="#bdc3cf"
                d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"
            />
        </svg>
    );
}

function RepoIcon(): React.ReactElement {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            style={{ flexShrink: 0, marginRight: 4, opacity: 0.7 }}
        >
            <path
                fill="#bdc3cf"
                d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8zM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2z"
            />
        </svg>
    );
}

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "2px 8px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: "20px",
};
