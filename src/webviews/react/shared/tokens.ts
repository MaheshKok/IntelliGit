export const GRAPH_LANE_COLORS = [
    "#4CAF50",
    "#2196F3",
    "#FF9800",
    "#E91E63",
    "#9C27B0",
    "#00BCD4",
    "#FF5722",
    "#8BC34A",
    "#3F51B5",
    "#FFC107",
];

export const GIT_STATUS_COLORS: Record<string, string> = {
    M: "var(--vscode-gitDecoration-modifiedResourceForeground, #d19a66)",
    A: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
    D: "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
    R: "var(--vscode-gitDecoration-renamedResourceForeground, #a371f7)",
    U: "var(--vscode-gitDecoration-conflictingResourceForeground, #e5c07b)",
    "?": "var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)",
    C: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
    T: "var(--vscode-gitDecoration-modifiedResourceForeground, #d19a66)",
};

export const GIT_STATUS_LABELS: Record<string, string> = {
    M: "Modified",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    U: "Conflicting",
    "?": "Unversioned",
    C: "Copied",
    T: "Type Changed",
};

export const FILE_TYPE_BADGES: Record<string, { label: string; bg: string; fg?: string }> = {
    ts: { label: "TS", bg: "#3178c6" },
    tsx: { label: "TX", bg: "#3178c6" },
    js: { label: "JS", bg: "#f0db4f", fg: "#323330" },
    jsx: { label: "JX", bg: "#f0db4f", fg: "#323330" },
    json: { label: "JS", bg: "#5b5b5b" },
    md: { label: "M", bg: "#519aba" },
    css: { label: "CS", bg: "#563d7c" },
    scss: { label: "SC", bg: "#c6538c" },
    html: { label: "HT", bg: "#e44d26" },
    svg: { label: "SV", bg: "#ffb13b", fg: "#323330" },
    py: { label: "PY", bg: "#3572a5" },
    rs: { label: "RS", bg: "#dea584" },
    go: { label: "GO", bg: "#00add8" },
    yaml: { label: "YA", bg: "#cb171e" },
    yml: { label: "YA", bg: "#cb171e" },
    xml: { label: "XM", bg: "#f26522" },
    sh: { label: "SH", bg: "#4eaa25" },
    toml: { label: "TO", bg: "#9c4221" },
    lock: { label: "LK", bg: "#666" },
    gitignore: { label: "GI", bg: "#f34f29" },
    env: { label: "EN", bg: "#ecd53f", fg: "#323330" },
};

export const REF_BADGE_COLORS = {
    head: { bg: "#4CAF50", fg: "#fff" },
    tag: { bg: "#FF9800", fg: "#fff" },
    remote: { bg: "#2196F3", fg: "#fff" },
    local: { bg: "#6d6dea", fg: "#fff" },
};
