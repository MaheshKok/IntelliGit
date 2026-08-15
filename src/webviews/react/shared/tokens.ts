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
        panel: "var(--vscode-sideBar-background, var(--vscode-editor-background, #2f3848))",
        editor: "var(--vscode-editor-background, #2b3342)",
        // HC Light and HC Black omit --vscode-editorGroupHeader-tabsBackground, so the
        // dark fallback paints a wrong-polarity, low-contrast header surface. Chain
        // through --vscode-editor-background to preserve the host's readable polarity.
        toolbar:
            "var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #394354))",
        // HC Light and HC Black omit --vscode-editorGroupHeader-tabsBackground, so the
        // dark fallback paints a wrong-polarity, low-contrast section header. Chain
        // through --vscode-editor-background to preserve the host's readable polarity.
        sectionHeader:
            "var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #394354)))",
        border: "var(--vscode-panel-border, #465066)",
        divider: "var(--vscode-panel-border, #465066)",
        sidebarBorder: "var(--vscode-sideBar-border, var(--vscode-panel-border, #465066))",
        input: "var(--vscode-input-background, #202633)",
        inputBorder: "var(--vscode-input-border, rgba(160, 174, 205, 0.28))",
        foreground: "var(--vscode-foreground, #d7dce5)",
        // Pulled toward the host foreground so secondary text clears the 4.5:1 floor on
        // selected and high-contrast rows, without erasing the semantic hue: measured
        // across all four fixture themes the mixed value stays 28-46/255 away from plain
        // foreground, so "muted" still reads as muted. (Light Modern is the exception, and
        // not one this token causes -- that theme defines descriptionForeground as #3b3b3b,
        // the same value as foreground, so muted and primary were already identical there.)
        //
        // The mix lives on the base token rather than a `mutedText` twin beside it. A twin
        // only covers the consumers someone remembers to repoint: every one of these three
        // tokens is read through two mechanisms -- the `--intelligit-pycharm-*` custom
        // property AND a direct `JETBRAINS_UI.color.*` read -- and repointing only the
        // custom property in theme.ts left 7 of muted's 27 consumers (branch column, commit
        // list, checks popover) painting the old failing colour on the same surfaces. Every
        // reachable consumer of these three paints text, so there is no second value to keep.
        muted: "color-mix(in srgb, var(--vscode-descriptionForeground, #9ca6b8) 60%, var(--vscode-foreground, #d7dce5))",
        disabled: "var(--vscode-disabledForeground, rgba(215, 220, 229, 0.55))",
        // The branch-count badge is already faded to 85%; keep its blue identity while
        // bringing the resolved colour toward the host foreground for selected HC rows.
        branchText:
            "color-mix(in srgb, var(--vscode-charts-blue, #6da7ff) 15%, var(--vscode-foreground, #d7dce5))",
        // Merge rows remain visibly dimmer than primary rows, but no longer inherit a
        // half-alpha disabled foreground that becomes unreadable on a light surface.
        mergeForeground:
            "color-mix(in srgb, var(--vscode-disabledForeground, var(--vscode-foreground, #d7dce5)) 25%, var(--vscode-foreground, #d7dce5))",
        selected: "var(--vscode-list-activeSelectionBackground, #4f5f7c)",
        // Chained through --vscode-foreground on purpose. VS Code only emits a CSS variable
        // for colors the active theme actually defines, and neither High Contrast theme
        // defines list.activeSelectionForeground -- so a bare literal fallback here is what
        // those themes get. #eef3ff is a near-white picked for dark backgrounds; against HC
        // Light's white selection it renders at a 1.06:1 contrast ratio, i.e. invisible, in
        // the theme specifically intended for users who need contrast.
        selectedForeground:
            "var(--vscode-list-activeSelectionForeground, var(--vscode-foreground, #eef3ff))",
        hover: "var(--vscode-list-hoverBackground, rgba(111, 126, 156, 0.24))",
        toolbarHover: "var(--vscode-toolbar-hoverBackground, rgba(111, 126, 156, 0.24))",
        focus: "var(--vscode-focusBorder, #6aa2ff)",
        primary: "var(--vscode-button-background, #5572d9)",
        primaryHover: "var(--vscode-button-hoverBackground, #6382eb)",
        primaryForeground: "var(--vscode-button-foreground, #ffffff)",
        // These three are deliberately NOT mixed toward the foreground the way `muted`
        // above is, and the difference is not an oversight.
        //
        // `muted` carries no meaning beyond "less important", so trading its chroma for
        // contrast costs nothing. These three ARE the meaning: green is added, red is
        // deleted. Measured across the four host fixtures, a 55% mix toward the
        // foreground shifted hue by under 1 degree while destroying 25-45% of the HSL
        // saturation -- it did not recolour the signal, it drained it, which is the one
        // failure mode this particular token cannot absorb.
        //
        // It also bought almost nothing. Of the twelve token x theme combinations on a
        // normal row, exactly one measured under 4.5:1 -- dark-modern `deleted` at
        // 3.87:1 -- and that value is `#c74e39`, VS Code's own stock
        // gitDecoration-deletedResourceForeground, which Microsoft paints on the same
        // background in the built-in SCM tree. That cell is carried in
        // tests/visual/fixtures/knownFindings.json, whose ratchet asserts set equality
        // in BOTH directions, so it can neither regress further nor be quietly dropped.
        //
        // The genuinely unreadable measurements were on SELECTED rows (hc-light reached
        // 1.04:1), and the mix did not fix those either -- it moved that cell to 1.29:1.
        // That is handled at the consumer instead: selected rows inherit
        // `selectedForeground`, the same as every other piece of text on the row.
        //
        // Two further surfaces are not the row background at all, and are likewise
        // resolved where they are consumed rather than by editing this token: the
        // commit-panel section header, which paints on the selection colour
        // unconditionally (SectionHeader.tsx), and the danger button, whose backdrop is
        // tinted from `deleted` itself (commit-panel/theme.ts). Each carries the
        // measurements at its own site.
        added: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
        modified: "var(--vscode-gitDecoration-modifiedResourceForeground, #d19a66)",
        deleted: "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
        // Not `--vscode-checkbox-border`, however much it looks like the right token: that one
        // outlines VS Code's native checkbox against `checkbox.background`, and on a dark theme
        // it is `#3c3c3c` — black against this panel. The button background is the nearest
        // token that is guaranteed to contrast with the surface these checkboxes actually sit on.
        checkboxUncheckedBorder: "var(--vscode-button-background, rgba(206, 214, 230, 0.72))",
        checkboxCheckedBackground: "var(--vscode-checkbox-background, rgba(106, 162, 255, 0.16))",
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
        /** Commit-graph rows and every control: the product's base rhythm. */
        rowHeight: 24,
        /**
         * File- and branch-tree rows, two pixels tighter than a graph row.
         *
         * The trees are the densest surface in the product and the one most
         * often read as a list rather than scanned as a timeline, so they run
         * closer than the graph does. This was a `22px` literal in three places
         * with nothing saying it was deliberate; naming it is what separates a
         * second density from a drifted one.
         */
        treeRowHeight: 22,
        toolbarHeight: 32,
        splitter: 3,
        badgeRadius: 3,
        radius: 4,
        selectedRadius: 5,
        /** Menus, dialogs, popovers. One step softer than a control, never more. */
        floatingRadius: 5,
        pillRadius: 999,
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
 * active theme is legible. On the stock Dark+ and Light+ themes that lands
 * every entry above the 3:1 non-text threshold (WCAG 1.4.11) with no second
 * hand-tuned palette. It is not a floor: chart and ANSI colors are authored by
 * the theme, so a user-authored theme can put any of them anywhere, and the mix
 * improves the odds rather than guaranteeing a ratio. Guaranteeing one would
 * mean measuring each accent against the resolved toolbar background at runtime
 * and correcting it there.
 *
 * That trade is affordable because hue here is decoration. The `iconStyle`
 * setting's `standard` value drops it entirely, and every control carries a
 * label and its own glyph, so nothing depends on color. The literal fallbacks
 * are the original pastels and only render on a host that defines no chart
 * colors at all.
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
 * Every font size the webview is allowed to render, in pixels.
 *
 * Hierarchy in this product comes from weight, color, and position — not from
 * scaling text up — so the scale is deliberately short. Three sizes carry the
 * anchored UI:
 *
 * - `caption` (11) — timestamps, authors, counts, badges, hints. The floor.
 * - `label` (12) — buttons, tabs, toolbar text, column headers.
 * - `body` (13) — commit subjects, file names, row content, section titles.
 *
 * `dialogTitle` (14) is the one step above body, and it exists because the three
 * anchored sizes could not do this job. A modal heading set at 13/600 is
 * indistinguishable from the body text directly beneath it, which left every
 * dialog in the product — shelve, unshelve, clean-up, rename, stash/unstash, and
 * the interactive-rebase dialog — reaching for 14px anyway. Ten call sites had
 * already voted; the rule was what was wrong, so the rule moved. It is scoped to
 * modal headings and must not be used to emphasize anchored text.
 *
 * `type-scale.test.ts` enforces this list against the webview source, so a fifth
 * size fails the suite rather than arriving quietly.
 */
export const TYPE_SCALE = {
    caption: 11,
    label: 12,
    body: 13,
    dialogTitle: 14,
} as const;

/** The allowed sizes as a set, for the guard test and any runtime assertion. */
export const TYPE_SCALE_PX: readonly number[] = Object.values(TYPE_SCALE);

/**
 * The complete shadow vocabulary, lowest lift to highest.
 *
 * A shadow in this system carries exactly one meaning: *this layer is temporary
 * and sits above the page.* Anchored surfaces — panels, toolbars, rows, inputs,
 * the graph canvas — get a 1px border and a tonal step instead, never a shadow.
 *
 * These lived as literals at each float site, which is how four of the five
 * surfaces ended up wearing the wrong one: the commit tooltip took the dialog
 * shadow, the CI-status popover took the drag shadow — the heaviest in the
 * system, on a hover surface — the unstash dialog invented a sixth value, and
 * the drag preview took the lightest. Lift is what tells the user how far above
 * the page a surface is, so a popover casting a drag shadow is a lie about the
 * layer. Naming them here gives the assignment one place to be reviewed.
 */
export const SHADOW = {
    /** Transient surfaces that follow the cursor: tooltips, popovers, hints. */
    popover: "0 4px 14px rgba(0, 0, 0, 0.35)",
    /** Context menus and dropdowns: a tight contact shadow plus an ambient one. */
    menu: "0 8px 24px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.35)",
    /** Modal dialogs. */
    dialog: "0 10px 28px rgba(0, 0, 0, 0.42)",
    /** The lifted state of a row under a direct-manipulation gesture. */
    drag: "0 18px 46px rgba(0, 0, 0, 0.5)",
    /** Not elevation: a 1px inner edge for surfaces that cannot spend layout on a border. */
    insetHairline: "inset 0 0 0 1px rgba(160, 189, 237, 0.14)",
} as const;

/**
 * Maps Git porcelain status codes to VS Code git-decoration theme colors.
 *
 * Each entry uses a VS Code theme variable with a JetBrains-matching fallback.
 * Callers look up single-character codes (`M`, `A`, `D`, `R`, `U`, `?`, `C`, `T`)
 * to color file status badges and tree icons consistently with the editor theme.
 */
export const GIT_STATUS_COLORS: Record<string, string> = {
    M: JETBRAINS_UI.color.modified,
    A: JETBRAINS_UI.color.added,
    D: JETBRAINS_UI.color.deleted,
    R: "var(--vscode-gitDecoration-renamedResourceForeground, #a371f7)",
    U: "var(--vscode-gitDecoration-conflictingResourceForeground, #e5c07b)",
    "?": "var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)",
    C: JETBRAINS_UI.color.added,
    T: JETBRAINS_UI.color.modified,
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
    // Same chained fallback as color.selectedForeground: a bare near-white literal is only
    // correct on dark backgrounds. All four captured themes define badge.foreground, so this
    // is defence against themes that do not rather than a fix for an observed failure.
    fg: "var(--vscode-badge-foreground, var(--vscode-foreground, #eef3ff))",
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
