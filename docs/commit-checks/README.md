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

## Re-run and cancel

Before IntelliGit sends a re-run or cancel request, it saves a note for that run or job
in the workspace and waits for the save to finish; if the note cannot be saved, the
request is not sent. While a note exists for a commit, that commit's check results are
kept in memory only and refreshed on the short pending interval (30 seconds). They are
never written to the caches that survive a restart, so an old result cannot come back
while the new run starts.

The note itself is kept across a restart. It ends when a fetched result shows the
action took effect (a new run attempt or job, or the run cancelled or finished), or at
once when the request definitely fails, for example when the provider refuses it. Nothing removes it by age: after 10 minutes
without that evidence the target reads "not seen yet - Refresh", and clicking Refresh
then ends the note and fetches the commit again. A Refresh before then keeps the note.
