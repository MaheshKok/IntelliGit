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
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.action-indigo-hover}"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "rgba(255,255,255,0.03)"
    textColor: "{colors.foreground-mist}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
  button-secondary-hover:
    backgroundColor: "rgba(255,255,255,0.08)"
  button-toolbar-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ash}"
    rounded: "{rounded.control}"
    padding: "2px 4px"
    height: "24px"
    width: "24px"
  button-toolbar-ghost-hover:
    backgroundColor: "rgba(255,255,255,0.06)"
    textColor: "{colors.foreground-mist}"
  button-danger:
    backgroundColor: "rgba(199,78,57,0.16)"
    textColor: "{colors.status-deleted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "24px"
  input-field:
    backgroundColor: "{colors.input-well}"
    textColor: "{colors.foreground-mist}"
    rounded: "{rounded.control}"
    height: "24px"
  row-selected:
    backgroundColor: "{colors.selection-indigo}"
    textColor: "{colors.selection-foreground}"
    rounded: "{rounded.selected}"
    height: "{spacing.row}"
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

**The Host Wins Rule.** Every color used in the UI is written as `var(--vscode-<token>, <fallback>)`. Introducing a bare hex value into a component is prohibited. The only sanctioned exceptions are the ten graph lane colors and the file-type badge palette, both documented above, both because no host token exists for them.

**The Fallback Is Not The Design Rule.** The hex values in this document describe what renders when the host theme supplies nothing. Never tune a component by adjusting a fallback, and never review a color decision in only one theme — check it in a light theme and a high-contrast theme before calling it done.

**The One Loud Thing Rule.** At most one Action Indigo element per surface. If a panel has two primary buttons, one of them is secondary and hasn't been told yet.

## 3. Typography

**Display Font:** none. This system has no display type and should not acquire any.
**Body Font:** system UI stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`)
**Label/Mono Font:** the user's editor font (`var(--vscode-editor-font-family, var(--vscode-font-family))`)

**Character:** Deliberately anonymous. The body stack is whatever the operating system considers native, so IntelliGit's text renders identically to VS Code's own menus and trees — the seam between extension and editor should be invisible. The only typographic contrast in the system is sans-versus-mono, and mono carries a specific meaning: this string came from Git. Commit hashes, branch names, file paths, and diff content are mono; everything the interface says in its own voice is sans.

### Hierarchy

- **Title** (600, 13px, 1.4): Section headers, panel titles, dialog headings. The largest type in the product.
- **Body** (400, 13px, 1.4): Commit subjects, file names, row content, message text. The workhorse.
- **Label** (500, 12px, 1.3): Buttons, tabs, toolbar text, column headers.
- **Caption** (400, 11px, 1.3): Timestamps, author names, commit counts, badges, hints. The floor.
- **Mono** (400, 12px, 1.4): Hashes, refs, paths, diff bodies. Inherits the user's editor font and therefore their ligature and font-size preferences.

### Named Rules

**The Three-Step Rule.** The entire type scale is 11px, 12px, and 13px. A fourth size is not a design decision, it is a mistake. Hierarchy comes from weight (400/500/600), color (Foreground Mist versus Muted Ash), and position — never from scaling text up.

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

### Named Rules

**The Float-Or-Flat Rule.** A shadow means the layer is temporary. If a surface is anchored in the layout, it gets a border, not a shadow. A shadow on a toolbar or a panel header is always wrong.

**The Darkness-Not-Blur Rule.** These shadows are dark and relatively tight because they sit on a dark panel. Do not soften them toward a light-UI look. If a shadow reads as a soft gray halo rather than a cast shadow, the alpha is too low and the blur is too large.

## 5. Components

The whole component vocabulary is **tight and instrumental**: every control reads as an instrument on a panel — uniform height, aligned to a grid, no rounded friendliness. Nothing is sized for a first impression; everything is sized for the four-hundredth use.

### Buttons

- **Shape:** Barely-softened corners (4px radius), fixed 24px height. Never pill-shaped, never square.
- **Primary:** Action Indigo background, white text, 600 weight, 10px horizontal padding. One per surface.
- **Hover / Focus:** Background shifts to Action Indigo Hover. Focus draws a Focus Azure ring. No transform, no scale, no shadow.
- **Secondary:** A 3% white wash with a 1px light border — visible as a control, subordinate to primary.
- **Toolbar Ghost:** Transparent at rest with Muted Ash icons, 24×24px. On hover, a 6% white wash and the icon warms to Foreground Mist. Pressed state uses a `color-mix()` tint of the host button color at 34%. This is the most-used control in the product.
- **Danger:** A 16% wash of Status Deleted with a 60% border in the same hue and matching text. Destructive actions are colored, never shouted — they are visibly different without a red-filled button.

### Cards / Containers

Cards are essentially absent, and that is deliberate. Content lives in flat lists, trees, and panes separated by 1px rules and tonal steps. Where a bounded region is genuinely needed (a dialog body, a conflict band), it is a 4px-radius region with a 1px Divider Steel border and no shadow. **Nested cards are prohibited.**

### Inputs / Fields

- **Style:** Input Well background — the darkest surface in the system, so fields read as recessed — with a 1px input border and 4px radius.
- **Focus:** Border shifts to Focus Azure. No glow, no size change.
- **Commit message box:** The one input allowed to grow. It is the primary writing surface in the product and gets vertical room the other controls do not.

### Rows / Trees

- **Height:** 24px, fixed. Tree indent is 18px per level.
- **Selected:** Selection Indigo background at 5px radius with Selection Foreground text — a slightly softer corner than controls, so selection reads as a highlight rather than a button.
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
