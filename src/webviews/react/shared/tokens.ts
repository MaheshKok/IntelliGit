/**
 * JetBrains New UI design tokens used as fallback values when VS Code theme
 * variables are unavailable.
 *
 * Color entries use `var(--vscode-*, <fallback>)` so the webview adapts to the
 * active VS Code theme. Hardcoded fallbacks match PyCharm 2023+ default dark
 * theme values. Size and graph tokens provide consistent spacing and hit targets
 * across all IntelliGit webview panels.
 */
export const JETBRAINS_UI = {
    color: {
        panel: "var(--vscode-sideBar-background, #2f3848)",
        editor: "var(--vscode-editor-background, #2b3342)",
        toolbar: "var(--vscode-editorGroupHeader-tabsBackground, #394354)",
        border: "var(--vscode-panel-border, rgba(158, 169, 190, 0.22))",
        divider: "var(--vscode-panel-border, #465066)",
        input: "var(--vscode-input-background, #202633)",
        inputBorder: "var(--vscode-input-border, rgba(160, 174, 205, 0.28))",
        foreground: "var(--vscode-foreground, #d7dce5)",
        muted: "var(--vscode-descriptionForeground, #9ca6b8)",
        selected: "var(--vscode-list-activeSelectionBackground, #4f5f7c)",
        selectedForeground: "var(--vscode-list-activeSelectionForeground, #eef3ff)",
        hover: "var(--vscode-list-hoverBackground, rgba(111, 126, 156, 0.24))",
        focus: "var(--vscode-focusBorder, #6aa2ff)",
        branch: "var(--vscode-charts-blue, #6da7ff)",
        tag: "var(--vscode-charts-orange, #d99b38)",
        head: "var(--vscode-charts-green, #79c76d)",
        currentBranch: "var(--vscode-charts-cyan, #7fd4cf)",
        graphBackground: "var(--vscode-editor-background, #2b3342)",
        graphBackgroundFallback: "#2b3342",
        graphRing: "var(--vscode-editor-background, #2b3342)",
        tooltipBackground: "var(--vscode-editorHoverWidget-background, #303848)",
        tooltipBorder: "var(--vscode-editorHoverWidget-border, rgba(164, 178, 205, 0.2))",
        menuBackground: "#2B2D30",
        menuBorder: "#43454A",
        menuForeground: "#BBBFC4",
        menuSeparator: "#3E4042",
        menuHint: "#6E7074",
        menuSelection: "#2E436E",
    },
    size: {
        icon: 14,
        rowHeight: 24,
        toolbarHeight: 32,
        splitter: 3,
        radius: 4,
        selectedRadius: 5,
        treeIndent: 18,
    },
    graph: {
        laneWidth: 10,
        maxWidth: 100,
        lineWidth: 1.5,
        mergeLineWidth: 1.3,
        dotRadius: 4.5,
        dotInnerRadius: 2,
        dotRingWidth: 2,
        leftPad: 2,
    },
} as const;

/**
 * Graph lane colors assigned round-robin to concurrent branches in the commit graph.
 *
 * The palette is ordered for visual contrast so adjacent lanes remain distinguishable
 * even when many branches are active. Colors are hardcoded because VS Code does not
 * provide graph-lane theming variables.
 */
export const GRAPH_LANE_COLORS = [
    "#7bcf6f",
    "#5da8ff",
    "#9b7be5",
    "#6cc9ba",
    "#d49b43",
    "#d86f6f",
    "#77b255",
    "#5a86d6",
    "#c084d2",
    "#d0b35a",
];

/**
 * Maps Git porcelain status codes to VS Code git-decoration theme colors.
 *
 * Each entry uses a VS Code theme variable with a JetBrains-matching fallback.
 * Callers look up single-character codes (`M`, `A`, `D`, `R`, `U`, `?`, `C`, `T`)
 * to color file status badges and tree icons consistently with the editor theme.
 */
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

/**
 * Human-readable labels for Git working-tree status codes.
 *
 * Used in tooltips and aria-labels where a single-character code is not
 * descriptive enough for screen-reader or hover context.
 */
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

/**
 * File extension to badge mapping used in the file tree and commit detail panes.
 *
 * Each entry provides a short label (1–2 characters) and a background color.
 * `fg` is optional and defaults to white when omitted. Callers look up the
 * file extension (lowercase, no dot) to render a compact file-type badge.
 */
export const FILE_TYPE_BADGES: Record<string, { label: string; bg: string; fg?: string }> = {
    ts: { label: "TS", bg: "#3178c6" },
    tsx: { label: "TX", bg: "#3178c6" },
    js: { label: "JS", bg: "#f0db4f", fg: "#323330" },
    jsx: { label: "JX", bg: "#f0db4f", fg: "#323330" },
    json: { label: "JN", bg: "#5b5b5b" },
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

/**
 * Background and foreground colors for commit ref badges (HEAD, tags, remote/local branches).
 *
 * Mapped through `JETBRAINS_UI` tokens so badge colors stay consistent with the
 * branch column and commit graph palette.
 */
export const REF_BADGE_COLORS = {
    head: { bg: JETBRAINS_UI.color.head, fg: "#fff" },
    tag: { bg: JETBRAINS_UI.color.tag, fg: "#fff" },
    remote: { bg: JETBRAINS_UI.color.branch, fg: "#fff" },
    local: { bg: "#7f8ee8", fg: "#fff" },
};
