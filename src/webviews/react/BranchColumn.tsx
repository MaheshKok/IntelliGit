// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { Branch } from "../../types";

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

interface MenuItem {
    label: string;
    action: string;
    separator?: boolean;
}

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

function getMenuItems(branch: Branch, currentBranchName: string): MenuItem[] {
    const cur = q(currentBranchName);
    const sel = q(branch.name);

    if (branch.isCurrent) {
        return [
            { label: `New Branch from ${cur}...`, action: "newBranchFrom" },
            { label: "", action: "", separator: true },
            { label: "Show Diff with Working Tree", action: "showDiffWithWorkingTree" },
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
            { label: `Compare with ${cur}`, action: "compareWithCurrent" },
            { label: "Show Diff with Working Tree", action: "showDiffWithWorkingTree" },
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
        { label: `Compare with ${cur}`, action: "compareWithCurrent" },
        { label: "Show Diff with Working Tree", action: "showDiffWithWorkingTree" },
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

// --- Context menu component ---

function ContextMenu({
    x,
    y,
    items,
    onSelect,
    onClose,
}: {
    x: number;
    y: number;
    items: MenuItem[];
    onSelect: (action: string) => void;
    onClose: () => void;
}): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    // Clamp to viewport after first render so the menu never goes off-screen
    useLayoutEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 4;
        let left = x;
        let top = y;
        if (top + rect.height > vh - pad) {
            top = Math.max(pad, vh - rect.height - pad);
        }
        if (left + rect.width > vw - pad) {
            left = Math.max(pad, vw - rect.width - pad);
        }
        setPos({ left, top });
    }, [x, y]);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const handleBlur = () => onClose();
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("blur", handleBlur);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("blur", handleBlur);
        };
    }, [onClose]);

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                background: "var(--vscode-editor-background)",
                border: "1px solid var(--vscode-panel-border, var(--vscode-widget-border, #3c3f41))",
                borderRadius: 4,
                padding: "4px 0",
                zIndex: 9999,
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                minWidth: 340,
                maxWidth: 640,
            }}
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return (
                        <div
                            key={`sep-${i}`}
                            style={{
                                height: 1,
                                background:
                                    "var(--vscode-panel-border, var(--vscode-widget-border, #3c3f41))",
                                margin: "4px 0",
                            }}
                        />
                    );
                }
                return (
                    <div
                        key={item.action}
                        onClick={() => {
                            onSelect(item.action);
                            onClose();
                        }}
                        style={{
                            padding: "4px 20px",
                            cursor: "pointer",
                            fontSize: "12px",
                            whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background =
                                "var(--vscode-list-activeSelectionBackground)";
                            (e.currentTarget as HTMLDivElement).style.color =
                                "var(--vscode-list-activeSelectionForeground)";
                        }}
                        onMouseLeave={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background = "";
                            (e.currentTarget as HTMLDivElement).style.color = "";
                        }}
                    >
                        {item.label}
                    </div>
                );
            })}
        </div>
    );
}

// --- Main component ---

export function BranchColumn({
    branches,
    selectedBranch,
    onSelectBranch,
    onBranchAction,
}: Props): React.ReactElement {
    const current = branches.find((b) => b.isCurrent);
    const locals = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);
    const remotes = useMemo(() => branches.filter((b) => b.isRemote), [branches]);

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
        setContextMenu({ x: e.clientX, y: e.clientY, branch });
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
                    background: var(--vscode-list-activeSelectionBackground) !important;
                    color: var(--vscode-list-activeSelectionForeground) !important;
                }
                .branch-row.selected:hover {
                    background: var(--vscode-list-activeSelectionBackground) !important;
                    color: var(--vscode-list-activeSelectionForeground) !important;
                }
            `}</style>
            {/* HEAD */}
            {current && (
                <div style={{ padding: "4px 0" }}>
                    <div
                        className={`branch-row${selectedBranch === null ? " selected" : ""}`}
                        onClick={() => onSelectBranch(null)}
                        onContextMenu={(e) => handleBranchContextMenu(e, current)}
                        style={{
                            ...rowStyle,
                            fontWeight: 600,
                        }}
                    >
                        <GitBranchIcon color="#4CAF50" />
                        <span>HEAD &rarr; {current.name}</span>
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
                <div>
                    {localTree.map((node) => (
                        <TreeNodeRow
                            key={node.label}
                            node={node}
                            depth={1}
                            selectedBranch={selectedBranch}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onToggleFolder={toggleFolder}
                            onContextMenu={handleBranchContextMenu}
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
                <div>
                    {Array.from(remoteGroups.entries()).map(([remote, group]) => {
                        const remoteKey = `remote-${remote}`;
                        const isExpanded = expandedFolders.has(remoteKey);
                        return (
                            <div key={remote}>
                                <div
                                    className="branch-row"
                                    onClick={() => toggleFolder(remoteKey)}
                                    style={{ ...rowStyle, paddingLeft: 12 }}
                                >
                                    <ChevronIcon expanded={isExpanded} />
                                    <RepoIcon />
                                    <span>{remote}</span>
                                </div>
                                {isExpanded &&
                                    group.tree.map((node) => (
                                        <TreeNodeRow
                                            key={node.label}
                                            node={node}
                                            depth={2}
                                            selectedBranch={selectedBranch}
                                            expandedFolders={expandedFolders}
                                            onSelectBranch={onSelectBranch}
                                            onToggleFolder={toggleFolder}
                                            onContextMenu={handleBranchContextMenu}
                                            prefix={`remote/${remote}`}
                                        />
                                    ))}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getMenuItems(contextMenu.branch, current?.name ?? "HEAD")}
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
    prefix,
}: {
    node: TreeNode;
    depth: number;
    selectedBranch: string | null;
    expandedFolders: Set<string>;
    onSelectBranch: (name: string | null) => void;
    onToggleFolder: (key: string) => void;
    onContextMenu: (e: React.MouseEvent, branch: Branch) => void;
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
                    style={{ ...rowStyle, paddingLeft: depth * 12 }}
                >
                    <ChevronIcon expanded={isExpanded} />
                    <FolderIcon />
                    <span>{node.label}</span>
                </div>
                {isExpanded &&
                    node.children.map((child) => (
                        <TreeNodeRow
                            key={child.label}
                            node={child}
                            depth={depth + 1}
                            selectedBranch={selectedBranch}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onToggleFolder={onToggleFolder}
                            onContextMenu={onContextMenu}
                            prefix={folderKey}
                        />
                    ))}
            </>
        );
    }

    const isCurrent = node.branch?.isCurrent;
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
                paddingLeft: depth * 12,
            }}
        >
            <GitBranchIcon color={isCurrent ? "#4CAF50" : undefined} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.label}</span>
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
                textTransform: "uppercase",
                opacity: 0.7,
                paddingLeft: 4,
                marginTop: 4,
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

function ChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            style={{
                flexShrink: 0,
                marginRight: 2,
                opacity: 0.6,
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
                fill="currentColor"
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
                fill="currentColor"
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
    lineHeight: "22px",
};
