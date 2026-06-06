<!--
This document is a comprehensive competitive analysis of GitLens for VS Code.
It catalogs the complete feature surface (Community/free and Pro/paid), flags
which features sit behind the paywall, and analyzes pricing and monetization so
the team can plan a lower-cost competing VS Code extension. It is a planning and
research artifact, not implementation documentation.

Sources are listed at the end. Feature/paywall lines and prices were verified
against GitKraken's official help, pricing, and Pro-features pages in May 2026.
-->

# GitLens Feature Analysis (Competitive Teardown)

> **Purpose.** We are building a VS Code extension that delivers GitLens-class
> capabilities at a fraction of the cost. This document is the exhaustive
> reference for *what GitLens does* and *what GitLens charges for*. Every feature
> is tagged with its tier so we can decide what to match for free, what to
> paywall, and where to undercut. Implementation planning happens separately.

**Legend**

| Tag | Meaning |
|-----|---------|
| 🆓 **Community** | Free, no account required (some require a GitKraken account but no payment) |
| 💲 **Pro** | Requires a paid GitLens Pro subscription (14-day trial available) |
| 💲💲 **Advanced** | Requires the higher Advanced/Enterprise tier |
| 🔒 **Repo-gated** | Free on local/public repos, **paywalled on private repos** |
| 🧪 **Preview/Experimental** | Shipped but flagged preview/experimental |

> **The single most important monetization mechanic:** GitLens's biggest paywall
> is not a feature toggle — it is **the private-repository gate**. Several
> headline features (most notably the Commit Graph) are fully usable on local and
> public repos for free, but require Pro the moment you point them at a **private
> repository**. Since virtually all professional/commercial work lives in private
> repos, this converts "free" features into paid ones for the paying audience.
> This is the lever we must consciously decide whether to pull, soften, or remove.

---

## Table of Contents

1. [Pricing & Tier Structure](#1-pricing--tier-structure)
2. [Blame & Authorship](#2-blame--authorship)
3. [Hovers & Tooltips](#3-hovers--tooltips)
4. [Navigation & Comparison](#4-navigation--comparison)
5. [Search & History](#5-search--history)
6. [Visualization — Commit Graph & Visual File History](#6-visualization--commit-graph--visual-file-history)
7. [Side Bar Views & Home View](#7-side-bar-views--home-view)
8. [Code Review & Collaboration — Launchpad, Code Suggest](#8-code-review--collaboration--launchpad-code-suggest)
9. [Patches & Sharing — Cloud Patches, Deep Links](#9-patches--sharing--cloud-patches-deep-links)
10. [AI Features](#10-ai-features)
11. [Worktrees & Workspaces](#11-worktrees--workspaces)
12. [Remote Provider & Issue-Tracker Integrations](#12-remote-provider--issue-tracker-integrations)
13. [Editing, Commands & Workflow](#13-editing-commands--workflow)
14. [Customization, Modes & Settings](#14-customization-modes--settings)
15. [Account, Security & Enterprise](#15-account-security--enterprise)
16. [Paywall Map — What You Actually Pay For](#16-paywall-map--what-you-actually-pay-for)
17. [Monetization Analysis & Our "Fraction of Cost" Angle](#17-monetization-analysis--our-fraction-of-cost-angle)
18. [Sources](#18-sources)

---

## 1. Pricing & Tier Structure

GitLens is published by GitKraken. Pricing is **per seat**, headline rates are
"per seat / month billed annually," and monthly billing carries roughly a 20%
premium. A **14-day Pro trial** is offered, and there is a **GitHub Student
Developer Pack** route to 6 free months.

| Tier | Price (annual) | Seats | Core proposition |
|------|----------------|-------|------------------|
| **Community** | Free | unlimited | Blame, hovers, CodeLens, revision navigation, basic in-editor Git insight. Commit Graph etc. usable only on **local/public** repos. |
| **Pro** | **~$8 / seat / mo** (promo first seat ~$5) | individual / small | Commit Graph + Visual File History + Worktrees on **private** repos, Launchpad, issue-tracker integrations, AI commit messages, **250,000 AI tokens/week** (GitKraken AI). |
| **Advanced** | **~$12 / seat / mo** | up to 10 | Everything in Pro **plus** self-hosted Git integrations, PR automations, single-domain SSO, priority support, auto-compose commits, changelog generation, **1,000,000 AI tokens/week**. |
| **Business / Enterprise** | Custom / bundled with GitKraken suite | org | Org-wide SSO (Okta, Google), governance, bundled GitKraken Desktop/CLI. |

**Key takeaways for us**
- The **entry paid price is ~$8/seat/mo** ($96/yr). That is the number we
  undercut. A credible "fraction of cost" target is **$2–4/seat/mo** or a
  **one-time / free-core** model.
- GitKraken bundles an **AI token allowance** into the subscription. AI is a real
  recurring COGS for them; it is the part of their price that is *not* pure
  margin. Our cheapest path is **BYOK (bring-your-own-key)** AI so we carry no
  token cost.
- The **private-repo gate** is what makes Pro feel mandatory. Removing it is our
  strongest differentiator and costs us nothing technically.

---

## 2. Blame & Authorship

The blame suite is GitLens's signature and is **entirely free**. This is table
stakes — we must match all of it in our free tier or we are not credible.

| Feature | Tier | What it does | UI surface | Why users value it |
|---------|------|--------------|------------|--------------------|
| **Current Line Blame** | 🆓 | End-of-line annotation: author, date, commit message for the active line | Subtle inline text at end of current line | Instant "who/why" without leaving the line; the feature people install GitLens for |
| **Git CodeLens** | 🆓 | Inline insight above files/functions/blocks: most recent change + contributors; click → quick pick | CodeLens row above code blocks (`Shift+Alt+B`) | Authorship and recency at the block level; jump into history fast |
| **Status Bar Blame** | 🆓 | Author + date of current line shown in the status bar; click → commit action quick pick | VS Code status bar | Always-visible attribution that doesn't clutter the editor |
| **File Blame** | 🆓 | Full-file, line-by-line annotation of commit message + author, with an age heatmap on the right edge | Editor gutter/overlay (`Alt+B`) | Review the whole file's authorship at once |
| **File Changes** | 🆓 | Highlights locally modified / recently committed lines | Themable inline highlight | See what changed vs committed state at a glance |
| **File Heatmap** | 🆓 | Color bar showing line recency — hot (recent) → cold (old) | Bar on file edge | Spot stale vs actively-churned code instantly |

**Assessment.** Zero paid features here. This is the free hook that drives
installs. Our extension must reproduce all six with comparable polish; this is
non-negotiable baseline, not differentiation.

---

## 3. Hovers & Tooltips

| Feature | Tier | What it does | UI surface |
|---------|------|--------------|------------|
| **Current Line — Details Hover** | 🆓 | Rich commit card on hover: message, author, date, **auto issue/PR links**, quick-action bar | Hover over active line |
| **Current Line — Changes Hover** | 🆓 | Shows the previous version of the modified line (inline diff) | Hover over active line |
| **Annotation — Details Hover** | 🆓 | Same rich commit card, per line, while file blame annotations are on | Hover during annotation |
| **Annotation — Changes Hover** | 🆓 | Previous line version while annotations are on | Hover during annotation |

**Assessment.** Free. The autolink-in-hover (Jira/GitHub issue keys becoming
clickable) is where it ties into the integration story (§12), and *rich* autolink
hovers (avatars, PR summaries) become Pro there.

---

## 4. Navigation & Comparison

| Feature | Tier | What it does |
|---------|------|--------------|
| **Revision Navigation** | 🆓 | Step a file backward/forward through its history; diff against previous/next revision, working file, or a branch/tag | 
| Open Changes with Previous / Next Revision | 🆓 | Diff current file against adjacent revisions |
| Open Line Changes with Previous Revision | 🆓 | Line-scoped diff across revisions |
| Open Changes with Working File / Branch or Tag / Revision | 🆓 | Diff against arbitrary refs |

**Assessment.** All free. Core "time travel through a file" capability.

---

## 5. Search & History

| Feature | Tier | What it does | UI surface |
|---------|------|--------------|------------|
| **Git Command Palette** | 🆓 | Guided quick-pick access to common Git commands: branch history, current-branch history, file history, commit search, commit/line details, stash access, repo status | Command Palette |
| **Interactive Rebase Editor** | 🆓 | GUI for `git rebase -i`: drag-to-reorder, pick/squash/drop; can be set as the default Git rebase editor | Custom editor tab |
| **Commit Search (basic)** | 🆓 | Search commits by message/author/file/change/`@me` | Quick pick / Search view |

**Assessment.** All free, including the genuinely-loved Interactive Rebase Editor.
The *richer* commit search embedded in the Commit Graph becomes repo-gated (§6).

---

## 6. Visualization — Commit Graph & Visual File History

This is the headline **paid** territory, gated by the **private-repo** mechanic.

### Commit Graph 🔒 (free on local/public, **Pro on private**)

A full-window, color-coded DAG of branches, commits, tags, and contributors.

| Capability | Detail |
|------------|--------|
| Visual DAG | Branches, merges, contributors color-coded; header shows repo, current branch, last-fetched time |
| Rich Commit Search | Prefixed search: `Commit:`, `Message:`, `Author:`, `File:`, `Change:`, `@me` |
| Context actions | Full right-click menus on branches/commits/tags — **rebase, merge, cherry-pick, revert, reset, push/pull** |
| PR indicators | Inline pull-request markers for GitHub & GitLab |
| Filtering | Current branch only / all local / remote-only / tags / stashes; hide/show individual remotes, branches, tags |
| Columns | Drag-to-reorder, right-click toggle, compact layout for small screens |
| Minimap 🧪 | Experimental visual scrollbar of activity |
| Scroll markers | Highlight checked-out branch and search matches |

**Why people pay:** it is a GitKraken-Desktop-quality graph living *inside* VS
Code, with mutating Git operations one click away. The graph itself renders on a
free repo — but a developer's day-job repos are private, so they hit the wall
immediately.

### Visual File History 🔒 (free on local/public, **Pro on private**)

A timeline chart of a single file's evolution.

| Capability | Detail |
|------------|--------|
| Swim lanes | Y-axis = contributors; X-axis = time |
| Bubbles | Color per author; bubble size ∝ magnitude of change |
| Add/delete bars | Green (additions) / red (deletions) per commit on the right |
| Hover detail | Per-change commit insight |

**Why people pay:** answers "how did this file get like this, and who drove it"
visually — strong for onboarding and code archaeology.

**Assessment.** These two are the core of the Pro pitch. Our decision: do we
make graph+file-history **free on private repos** (the obvious undercut) and
paywall something else, or match GitLens's gate at a lower price?

---

## 7. Side Bar Views & Home View

| Feature | Tier | What it does |
|---------|------|--------------|
| **Home View** | 💲 (Pro) | Unified "command center": active work across repos, recent-activity tracking, task prioritization by status — reduces context switching |
| Commits / Branches / Remotes / Stashes / Tags / Contributors / Search & Compare / File History views | 🆓 | Standard GitLens side-bar tree views over repository data |
| Worktrees view | 🔒 | Worktree management surface (feature gated, see §11) |
| Cloud Patches view | 🧪 | Lists shared patches (see §9) |
| GitKraken Account view | 🆓 | Account, integrations, org membership |

**Assessment.** The basic data views are free; the **Home View dashboard** is a
Pro upsell built on top of them. The dashboard is presentation, not new data — a
cheap thing for us to offer free as differentiation.

---

## 8. Code Review & Collaboration — Launchpad, Code Suggest

| Feature | Tier | What it does | Notes |
|---------|------|--------------|-------|
| **Launchpad** | 💲 (Pro) | PR hub inside VS Code: groups your PRs by status — Ready to merge / Blocked / Requires follow-up / Needs your review / Waiting for review / Draft / Snoozed. Pin/snooze, open in browser, merge, switch branch | GitHub.com, GitLab.com (Bitbucket/Azure per marketing); access via Command Palette or PR status-bar item |
| **Code Suggest** | 🧪 Preview | Propose edits across the **whole project**, not just changed lines, while a PR is open; collaborators review/apply | github.com only; apply locally or on gitkraken.dev |

**Assessment.** Launchpad is a flagship **Pro** feature and a real productivity
draw for people juggling many PRs. It depends on remote-provider integrations
(§12). For us, a basic "my open PRs grouped by status" view is achievable and
could be **free** to undercut.

---

## 9. Patches & Sharing — Cloud Patches, Deep Links

| Feature | Tier | What it does |
|---------|------|--------------|
| **Cloud Patches** | 💲 / 🧪 Preview | Securely store Git patches in the cloud and share across GitLens/GitKraken Desktop/CLI. Create from working changes, commits, stashes, comparisons. Visibility: public link / org / collaborators only. Apply from URL. **Self-host via your own AWS S3.** |
| **Deep Links** | 🆓 | Shareable URLs to comparisons, workspaces, graph resources, files/lines, cloud patches; "Copy Link to…" right-click; vscode.dev line links |

**Assessment.** Cloud Patches require GitKraken's **hosted backend** — that is a
real infrastructure cost and a genuine reason it's paid. This is the one area
where matching GitLens cheaply is hard *unless* we lean on the self-host/S3 model
or skip it. Deep Links are free and trivial.

---

## 10. AI Features

AI is bundled into paid tiers via a **weekly token allowance** (Pro 250k,
Advanced 1M). Provider choice: GitHub Copilot, GitKraken AI, or **BYOK**.

| Feature | Tier | What it does |
|---------|------|--------------|
| **AI Commit Messages** | 🆓 basic / 💲 enhanced 🧪 | Generate a commit message from staged diff; customizable prompt |
| **AI Stash Messages** | 💲 (Pro+) | Auto-generate meaningful stash descriptions |
| **AI Explanations** | 🧪 Preview | Natural-language summaries of branches, working changes, stashes (✨ Explain) |
| **AI Commit Explanations** | 💲 (Pro+) | Explain a commit's purpose/context in Commit Details / Cloud Patch / review |
| **AI Changelog Creation** | 💲💲 (Advanced+) | Structured changelog from a selection of commits |
| **Commit Composer** | 💲 (Pro) | Interactively draft/auto-compose commits before applying; branch & selective **recomposition**; switch models; custom instructions; untracked-file support |

**Assessment.** This is where GitKraken's price has real underlying cost (tokens).
**Our wedge: ship all AI features as BYOK** — the user pays their own
OpenAI/Anthropic/Copilot bill, we charge $0 for tokens. We can then offer *more*
AI surface than Pro at *lower* subscription cost because we don't resell
inference. Commit Composer / recomposition is the most sophisticated AI feature
and the strongest Pro/Advanced differentiator to study.

---

## 11. Worktrees & Workspaces

| Feature | Tier | What it does |
|---------|------|--------------|
| **Worktrees** | 🔒 (free local/public, **Pro on private**) | Create/manage multiple working trees so you can work several branches at once without stashing/switching; review a PR in one worktree while building a feature in another |
| **Workspaces** | 💲 (Pro, cloud) | Group and link multiple repositories; cloud workspaces (Advanced raises repo limits, e.g. 250) |

**Assessment.** Worktrees are pure local Git plumbing — there is **no technical
reason** to gate them behind private-repo Pro except monetization. That makes
free worktrees-on-private a clean, cheap differentiator for us. Cloud Workspaces,
like Cloud Patches, need a backend.

---

## 12. Remote Provider & Issue-Tracker Integrations

| Feature | Tier | What it does |
|---------|------|--------------|
| **Basic integrations** (autolinking) | 🆓 | Turn issue/PR references in commit messages into clickable links |
| **Rich integrations** (GitHub, GitLab) | 💲 (Pro) | Launchpad support, rich hover info, PR↔branch/commit association, author/commenter avatars |
| **Providers supported** | — | GitHub, GitHub Enterprise, GitLab, GitLab self-managed, Gitea, Gerrit, Bitbucket, Bitbucket Server, Azure DevOps |
| **GitHub Enterprise / GitLab self-managed** | 💲💲 (Advanced) | Self-hosted rich integration via PAT + domain config |
| **Jira integration** | 💲 (Pro+) | Convert Jira keys (e.g. `ABC-123`) to clickable links; connected via GitKraken account |
| **Custom autolinks** | 🆓 | Define your own external-reference → URL patterns |

**Assessment.** Plain autolinks are free; **rich** provider data (avatars, PR
summaries, association) and **self-hosted** providers are the paid escalation.
Self-hosted enterprise integration is correctly an Advanced-tier item. Rich
GitHub/GitLab hovers use public APIs and could be offered cheaper/free.

---

## 13. Editing, Commands & Workflow

All 🆓 unless noted.

- **Powerful Commands:** Add Co-authors, Copy SHA/Message/Current Branch, Switch
  Branch, Compare References / HEAD / Working Tree, Open Changes / All Changes /
  Directory Compare (difftool), Open File/Revision, Open Blame Prior to Change,
  Open/Close Changed/Unchanged Files, Enable/Disable Debug Logging, **Copy as
  Patch / Apply Copied Patch**.
- **Terminal Links** 🆓 — clickable branches/tags/commit ranges/SHAs in the
  integrated terminal.
- **Autolinks** 🆓 — external references → links in commit messages.
- **Experimental Multi-diff Editor** 🆓 🧪 — open folder/commit/stash/comparison
  changes in one multi-diff tab (VS Code 1.86+).

**Assessment.** A deep, all-free command surface. Matching breadth here is a
grind but each command is individually small.

---

## 14. Customization, Modes & Settings

| Feature | Tier | What it does |
|---------|------|--------------|
| **Modes** | 🆓 | User-defined setting bundles. **Zen Mode** hides visual noise; **Review Mode** turns annotations on for review; quick switch; optional status-bar indicator |
| **Menus & Toolbars** | 🆓 | Customize which GitLens commands appear where (interactive settings editor) |
| **Settings Editor** | 🆓 | Rich interactive GUI for all annotation/CodeLens/hover/heatmap/integration settings — not just raw JSON |
| **Themable Colors** | 🆓 | All annotations respect theme + custom color overrides |

**Assessment.** All free, and the **interactive settings editor** is a notable
polish item — GitLens has hundreds of settings made approachable through a GUI.
Underrated and expensive to replicate well.

---

## 15. Account, Security & Enterprise

| Feature | Tier | What it does |
|---------|------|--------------|
| **GitKraken Account** | 🆓 (account, not payment) | Gateway for integrations and cloud features |
| **SSO (single domain)** | 💲💲 (Advanced) | Single-domain SSO |
| **SSO (Okta, Google)** | Enterprise | Org-wide identity |
| **Priority support** | 💲💲 (Advanced) | Faster support SLA |
| **PR automations** | 💲💲 (Advanced) | Automated PR workflows |
| **Security docs** | 🆓 | Published security posture |

**Assessment.** Standard enterprise gating (SSO, support, automations). Not where
individual developers feel pain; relevant only if we pursue team/enterprise sales.

---

## 16. Paywall Map — What You Actually Pay For

Condensed view of exactly where money changes hands.

```
FREE FOREVER (table stakes — we must match):
  Blame (all 5 variants) · Hovers · CodeLens · Status-bar blame
  Revision navigation · Git Command Palette · Interactive Rebase Editor
  Basic commit search · Deep links · Terminal links · Autolinks (basic)
  Modes · Menus/toolbars · Interactive settings editor · All powerful commands
  Basic AI commit message
  Commit Graph / Visual File History / Worktrees  ←  ONLY on local + public repos

PAID via PRIVATE-REPO GATE (Pro) — the core conversion lever:
  Commit Graph on private repos
  Visual File History on private repos
  Worktrees on private repos

PAID — Pro features (no free equivalent):
  Launchpad (PR hub) · Home View dashboard · Commit Composer
  Rich GitHub/GitLab integration (avatars, PR association)
  Jira integration · AI stash messages · AI commit explanations
  Cloud Patches (hosted) · Cloud Workspaces (hosted)
  Bundled AI token allowance (250k/wk)

PAID — Advanced / Enterprise:
  Self-hosted Git integrations (GH Enterprise, GitLab self-managed)
  PR automations · Changelog AI · Single-domain SSO · Priority support
  1,000,000 AI tokens/wk · Org SSO (Okta/Google)
```

**One-sentence summary of GitLens monetization:** *Give away the in-editor blame
experience to drive mass adoption, then charge ~$8/seat/mo the instant a
professional opens the Commit Graph (or other power features) on their private
work repo, with AI tokens and enterprise integrations as the up-sell ladder.*

---

## 17. Monetization Analysis & Our "Fraction of Cost" Angle

### Where GitLens's price is real cost vs pure margin

| Cost-bearing (hard to undercut to $0) | Pure margin / mechanic (easy to undercut) |
|----------------------------------------|-------------------------------------------|
| AI token allowance (real inference $) | Private-repo gate on Commit Graph |
| Cloud Patches / Cloud Workspaces backend | Private-repo gate on Worktrees |
| Hosted account & sync infra | Home View dashboard |
| Priority support staffing | Rich GitHub/GitLab hovers (public APIs) |
| | Launchpad (built on free PR APIs) |

### Recommended positioning levers (decisions for later, evidence here)

1. **Kill the private-repo gate.** Offer Commit Graph, Visual File History, and
   Worktrees **free on all repo types**. This single move neutralizes GitLens's
   primary conversion mechanism and costs us nothing — these are local Git
   operations. Strongest, cheapest differentiator.
2. **AI as BYOK, $0 token cost.** Let users plug in their own
   Anthropic/OpenAI/Copilot key. We never resell inference, so we can offer the
   *full* AI surface (messages, explanations, composer) without the recurring
   COGS that forces GitKraken's price up and their token caps.
3. **Undercut the headline price.** Target **$2–4/seat/mo** or a **free-core +
   cheap-Pro** split. The number to beat publicly is **$8/seat/mo**.
4. **Avoid the hosted-backend features first.** Cloud Patches / Cloud Workspaces
   carry real infra cost; treat them as later/optional (or self-host-only) rather
   than launch blockers.
5. **What we could still charge for** (sustainable paid tier without heavy COGS):
   team features, advanced Launchpad/PR automation, self-hosted enterprise
   integrations, SSO — i.e., target *teams/enterprise* for revenue while keeping
   the *individual developer* experience free or near-free.

### Risk / honest caveats

- **Polish is the moat, not the feature list.** GitLens's value is in the
  thousands of settings, theming, hover richness, and 10+ years of edge-case
  handling. A feature-parity checklist underestimates the work; the interactive
  settings editor and blame rendering quality alone are large efforts.
- **Brand/trust & the GitKraken ecosystem** (Desktop, CLI, cross-tool patches)
  are part of what Pro buyers pay for. We can't match the ecosystem; we compete
  on price + openness, not breadth.
- **AI BYOK shifts UX burden to the user** (key management). Good for cost, worse
  for one-click onboarding — a real tradeoff to design around.
- **Verify the private-repo gate before launch messaging.** GitKraken adjusts
  what's gated between releases; re-confirm against the live product near launch.

---

## 18. Sources

Verified May 2026.

- [GitLens Core Features — GitKraken Help](https://help.gitkraken.com/gitlens/gitlens-features/)
- [GitLens Community vs. Pro — GitKraken Help](https://help.gitkraken.com/gitlens/gitlens-community-vs-gitlens-pro/)
- [GitLens Pro Features — GitKraken](https://www.gitkraken.com/gitlens/pro-features)
- [GitLens Pricing — GitKraken](https://www.gitkraken.com/gitlens/pricing)
- [GitKraken Pricing (suite) — GitKraken](https://www.gitkraken.com/pricing)
- [GitLens — Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens)
- [vscode-gitlens — GitHub](https://github.com/gitkraken/vscode-gitlens)
- [GitKraken Pricing 2026 — TheSoftwareScout](https://thesoftwarescout.com/gitkraken-pricing-2026-plans-costs-is-it-really-worth-it/)
- [GitLens Pro via GitHub Student Pack](https://aistudentdiscount.com/gitlens-pro-github-student-developer-pack/)
