---
name: IntelliGit
description: IDE-grade Git tooling that wears the user's VS Code theme.
colors:
  panel-slate: "#2f3848"
  editor-ink: "#2b3342"
  toolbar-slate: "#394354"
  divider-steel: "#465066"
  input-well: "#202633"
  foreground-mist: "#d7dce5"
  muted-ash: "#9ca6b8"
  selection-indigo: "#4f5f7c"
  selection-foreground: "#eef3ff"
  focus-azure: "#6aa2ff"
  action-indigo: "#5572d9"
  action-indigo-hover: "#6382eb"
  brand-blue: "#3b82f6"
  status-added: "#73c991"
  status-modified: "#d19a66"
  status-deleted: "#c74e39"
  status-conflicting: "#e5c07b"
  status-renamed: "#a371f7"
  ref-branch: "#6da7ff"
  ref-tag: "#d99b38"
  ref-head: "#79c76d"
  ref-current: "#7fd4cf"
  lane-fern: "#7bcf6f"
  lane-sky: "#5da8ff"
  lane-iris: "#9b7be5"
  lane-lagoon: "#6cc9ba"
  lane-amber: "#d49b43"
  lane-clay: "#d86f6f"
  lane-moss: "#77b255"
  lane-denim: "#5a86d6"
  lane-orchid: "#c084d2"
  lane-brass: "#d0b35a"
  menu-surface: "#2b2d30"
  menu-border: "#43454a"
  menu-foreground: "#bbbfc4"
  menu-divider: "#3e4042"
  menu-muted: "#6e7074"
  menu-selected: "#2e436e"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
  mono:
    fontFamily: "var(--vscode-editor-font-family, var(--vscode-font-family))"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  control: "4px"
  selected: "5px"
  floating: "5px"
  badge: "3px"
  pill: "999px"
  hairline: "1px"
spacing:
  hair: "2px"
  tight: "4px"
  snug: "10px"
  icon: "14px"
  indent: "18px"
  row: "24px"
  toolbar: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-indigo}"
    textColor: "var(--vscode-button-foreground, #ffffff)"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.action-indigo-hover}"
    textColor: "var(--vscode-button-foreground, #ffffff)"
  button-secondary:
    backgroundColor: "var(--vscode-button-secondaryBackground, rgba(255,255,255,0.03))"
    textColor: "{colors.foreground-mist}"
    borderWidth: "{rounded.hairline}"
    borderColor: "var(--vscode-button-border, rgba(176, 186, 205, 0.62))"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
  button-secondary-hover:
    backgroundColor: "var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.08))"
  button-toolbar-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ash}"
    rounded: "{rounded.control}"
    padding: "2px 4px"
    height: "24px"
    width: "24px"
  button-toolbar-ghost-hover:
    backgroundColor: "var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06))"
    textColor: "{colors.foreground-mist}"
  button-danger:
    backgroundColor: "color-mix(in srgb, {colors.status-deleted} 16%, transparent)"
    textColor: "{colors.status-deleted}"
    borderWidth: "{rounded.hairline}"
    borderColor: "color-mix(in srgb, {colors.status-deleted} 60%, transparent)"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
  input-field:
    backgroundColor: "{colors.input-well}"
    textColor: "{colors.foreground-mist}"
    borderWidth: "{rounded.hairline}"
    borderColor: "var(--vscode-input-border, #566176)"
    rounded: "{rounded.control}"
    height: "24px"
  row-selected:
    backgroundColor: "{colors.selection-indigo}"
    textColor: "{colors.selection-foreground}"
    rounded: "{rounded.selected}"
    height: "{spacing.row}"
    ring: "inset 0 0 0 1px {colors.focus-azure}"
---

# Design System: IntelliGit

## 1. Overview

**Creative North Star: "The Borrowed Room"**

IntelliGit does not own the room it works in. It is furniture placed inside someone else's editor, and the walls, the light, and the paint belong to the user's VS Code theme. This is not a metaphor imposed on the code — it is literally how the system is built. Every color in every panel resolves through a `var(--vscode-*, <fallback>)` chain, so a user on Solarized Light, a high-contrast theme, or a hand-tuned personal theme sees IntelliGit rendered in *their* colors, not ours. The hardcoded hex values throughout this document are fallbacks, not intentions. They are what appears when the host has nothing to say, and they were chosen to match PyCharm 2023+ Darcula so the unstyled state still looks deliberate rather than broken.

What IntelliGit *does* own is density and arrangement. Rows are 24px, toolbars 32px, icons 14px, base type 13px, and the radius is 4px almost everywhere. Those numbers are tight on purpose: this is a surface a developer opens forty times a day, and every pixel spent on breathing room is a commit row that fell below the fold. The discipline is JetBrains': fit more real signal per screen, and add no chrome to carry it. Depth comes from 1px borders and tonal background steps between panel, toolbar, and input — not from cards, not from shadows, not from decoration.

This system explicitly rejects **GitKraken-style visual maximalism**. Heavy custom chrome, saturated rainbow graph lanes, and brand color competing with the user's code are all failure states here. The repository's history is the subject; the interface rendering it is not. If a visual choice makes IntelliGit more recognizable at the cost of making the history harder to read, it is the wrong choice.

**Key Characteristics:**

- Every color is theme-derived; hardcoded hex appears only as a fallback
- Dense by design: 24px rows, 13px base type, 4px radius, 14px icons
- Flat at rest — shadows are reserved for layers that float
- Status is never carried by color alone; a glyph or label always accompanies it
- Near-zero motion; the one transition in the system is a 0.1s transform
- Ships in 12 languages, so every layout must survive ~1.4× English string length

## 2. Colors

A theme-inherited palette with one owned exception: a deliberately muted set of graph lane colors, the only hues IntelliGit chooses for itself.

### Primary

- **Action Indigo** (`#5572d9`, hover `#6382eb`): The commit button and every other affirmative primary action. Resolves from `--vscode-button-background`, so on most themes this is the host's button color, not ours. It is the single strongest color in the anchored UI and appears at most once per surface.
- **Brand Blue** (`#3b82f6`): The logo mark only — the circle-and-branch glyph in `media/intelligit.svg`, the marketplace icon, and the README. **It never appears in the UI.** Product chrome is the host's job; this color exists for the storefront and nowhere else.
- **Focus Azure** (`#6aa2ff`): Focus rings and the active-input border, from `--vscode-focusBorder`. Always visible, never suppressed.

### Secondary

- **Muted Signal Set** (`#7bcf6f` fern, `#5da8ff` sky, `#9b7be5` iris, `#6cc9ba` lagoon, `#d49b43` amber, `#d86f6f` clay, `#77b255` moss, `#5a86d6` denim, `#c084d2` orchid, `#d0b35a` brass): The ten commit-graph lane colors, assigned round-robin to concurrent branches. These are the **only** hardcoded colors in the UI that are not fallbacks, because VS Code exposes no graph-lane theming variables. Every one is deliberately desaturated: bright enough that adjacent lanes stay distinguishable at 10px lane width, dull enough that a graph with nine active branches never out-shouts the syntax highlighting in the editor beside it. The ordering is contrast-optimized, not hue-ordered — lane 1 and lane 2 must never read as the same branch at a glance.

### Tertiary

- **Status Added** (`#73c991`), **Status Modified** (`#d19a66`), **Status Deleted** (`#c74e39`), **Status Conflicting** (`#e5c07b`), **Status Renamed** (`#a371f7`): Git working-tree state on file rows, tree icons, and badges. All resolve from `--vscode-gitDecoration-*`, so they match the colors the user already reads in the Explorer.
- **Ref Branch** (`#6da7ff`), **Ref Tag** (`#d99b38`), **Ref Head** (`#79c76d`), **Ref Current** (`#7fd4cf`): Commit ref badges in the graph, from the `--vscode-charts-*` family.

### Neutral

- **Panel Slate** (`#2f3848`): The resting background of every IntelliGit panel, from `--vscode-sideBar-background`.
- **Editor Ink** (`#2b3342`): The commit-graph canvas and detail panes, from `--vscode-editor-background`. One step darker than the panel, which is how the graph reads as recessed without a border.
- **Toolbar Slate** (`#394354`): Toolbars and section headers, one step lighter than the panel. The tonal step *is* the separator.
- **Divider Steel** (`#465066`): 1px rules between rows, panes, and sections.
- **Input Well** (`#202633`): Text inputs and the commit-message box, darkest surface in the system. Inputs read as recessed wells, never as raised cards.
- **Foreground Mist** (`#d7dce5`): Primary text.
- **Muted Ash** (`#9ca6b8`): Secondary text — timestamps, hashes, counts, hints. Used heavily, so it is the contrast risk in this system.
- **Selection Indigo** (`#4f5f7c`) with **Selection Foreground** (`#eef3ff`): The selected row.

### Named Rules

**One Source Of Fallbacks Rule.** Every `--vscode-*` chain and every fallback beside it is written once, in `JETBRAINS_UI` in `shared/tokens.ts`. The `--intelligit-pycharm-*` custom properties are emitted from that object by `commit-panel/theme.ts`; they are not a second place to author a color. They were, for a while, and because both sets resolved through the same host tokens a themed editor hid it — but the fallbacks had drifted apart in ten roles (panel `#2b384e` against `#2f3848`, deleted `#f26b51` against `#c74e39`, muted, selected, input, foreground, focus, added, modified, and the border), so on a host supplying no tokens the commit panel and the commit graph rendered as two different products. The table below is the only column of fallbacks there is.

**The Host Wins Rule.** Every color used in the UI is written as `var(--vscode-<token>, <fallback>)`. Introducing a bare hex value into a component is prohibited. A `var()` with *no* fallback is the same failure wearing a better disguise: the shelf warning count and the shelf-health banner both referenced `--vscode-inputValidation-warningBackground` bare, and that token is optional, so a theme that omits it rendered the product's two loudest warnings as unstyled text. The one sanctioned exception is the ten graph lane colors documented above, because VS Code exposes no graph-lane theming variable. There is no second exception: a file-type badge palette of ecosystem brand colors once sat in `tokens.ts`, unreferenced, with three entries below even the 3:1 non-text floor — it was deleted rather than documented, because sanctioning it would have written a contrast failure into the system PRODUCT.md promises never to ship.

**The Fallback Is Not The Design Rule.** The hex values in this document describe what renders when the host theme supplies nothing. Never tune a component by adjusting a fallback, and never review a color decision in only one theme — check it in a light theme and a high-contrast theme before calling it done.

**The One Loud Thing Rule.** At most one Action Indigo element per surface. If a panel has two primary buttons, one of them is secondary and hasn't been told yet.

**The One Hue Per Bar Rule.** In the "color" icon style, a toolbar accent answers exactly one question — *which action is this?* — so no two actions in the same bar may wear the same hue. The single sanctioned sharing is expand-all and collapse-all: they are two halves of one control, and the shared hue is what makes the eye read them as a pair. Hues do repeat *across* bars, because a bar is the unit the eye scans; the tab bar is traffic with the remote and the panel toolbars are work on the local repository. The assignment lives in `TOOLBAR_ICON_ACCENTS` in `tokens.ts` with a per-bar roster beside it, because picking hues at each call site had no arbiter and drifted into four collisions — shelf and show-diff both on violet, fetch and pull both on sky, stash and both halves of the expand pair all on pink. `tests/webview/unit/toolbar-icon-accents.test.tsx` enforces both halves of this rule against rendered output, so a call site that picks its own hue fails rather than drifting. The native sidebar icons are static SVGs that cannot resolve a token, so `manifest.test.ts` pins them to the accent's fallback and fails if a reassignment leaves them behind. None of this is load-bearing: `iconStyle: "standard"` drops every accent, and each control still carries its own glyph and label.

## 3. Typography

**Display Font:** none. This system has no display type and should not acquire any.
**Body Font:** system UI stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) — used by Title, Body, Label, and Caption alike
**Mono Font:** the user's editor font (`var(--vscode-editor-font-family, var(--vscode-font-family))`) — used by Mono alone

**Character:** Deliberately anonymous. The body stack is whatever the operating system considers native, so IntelliGit's text renders identically to VS Code's own menus and trees — the seam between extension and editor should be invisible. The only typographic contrast in the system is sans-versus-mono, and mono carries a specific meaning: this string came from Git. Commit hashes, branch names, file paths, and diff content are mono; everything the interface says in its own voice is sans.

### Hierarchy

- **Title** (600, 13px, 1.4): Section headers, panel titles, dialog headings. The largest type in the product.
- **Body** (400, 13px, 1.4): Commit subjects, file names, row content, message text. The workhorse.
- **Label** (500, 12px, 1.3): Buttons, tabs, toolbar text, column headers.
- **Caption** (400, 11px, 1.3): Timestamps, author names, commit counts, badges, hints. The floor.
- **Dialog Title** (600, 14px, 1.4): Modal headings only. The one step above Body, and the only place it is allowed.
- **Mono** (400, 12px, 1.4): Hashes, refs, paths, diff bodies. Inherits the user's editor font and therefore their ligature and font-size preferences.

### Named Rules

**The Three-Step Rule, plus one.** The anchored UI is 11px, 12px, and 13px, and a fourth size in *that* range is a mistake. Hierarchy comes from weight (400/500/600), color (Foreground Mist versus Muted Ash), and position — never from scaling text up.

The single exception is **Dialog Title (600, 14px)**, and it is an exception the code argued for and won. A modal heading set at 13/600 is indistinguishable from the body text directly beneath it, so all ten dialogs — shelve, unshelve, clean-up, rename, delete-shelf, stash/unstash, the shelf-health banner, and the interactive-rebase dialog — had reached for 14px on their own. Ten call sites voting the same way against a prose rule means the rule was wrong. It is scoped to modal headings and must never be used to emphasize anchored text.

The scale now lives in `TYPE_SCALE` in `shared/tokens.ts`, and `tests/webview/unit/type-scale.test.ts` scans every `.ts`, `.tsx`, and `.css` file under `src/webviews` for a size outside it. That test is what makes this rule real: before it existed the scale had already drifted in both directions, down to 10px on the amend-context block, the status badge, and the merge editor's keyboard hints — below the product's own stated caption floor, on the text carrying a commit's identity — and up to 14px on the dialogs. A prose rule cannot tell those two cases apart. The test names both, and a human decides which is the bug.

**The Mono Means Git Rule.** Monospace is semantic, not decorative. If a string came out of Git — a hash, a ref, a path, a diff line — it is mono. If IntelliGit wrote it, it is sans. Never use mono for emphasis.

**The 1.4× Rule.** The UI ships in 12 languages. Every label must hold its layout at roughly 1.4× the English string length. German and Russian break tight buttons first; check those two before shipping any new control.

## 4. Elevation

The system is **flat at rest and lifts only to float**. Anchored surfaces — panels, toolbars, rows, inputs, the graph canvas — never carry a shadow. Depth between them is built from two things only: 1px borders in Divider Steel, and tonal steps between Input Well, Editor Ink, Panel Slate, and Toolbar Slate. A shadow in this system carries exactly one meaning: *this layer is temporary and sits above the page.* Menus, dialogs, popovers, and drag previews get one; nothing else ever does.

### Shadow Vocabulary

- **Popover** (`box-shadow: 0 4px 14px rgba(0,0,0,0.35)`): Small transient surfaces — tooltips, CI-status popovers, inline hints.
- **Menu** (`box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.35)`): Context menus and dropdowns. The two-layer stack gives a tight contact shadow plus an ambient one.
- **Dialog** (`box-shadow: 0 10px 28px rgba(0,0,0,0.42)`): Modal dialogs, including the interactive-rebase dialog.
- **Drag** (`box-shadow: 0 18px 46px rgba(0,0,0,0.5)`): The lifted state of a row being dragged, most visibly during rebase reordering. The heaviest shadow in the system, and the only one attached to a direct-manipulation gesture.
- **Inset Hairline** (`box-shadow: inset 0 0 0 1px rgba(160,189,237,0.14)`): Not elevation. A borderless 1px inner edge for surfaces that need definition without consuming layout space.
- **Selected Ring** (`box-shadow: inset 0 0 0 1px var(--vscode-focusBorder)`): Not elevation. The boundary of a selected row, and the one shadow value that lands on an anchored surface — see Rows / Trees for why it is an inset shadow rather than the border the Float-Or-Flat Rule would otherwise ask for. It is not decoration: the host's own selection fill measures 1.15:1 against the panel on Light Modern and 1.18:1 on HC Light, so without this ring a selected row has no visible boundary at all on most stock themes.

### Named Rules

**The Float-Or-Flat Rule.** A shadow means the layer is temporary. If a surface is anchored in the layout, it gets a border, not a shadow. A shadow on a toolbar or a panel header is always wrong.

**The Darkness-Not-Blur Rule.** These shadows are dark and relatively tight because they sit on a dark panel. Do not soften them toward a light-UI look. If a shadow reads as a soft gray halo rather than a cast shadow, the alpha is too low and the blur is too large.

**The Vocabulary Is A Token Rule.** The six values live in `SHADOW` in `shared/tokens.ts` and are referenced, never retyped. Written as literals at each float site they had no arbiter, and four of the five surfaces ended up wearing the wrong lift: the commit tooltip took Dialog, the CI-status popover took Drag — the heaviest in the system, on a surface that follows the cursor — the unstash dialog invented a value of its own, and the branch drag preview took the lightest. Lift is how the user reads distance from the page, so a popover casting a drag shadow is a false statement about the layer, not a cosmetic slip.

## 5. Components

The whole component vocabulary is **tight and instrumental**: every control reads as an instrument on a panel — uniform height, aligned to a grid, no rounded friendliness. Nothing is sized for a first impression; everything is sized for the four-hundredth use.

### Buttons

- **Shape:** Barely-softened corners (4px radius), fixed 24px height. Never pill-shaped, never square.
- **Primary:** Action Indigo background, white text, 600 weight, 10px horizontal padding. One per surface.
- **Hover / Focus:** Background shifts to Action Indigo Hover. Focus draws a Focus Azure ring. No transform, no scale, no shadow.
- **Secondary:** A 3% white wash with a 1px light border — visible as a control, subordinate to primary. The border is deliberately lighter than Divider Steel: composited over the panel it measures 3.26:1, which is what WCAG 1.4.11 asks of a control boundary, where Divider Steel would give 1.39:1. A rule between rows may whisper; the edge that tells the user where a button is may not.
- **Toolbar Ghost:** Transparent at rest with Muted Ash icons, 24×24px. On hover, the host's own toolbar-hover background and the icon warms to Foreground Mist, eased over 120ms and suppressed under `prefers-reduced-motion`. Pressed state uses a `color-mix()` tint of the host button color at 34%. This is the most-used control in the product, so its hover has to survive a light theme — a fixed white wash does not.
- **Danger:** A 16% wash of Status Deleted with a 60% border in the same hue and matching text. Destructive actions are colored, never shouted — they are visibly different without a red-filled button.

### Cards / Containers

Cards are essentially absent, and that is deliberate. Content lives in flat lists, trees, and panes separated by 1px rules and tonal steps. Where a bounded region is genuinely needed (a dialog body, a conflict band), it is a 4px-radius region with a 1px Divider Steel border and no shadow. **Nested cards are prohibited.**

### Workbench composition

The default undocked layout gives history the remaining width after reserving 168px for repositories, 220px for branches, 220px for details, and 260px for the commit panel. At 1200px, the graph receives 316px after the four 4px dividers. Saved pane widths override these defaults; existing minimum widths, drag behavior, and narrow-window pane priorities still apply. Author and date columns appear only when the commit-message cell can retain at least 180px, so secondary metadata does not consume the space gained by history.

Search fields use a 26px control inside the 32px toolbar rhythm. Section titles, counts, and totals have separate spacing and weight so supporting information does not compete with the task. Data rows retain their 22px tree and 24px graph geometry.

### Inputs / Fields

- **Style:** Input Well background — the darkest surface in the system, so fields read as recessed — with a 1px input border and 4px radius.
- **Focus:** Border shifts to Focus Azure. No glow, no size change.
- **Search hints:** Placeholder color comes from the host input-placeholder token, with an explicit opacity of 1. Chakra's system color mode must not determine contrast inside a VS Code-themed input.
- **Commit message box:** The primary writing surface starts at a 220px composer height, with a 180px minimum. A visible localized label names the textarea; Generate/Stop sits beside the label, outside the writing area. The action row wraps as needed for translated labels. Commit is primary and Push is secondary.

### Rows / Trees

- **Height:** 24px, fixed. Tree indent is 18px per level.
- **Selected:** Selection Indigo background at 5px radius with Selection Foreground text — a slightly softer corner than controls, so selection reads as a highlight rather than a button — *plus a 1px inner ring in Focus Azure*. The ring is not decoration. The background resolves to `--vscode-list-activeSelectionBackground`, a color the host owns; VS Code's own list widget pairs that fill with an outline drawn on top, so stock themes are free to pick a fill with almost no contrast, and they do. Measured against the panel: Light Modern 1.15:1, HC Light 1.18:1, Dark Modern 1.48:1 — all under the 3:1 WCAG 1.4.11 asks of a non-text state indicator, and HC Light, the theme that exists for contrast, was the worst of them. The fill cannot carry the state alone, so the ring carries it. It is an inset `box-shadow` rather than a border because rows are fixed-height and a border would shift their content, and rather than an outline because tree rows already draw a focus outline at the same -1px offset.
- **Hover:** A translucent host hover wash. Never a border; a border on hover causes 1px layout shift.
- **Status:** Always a colored glyph *plus* a label or letter code. Color alone is never the carrier.

### Commit Graph (signature component)

The graph is rendered on HTML5 Canvas rather than DOM, and its geometry is fixed: 10px lane width, 1.5px branch lines, 1.3px merge lines, 4.5px commit dots with a 2px inner radius and a 2px ring in the canvas background color. That ring is what keeps a dot legible when a line passes behind it. Lanes cycle the Muted Signal Set round-robin. The graph caps at 100px of lane width — beyond roughly ten concurrent lanes it stops widening, because a graph wide enough to show every branch is a graph nobody can read.

### Interactive Rebase Dialog (signature component)

The clearest expression of "calm, reversible, safe". The commit list is capped at `min(50vh, 520px)` and scrolls internally so the dialog never outgrows the viewport. Rows are separated by 1px Divider Steel and reorder by drag, using the Drag shadow as the only lift in the system tied to a gesture. Rewritten-history consequences are stated in the dialog itself, before submission — the warning is part of the layout, not a confirmation step bolted on after.

## 6. Do's and Don'ts

### Do:

- **Do** write every color as `var(--vscode-<token>, <fallback>)`. The host theme wins, always.
- **Do** check every change in a light theme and a high-contrast theme before calling it done. Dark-only review is how this system breaks.
- **Do** keep the type scale at 11px / 12px / 13px and get hierarchy from weight, color, and position instead.
- **Do** use monospace only for strings that came out of Git — hashes, refs, paths, diff content.
- **Do** pair every status color with a glyph or label, so red/green color blindness and grayscale rendering never lose information.
- **Do** hold layouts at ~1.4× the English string length; check German and Russian first.
- **Do** keep anchored surfaces flat and separate them with 1px borders and tonal steps.
- **Do** give destructive actions the Danger treatment — a tinted wash and matching text, visibly different without being loud.
- **Do** respect `prefers-reduced-motion`; the global reduce block in `webviewHtml.ts` is the floor, not a substitute for restraint.

### Don't:

- **Don't** reach for **GitKraken-style visual maximalism** — heavy custom chrome, saturated rainbow lanes, or brand color competing with the user's code. The history is the subject; the interface is not.
- **Don't** put **Brand Blue `#3b82f6` anywhere in the UI.** It is a logo and marketplace color. The product chrome belongs to the host theme.
- **Don't** introduce a bare hex value into a component. The only sanctioned hardcoded colors are the ten graph lanes and the file-type badges, and both are already defined in `shared/tokens.ts`.
- **Don't** add a shadow to an anchored surface. If it doesn't float, it gets a border.
- **Don't** add a fourth type size, and never scale text up for emphasis.
- **Don't** use cards to group content, and never nest them.
- **Don't** use a colored `border-left` or `border-right` greater than 1px as an accent stripe on rows, callouts, or conflict bands.
- **Don't** use gradient text, `background-clip: text`, or glassmorphism anywhere. There is no decorative layer in this product.
- **Don't** animate layout properties, and don't add entrance animations to lists. Rows appear; they do not arrive.
- **Don't** encode Git status in color alone.
- **Don't** tune a component by editing its fallback hex — that only changes the unthemed state.
