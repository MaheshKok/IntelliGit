# CI Checks tab — planning brief

Date: 2026-11-07. Base: `/Users/maheshkokare/PycharmProjects/IntelliGit`, `main` at `846f8506` (0.43.1), clean. Planning only; the plan is built later through phase-run waves.

## Locked intent

The user wants the CI/CD display in IntelliGit's Git Log redesigned into "one of the most useful features for users and the most appealing UI". Two blind proposals were compared (Opus 5.5 and Fable 5.1). The user picked **Fable 5.1's proposal plus Opus's two extras** (user message, 2026-11-07: "Fable + your extras").

Source proposal (read it in full; it is the reference behaviour): `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/fable/ideas.md`.
Design (Figma, design-first rule): https://www.figma.com/design/sB9RPn3wTLcbpWZIwKyrUB — frames `1:2` Git Log CI column, `2:2` Checks tab, `3:2` status bar + toast, `4:2` CI bisect. Same design as HTML: `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/design/checks-tab.html`. All data in it is sample.

Every feature below is in scope; the plan orders them into phases, it does not drop any. Narrowing or deferring any one is `PENDING-OWNER`.

1. Grouped check tree: workflow → job → step, with status, duration and start time; failed jobs expanded to the failing step.
2. HEAD status-bar item (`✗ 1 · ● 2 · ✓ 7  4m 12s`) plus one toast when the user's own HEAD goes from pending to settled, once per hash, with Open Checks / Open log / Re-run failed.
3. Failure summary inline and "Open full log in editor": a read-only editor document opened at the first error line. Logs are streamed to extension storage; the full log never enters webview state. A bounded excerpt around the first error (≤ 40 lines, ≤ 8 KB, escaped text) may, because the approved design (frame 2:2) shows one.
4. Failure annotations as Problems-panel diagnostics (GitHub only), source `CI: <job>`, HEAD only, cleared when HEAD moves.
5. Re-run failed / re-run job / cancel run (cancel asks to confirm).
6. "Blocks merge" tag for required checks; "optional" tag for allowed-to-fail jobs; "required: unknown" when the provider refuses.
7. Live elapsed timer and "usually ~Xm" from the previous successful run; "overdue" hint past 1.5× usual.
8. "new" / "still" / "fixed" tags per job versus the parent commit, joined by job name; "unknown" when a matrix job was renamed.
9. "Also red on main" tag, default branch read from `origin/HEAD`.
10. Header line: trigger event, actor, ref, run number.
11. Optional fixed-width CI column in the Git Log: stacked green/red/yellow bar plus `passed/total`.
12. ETag conditional polling for pending commits.
13. Surprise — CI bisect: right-click a range → "Find where CI broke"; per-job sparkline over the visible commits and "broke at <hash>". Range capped at the visible page.
14. **Opus extra — Changed since last green**: in a failed job's detail, the files changed between the last commit where that job passed and the selected commit, from local git (`git diff <lastGreen>..<sha>`), each opening its diff. Works on every provider.
15. **Opus extra — Flaky badge**: a `flaky n/m` tag on a job that failed then passed on the same commit (re-runs) or flips green/red without a run of reds, over the cached history. Shown in the tree and in the bisect view.

Surfaces (Fable's layout, chosen): a **Checks tab** in the existing commit-details pane next to the changed-files list; the existing per-row popover stays as the quick look and gains "Open in Checks"; the status bar item; Problems diagnostics; the optional CI column. Rejected (ideas.md §5): an Activity Bar container, a bigger popover, an Output channel for logs.

## Hard rules

- **Dynamic over hardcoded** (standing user rule): rate limits from response headers (`requestGate.ts` already observes them), ETags from responses, "usually" from the previous run, default branch from `origin/HEAD`, required checks from the provider. A missing source shows "unknown" in the UI and never a guessed constant.
- **Scopes are opt-in**: reading keeps today's scopes. Write actions needing a wider token (GitLab `api`, Bitbucket Cloud pipeline write) are offered, and on 403 explained with how to make such a token; never requested up front.
- **Bitbucket Server is the floor**: no jobs, steps, logs, annotations or re-runs. Its UI degrades to flat list + duration + required without looking broken. Every feature is tagged per provider by a provider-declared capability, not by UI `if provider === …` checks.
- **Settled runs are immutable**: cache hard (the existing 24 h persistent cache); spend the request budget on pending ones.
- **All four providers** keep working; nothing regresses for users who never open the tab.
- Repository rules: every PR bumps the version and adds a user-friendly `CHANGELOG.md` entry (project CLAUDE.md); new strings ship with their l10n in the same phase; a new command lands in both e2e command inventories.

## Correction to the source proposal

ideas.md:15 says "No retry ladder exists". That is half right:
- Right: the service turns a fetch failure into an `unavailable` snapshot cached 15 min (`service.ts:76-90`, `:57`, per Fable, not re-read).
- Wrong: the webview has a retry ladder for pending checks: `retryDelaysForCommitChecks` at `src/webviews/react/commit-list/checksRefresh.ts:48`, called at `src/webviews/react/CommitList.tsx:521` and `:569` inside `scheduleNextRetry` (`:511`).
The plan must state: pending checks re-poll on a ladder; failed fetches do not retry. Re-read `service.ts` and `coordinator.ts` before relying on the 30 s / 15 s TTLs (ideas.md:15-19, not re-verified).

## Code map (from a finder lane, 2026-11-07)

| What | Where |
|---|---|
| Commit details pane (no tabs today) | `src/webviews/react/commit-info/CommitInfoPane.tsx:141` export, `:244-254` render, `CommitChangedFilesPanel` at `:254` / `:388` |
| Hosts of the pane | `src/webviews/react/CommitGraphPanel.tsx:631`, `CommitInfoApp.tsx:105`, `undocked/UndockedLayout.tsx:433` |
| Checks column gate | `src/webviews/react/CommitList.tsx:441-442` (Author/Date gate `:456-457`), header `:719` |
| Checks cell in a row | `src/webviews/react/commit-list/CommitRow.tsx:542-550` (`CommitChecksButton` `:543`), fed by `CommitListRows.tsx:113-116` |
| Popover | `src/webviews/react/commit-list/CommitChecksPopover.tsx` (`CommitChecksPanel` `:186`) |
| Types | `src/types.ts:137` `CommitCheckItem`, `:146` `CommitChecksSnapshot` |
| Providers | `src/services/commitChecks/githubProvider.ts`, `gitlabProvider.ts`, `bitbucketShared.ts`, `bitbucketServerProvider.ts` (URL at `:237`: ``https://${host}/rest/build-status/1.0/commits/${encodeURIComponent(hash)}``) |
| Cache / gate | `coordinator.ts`, `service.ts`, `persistentCache.ts`, `requestGate.ts` under `src/services/commitChecks/` |
| Read-only document provider to copy | `src/services/diffService.ts:174` `registerReadonlyDiffContentProvider` (the only `registerTextDocumentContentProvider`, `:178`), wired at `src/extension.ts:41` |
| Status bar item / DiagnosticCollection | none exist in the extension today |
| Settings | `package.json:1561-1615`: `intelligit.commitChecks.hosts`, `.enabled`, `.providers`, `.ciCdFilter` |
| Docs | `docs/commit-checks/README.md` |
| Tests | `tests/unit/services/commitChecks/*`, `tests/integration/webviews/commitChecksEnabled-gating.integration.test.tsx` |

## Provider API facts

Checked against official docs by a web-research lane on 2026-11-07. Anything not listed here is `[ASSUMED]` in the plan.

**GitHub**
- `GET /repos/{o}/{r}/actions/runs?head_sha=` and `GET .../actions/runs/{run_id}/jobs` exist. Each job has `steps[]` with `status`, `conclusion`, `started_at` and `completed_at` (all nullable except `status`). Permission: Actions read. https://docs.github.com/en/rest/actions/workflow-runs and https://docs.github.com/en/rest/actions/workflow-jobs
- `GET .../check-runs/{id}/annotations` returns `path`, `start_line`, `end_line`, `annotation_level` and `message`. It needs the classic `repo` scope on private repos. The fine-grained permission is **not documented**, so it goes under open questions. https://docs.github.com/en/rest/checks/runs
- `GET .../actions/jobs/{job_id}/logs` answers 302 with a `Location` link that **expires after 1 minute**. Permission: Actions read.
- `POST .../runs/{id}/rerun`, `.../rerun-failed-jobs` and `.../cancel`, and `POST .../actions/jobs/{job_id}/rerun` (single-job re-run, which **does exist**) all need Actions write, or classic `repo`.
- Required checks: `GET .../branches/{b}/protection/required_status_checks` needs Administration read (fine-grained). A non-admin route is `GET .../rules/branches/{branch}` (Metadata read). It returns active rulesets but **not classic branch protection**, so the plan must decide how to combine the two, falling back to "unknown". https://docs.github.com/en/rest/branches/branch-protection and https://docs.github.com/en/rest/repos/rules
- ETag: a 304 does not count against the primary limit **only when the request carries `Authorization`**. https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

**GitLab**
- The `pipelines?sha=`, `pipelines/:pid/jobs`, `jobs/:jid/trace`, `jobs/:id/retry` and `pipelines/:id/cancel` endpoints all exist.
- Reading works with `read_api`. Retry and cancel need `api`. This is inferred from the scope definitions, because the docs give no scope per endpoint. https://docs.gitlab.com/api/jobs/ and https://docs.gitlab.com/security/tokens/access_token_scopes/

**Bitbucket Cloud** (from https://api.bitbucket.org/swagger.json)
- Filter pipelines by commit with `target.commit.hash`.
- Steps and step logs need scope `pipeline`. `stopPipeline` needs `pipeline:write`.
- Auth types listed: OAuth and API token. App passwords are **not listed**, so the plan must check what the existing Bitbucket Cloud auth uses.

**Bitbucket Server / Data Center**
- `/rest/build-status/1.0/commits/{id}` (used today) is called deprecated by Atlassian support since 7.4. The replacement is `/rest/api/latest/projects/{p}/repos/{r}/commits/{id}/builds`.
- Atlassian's own tickets disagree (BSERV-13381, BSERV-19724). So the migration must **keep the old endpoint as a fallback** for older servers and must not break them.
- `GET /rest/required-builds/latest/projects/{p}/repos/{r}/conditions` (REPO_READ) exists. This comes from search snippets only; the page was not read in full.

## Check commands (package.json)

- Unit + integration: `bun vitest run` (`"test"`, `package.json:1649`)
- Lint: `eslint src scripts tests` (`:1633`)
- Typecheck: `bun run typecheck` (ext + webview + tests, `:1646`)
- Build: `bun scripts/build.js` (`:1621`)
- E2E: `bun run test:e2e` (Playwright, `:1655`); e2e proof runs on CI, not locally.
- No Makefile.

## Options already rejected

- Separate Activity Bar view, bigger popover, Output-channel logs (ideas.md §5).
- Requesting wider token scopes up front.
- Provider checks scattered as `if` branches in UI components (use declared capabilities).

## What the plan must prove (journeys and failure cases)

- Select a commit → Checks tab shows the tree; switch commits rapidly → no stale tree from the previous commit.
- Pending HEAD → status bar counts tick → settles → exactly one toast; reload VS Code mid-run → no duplicate toast for an already-settled hash.
- Open full log → editor at first error; log larger than the webview message limit; log URL expired (GitHub 302 link lives ~1 min) → re-fetch.
- Re-run failed with a read-only token → 403 explained, nothing else breaks; cancel → confirm → state turns cancelled.
- Required checks endpoint refuses (non-admin) → "required: unknown", not an error.
- Signed out, provider unreachable, rate limit near → existing sign-in / error / cooldown states, rendered inside the tab.
- Bitbucket Server repo → flat list, duration, required; no empty sections, no dead buttons.
- HEAD moves → Problems diagnostics from the old HEAD are cleared.
- Bisect over uncached commits → requests go through `requestGate`, cancellable, capped at the visible page.
- Changed since last green when no green exists in the loaded history → says so, no diff list.
