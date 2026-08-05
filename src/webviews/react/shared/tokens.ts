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
 * Graph lane colors for dark themes, assigned round-robin to concurrent branches.
 *
 * The palette is ordered for visual contrast so adjacent lanes remain distinguishable
 * even when many branches are active. Colors are hardcoded because VS Code does not
 * provide graph-lane theming variables, which makes these the only colors the product
 * owns outright — so both themes have to be supplied explicitly. Every entry clears
 * 3:1 (WCAG 1.4.11, non-text) against a dark editor background.
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
 * Graph lane colors for light themes.
 *
 * A single palette cannot serve both themes: clearing 3:1 against white requires a
 * relative luminance at or below 0.175, while clearing it against the dark editor
 * background requires 0.20 or above. Same hues as {@link GRAPH_LANE_COLORS} with
 * lightness lowered, staggered so adjacent lanes differ in lightness as well as hue.
 * Every entry clears 3.5:1 against `#f3f3f3` and 3.9:1 against pure white.
 */
export const GRAPH_LANE_COLORS_LIGHT = [
    "#258d13",
    "#005cbb",
    "#7e54cc",
    "#005f52",
    "#b37300",
    "#b13c42",
    "#256700",
    "#4374cf",
    "#904da4",
    "#684900",
];

/**
 * Accent hues for the "color" toolbar-icon style.
 *
 * The pastels these replaced were tuned for a dark panel and fell to roughly
 * 1.5:1 on a light one. Each entry now takes its hue from a host token that
 * already ships light and dark values, then mixes in 30% of
 * `--vscode-icon-foreground` to pull the result toward whichever end of the
 * active theme is legible. That holds every entry above the 3:1 non-text
 * threshold (WCAG 1.4.11) on both, with no second hand-tuned palette. The
 * literal fallbacks are the original pastels and only render on a host that
 * defines no chart colors at all.
 *
 * Hue here is decoration: `iconStyle: "standard"` drops it entirely, and every
 * control carries a label and its own glyph, so nothing depends on color.
 */
function iconAccent(token: string, fallback: string): string {
    return `color-mix(in srgb, var(${token}, ${fallback}) 70%, var(--vscode-icon-foreground, #c5c5c5))`;
}

export const ICON_ACCENTS = {
    amber: iconAccent("--vscode-charts-yellow", "#f2c46d"),
    orange: iconAccent("--vscode-charts-orange", "#ff9e64"),
    sky: iconAccent("--vscode-charts-blue", "#8fd5ff"),
    cyan: iconAccent("--vscode-terminal-ansiCyan", "#4ec7d6"),
    violet: iconAccent("--vscode-charts-purple", "#c8a2ff"),
    pink: iconAccent("--vscode-terminal-ansiMagenta", "#f3b1cf"),
    green: iconAccent("--vscode-charts-green", "#a6e3a1"),
    danger: iconAccent("--vscode-charts-red", "#ff4d4f"),
} as const;

/**
 * The accent each toolbar action wears, and the rule that keeps them apart.
 *
 * Hue answers exactly one question in a toolbar — *which action is this?* — so
 * no two actions in the same bar may share one. Picking hues at the call site
 * had no arbiter, and three of them collided: shelf and show-diff both landed
 * on violet, while stash, expand-all and collapse-all all landed on pink. The
 * strip read as a rainbow and still failed to tell its buttons apart.
 *
 * `expandCollapse` is the one deliberate sharing. Expand and collapse are two
 * halves of one control, and a shared hue is what makes the eye read them as a
 * pair instead of as two unrelated buttons.
 *
 * Hues do repeat *across* bars — push is green in the tab bar, the
 * expand/collapse pair is green in the toolbar below it — because a bar is the
 * unit the eye scans. The tab bar is traffic with the remote; the panel
 * toolbars are work on the local repository. `toolbar-icon-accents.test.tsx`
 * enforces both halves of this rule, per bar.
 */
export const TOOLBAR_ICON_ACCENTS = {
    /** Tab bar — traffic with the remote. */
    sync: ICON_ACCENTS.violet,
    fetch: ICON_ACCENTS.cyan,
    pull: ICON_ACCENTS.sky,
    push: ICON_ACCENTS.green,
    /** Window chrome rather than Git, and the only such control in its bar. */
    dock: ICON_ACCENTS.amber,

    /** Panel toolbars — work on the local repository. */
    refresh: ICON_ACCENTS.cyan,
    rollback: ICON_ACCENTS.amber,
    viewOptions: ICON_ACCENTS.sky,
    groupBy: ICON_ACCENTS.sky,
    stash: ICON_ACCENTS.pink,
    shelf: ICON_ACCENTS.violet,
    showDiff: ICON_ACCENTS.orange,
    /** One hue, two buttons: see above. */
    expandCollapse: ICON_ACCENTS.green,
} as const;

/**
 * Which accents may appear together, by bar.
 *
 * The uniqueness rule is only meaningful per bar, so the bars have to be
 * written down somewhere a test can read them. Keeping the roster here rather
 * than in the test means adding a button to a toolbar and forgetting to widen
 * its roster fails loudly instead of silently escaping the rule.
 */
export const TOOLBAR_ACCENT_BARS = {
    tabBar: ["sync", "fetch", "pull", "push", "dock"],
    commitToolbar: [
        "refresh",
        "rollback",
        "viewOptions",
        "stash",
        "shelf",
        "showDiff",
        "expandCollapse",
    ],
    shelfToolbar: ["refresh", "groupBy", "expandCollapse"],
    stashToolbar: ["refresh", "showDiff", "groupBy", "expandCollapse"],
} as const satisfies Record<string, readonly (keyof typeof TOOLBAR_ICON_ACCENTS)[]>;

/**
 * Stacking order for layered surfaces, lowest to highest.
 *
 * Portalled surfaces have to out-rank in-flow content, but they only need to
 * out-rank each other by one step; `9999` and `10000` said nothing about which
 * surface was meant to win. The context menu sits at the top because it can be
 * opened from any of the surfaces below it.
 */
export const Z_INDEX = {
    /** In-flow content that paints over its immediate siblings. */
    raised: 1,
    /** Headers and rows pinned inside a scroll container. */
    sticky: 2,
    /** Hover surfaces that follow the cursor and take no clicks. */
    tooltip: 30,
    /** Dialogs and their backdrops. */
    modal: 50,
    /** Portalled popovers anchored to a control. */
    popover: 60,
    /** Portalled context menus. Always topmost. */
    menu: 70,
} as const;

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
 * Shared surface for commit ref badges (HEAD, tags, remote/local branches).
 *
 * Every ref badge uses the same background/foreground pair rather than a per-type
 * fill. VS Code guarantees these two tokens are legible together on every theme,
 * including user-authored ones; a per-type fill cannot make that guarantee, because
 * the fill follows the theme while the label color cannot follow it in pure CSS.
 * Ref type is carried by {@link REF_ACCENT_COLORS} on the leading icon and by the
 * ref name itself, so no information depends on the fill.
 */
export const REF_BADGE_SURFACE = {
    bg: "var(--vscode-badge-background, #4d5b78)",
    fg: "var(--vscode-badge-foreground, #eef3ff)",
};

/**
 * Per-type accent applied to the leading icon of a ref badge.
 *
 * Decorative reinforcement only: the icon glyph and the ref name already distinguish
 * type, so these carry no information on their own and are held to the 3:1 non-text
 * threshold rather than 4.5:1.
 */
export const REF_ACCENT_COLORS = {
    head: JETBRAINS_UI.color.head,
    tag: JETBRAINS_UI.color.tag,
    remote: JETBRAINS_UI.color.branch,
    local: JETBRAINS_UI.color.currentBranch,
};
