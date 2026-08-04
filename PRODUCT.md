# Product

## Register

product

## Platform

web

## Users

Developers doing heavy Git work — frequent rebases, conflict resolution, shelving, and history surgery — regardless of which editor they arrived from. They already know Git; they are not looking for training wheels.

Their context is mid-task and rarely calm: cleaning up a branch before a push, resolving the conflict that is blocking a merge, hunting the commit that introduced a regression, parking unfinished work to take an urgent fix. The job to be done is to shape commits, read history, move branches, and recover from mistakes without leaving the editor or rebuilding state from terminal scrollback.

Each surface owns one task. The commit panel is for shaping and sending a change: stage by section, folder, or file, write the message, amend, commit, push. The commit graph is for reading history and acting on it where it is visible, so branch and commit operations happen in the same place the user is already looking. The three-pane merge editor is for resolving a conflict with Yours, the editable Result, and Theirs all on screen at once. The rebase dialog is for reordering, squashing, and rewording a range before it becomes public.

## Product Purpose

IntelliGit gives daily Git work a single cockpit inside VS Code, instead of splitting it across the Source Control view, the terminal, diff tabs, branch pickers, and a third-party graph extension. It does not replace Git or hide it — it makes the state of the repository continuously visible so the user acts on what they can see rather than on what they remember.

Success is **retention**. A developer who installs IntelliGit stops using the built-in Source Control view entirely and would notice immediately if the extension disappeared. Installs are a leading indicator; the real measure is whether the second week looks like the first.

## Positioning

IntelliGit deliberately merges the strongest Git ideas from three IDEs — JetBrains, VS Code, and Visual Studio — rather than cloning any one of them. Every screen should feel like the best available answer to its problem, not like a port of someone else's product.

## Brand Personality

Calm, reversible, safe.

The voice is plain and exact. It does not celebrate routine success, and it does not dramatize a recoverable failure. Messages name what happened and what the user can do next, in the vocabulary Git already uses, without euphemism and without alarm.

The emotional goal is confidence under pressure: the user should believe, without having to think about it, that they cannot lose work here. That belief is earned by making destructive operations legible before they run and recoverable after — not by adding warnings.

## Anti-references

**GitKraken-style visual maximalism.** Heavy custom chrome, saturated rainbow graph lanes, and brand color competing with the user's code for attention. The repository's history is the subject; the interface rendering it is not. If a visual choice makes IntelliGit more recognizable at the cost of making the history harder to read, it is the wrong choice.

## Design Principles

**Reversibility is the feature.** Every destructive operation is legible before it runs and recoverable after it does. This is the product's core promise, so it outranks convenience: an extra beat of visible state beats a faster path that leaves the user guessing what just happened.

**The editor's chrome, the IDE's depth.** IntelliGit wears VS Code — its theme, its typography, its interaction conventions — while offering the workflow depth of a full JetBrains IDE. The user's theme belongs to the user. Depth is added in capability, never in decoration.

**Density is not noise.** Information density is the goal and the failure mode is close by. Fit more real signal per pixel; add no chrome to carry it. When a surface feels crowded, the fix is removing decoration, not removing information.

**A better cockpit, not a replacement.** IntelliGit surfaces Git's real concepts under Git's real names. It competes on how clearly state is shown and how safely operations are performed, never by inventing a simpler fiction on top.

**Earn the second session.** Retention is the scoreboard, so every surface is judged on the tenth use rather than the first. Favor the choice that stays fast and legible under repetition over the one that impresses on first open.

## Accessibility & Inclusion

The floor is whatever the host provides: because every color in the UI resolves through a `--vscode-*` token, contrast is ultimately decided by the user's active VS Code theme, and IntelliGit cannot unilaterally promise a WCAG ratio for a palette it does not own. What it can promise, and must, is that it never *reduces* contrast below what the host theme supplies — no hardcoded low-contrast overrides, no muted-on-muted text that a high-contrast theme cannot rescue.

Above that floor, the commitments are the parts IntelliGit genuinely controls: every action reachable without a mouse, visible focus on every interactive element, accessible names on icon-only controls, and status changes announced rather than shown by color alone. Git status is never encoded in color by itself — added, modified, and deleted always carry a glyph or a label too, which also covers red/green color blindness.

Motion is minimal by nature here and must respect `prefers-reduced-motion`.

The UI ships in 12 languages, so layouts hold at roughly 1.4× the English string length without clipping or overflow.
