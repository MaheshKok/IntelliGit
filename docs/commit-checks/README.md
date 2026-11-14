# Commit Checks

IntelliGit shows a CI/CD status badge next to each commit in the commit graph. The
badge aggregates the build / check results that the commit's host (GitHub, GitLab,
Bitbucket Cloud, or Bitbucket Server / Data Center) reports for that commit SHA, and
opens a popover listing the individual checks with links back to the host.

This document covers setup (tokens, scopes, self-hosted host mapping), the available
settings, and the rate-limit / caching behavior.

## How it works

For each visible commit the extension resolves a provider from the repository's
remotes (origin first), fetches that commit's checks from the provider's API, and maps
the host-specific states into one shared snapshot:

- `success` — all aggregated checks passed.
- `failure` — at least one check failed.
- `pending` — checks are still running (re-polled until they settle).
- `none` — the provider returned no checks for the commit, or the feature/provider is
  disabled for that remote.
- `unavailable` — the checks could not be fetched. When this is caused by a missing or
  rejected token for a known host, the popover offers a host-targeted **Sign in**
  button; for generic network/HTTP errors it just shows the error.

Provider resolution is a hard stop: the first remote (origin first) that matches a
registered provider claims the commit. If that provider is disabled, the badge is
`none` — the extension does not fall through to a different remote whose provider is
enabled.

## Checks tab

The Checks tab is still being built and stays hidden in released versions until it is
finished; this section describes it as it will appear. While it is hidden, no Checks tab
detail is fetched; the commit-list CI badges still fetch as before.

The commit-details pane has two tabs, **Files** (the default) and **Checks**. The pane
remembers the tab you chose. The Checks tab shows the selected commit's CI as a tree:
workflow or pipeline, then its jobs, then each job's steps, each with its state,
duration and start time. Failed jobs open down to the step that failed. Statuses and
third-party checks that belong to no workflow sit under **Other checks**. Selecting a
job shows its details beside the tree when the pane is at least 760 px wide, and below
it in a narrower pane.

- The header shows the overall state, the duration and, when the provider reports it,
  "push by <actor> · <ref> · #<run>". **Refresh** always fetches again; **Open in
  browser** appears when the provider gives a link.
- Controls appear only for what the provider can do. GitLab shows pipelines and their
  jobs, grouped by stage; its API reports no steps, so jobs have none. A provider whose
  workflow detail this release does not read (Bitbucket Cloud and Bitbucket Server /
  Data Center) shows a flat list with no empty sections.
- A very large run shows a note when its list was cut short, with a link to the rest
  in the browser. Failed jobs past that limit are still listed as they are found.
- The tab shows the same signed-out, error and rate-limit states as the popover, and a
  link to the setting when CI checks are turned off. Signing in or out reloads an open
  tab, so it never keeps showing the previous account's checks.
- The popover's **Open in Checks** button selects the commit and switches to this tab.

The tab asks for detail only while it is open. A reply for a commit or repository that
is no longer selected, or an older reply for the same commit, is dropped.

### Required and optional checks

A required job or check that failed or has not finished yet carries a red **blocks
merge** tag. A GitLab job that is allowed to fail (`allow_failure`) carries a muted
**optional** tag. When IntelliGit cannot tell which checks are required, the header says
**required: unknown**; that is a fact about what the provider shares, not an error.

- The rule is read for the repository's default branch, which IntelliGit takes from
  `origin/HEAD` every time, never from a cache or a guessed `main`. The header names
  that branch (**required checks from trunk**), whatever branch the run was on. When
  `origin/HEAD` is missing, the header says so: run `git remote set-head origin --auto`
  to set it.
- GitHub: a check is required when the branch's rulesets or its branch protection name
  it. Both are always read. A branch with no protection keeps the answer complete; when
  your token may not read the protection settings, the header shows
  **required: unknown** and only the ruleset checks can carry the tag.
- GitLab: with **Pipelines must succeed** on in the project's merge request settings,
  every job not allowed to fail is required. When the project setting cannot be read,
  the header shows **required: unknown**.
- Bitbucket Cloud and Bitbucket Server / Data Center always show **required: unknown**
  in this release.
- The rule is kept in memory for one hour per repository and branch; signing in or out
  drops it. A network or server error is not kept, so the next look asks again.

### Write actions

On GitHub and GitLab the tab can **Re-run failed** jobs of a failed run, **Re-run job**
for one finished job, and **Cancel run** for a queued or running run. Cancel asks once
more (**Confirm cancel** or **Keep running**) before anything is sent. While a request is
on its way every action button waits, so a second click sends nothing. Afterwards the
tab shows "Waiting for re-run to start" (or "Waiting for cancel to take effect") until
the provider shows the new state; after 10 minutes without it, the label turns into a
**Refresh** link.

These actions need a token that can write:

- GitHub uses the same built-in VS Code session and its `repo` scope; no new scope is
  asked for. You also need permission to run workflows in the repository.
- GitLab needs a personal access token with the `api` scope; a `read_api` token can only
  read. Create one in GitLab under **Preferences → Access tokens**, then store it with
  `IntelliGit: Sign in to Commit Checks Provider`.

When the token cannot write, the tab says so, keeps the checks on screen, and links to
this section.

## Authentication per provider

| Provider | Credential | How to provide it | Scope / permission |
|----------|------------|-------------------|--------------------|
| GitHub (`github.com`) | Built-in VS Code GitHub session | Existing VS Code session only — automatic checks do not open a GitHub sign-in prompt | `repo` |
| GitLab (`gitlab.com` + self-hosted) | Personal access token | `IntelliGit: Sign in to Commit Checks Provider` command | `read_api` |
| Bitbucket Cloud (`bitbucket.org`) | Access token or OAuth Bearer token (app passwords are not supported) | `IntelliGit: Sign in to Commit Checks Provider` command | `repository` (read) |
| Bitbucket Server / Data Center (self-hosted) | HTTP access token | `IntelliGit: Sign in to Commit Checks Provider` command | Repository read |

GitHub uses the editor's built-in account, so it never needs a stored token. The other
three read a per-host token from VS Code SecretStorage. Use the command palette:

- `IntelliGit: Sign in to Commit Checks Provider` — stores a token for a host. You can
  also reach this directly from the badge popover's **Sign in** button, which targets
  the exact host of the commit you are looking at (no host picker).
- `IntelliGit: Sign out of Commit Checks Provider` — clears the stored token for a host.

Tokens are passed only to the request `Authorization` / `PRIVATE-TOKEN` header. They
are never written to logs, error messages, or the check snapshots.

## Self-hosted host mapping

Self-hosted GitLab and Bitbucket Data Center run on custom hostnames, so the extension
cannot guess which provider a host speaks. Map each self-hosted host to its provider
with `intelligit.commitChecks.hosts`:

```jsonc
{
  "intelligit.commitChecks.hosts": {
    "gitlab.acme.com": "gitlab",
    "bitbucket.acme.com": "bitbucket-server"
  }
}
```

Allowed provider ids in this map are `gitlab` and `bitbucket-server` (the fixed-host
SaaS providers — GitHub and Bitbucket Cloud — are matched automatically and are not
configurable here). After mapping a host, sign in for that host with the command above.

## Settings

All commit-check settings are read once at activation and **take effect after a window
reload** (`Developer: Reload Window`).

| Setting | Type | Default | Effect |
|---------|------|---------|--------|
| `intelligit.commitChecks.enabled` | boolean | `true` | Master switch. When `false`, no badge renders and no check network calls are made. |
| `intelligit.commitChecks.providers` | object | all `true` | Per-provider toggles keyed `github`, `gitlab`, `bitbucket-cloud`, `bitbucket-server`. A disabled provider yields no badge for its remotes. |
| `intelligit.commitChecks.ciCdFilter` | string | `""` | Regex (case-insensitive) selecting which check names count as CI/CD on GitHub and GitLab. Empty keeps the built-in pattern. |
| `intelligit.commitChecks.hosts` | object | `{}` | Self-hosted host-to-provider map (see above). |

Notes:

- `ciCdFilter` only overrides the *include* half of the filter. Review-bot checks
  (CodeRabbit, reviewdog, and similar) are always excluded regardless of the pattern,
  and an invalid regex falls back to the built-in pattern and shows a one-time warning.
- The `ciCdFilter` allowlist applies to GitHub and GitLab only. Bitbucket Cloud and
  Server intentionally aggregate every reported build status (no allowlist) so a
  failing non-keyword tool such as Jenkins or SonarCloud is never hidden.

## Rate limits and caching

Commit checks share runtime caching and in-flight request de-duplication across graph
surfaces. Cache keys remain provider and repository scoped (as well as commit and
settings scoped), so snapshots from different providers or repositories are never
shared. Eligible settled and no-check snapshots can also be retained across extension
restarts; pending and unavailable snapshots are not persisted.

A snapshot counts as settled only when every check in it has finished. A failure
reported while other checks are still running stays on the short pending refresh
interval and is not kept across restarts, so the badge keeps updating until the last
job ends. The detailed CI view uses its own cache with the same intervals; it keeps a
detail across restarts only when the run is finished and every run, job and check was
listed in full.

For GitHub, the detailed view reads the commit's workflow runs and each run's latest
jobs and steps from the Actions API, 100 items per page and at most 10 pages (1,000
items) per list. A longer list comes back marked as cut short at 1,000 items; when that run failed,
IntelliGit keeps reading the pages past the limit one at a time, keeping only failed
jobs, so a scan that reaches the end of the list shows every failed job. That scan
pauses while the rate-limit gate cools down and resumes when the cooldown ends; if a
page fails, a next-page link is refused or the job budget runs out, it stops and the
failed jobs it found so far may be only part of the list. Refresh continues from the
page it stopped at. If the run was re-run while the scan was reading, the scan stops
instead and Refresh reads the run again from the start. Its progress is kept in memory only. Next-page
links are followed only when they stay on `https://api.github.com` under the
repository's own path; any other link stops paging, is never requested, and the list
is marked as cut short, so the token is never sent anywhere else.

For GitLab, the detailed view reads the commit's pipelines, each pipeline's own header
(who started it, when it started and finished) and its latest jobs, plus the commit's
statuses, with the same `read_api` token, 100 items per page and at most 10 pages per
list. A status that is none of the pipelines' jobs, such as an external CI's, is listed
under **Other checks**. When a failed pipeline has more than 1,000 jobs, IntelliGit
then reads the pipeline's failed jobs on their own, one page at a time, and adds the
ones not already listed, and their statuses leave **Other checks**; the scan pauses,
stops and resumes the same way as GitHub's. If the pipeline is retried while the scan is
reading, even when the retry fails again, the scan stops and Refresh reads it again. A
pipeline retried while its first 1,000 jobs are read is shown as still settling and read
again shortly. If GitLab gives the pipeline no update time, a retry that fails again
cannot be seen while the scan reads, so the scan ends as stopped with that reason instead
of done, and Refresh reads the failed jobs again from the start. For the same reason, a
pipeline with no update time is kept for the session only and read again after a
restart, and the copy saved before it is deleted. If that delete fails, the older copy
can come back after a restart, until you press Refresh.

After a re-run or cancel, the window you started it from waits for the new run and
never shows the old result again. Another VS Code window open on the same repository
keeps showing the old result until you press Refresh there. Rarely, an older copy that
another window saved can come back after a restart, until you press Refresh. A GitLab
403 is treated as a missing permission, never as a rate limit.
Next-page links are followed only on the GitLab host under the project's own API path.

While the last read of a commit was incomplete (checks still pending, none reported yet,
or the read failed), GitHub, GitLab and Bitbucket (Cloud and Server) requests for it are
conditional:
IntelliGit remembers each answer's `ETag` and sends it back as `If-None-Match`, so an
unchanged list comes back as a body-less `304 Not Modified` (free against GitHub's
request allowance) and the remembered answer, with its next-page links, is used again.
A commit's first read is always a full one, and requests for a commit whose last read
was complete are never conditional. The remembered answers live in memory only, at most 500
per window, keyed by the request URL and the current sign-in. Each answer also records
a digest of the request headers it was read with, so a request with another token (a
sign-in change, or a token saved from another window) is never conditional and never
gets another token's answer. A `304` with nothing remembered is sent again once without
`If-None-Match`, as a request of its own: it waits for a rate-limit cooldown and counts
against the request allowance like any other.

Diagnostic lines for CI requests go to the **IntelliGit CI** output channel. They name
the operation, provider and short commit hash; they never contain tokens, request
headers or log text.

Automatic HTTP requests pass through a gate for each provider/API-origin pair. Every
gate allows four concurrent requests and starts no more than 300 automatic requests in
an hour. It also honors provider-specific response signals:

- **GitHub:** one shared `api.github.com` scope. GitHub quota metadata preserves a
  reserve, and reset or retry signals start a cooldown.
- **GitLab:** one scope per configured API host. It uses the same concurrency and
  client budget, then honors server `RateLimit` remaining/reset data and `Retry-After`.
  It does not assume a server quota when that metadata is absent.
- **Bitbucket Cloud:** one shared `api.bitbucket.org` scope. It uses the same
  concurrency and client budget, with `X-RateLimit-NearLimit` and `Retry-After`
  driving cooldowns.
- **Bitbucket Server/Data Center:** one scope per configured API host. It uses the
  same concurrency and client budget, then cools down on HTTP 429 and `Retry-After`;
  if no retry time is supplied, the fallback is 60 seconds. It does not infer an
  instance quota.

A bare HTTP 403 from GitLab or either Bitbucket provider remains an authentication or
availability result, not a quota cooldown.

## CI logs

> Planned: like the Checks tab itself, the log view below stays hidden in released versions
> until the tab is finished. GitHub and GitLab logs work today; Bitbucket logs come later.

In the Checks tab, a finished failed job shows why it failed when the provider says so
(GitHub: the check run's title and summary; GitLab: the job's failure reason), and a short
excerpt of its log around the first error line: GitHub's `##[error]` line, GitLab's
`ERROR:` line, else the first line that says error or failed. The summary and the
excerpt are shown as plain text, at most 2 000 characters for the summary and 40 lines or
8 KB for the excerpt, with colour codes and control characters removed. Only the excerpt
reaches the tab; the full log stays in the extension.

**Open full log in editor** opens the whole log in a read-only editor tab at the first
error line, with a progress notification you can cancel. The log is downloaded once: the
excerpt and the editor share it. A job that is still queued or running shows "Log
available when the job finishes" and downloads nothing. A token that may not read logs
shows "Your token cannot read this log". A log cut at 50 MB shows a note with **Open in
browser** for the rest.

CI logs are held in memory, one store per VS Code window, and are never written to disk.
A window keeps the three most recently used logs; opening a fourth drops the oldest, and
asking for a dropped log downloads it again. Two windows never share a downloaded log,
and a window reload or a VS Code restart empties the store. A log tab that VS Code
restores after a reload says the log is no longer loaded until you open it again from
the Checks tab.

Each log keeps at most its first 50 MB. A log that reaches 50 MB ends with the line
`[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]`.

Log downloads follow redirects (such as GitHub's short-lived log links) only to `https:`
addresses and at most five times. When a redirect leads to another host, scheme or port,
IntelliGit removes the `Authorization`, `Cookie`, `Private-Token` and `Job-Token` headers
and does not send them again for the rest of that download.

## Re-run and cancel

> Planned: the Re-run and Cancel actions are not available yet. This section describes
> how they will behave; the note store below is in place, but nothing creates a note yet.

Before IntelliGit sends a re-run or cancel request, it saves a note for that run or job
in the workspace and waits for the save to finish; if the note cannot be saved, the
request is not sent. While a note exists for a commit, that commit's check results are
kept in memory only and count as out of date after 30 seconds (the short pending cache
lifetime), so the next look at the commit fetches it again; how often the commit is
polled is a separate schedule. The results are never written to the caches that survive
a restart, so an old result cannot come back while the new run starts.

The note itself is kept across a restart. It ends when a result fetched after the click
shows the action took effect, or at once when the request definitely fails, for example
when the provider refuses it. What counts as taking effect depends on the action:

- Re-run on GitHub: the run gets a new attempt, or moves back to queued or running.
- Retry of a GitLab job: a newer job with the same name appears in the pipeline.
- Retry of a GitLab pipeline: a job newer than any the pipeline had appears.
- Cancel: the run is cancelled or finished.

A result for an older run attempt than the one clicked never ends a note. Nothing
removes a note by age: after 10 minutes without that evidence the target reads
"not seen yet - Refresh", and clicking Refresh then ends the note and fetches the
commit again. A Refresh before then keeps the note.
