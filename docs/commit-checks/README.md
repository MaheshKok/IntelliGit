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
| GitHub (`github.com`) | Built-in VS Code GitHub session | Automatic — VS Code prompts for the GitHub sign-in on first use | `repo` |
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
| `intelligit.commitChecks.ciCdFilter` | string | `""` | Safe regex subset (case-insensitive) selecting which check names count as CI/CD on GitHub and GitLab. Empty keeps the built-in pattern. |
| `intelligit.commitChecks.hosts` | object | `{}` | Self-hosted host-to-provider map (see above). |

Notes:

- `ciCdFilter` only overrides the *include* half of the filter. Review-bot checks
  (coderabbit, reviewdog, and similar) are always excluded regardless of the pattern,
  and an invalid or unsafe regex falls back to the built-in pattern and shows a one-time warning.
- The `ciCdFilter` allowlist applies to GitHub and GitLab only. Bitbucket Cloud and
  Server intentionally aggregate every reported build status (no allowlist) so a
  failing non-keyword tool such as Jenkins or SonarCloud is never hidden.

## Rate limits and caching

The coordinator caches each commit's snapshot by SHA:

- Terminal `success` / `failure` snapshots are cached indefinitely.
- `pending`, `none`, and recoverable `unavailable` snapshots are served from cache
  within a fixed TTL (`DEFAULT_COMMIT_CHECKS_TTL_MS`, 15 seconds). Scrolling and
  re-renders within the TTL reuse the cached snapshot; the 15-second graph poll
  re-fetches once the TTL elapses.

This is a **throttle, not server-driven backoff**: it guarantees at most one request
per commit per TTL, but it does not read a server-sent `Retry-After` / rate-limit-reset
header. While a host stays rate-limited (HTTP 429, surfaced as `unavailable`), the
badge still re-fetches once per TTL and auto-recovers after the limit clears, rather
than honoring an exact server clear-time. Literal `Retry-After` handling is a tracked
follow-up; see `docs/commit-checks/implementation-runbook.md` for the upgrade path.
