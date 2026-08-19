# Open Repository button (issue #167)

## Goal

Add a title-bar button to the Commit panel (`intelligit.commitPanel`) that opens the
active repository's remote page in the user's browser. Works for GitHub, GitLab,
Bitbucket, and self-hosted hosts alike — the button is host-agnostic.

Done means: with a repo whose `origin` is any of the supported remote URL shapes,
clicking the button opens the correct `https://host/owner/repo` page; with no repo,
no remote, or an unparseable remote, the user gets a timed warning and no navigation.

## Approach

1. **New pure module `src/git/remoteWebUrl.ts`** exporting
   `remoteUrlToWebUrl(remoteUrl: string): string | null`.
   Host-agnostic conversion of a git remote URL into a browsable web URL.
   This is the whole correctness surface, and it is unit-tested and mutation-proved.

2. **Command `intelligit.openRepository` (+ `.color`)** registered in
   `src/activation/repositoryCommands.ts` alongside the other repository commands.
   Resolves `origin`, falls back to the first remote from `GitOps.getRemotes()`,
   converts via the module above, and opens with `vscode.env.openExternal`.

3. **Wiring**: `package.json` commands + `view/title` menu entries gated on
   `config.intelligit.icons`; `noRepositoryMode.ts` gets both ids so the button
   degrades to the standard "no repository" message; 4 new SVG icons; the
   `command.openRepository` key added to all 12 `package.nls*.json` files and the
   two runtime warnings added to all 12 `l10n/bundle.l10n*.json` files.

## Key decisions & tradeoffs

- **New module rather than reusing a provider parser.** All four existing parsers
  (`parseGithubRemoteUrl`, `parseGitlabRemoteUrl`, the two Bitbucket ones) are
  host-locked and return API refs, not web URLs. The issue explicitly wants "GitHub,
  GitLab, etc.", so host-locking would fail the requirement.

- **Credentials are stripped, always.** `https://user:token@host/o/r.git` becomes
  `https://host/o/r`. Opening a URL with an embedded PAT hands it to browser history,
  the referrer chain, and any sync. This is the one non-negotiable in the module, and
  it holds structurally: the output is rebuilt from `URL.host`/`URL.hostname`, both of
  which exclude the userinfo section, rather than edited in place.

- **SSH ports are dropped, web ports are kept.** `ssh://git@host:2222/o/r.git` must
  not become `https://host:2222/...` — 2222 is an SSH port and would 404 or worse.
  An explicit port on an `https://` remote is already a web port and is preserved.

- **`http://` remotes stay `http://`.** Self-hosted instances on plain HTTP exist, and
  this is a browser navigation, not a server-side fetch, so the SSRF reasoning that
  makes `gitlabProvider` reject `http` does not apply. Everything that is not
  `http`/`https` after conversion is rejected.

- **Placement on the Commit panel** (user decision). It becomes that view's first
  title button.

- **A `link-external` glyph in the repo's 4-file SVG convention**, not the `$(link)`
  codicon the issue suggested (user decision). The codicon would not have honoured
  the `intelligit.icons` mono/color setting every other title button respects.

## Out of scope

- Opening a specific branch, commit, file, or line — this opens the repository root only.
- A setting to choose which remote is used; `origin` with a first-remote fallback covers
  the reported need.
- Changing the existing provider parsers.
