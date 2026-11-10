# Plan: CI Checks tab — grouped CI tree, HEAD status, logs, actions and CI bisect in the Git Log
_Written by fable-author (D1) from BRIEF.md, 2026-11-07; revised after Codex Round 1; revised after Codex Round 2 (path C); revised after Codex Round 3_

## Goal

Today a red CI badge in the Git Log answers only "is this commit green?". The next questions are which job failed, why, whether it blocks the merge, whether my commit caused it, and how to re-run it. Each of those still needs a browser tab. This plan turns IntelliGit's CI display into a working tool inside the editor [FACT: BRIEF.md:7, ideas.md:23].

In scope: all 15 features in BRIEF.md "Locked intent" (BRIEF.md:14-28), on the surfaces the user chose: a **Checks tab** in the commit-details pane, the existing popover kept as a quick look that gains "Open in Checks", a status-bar item for HEAD, Problems diagnostics, and an optional CI column (BRIEF.md:30). All four providers (GitHub, GitLab, Bitbucket Cloud, Bitbucket Server / Data Center) keep working. Each provider declares what it can do, and the UI reads that declaration instead of checking which provider it is (BRIEF.md:36).

Feature → phase map (no feature is dropped; three bounds that narrow features are owner-resolved rows O1-O3):

| # | Feature (BRIEF.md) | Phase(s) |
|---|---|---|
| 1 | Grouped check tree workflow → job → step | 1 (contracts, cache), 2 (GitHub), 3 (GitLab), 4 (UI), 17 (Bitbucket Cloud), 18 (Bitbucket Server floor) |
| 2 | HEAD status-bar item + once-per-hash toast | 13 |
| 3 | Failure summary + "Open full log in editor" | 6 (log transport and in-memory log store), 7 (GitHub, GitLab, preview, editor and UI), 17 (Bitbucket Cloud) |
| 4 | Problems diagnostics (GitHub only, HEAD only) | 14 |
| 5 | Re-run failed / re-run job / cancel run | 19 (durable action fence), 8 (GitHub, GitLab), 17 (Bitbucket Cloud cancel) |
| 6 | "blocks merge" / "optional" / "required: unknown" | 9 (GitHub, GitLab, unknown for others), 18 (Bitbucket Server conditions) |
| 7 | Live elapsed, "usually ~Xm", "overdue" | 10 (GitHub, GitLab), 17, 18 |
| 8 | "new" / "still" / "fixed" / "unknown" vs parent | 11 |
| 9 | "also red on main" | 11 |
| 10 | Header line: event, actor, ref, run number | 2 (GitHub data), 3 (GitLab data), 4 (UI), 17 (Bitbucket Cloud data) |
| 11 | Optional fixed-width CI column | 15 |
| 12 | ETag conditional polling | 5 |
| 13 | CI bisect ("Find where CI broke") | 16 |
| 14 | Changed since last green | 12 |
| 15 | Flaky badge | 12 (tree), 16 (bisect view) |

Ambitious mode: baseline = the 15 locked features in the phases below. Ambitious = no useful upgrade beyond the locked intent, which is already the larger of the two proposals plus both extras. Scheme = `baseline`, so there is no gate phase [PROPOSED].

The next deliverable is Phase 1: the shared detail contracts, the completion, settlement and coverage rules, and the cache fences (per-key generation, `clear()` inside the store's queue) that every later phase relies on. The durable action fence is its own Phase 19, which depends only on Phase 1 (Codex R3 #13). Phase 1 is not blocked by any PENDING-OWNER row.

## Reference behaviour

- **The behaviour to copy** is `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/fable/ideas.md`: §3 ideas 1-12, §4 bisect, §5 layout, §6 cross-cutting rules. It is amended by BRIEF.md:41-46 (the retry-ladder correction, restated under Current state), by the two Opus extras (BRIEF.md:27-28), by BRIEF.md:16 (a bounded, escaped log excerpt may reach the webview because frame `2:2` shows one; the full log never does), and by the owner's path C decision of 2026-11-07 (logs are held in memory per window; REVISION-2-BRIEF.md §1).
- **Visual references** are the Figma file https://www.figma.com/design/sB9RPn3wTLcbpWZIwKyrUB, frames `1:2` (Git Log CI column), `2:2` (Checks tab), `3:2` (status bar and toast) and `4:2` (CI bisect). The same design exists as HTML at `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/design/checks-tab.html`. All data in it is sample data [FACT: BRIEF.md:10]. This author did not open the HTML. Root checked it on 2026-11-07: the tab bar ("Changed files (n)", "Checks (n)", "Details") sits above the pane body; the Checks tab's tree is on the left (340 px, one column under 760 px) and the detail on the right [FACT: Root's check of checks-tab.html:43-60, :110, recorded in the first version of this plan]. Each UI phase's builder reads the named frame and takes widths, spacing and colours from it.
- **Provider APIs** (checked by a web-research lane on 2026-11-07, BRIEF.md:66-90, plus the links Codex cited in Rounds 1 and 2):
  - **GitHub.** `GET /repos/{o}/{r}/actions/runs?head_sha=` and `GET .../actions/runs/{run_id}/jobs`. Jobs carry `steps[]`, and each step has `status`, `conclusion`, `started_at` and `completed_at`; all except `status` can be null. Permission: Actions read [FACT: https://docs.github.com/en/rest/actions/workflow-runs, https://docs.github.com/en/rest/actions/workflow-jobs]. Annotations come from `GET .../check-runs/{id}/annotations`. The docs name Checks read for GitHub App tokens; for OAuth and classic tokens they need `repo` on private repositories [FACT: https://docs.github.com/en/rest/checks/runs#list-check-run-annotations, per Codex Round 1 #33; BRIEF.md:72]. Job logs: `GET .../actions/jobs/{job_id}/logs` answers 302, and its link expires after 1 minute [FACT: BRIEF.md:73]. The write calls `rerun`, `rerun-failed-jobs`, `cancel` and `jobs/{job_id}/rerun` need Actions write or classic `repo` [FACT: BRIEF.md:74]. Required checks come from `.../branches/{b}/protection/required_status_checks` (Administration read) or `.../rules/branches/{branch}` (Metadata read, rulesets only, no classic protection) [FACT: https://docs.github.com/en/rest/branches/branch-protection, https://docs.github.com/en/rest/repos/rules]. A 304 is free against the primary limit only when the request carries `Authorization` [FACT: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api]. List endpoints default to a smaller page size than 100, so every bounded list names `per_page=100` [FACT: Codex Round 2 #9 citing https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run].
  - **GitLab.** The endpoints `pipelines?sha=`, `pipelines/:pid` (single pipeline, with `user` and `duration`), `pipelines/:pid/jobs`, `jobs/:jid/trace`, `jobs/:id/retry` and `pipelines/:id/cancel` exist. The project pipeline list does not carry the user and duration; the single-pipeline request does [FACT: https://docs.gitlab.com/api/pipelines/, per Codex Round 1 #13]. Reading works with `read_api`. Retry and cancel need `api`; that is inferred from the scope definitions [FACT: https://docs.gitlab.com/api/jobs/, https://docs.gitlab.com/security/tokens/access_token_scopes/]. Pages default to 20 items, so every bounded list names `per_page=100` [FACT: Codex Round 2 #9 citing https://docs.gitlab.com/api/rest/#pagination]. The project pipeline list accepts `created_before` / `created_after` and `order_by` in `id`, `status`, `ref`, `updated_at`, `user_id` (no `created_at`; `id` order follows creation). "List all jobs by pipeline" accepts `scope` (one or an array of job statuses, `failed` included) and `include_retried` (default `false`) [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/].
  - **Bitbucket Cloud.** Pipelines can be filtered with `target.commit.hash`. Pipeline discovery, steps and step logs need scope `pipeline`, and `stopPipeline` needs `pipeline:write`. Step log downloads can answer 307 [FACT: https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/, per Codex Round 1 #6 and #14]. The listed auth types are OAuth and API token; app passwords are not listed [FACT: https://api.bitbucket.org/swagger.json via BRIEF.md:82-85].
  - **Bitbucket Server / Data Center.** `/rest/build-status/1.0/commits/{id}` is deprecated, and its replacement is `/rest/api/latest/projects/{p}/repos/{r}/commits/{id}/builds`. Atlassian's own tickets disagree (BSERV-13381, BSERV-19724), so the old endpoint stays as a fallback. `GET /rest/required-builds/latest/projects/{p}/repos/{r}/conditions` needs REPO_READ; this comes from search snippets only [FACT: BRIEF.md:87-90].
- **Rejected surfaces:** an Activity Bar container, a bigger popover, and an Output channel for CI logs [FACT: ideas.md:169-173, BRIEF.md:31]. The token-free diagnostic trace in §16 is an extension log for troubleshooting, not a place where users read CI logs.

## Current state and gap

What exists today, as read for this plan:

- **Snapshot model.** `CommitChecksSnapshot` has `hash`, `state`, `summary`, a flat `items: CommitCheckItem[]`, `error?` and `signInHost?` [CODE: src/types.ts:146-159]. `CommitCheckItem` is `{name, description, state, source: "check-run" | "status", url?}` with no provider identity [CODE: src/types.ts:137-143]. `CommitCheckState` already includes `cancelled`, `skipped`, `neutral`, `timed_out`, `action_required`, `unknown`, `none` and `unavailable` besides `pending`, `success` and `failure` [CODE: src/types.ts:120-123; src/services/commitChecks/normalize.ts:39-48]. `"pending"` and `"none"` count as not settled [CODE: src/types.ts:132-134]. There are no runs, jobs, steps, times, actors or required flags.
- **Aggregate state hides running work.** `aggregateState` returns `failure` as soon as any item failed, even while other items are still `pending` [CODE: src/services/commitChecks/normalize.ts:39-42]. Everything downstream treats `failure` as settled: L1 keeps it forever [CODE: service.ts isFresh, the final `return true`], the persistent cache stores it [CODE: persistentCache.ts `isPersistentCommitCheckState`], and the webview ladder stops because `failure` is not a pending state [CODE: src/types.ts:132-134]. Today a commit with one failed job and one running job shows a red badge that never updates. This plan fixes that in Phase 1 (#1).
- **Provider seam.** `CommitChecksProvider` has `id`, `match`, `keyFor` and `getChecks(ref, hash)`, which "must not throw" [CODE: src/services/commitChecks/types.ts:24-32]. `ProviderId` is `"github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server"` [CODE: src/services/commitChecks/types.ts:9]. There is no capability declaration.
- **Auth.** GitHub sends `Authorization: Bearer ${session.accessToken}` from VS Code's built-in session [CODE: src/services/commitChecks/githubProvider.ts:133; src/types.ts:155-156]. Bitbucket Cloud sends a Bearer token from CredentialStore, described as "repository/project/workspace access tokens" [CODE: src/services/commitChecks/bitbucketCloudProvider.ts:167-170]. Bitbucket Server sends a Bearer HTTP access token [CODE: src/services/commitChecks/bitbucketServerProvider.ts:186-187]. The Server provider's repo ref already keeps the project and repository keys [FACT: Codex Round 1 #31; not re-read by this author — Phase 18 step 1 confirms it in `match` before coding].
- **Next-page links.** The Bitbucket Cloud snapshot path already validates provider-supplied next links in `normalizeBitbucketCloudNextUrl` [CODE: bitbucketCloudProvider.ts:229-241, per Claude's Round 2 check]. No other provider follows next links today.
- **Production construction.** The shared service is built in `src/activation/repositoryMode.ts:256-264` with `ttlMs: 30_000` (pending), `noneTtlMs: 1 h`, `unavailableTtlMs: 15 min`, `maxEntries: 1_000`, and a `CommitChecksPersistentCache` over `context.globalState` with `noneMaxAgeMs: 1 h` [CODE: src/activation/repositoryMode.ts:256-264]. Providers receive a `FetchJson` that runs every request through `requestGateRegistry.run(providerId, url, (generation) => …)` and reports each response to `observeResponse` [CODE: src/activation/repositoryMode.ts:265-279].
- **Cache.** `CommitChecksService` keeps an L1 map with in-flight de-duplication. Terminal states are fresh forever in L1 [CODE: service.ts isFresh]. `force` bypasses L1 and L2 but still joins an in-flight fetch for the same key [CODE: service.ts getOrFetch, the `inflight.get(key)` check before the persistent read], so a forced refresh after a re-run can return the pre-re-run result. `clear()` bumps one global generation so late results are dropped, clears the in-flight map, and wipes the persistent store [CODE: service.ts clear]. There is no per-key invalidation.
- **Persistent cache.** One Memento key `intelligit.commitChecks.cache.v1` holds a payload with `schemaVersion: 1` and up to 2 000 entries; terminal entries live 24 h and `none` entries 1 h; `set` ignores `pending` and `unavailable` snapshots, so a pending result never overwrites an older settled entry; reads and `set` are serialised through an `enqueue` chain, but `clear()` runs outside that chain [CODE: persistentCache.ts:98-119, the `clear()` at :117-119 confirmed by Claude's Round 2 check], so a `set` queued before a `clear()` can land after it and bring back an entry written under an old sign-in (Codex Round 2 #3). There is no per-key delete. The store is typed to `CommitChecksSnapshot`.
- **HTTP helper.** `FetchJson` is `(url, headers) => Promise<unknown>`: it returns the parsed body only, not the response headers [CODE: src/services/commitChecks/http.ts:10]. It uses `https.get`, which does not follow redirects; any non-2xx status, 3xx and 304 included, rejects as `HttpError` carrying `statusCode` and the response headers [CODE: http.ts:53-91]. It is GET-only and has a 15 s timeout [CODE: http.ts:87-89]. A response observer receives token-free metadata [CODE: http.ts:18-23, :65].
- **Request gate.** Each `(provider, origin)` bucket gets 4 concurrent requests. The fallback is 300 per hour until a quota is observed, then the server's limit up to 5 000. It keeps a reserve (at least 100, or 10 %) and handles cooldown and 429 [CODE: src/services/commitChecks/requestGate.ts:9-29, :63-69, :79]. Once a queued task gets a slot, the gate invokes it with no cancellation check [FACT: Codex Round 1 #25 citing requestGate.ts:219-232; not re-read by this author].
- **Retry ladder (correction to ideas.md:15).**
  - Pending checks re-poll on a ladder: `PENDING_CHECK_RETRY_DELAYS_MS = [3s, 5s, 10s, 20s, 30s, 60s, 60s, 120s]` [CODE: src/webviews/react/commit-list/checksRefresh.ts:6-8].
  - A pushed HEAD with no checks yet re-polls on `HEAD_NONE_CHECK_RETRY_DELAYS_MS = [3s, 5s, 10s, 30s]` [CODE: checksRefresh.ts:11].
  - There is a hard cap of `MAX_COMMIT_CHECK_RETRIES_PER_HASH = 20` [CODE: checksRefresh.ts:26], selected by `retryDelaysForCommitChecks` [CODE: checksRefresh.ts:48-57]. When the eight rungs are used up the ladder stops, independently of the 20 cap [FACT: Codex Round 1 #18 citing CommitList.tsx:548-554; Root confirmed checksRefresh.ts:6-8, :26].
  - **Failed fetches do not retry automatically.** An `unavailable` snapshot schedules no timer [CODE: checksRefresh.ts:41-47, :56]. It is cached for 15 min [CODE: repositoryMode.ts:259] and can be refreshed by the user [CODE: checksRefresh.ts:59-71].
  - This plan restates the rule as: pending checks re-poll on a ladder; failed fetches do not retry.
- **Architecture rule.** Code under `src/webviews/react/` may not import `src/commands`, `src/git`, `src/services`, `src/views` or `src/extension`, and may not import Node built-ins or the VS Code API [CODE: .dependency-cruiser.cjs:24-33, :59-70]. Any constant or contract shared by the host and the webview must live outside those paths.
- **Commit-details pane.** `CommitInfoPane` renders `CommitChangedFilesPanel` with no tabs [CODE: src/webviews/react/commit-info/CommitInfoPane.tsx:141-150, :244-264]. It drops expanded dirs and selection when `detail.hash` changes [CODE: CommitInfoPane.tsx:151-189] and persists a view preference with `readGroupByDir` / `persistGroupByDir` [CODE: CommitInfoPane.tsx:172, :224-227]. It is hosted in three places: `CommitGraphPanel.tsx:631`, `CommitInfoApp.tsx:105` and `undocked/UndockedLayout.tsx:433` [FACT: BRIEF.md:53].
- **Settings and scripts.** Existing settings are `intelligit.commitChecks.hosts`, `.enabled`, `.providers` and `.ciCdFilter`, all `scope: window`, read once at activation (reload to change) [CODE: package.json:1561-1615; repositoryMode.ts:238-248]. Scripts: `format:check`, `lint`, `lint:strict`, `react-doctor`, `architecture:check`, `typecheck`, `build`, `build:prod`, `test`, `test:e2e` (an explicit spec list), `l10n:sync`, `l10n:translate`, `l10n:import`, `l10n:validate`, `l10n:audit`, `package`, `verify:manifest` [CODE: package.json:1619-1662].
- **Read-only documents.** The only `registerTextDocumentContentProvider` is `registerReadonlyDiffContentProvider` [FACT: BRIEF.md:60 citing src/services/diffService.ts:174-178, wired at src/extension.ts:41]. The existing `openCommitFileDiff` compares a commit with its parent, not two arbitrary revisions [FACT: Codex Round 1 #22 citing diffService.ts:866-907].
- **Absent today:** a status-bar item, a `DiagnosticCollection` [FACT: BRIEF.md:61], ETag handling [FACT: ideas.md:146], response headers on `FetchJson` [CODE: http.ts:10], any non-GET request [CODE: http.ts:55], and any write call to a CI provider.
- **Accepted cost of the in-memory log store (owner path C, 2026-11-07).** CI logs are held in memory per window. A window reload or a VS Code restart empties the store, and a log is downloaded again the next time the user asks for it. Two windows never share a downloaded log.

| Needed behaviour | Exists | Missing |
|---|---|---|
| Run → job → step tree with times | flat `items` | detail model, provider fetches, pagination with a continuation guard, coverage field, tab UI |
| Polling, caching and toast keyed on "all work finished" | aggregate `failure` treated as settled | `complete` separate from outcome; `coverage` separate from both |
| Re-run invalidates cached results | global `clear()` only (outside the store queue); `force` joins in-flight | per-key generation fence, durable per-key delete, durable action fence, `clear()` inside the queue |
| HEAD status and settle toast | per-row badge only while the Git Log is open | host-side HEAD monitor, status bar, atomic cross-window toast claim |
| Logs in an editor | none | redirect helper, bounded download to memory, per-window log store, preview request, content provider |
| Annotations as diagnostics | none | GitHub annotations fetch, path validation, `DiagnosticCollection` |
| Re-run / cancel | none | POST helper, write calls, 403 explanation, inline confirm |
| Required / optional | `allow_failure` declared in the GitLab response and unused [FACT: ideas.md:97] | required-check fetch, tags |
| Elapsed / usual / overdue | none | time fields, previous-run query, client timer |
| new / still / fixed, also red on main, flaky | per-row snapshots already fetched | logical-identity history join, scoped attempt history, default branch from `origin/HEAD` |
| CI column | badge tied to the Author/Date gate [FACT: BRIEF.md:54] | own column and setting |
| ETag | none | response headers on the fetch boundary, conditional request store |
| Bisect | none | range action with parent links, progress, cancel inside the gate |
| Changed since last green | none | first-parent walk inside the loaded set, two-revision diff action |
| Bitbucket Server endpoint | deprecated `/rest/build-status/1.0/commits/{sha}` [FACT: BRIEF.md:58] | new endpoint with fallback, enriched flat checks |

## User journeys

Each journey names the test that walks it. Test files are created in the phase given in brackets. E2E specs run on CI.

1. **Look at a commit's CI.** The user selects a commit in the Git Log, then clicks the **Checks** tab beside **Files** in the details pane.
   - While loading, the tab shows a spinner row.
   - With data, the header shows the overall state, the duration and "push by <actor> · <ref> · #<run>". Below it is the tree workflow → job → step. Failed jobs are expanded down to their failing step.
   - With a run whose job list hit the page bound (O1), the tree shows "Showing the first 1 000 jobs — open the run in the browser for the rest" with an Open in browser link. If the run failed, every failed job is still listed, including those past the first 1 000 (§3). While those are still being found the tree shows "Loading more failed jobs…"; when the provider rate limit cools down it shows "Loading more failed jobs — paused for rate limit" and resumes by itself when the cooldown ends; failed jobs already found stay listed throughout.
   - If the provider's next-page link points somewhere IntelliGit will not send the token, paging stops and the tree shows "Showing the first N jobs — the provider's next-page link was refused" with Open in browser [PROPOSED wording].
   - With no CI, the tab says "No CI checks for this commit".
   - With CI checks turned off, it says so and links to the setting.
   - Clicking a job shows its detail on the right.
   - The chosen tab survives a reload, the same way "group by folder" does.
   - Tests: `tests/integration/webviews/commitChecksTab.integration.test.tsx` › "shows the tree for the selected commit", "failed jobs past the first 1 000 are listed", "overflow scan paused shows the paused note" (Phase 4); `tests/e2e/ciChecksTab.spec.ts` › "Checks tab shows the tree in light and dark themes, narrow and wide pane" (Phase 4); provider overflow tests in Phases 2, 3 and 17.
2. **Switch commits rapidly, and come back.** The user arrows A → B → A while details are still loading, then presses Refresh on A twice. The tab shows only the reply to the newest request. An older reply for A, an older reply for B, or the first Refresh reply arriving after the second is dropped. Switching to another repository whose selected commit has the same SHA shows that repository's checks, never the previous one's.
   - Tests: `commitChecksTab.integration.test.tsx` › "drops a detail reply for a commit that is no longer selected", "A→B→A drops the first A reply", "same-hash out-of-order refresh keeps the newest", "same SHA in another repository is not reused" (Phase 4).
3. **Quick look, then the full view.** The user clicks the row's CI badge, and the popover opens as today. They click **Open in Checks**: the popover closes, the row is selected, and the Checks tab is active.
   - Tests: `tests/integration/webviews/commitChecksPopover.openInChecks.integration.test.tsx` (Phase 4); `ciChecksTab.spec.ts` › "Open in Checks from the popover" (Phase 4).
4. **Pending HEAD settles.** The user pushes and keeps editing. The status bar shows `$(error) 0 · $(sync~spin) 3 · $(check) 4  1m 05s` and ticks every second. A job fails while two are still running: the counts show one failure, the item keeps polling, and no toast appears yet. When every job has finished, the monitor fetches the job detail once more, the counts update and exactly one toast appears: "CI failed on 3f2a1c4: unit-tests" with **Open Checks**, **Open log** and **Re-run failed**. On success the toast is "CI passed on 3f2a1c4" with **Open Checks** only.
   - A long build keeps being watched: after the ladder the item polls every 120 s until every job finishes.
   - The provider rate limit is near: the item shows "CI paused" with the cooldown in its tooltip; clicking it refreshes once the cooldown ends.
   - The user reloads VS Code while CI is running and CI finishes during the reload: after activation, the first fetch shows the finished state, and one toast appears.
   - The user reloads after the toast was shown: no toast.
   - VS Code starts on a HEAD whose CI already failed: the status bar shows the counts at once, and the job detail is fetched on that first load, so **Open log** from the status bar's Checks view has a target (no toast, because the HEAD was never seen running).
   - Two VS Code windows show the same repository at the same HEAD: only the focused window shows the toast, once per hash for the machine. If focus moves between the windows at the moment CI finishes and both pass the focus check, one atomic claim decides which window shows it.
   - Tests: `tests/unit/services/commitChecks/headStatus.test.ts` › "failed plus running job keeps polling and does not toast", "toasts once per hash across a simulated reload", "settles during the restart gap → one toast", "two hosts, one toast", "both pass the focus check, one mkdir wins", "settled failing HEAD on first load fetches detail", "pending→settled fetches detail once more before stopping" (Phase 13); `tests/e2e/ciHeadStatus.spec.ts` (Phase 13).
5. **Read the log.** The user selects a failed job. The detail shows the provider's failure text and, after a short "Loading excerpt…", a short excerpt around the first error (at most 40 lines and 8 KB, shown as plain text). Selecting the job sends a preview request that downloads the log into the window's in-memory log store and returns only the excerpt; no editor opens. They click **Open full log in editor**: a progress notification appears (it ends at once when the preview already loaded the log), then a read-only editor tab opens with the cursor on the first error line.
   - The user selects job A, then job B before A's excerpt arrives: only B's excerpt is shown; A's reply is dropped.
   - A log of 30 MB still opens; the full log never reaches the webview.
   - A log longer than the per-log bound (O2) ends with "[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]", and the detail shows an Open in browser link. A server that announces a 300 MB log is not refused: the first 50 MB are shown with that line.
   - If GitHub's 1-minute link expired between the 302 and the download, the log link is requested again once.
   - The window keeps the three most recently used logs in memory. An open log tab keeps its text after its log leaves memory. Clicking **Open full log** for a log that left memory downloads it again; reopening a closed log tab in the same window downloads it again too.
   - After a window reload or a restart, the store is empty (the accepted cost of path C). A log tab that VS Code restores shows "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]"; the button downloads it again.
   - Two windows open the same log at once: each window downloads its own copy; neither affects the other.
   - On a 403 the detail shows "Your token cannot read this log".
   - A running job shows "Log available when the job finishes", no button and no preview request.
   - Tests: `tests/unit/services/commitChecks/ciLogMemoryStore.test.ts` (Phase 6); `commitChecksTab.integration.test.tsx` › "a preview reply for a job no longer selected is dropped" (Phase 7); `tests/e2e/ciLogEditor.spec.ts` (Phase 7).
6. **Re-run and cancel.** The user clicks **Re-run failed** on a commit whose failed result was cached. The button shows a spinner; the old failed result is dropped from both caches; the target shows "Waiting for re-run to start" until a fetch shows the new attempt, and then the tree goes yellow. Restarting VS Code while it waits keeps "Waiting for re-run to start" and never brings the old failed result back. If ten minutes pass and the provider still shows no new attempt, the label becomes "Re-run not seen yet — Refresh" (a timer switches it; no request is needed) and stays, across restarts and with no time limit, until a fetch shows the re-run or the user clicks Refresh on that label; that click ends the wait and shows whatever the provider reports (Codex R3 #1, #5).
   - With a read-only token: GitLab `read_api` returns 403, and an inline message explains "Your GitLab token is read-only. Create one with the `api` scope to re-run or cancel." with a docs link. Nothing else changes, the tree stays as it was, and no waiting label appears.
   - **Cancel** turns into **Confirm cancel** / **Keep running** inline. Confirming sends the cancel; the run shows "Waiting for cancel to take effect" until it shows cancelled.
   - Tests: `tests/integration/webviews/commitChecksActions.integration.test.tsx`, `tests/unit/services/commitChecks/ciActions.test.ts` › "re-run on a cached failed commit never shows the old result again", "restart while waiting shows waiting, never the old failure", "GitLab retry finishing before the next poll resolves the fence" (Phase 8); `tests/unit/services/commitChecks/ciActionFence.test.ts` (Phase 19); `tests/e2e/ciActions.spec.ts` (Phase 8).
7. **Does it block merge?** A failed required check carries a red "blocks merge" tag, and an allow-to-fail job carries a muted "optional" tag. When the provider refuses the required-checks query (non-admin), the header shows "required: unknown" and is not an error.
   - Test: `tests/unit/services/commitChecks/requiredChecks.test.ts` › "403 on protection yields unknown" (Phase 9).
8. **How long is left?** A running job shows a live "2m 14s" and "usually ~6m", measured against the latest successful run of the same workflow that started before this run. Past 1.5 × usual it shows "overdue". With no earlier successful run it shows "usually: unknown".
   - Tests: `tests/integration/webviews/commitChecksTiming.integration.test.tsx`, `tests/unit/services/commitChecks/ciTiming.test.ts` › "baseline excludes the selected and newer runs" (Phase 10).
9. **Is it my fault?** A failed job carries "new" (green on the parent), "still" (red on the parent), or "unknown" (the parent has no check with the same workflow and job, or more than one). A green job whose parent was red carries "fixed". A failed job also red on `origin/HEAD`'s branch tip carries "also red on main" (the real branch name is shown). After a `git fetch` moves that tip, the next comparison uses the new tip.
   - Test: `tests/unit/services/commitChecks/ciHistory.test.ts` (Phase 11); `defaultBranch.test.ts` › "a remote tip that moves between two comparisons is read fresh" (Phase 9).
10. **What changed since it last passed?** In a failed job's detail, "Changed since last green (a1b2c3d)" lists files from `git diff --name-status a1b2c3d..<sha>`. Clicking a file opens a diff of that file between `a1b2c3d` and the selected commit, including added, deleted and renamed files. With no green on the first-parent line inside the loaded history, it says "No passing run of this job in the loaded history" and shows no list.
    - Tests: `tests/unit/services/commitChecks/changedSinceGreen.test.ts` (Phase 12); `tests/e2e/ciChangedSinceGreen.spec.ts` (Phase 12).
11. **Flaky?** A job that failed then passed on the same commit, or that flips red for one commit between greens, shows "flaky 2/14". Where the provider cannot list re-run attempts, the tag reads "flaky 2/14 (estimated)" and the tooltip says "estimated from loaded commits; re-runs not counted for this provider" (O3).
    - Test: `ciHistory.test.ts` › "flaky" cases (Phase 12).
12. **Problems panel.** With a failed GitHub check on HEAD, the Problems panel lists the annotations with source `CI: unit-tests`. Clicking one opens the file at its line. Annotations whose path is absolute, escapes the repository, or has an impossible line range are dropped and counted ("2 annotations could not be placed"). After a commit or checkout moves HEAD, after sign-out, or after the feature is turned off, they disappear and do not come back.
    - Tests: `tests/unit/services/commitChecks/ciDiagnostics.test.ts` (Phase 14); `tests/e2e/ciDiagnostics.spec.ts` (Phase 14).
13. **CI column.** The user turns on `intelligit.commitChecks.showCiColumn`. A fixed-width column shows a stacked green/red/yellow bar and `7/10`. Hovering shows the summary, and clicking opens the Checks tab. Turning the setting off restores today's layout.
    - Tests: `tests/integration/webviews/commitCiColumn.integration.test.tsx`, `tests/e2e/ciColumn.spec.ts`, plus `tests/e2e/gitLogLayout.spec.ts` unchanged (Phase 15).
14. **Find where CI broke.** The user selects a range of rows, right-clicks and chooses **Find where CI broke**. The bisect view shows progress ("12 / 40 commits"), a sparkline per job, and "broke at 9e8d7c6" per job, with flaky tags.
    - **Cancel** stops queued requests, including ones already waiting for a request slot.
    - A selection that is not one first-parent line (it spans a merge's side branch) shows the sparklines with "not a straight line — no break point" instead of "broke at".
    - A range larger than the loaded page is capped, with a note "Limited to the 40 loaded commits".
    - Tests: `tests/unit/services/commitChecks/ciBisect.test.ts` (Phase 16); `tests/e2e/ciBisect.spec.ts` (Phase 16).
15. **Bitbucket Server repository.** The tab shows a flat list with duration, "required" tags and no empty sections. There are no Log, Re-run, Cancel or step controls, and no "usually" when no earlier build exists.
    - Test: `commitChecksTab.integration.test.tsx` › "floor provider renders flat list without dead controls" (Phase 4, extended in Phase 18).
16. **Signed out / unreachable / rate-limited.** The tab shows the same states the popover shows today, rendered inside the tab: **Sign in**, the error text, and the cooldown message. Signing out while a detail or annotation fetch is in flight discards its result.
    - Test: `commitChecksTab.integration.test.tsx` › "renders signed-out, unavailable and cooldown states" (Phase 4); `ciGenerations.test.ts` (Phase 1).

## Failure and recovery

| Boundary | Failure before write | Failure after write | During a refresh | After a restart |
|---|---|---|---|---|
| Provider read (runs/jobs/steps, every page) | Any page fails (first, middle or last) → the provider returns detail `state: "unavailable"` with `error`; it never returns a partial tree as complete and never throws (same contract as `getChecks`, [CODE: src/services/commitChecks/types.ts:30]); tab shows error + Refresh. No automatic retry. The page bound (O1) is not a failure: it returns the pages read with `coverage: {reason: "pageBound", shown}` shown in the UI. A next link refused by the continuation guard (K33) stops paging with `coverage: {reason: "rejectedNext", shown}`; no request is sent to it | n/a (read) | A forced refresh that fails keeps the previous detail visible with an inline "Refresh failed: <error>" line; it does not blank the tree [PROPOSED] | Details that are complete **and** fully covered come from the persistent detail cache (24 h); all others refetch on first view |
| Failed-item overflow scan (in the in-memory detail entry, R2 #8) | A page fails with any error other than the gate's cooldown or budget error → the scan stops with `failedScan.state: "stopped"`; failed items already found stay listed; the tab shows "Could not load more failed jobs — Refresh" [PROPOSED wording] | Each page's failed items are added to the entry before the next page is requested | Gate cooldown, whether seen before the request or thrown by the gate after the page was queued or acquired (cooldown or budget error, `requestGate.ts:223-235`, Codex R3 #8) → `paused`, cursor and found items kept, "Loading more failed jobs — paused for rate limit", resumes when the cooldown ends. Refresh resumes from the saved next URL if the run id and attempt still match the captured ones and `isCurrent(ctx)` holds; otherwise it discards the progress and starts again | Progress is in memory only; the detail is not persisted (coverage is not `full`), so the scan starts again on first view |
| Snapshot and detail caches (L1 + persistent) | Persistent write fails → entry stays in L1 only; traced (§16), not shown | Entry with another `contractVersion` or bad shape → miss, overwritten | Per-key generation fence: a fetch started before `invalidate(key)` or `clear()` neither writes L1 nor L2 nor publishes. `clear()` runs inside the store's `enqueue` chain (R2 #3), so a `set` queued before it lands before it and is wiped, never after | Incomplete, partially covered or fenced entries are never persisted; entries written by older versions that are incomplete are ignored on read |
| Action fence (`workspaceState["intelligit.ci.actionFences.v1"]`, K30, Phase 19) | Fence write fails → the action is not sent; inline "Could not start the action: <error>" | Fence awaited before the request is sent. Definite failure (forbidden, other 4xx/5xx, request not sent) → fence deleted. `ok` or `uncertain` → fence kept | While a fence exists for a hash, every snapshot and detail result for it is L1 only (pending TTL) and never persisted; the check runs inside the persistent store's `enqueue` callback. The hash polls on the pending ladder whatever its execution state (Codex R3 #5). The fence is deleted only when a result shows the action took effect for its target, by the provider's evidence rule stored with the fence (Codex R3 #4). At 10 min a timer, not a fetch, switches the label to "Re-run not seen yet — Refresh" / "Cancel not seen yet — Refresh"; the fence stays until a result shows the action or the user clicks that Refresh | Fences are read at activation and apply at once; the not-seen timer is re-armed from the stored time; no fence is deleted by age (Codex R3 #1) |
| Write action → cache invalidation | n/a | `invalidate(key)` deletes L1, the in-flight entry and the persisted entry (awaited through the store's `enqueue` chain) before the post-action fetch starts | Results while the fence exists are handled by the row above | The deleted persisted entry stays deleted; the fence is still there after a restart |
| ETag store (L1) | n/a | A 304 with no stored body (evicted) → re-request once without `If-None-Match` | 304 → reuse the stored body and its stored pagination headers (`Link`, `x-next-page`); quota headers come from the fresh 304 (Codex R3 #7); 200 → replace body, etag and pagination headers | Not persisted; first request after restart is unconditional |
| Log download into the window's memory store (`CiLogMemoryStore`, K16) | Request fails, 403, timeout or abort → nothing stored; every waiter on that key gets the same error; the next click retries | n/a (memory only). Reaching the 50 MB bound (O2) stores the first 50 MB plus the marker line with `truncated: true`; a larger announced `Content-Length` is never refused | A second request for the same key in the same window joins the in-flight download; a log that left the store (LRU of 3) is downloaded again | Store is empty. A restored log tab shows "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]"; the button downloads it again, and the content provider then fires `onDidChange` for that tab's URI so the tab shows the log (Codex R3 #6) |
| Redirects (all providers) | Non-HTTPS `Location`, more than 5 hops, or missing `Location` → "Log not available" | GitHub: 403/404/410 from the redirect target (expired link) → one new 302 request, then error | n/a | n/a |
| Provider write (re-run / cancel) | Request fails before sending → inline error, fence deleted, no state change | 2xx → invalidate snapshot + detail for the hash, then fetch; 403 → scope explanation, fence deleted; other 4xx/5xx → inline error with status, fence deleted; unknown outcome (timeout after send) → "The request may have been sent; refreshing" + invalidate + fetch, fence kept | A second click while one is in flight is disabled (busy state keyed by run/job id) | The fence row above carries the waiting state; the provider's run state decides when it ends |
| Toast claims (`<globalStorageUri>/ci-toast-claims/`, K13) | `mkdir` fails with anything other than `EEXIST` (no storage, permission) → no toast (fail closed: a missed toast beats a duplicate); traced; the hash stays in the pending-observed set and the claim is tried again on the next focus | `mkdir` succeeds → the claim is taken, then the toast is shown; a crash between the two loses that toast (at-most-once, the locked "once per hash"). `EEXIST` → another window (or this one before a reload) already toasted; no toast | n/a | Claims survive reload, are shared by every window on the machine, and are never removed (K13; owner 2026-11-07, Codex R3 #2) |
| Pending-observed set (`workspaceState`, K27) | Write fails → that hash may not toast after a reload; traced | Entry removed when its toast is claimed (or the claim already exists) or after 7 days | n/a | Read at activation; a HEAD still in the set resumes monitoring and toasts once if it finished during the restart gap |
| HEAD monitor | Fetch fails → status bar shows "CI unavailable" with the error in the tooltip; no automatic retry (same rule as the badge) | n/a | Rate-limit cooldown → "CI paused", no requests until the cooldown ends | Restarts from the pending-observed set; a complete failing HEAD gets one detail fetch on first load |
| DiagnosticCollection `intelligit-ci` | Annotations fetch fails → collection cleared for that hash, no error toast; Checks tab shows "Annotations unavailable: <reason>" | Set only if repoKey, HEAD hash, auth generation and lifecycle generation all still match after the last await | HEAD move, sign-out, disable or repository close → result discarded, collection cleared | Collection is in memory; rebuilt from the next HEAD poll |
| Git subprocess (`symbolic-ref`, `rev-parse`, `rev-list`, `diff`, `show`) | Command fails → the dependent field is "unknown" (default branch) or "Could not compare: <error>" (changed since green) | n/a | n/a | n/a |
| Webview message channel | Host posts while webview disposed → dropped [ASSUMED: existing behaviour; Phase 4 confirms] | Reply whose `repoKey` or `requestId` is not the newest for that slot, or a preview whose `selectionToken` is not the current selection → dropped | Bisect cancel message lost → bisect still finishes within its cap; queued items are not started after the panel is disposed | Tab selection restored from webview state; tree refetched from cache; no log text is ever stored in webview state |
| Diagnostic trace (§16) | Trace write fails → ignored (never breaks the feature) | n/a | n/a | Not persisted beyond VS Code's own log retention |

## Technical design

### 0. Shared module (Phase 1)

Contracts and pure helpers used by both the extension host and the React webview live in a new directory `src/shared/ci/`. That path matches none of the forbidden targets in `.dependency-cruiser.cjs` [CODE: .dependency-cruiser.cjs:24-33], and files there import neither `vscode` nor Node built-ins, so the webview rule at :59-70 also holds. Types go into `src/types.ts`, which both sides already use [CODE: src/types.ts:137-159, imported by checksRefresh via `commitHashesMatch` users — ASSUMED import path; Phase 1 confirms with `bun run typecheck:webview`]. Contents of `src/shared/ci/`:

- `capabilities.ts` — `ProviderCiCapabilities` (§1).
- `pollSchedule.ts` — the ladder constants moved from `checksRefresh.ts` (which re-exports them so existing imports keep working) and the HEAD monitor schedule (K26).
- `completion.ts` — `isCompleteSnapshot(snapshot)`, `isCompleteDetail(detail)` and `isFullyCovered(detail)` (§3).
- `identity.ts` — `logicalCheckId(...)` (§9, K35).
- `contractVersion.ts` — `CI_DETAIL_CONTRACT_VERSION` (K32).
- `excerpt.ts` — `sanitizeExcerpt(text)` (§5), used by the host before posting and asserted by webview tests.

`normalize.ts` imports `vscode` [CODE: normalize.ts:6], so nothing shared may live there.

### 1. Capability model (Phase 1)

```ts
export interface ProviderCiCapabilities {
    readonly runs: boolean;          // workflow/pipeline grouping exists
    readonly jobs: boolean;          // jobs under a run
    readonly steps: boolean;         // steps under a job
    readonly runHeader: boolean;     // event, actor, ref, run number
    readonly logs: boolean;          // per-job log download
    readonly failureSummary: boolean;// provider failure text per job
    readonly annotations: boolean;   // file/line annotations
    readonly rerunFailed: boolean;
    readonly rerunJob: boolean;
    readonly cancel: boolean;
    readonly requiredChecks: boolean;// provider can say which checks are required
    readonly optionalJobs: boolean;  // provider marks allowed-to-fail jobs
    readonly usualDuration: boolean; // a previous successful run can be queried
    readonly attemptHistory: boolean;// provider lists re-run attempts of a job on one commit
    readonly writeScopeHelp?: string;// l10n key of the 403 explanation for write actions
}
```

`CommitChecksProvider` gains `readonly capabilities: ProviderCiCapabilities` and an optional `getDetail(ref, hash, ctx): Promise<CommitCiDetailData>` (it must not throw, same as `getChecks`). Later phases add optional methods, each guarded by its capability flag: `continueFailedScan` (§3), `getJobLog`, `runAction`, `getRequiredChecks`, `getUsualDuration`, `getAttemptHistory` and `getAnnotations`. Every provider that follows next links also declares `allowNext(url): boolean` (K33).

**Capabilities are derived at read time, never persisted** (#9). The detail service attaches `provider.capabilities` to every detail it serves, from the installed provider object, after reading from L1 or L2. A cached detail written by an older release therefore cannot carry stale `logs: false` or floor flags. The webview reads `detail.capabilities` only, and no component compares `provider === …`. An ESLint `no-restricted-syntax` rule under `src/webviews/**` bans string comparisons against the four provider ids [PROPOSED]. If the rule's selector proves too broad, the fallback is a unit test that scans `src/webviews` for those literals.

Capability table. A flag is `true` only once the phase that implements it has landed; until then it is `false`, so the UI never shows a dead control:

| Flag | GitHub | GitLab | Bitbucket Cloud | Bitbucket Server |
|---|---|---|---|---|
| runs / jobs | P2 | P3 | P17 | false |
| steps | P2 | false (not in API, ideas.md:46) | false (BBC steps map to jobs) | false |
| runHeader | P2 | P3 | P17 | false |
| logs / failureSummary | P7 | P7 | P17 | false |
| annotations | P14 | false | false | false |
| rerunFailed | P8 | P8 (pipeline retry) | false (no rerun endpoint, ideas.md:87) | false |
| rerunJob | P8 | P8 | false | false |
| cancel | P8 | P8 | P17 (`stopPipeline`) | false |
| requiredChecks | P9 | P9 [ASSUMED source, see §7] | false → "required: unknown" | P18 |
| optionalJobs | false [ASSUMED: GitHub jobs carry no continue-on-error flag] | P9 (`allow_failure`) | false | false |
| usualDuration | P10 | P10 | P17 | P18 |
| attemptHistory | P12 | P12 | false (O3 fallback) | false (O3 fallback) |

### 2. Detail data model (Phase 1)

In `src/types.ts`, next to `CommitChecksSnapshot`:

```ts
export type CiState = "queued" | "running" | "success" | "failure" | "cancelled" | "skipped" | "neutral" | "unknown";
export type CiCoverage = "full" | { reason: "pageBound" | "rejectedNext"; shown: number };   // R2 #7; separate from execution `complete`
export interface CiFailedScan {          // R2 #8; in memory only, never persisted
    state: "running" | "paused" | "stopped" | "done";
    found: number;                       // failed items found past the bound so far
    error?: string;                      // set when state is "stopped"
}
export interface CiStep { number: number; name: string; state: CiState; startedAt?: string; completedAt?: string; }
export interface CiJob {
    id: string;                          // execution id (GitHub: Actions job id; GitLab: job id; BBC: step uuid); dedup inside one commit only
    logicalId: string;                   // logical check identity across commits (K35, §9)
    checkRunId?: string;                 // GitHub only: check-run id, parsed from the job's check-run link; used for annotations and failure summary
    name: string; checkName: string; state: CiState; url?: string;
    startedAt?: string; completedAt?: string; attempt?: number;
    steps: CiStep[];
    annotationCount?: number;            // GitHub only, from the check run's output.annotations_count (P14)
    optional?: boolean;                  // P9
    required?: "yes" | "no" | "unknown"; // P9
    failureSummary?: string;             // P7, ≤ 2 000 chars
    usualDurationMs?: number | null;     // P10; null = unknown, undefined = not asked
}
export interface CiRun {
    id: string; name: string; url?: string; state: CiState;
    workflowId?: string;                 // GitHub workflow_id; GitLab: pipeline source + ref is not a workflow, so absent
    event?: string; actor?: string; ref?: string; runNumber?: number; attempt?: number;
    createdAt?: string; startedAt?: string; completedAt?: string;
    usualDurationMs?: number | null;     // P10
    jobs: CiJob[];
    jobsCoverage: CiCoverage;            // O1 bound or a refused next link on the jobs/steps collection
    failedScan?: CiFailedScan;           // present while failed items past the bound are being found
}
export interface CiFlatCheck {           // statuses, third-party checks, Bitbucket Server builds
    id?: string;                         // execution identity: check-run id, status context, build key
    logicalId?: string;                  // K35
    name: string; description: string; state: CommitCheckState; source: "check-run" | "status" | "build"; url?: string;
    durationMs?: number | null;          // P18 for Server; absent elsewhere
    required?: "yes" | "no" | "unknown";
    usualDurationMs?: number | null;
}
export interface CiAttempt { attempt: number; executionId: string; state: CiState; startedAt?: string; completedAt?: string; }
export interface CiAttemptHistory {      // one history per (run, logical job) — R2 #14
    runId: string;                       // GitHub workflow run id; GitLab pipeline id
    logicalId: string;
    attempts: CiAttempt[];               // chronological per §9, unique by executionId
    coverage: CiCoverage;
}
export interface CommitCiDetailData {    // what providers return and what is persisted
    hash: string;
    provider: ProviderId;
    complete: boolean;                   // no run, job or flat check is queued/running/pending
    outcome: CommitCheckState;           // same aggregate rule as the snapshot (failure wins)
    runs: CiRun[];
    runsCoverage: CiCoverage;            // the run/pipeline list itself
    otherChecks: CiFlatCheck[];
    otherChecksCoverage: CiCoverage;     // Codex R3 #10; coverage of the flat list itself (§3 table)
    requiredStatus?: "known" | "partial" | "unknown"; // P9
    attemptHistory?: CiAttemptHistory[]; // P12
    error?: string;
    signInHost?: string;
}
export interface CommitCiDetail extends CommitCiDetailData {   // what the webview receives
    capabilities: ProviderCiCapabilities; // attached at read time from the installed provider
    repoKey: string;
    actionFence?: { targetId: string; action: "rerunFailed" | "rerunJob" | "cancel"; notSeen: boolean }; // attached at read time from K30
}
```

`CommitCheckItem` gains two optional fields: `id?: string` (check-run id or status context), set by the GitHub provider from Phase 2 on and by other providers when their API gives one; and `logicalId?: string` (K35), set from Phase 11 on where the snapshot API gives the workflow or pipeline name. Both are additive: older persisted snapshots without them stay valid.

- **Why `CiState` stays separate from `CommitCheckState`.** `CommitCheckState` already has `cancelled` and `skipped` [CODE: src/types.ts:120-123], so that is not the reason. The reasons: a job needs `queued` and `running` as separate states (the timer runs only for `running`), and `CommitCheckState` carries snapshot-level states (`none`, `unavailable`) that no job can have. The detail's aggregate `outcome` uses `CommitCheckState`, so badges and the tab agree.
- **Time fields** are the provider's ISO strings. A missing time renders as "—" and is never computed from a guess.
- **`checkName`** is the provider's check name for the job. Inside one commit, GitHub joins a job to a snapshot item by execution identity first (`CommitCheckItem.id === job.checkRunId`) and falls back to name only when exactly one job and exactly one item share that name (#15). For GitLab it is the job name [ASSUMED: commit status name equals job name; Phase 3 fixture]. Across commits only `logicalId` and the unique-name fallback are used (§9, R2 #13).
- **Coverage is not completion** (R2 #7). `complete` says whether execution has finished; `coverage` says whether every item of a collection was read. Banners read `coverage`. A detail is persisted only when it is complete and `isFullyCovered` (every `runsCoverage`, `jobsCoverage`, attempt `coverage` and `otherChecksCoverage` is `"full"`). A run list or flat list that is not fully covered also makes settlement `unknown` (§3, Codex R3 #9).
- **Floor detail.** A provider without `getDetail` gets a detail built from its snapshot: `runs: []`, `runsCoverage: "full"`, `otherChecks` mapped 1:1 from `snapshot.items`, `otherChecksCoverage: "full"` (a snapshot reports no truncation), `complete = isCompleteSnapshot(snapshot)`. Its capabilities are the provider's declared ones, attached at read time like every other detail (#10). Bitbucket Server replaces the floor adapter with its own `getDetail` in Phase 18 that fills `durationMs`, `required` and `usualDurationMs`.

### 3. Completion, coverage, fetch path and caching (Phase 1, Phase 2, Phase 5)

**Completion is separate from outcome** (#1). `isCompleteSnapshot(s)` is `s.state` not in `{pending, none, unavailable}` and no item has state `pending`. Providers set `d.complete` to "no run or job is `queued`/`running` and no flat check is `pending`". **Settlement needs full coverage** (Codex R3 #9): `settlementOf(d)` in `completion.ts` returns `"unknown"` when `runsCoverage` or `otherChecksCoverage` is not `"full"` (a run or flat check past the bound may still be queued or running), else `"settled"` when `d.complete`, else `"pending"`. `jobsCoverage` does not affect settlement, because a run's own state covers its hidden jobs [ASSUMED: providers compute the run state over all its jobs]. `isCompleteDetail(d)` is `settlementOf(d) === "settled"`, so `unknown` counts as incomplete everywhere below: pending TTL, never persisted, the HEAD monitor keeps polling, no toast. A commit with more runs than the bound is therefore polled every 120 s while it is HEAD. Everything that today keys on "settled" keys on completion instead:
- L1 freshness: a complete entry is fresh forever; an incomplete `failure` uses the pending TTL (30 s, [CODE: repositoryMode.ts:257]).
- Persistent eligibility: only complete snapshots are persisted (plus `none` for 1 h, as today); only details that are complete **and** fully covered (§2) are persisted, and never while an action fence exists for the hash (K30).
- Webview ladder: `retryDelaysForCommitChecks` returns the pending ladder for an incomplete `failure` too [ASSUMED: it receives the snapshot or its items; if it receives only `state`, the caller passes completion; Phase 1 reads CommitList.tsx:511-569].
- HEAD monitor stop and toast (§10).

**Per-key generation fence** (#2). `CommitChecksService` and `CommitCiDetailService` each gain `invalidate(key): Promise<void>`:
1. bump `keyGeneration[key]` (a `Map<string, number>`);
2. delete the L1 entry and the in-flight entry for the key, so the next fetch cannot join a pre-invalidation fetch;
3. delete the persisted entry through a new `delete(key)` on the persistent store, run inside the store's `enqueue` chain and awaited.

Every fetch captures `(globalGeneration, keyGeneration[key])` when it starts and writes L1, L2 or returns a publishable result only if both still match when it ends. `getOrFetch` checks `inflight` only after the fence, so `force: true` right after `invalidate` always starts a new request.

**`clear()` inside the queue** (R2 #3). `CommitChecksPersistentCache.clear()` and `CiDetailPersistentCache.clear()` run inside their store's `enqueue` chain, like `set` and `delete`. A `set` queued before `clear()` therefore runs first and is wiped by it; a `set` whose fetch started before the generation bump is dropped by the generation check before it is queued. This fixes the confirmed bug at `persistentCache.ts:117-119`.

**Action fence** (K30, R2 #2; built in Phase 19, Codex R3 #13). `src/services/commitChecks/ciActionFence.ts` keeps `{repoKey, hash, provider, action, targetId, runId, at, before, evidence}` records in `workspaceState["intelligit.ci.actionFences.v1"]`, mirrored in memory. `targetId` is the run id for `rerunFailed` and `cancel` and the job id for `rerunJob`; `runId` is the target's run or pipeline id; `before` is the target's `{attempt?, state, jobId?, maxJobId?, logicalId?}` at click time (`maxJobId` = the highest job id in the pipeline); `evidence` is the rule from step 4, chosen by the provider and stored with the fence, so a restart applies the same rule (Codex R3 #4).
1. Before `runAction` sends anything, the fence is written and awaited (`workspaceState.update`). A failed write means the action is not sent.
2. Then the request is sent. A definite failure (forbidden, other 4xx/5xx, not sent) deletes the fence. `ok` and `uncertain` keep it and run `invalidate(hash)` and the forced fetch (§6).
3. While any fence exists for a hash, snapshot and detail results for that hash stay in L1 with the pending TTL and are never persisted. The fence check runs inside the persistent store's `enqueue` callback, immediately before the write, so a `set` queued before the fence existed but run after it is still refused (plan-standard rule 2).
4. A fetched result ends the fence only when it shows the action took effect for the target, by the fence's stored `evidence` rule (Codex R3 #4). The provider names the rule per action (`actionEvidence(action)`, declared from Phase 8):
   - `runAttempt` (GitHub re-run failed and re-run job): run `runId` has an `attempt` higher than `before.attempt`, or its state moved from `before.state` to `queued` or `running`. The run is watched, not the old job id, because a GitHub re-run starts a new run attempt [ASSUMED: the re-run job also gets a new job id; watching the run attempt works either way].
   - `newerJobSameLogicalId` (GitLab job retry): pipeline `runId` has a job with the same `logicalId` as `before.logicalId` and a numeric id higher than `before.jobId`, in any state. A GitLab retry creates a new job id ([GitLab retry semantics](https://docs.gitlab.com/ci/jobs/#retry-jobs)), so a retry that already finished before the next poll still ends the fence.
   - `newerJobInPipeline` (GitLab pipeline retry, "Re-run failed"): pipeline `runId` has a job whose id is higher than `before.maxJobId` [PROPOSED: same reasoning as the job retry].
   - `cancelled` (cancel, every provider): run `runId` is `cancelled` or complete.
   Any other result leaves the fence in place.
5. The served detail carries `actionFence` (attached at read time). The UI shows "Waiting for re-run to start" / "Waiting for cancel to take effect" on the target. When `now - at ≥ 10 min` (`ACTION_FENCE_NOT_SEEN_MS`), `notSeen` is true and the label becomes "Re-run not seen yet — Refresh" / "Cancel not seen yet — Refresh". There is no silent expiry.
6. At activation the store loads the fences and applies them before the first fetch. No fence is deleted by age (Codex R3 #1). A fence ends only by evidence (step 4), by a definite failure (step 2), or when the user clicks Refresh on a target whose label reads "not seen yet": that click ends the fence (`endByUserRefresh`), then runs `invalidate(hash)` and a forced fetch whose result is cached by the normal rules. A Refresh while the label still reads "Waiting…" keeps the fence.
7. **Fence-driven polling** (Codex R3 #5). While a fence exists for a hash, the Checks tab (it sees `detail.actionFence`) polls that hash on the pending ladder and the HEAD monitor keeps its K26 schedule, whether or not the fetched execution is `complete`. The "not seen yet" switch comes from a timer in the fence store set to `at + ACTION_FENCE_NOT_SEEN_MS`, re-armed from the stored `at` at activation (fired at once when already past). The timer fires a change event, and the host re-posts the detail with `notSeen: true` and the `requestId` of the request showing the commit, with no fetch. A request-gate cooldown stops the polls, not the timer. The row badge keeps its own snapshot ladder and is not fence-driven [PROPOSED].

**Detail service.** `CommitChecksCoordinator.getDetail(hash, {force}, ctx)` resolves the provider the same way `getChecks` does and delegates to a `CommitCiDetailService`. That service is a sibling of `CommitChecksService` with the same L1, in-flight, generation, fence and persistence pattern. It is not a generic refactor of the existing service; see Key decisions.

- **Cache key:** `${existing snapshot key}#detail` (K9).
- **Persistence:** a sibling `CiDetailPersistentCache` in `context.globalState` under `intelligit.commitChecks.detailCache.v1`, max 200 entries, 24 h, same `enqueue` pattern with `delete(key)` and `clear()` inside it. Each entry stores `{key, contractVersion, data: CommitCiDetailData, fetchedAt, lastAccessedAt}`. An entry whose `contractVersion` differs from `CI_DETAIL_CONTRACT_VERSION` is a miss. Every phase that adds or changes a persisted detail field bumps the version.
- **Construction:** `src/activation/repositoryMode.ts` builds it next to the snapshot service at :256 with the same `ttlMs`, `noneTtlMs` and `unavailableTtlMs` values (read from one local options object, not new constants).
- **Reload:** `clear()` on credential or settings change clears both services and the log store (§5).
- **When detail is fetched:** only when the Checks tab is visible for the selected commit; for HEAD from the HEAD monitor while HEAD is incomplete and `capabilities.runs` is true, on first load when HEAD is already complete and failing, and once more on the pending→settled transition, after the detail key's `invalidate`, before the monitor stops (R2 #15, Codex R3 #3, §10); and for parents and default-branch tips in Phase 11 (snapshots only there). Never for every row.
- **Request gate:** every request goes through `CommitChecksRequestGateRegistry.run` [CODE: requestGate.ts:63-69; repositoryMode.ts:268-276].

**Response metadata and pagination** (#12, #13, Phase 2). `http.ts` gains `FetchResponse = {statusCode: number; headers: Record<string, string | string[] | undefined>; body: unknown}` and `FetchJsonWithMeta = (url, headers) => Promise<FetchResponse>`, built by `createHttpGetJsonWithMeta(onResponse)` from the same request core as `createHttpGetJson`. The existing `FetchJson` type and every existing caller stay unchanged. `repositoryMode.ts` wires `fetchWithMetaFor(providerId)` through the gate exactly as `fetchFor` does. A new `src/services/commitChecks/paginate.ts` exports `paginate(fetch, firstUrl, nextUrl: (resp) => string | undefined, itemsOf: (body) => T[], maxPages, allowNext: (url: string) => boolean)`:
- It follows every page until `nextUrl` returns nothing: GitHub `Link: <…>; rel="next"` [ASSUMED: GitHub paginates the runs and jobs lists with `Link`; Phase 2 fixture], GitLab `x-next-page` [FACT: Codex Round 1 #13 citing https://docs.gitlab.com/api/pipelines/], Bitbucket Cloud `next` in the body [ASSUMED; Phase 17 fixture].
- **Continuation guard** (K33, R2 #4). Before each next page, `allowNext(url)` must return true. Each provider builds it from its configured API base (read from the provider ref and the `intelligit.commitChecks.hosts` setting, never a constant), generalising `normalizeBitbucketCloudNextUrl` [CODE: bitbucketCloudProvider.ts:229-241]: the URL parses; scheme `https:`; host and port equal the API base's; the path starts with the same API prefix as the first request (GitHub `/repos/{o}/{r}/`, GitLab `/api/v4/projects/{id}/`, Bitbucket Cloud `/2.0/repositories/{workspace}/{repo}/`, each under the configured base path for self-hosted instances [ASSUMED prefixes; each provider phase's fixture confirms]). A rejected link stops paging and returns the items read with `coverage: {reason: "rejectedNext", shown}`; no request is sent to it, so credentials never leave the API. Bitbucket Cloud's existing helper becomes its `allowNext` in Phase 17.
- Any page failure rejects, and the provider maps it to `unavailable`.
- Reaching `maxPages` (O1) returns the items read so far with `coverage: {reason: "pageBound", shown}`.

**Page size on every bounded collection** (K36, R2 #9). O1's "10 pages × 100" holds only if every request asks for 100:

| Collection | Request | Phase |
|---|---|---|
| GitHub runs for a commit | `actions/runs?head_sha=<sha>&per_page=100` | 2 |
| GitHub jobs of a run | `actions/runs/{id}/jobs?filter=latest&per_page=100` | 2 |
| GitHub attempts | `actions/runs/{id}/jobs?filter=all&per_page=100` | 12 |
| GitHub annotations | `check-runs/{id}/annotations?per_page=100` | 14 |
| GitHub usual-duration fallback (newest-first paging) | `actions/workflows/{id}/runs?branch=<b>&status=success&per_page=100` | 10 |
| GitLab pipelines for a commit | `pipelines?sha=<sha>&per_page=100` | 3 |
| GitLab jobs of a pipeline | `pipelines/:pid/jobs?per_page=100` | 3 |
| GitLab failed jobs (overflow scan) | `pipelines/:pid/jobs?scope[]=failed&per_page=100` | 3 |
| GitLab attempts | `pipelines/:pid/jobs?include_retried=true&per_page=100` | 12 |
| Bitbucket Cloud pipelines for a commit | `pipelines/?target.commit.hash=<sha>&pagelen=100` [ASSUMED maximum; Phase 17 fixture] | 17 |
| Bitbucket Cloud steps of a pipeline | `pipelines/{uuid}/steps/?pagelen=100` [ASSUMED maximum; Phase 17 fixture] | 17 |
| Bitbucket Server builds | the existing five-page builds reader [FACT: Codex R3 #10], kept; reaching its bound sets `otherChecksCoverage: {reason: "pageBound", shown}` (Codex R3 #10); if its requests name no page size, Phase 18 adds `limit=100` | 18 |

Single-item lookups (`per_page=1` baseline queries in §10 of the timing design) are not bounded collections.

**Failed jobs are always kept (O1, owner 2026-11-07), as a resumable scan** (R2 #8). When a job or step collection hits the bound and its run or pipeline is failed, the provider returns the first 1 000 with `jobsCoverage: {reason: "pageBound", shown: 1000}` and a scan cursor `{runId, runAttempt?, url}`. The detail service then drives the overflow scan one page at a time through the provider's `continueFailedScan(ref, cursor, ctx) → {failed: CiJob[]; next?: cursor} | {error}`:
- **GitHub** jobs and **Bitbucket Cloud** steps have no state filter [ASSUMED for both; Phase 2 and Phase 17 fixtures]: the cursor continues past page 10 of the same collection and keeps only failed items.
- **GitLab** uses the filtered collection `pipelines/:pid/jobs?scope[]=failed&per_page=100` from its first page [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/], skipping job ids already in the first 1 000.
- Progress (`cursor`, the failed items found) is kept in the in-memory L1 detail entry; each page's items are added before the next page is requested. Pages go through the gate one at a time, so the scan is paced by the gate and has no page bound of its own (the owner's "always kept").
- When the gate bucket is in cooldown, the scan does not queue a request: `failedScan.state` becomes `paused` and it resumes when the cooldown ends [ASSUMED: the gate exposes the cooldown end time; Phase 2 reads `requestGate.ts` and, if it does not, adds a read-only accessor]. A cooldown or budget error that the gate throws after the page was queued or acquired (`requestGate.ts:223-235`) is handled the same way: `paused`, cursor and found items kept, resume scheduled for the cooldown end; it is not a page failure (Codex R3 #8) [ASSUMED: those gate errors can be told apart from HTTP errors; Phase 2 step 1 checks and, if not, adds an error class in `requestGate.ts`].
- Before each page, and on resume, the scan checks that the run id and attempt still equal the cursor's, that `isCurrent(ctx)` holds, and that the key's generation is unchanged; any mismatch discards the progress and the scan starts again with the new run.
- Any other page failure sets `state: "stopped"` with `error`; found items stay. Refresh resumes from the saved cursor.
- After each page the host re-posts `commitCiDetail` with the `requestId` of the request that is showing the commit; the webview accepts it because that `requestId` is still the newest for the slot (§4).
- A detail with a scan is never persisted (its coverage is not `full`), so a restart starts the scan again.

**GitHub requests (Phase 2):** the runs and jobs requests in the table above, both paginated. `otherChecks` = snapshot items whose `id` matches no job's `checkRunId`. An item without `id` (older cached snapshot) is removed only when exactly one job has the same name; otherwise it stays (a visible duplicate beats a hidden status).

**Pending polls in the webview** reuse the existing ladder and cap, moved to `src/shared/ci/pollSchedule.ts` and re-exported from `checksRefresh.ts`. Failed fetches do not retry. The HEAD monitor has its own schedule (§10).

**ETag (Phase 5)** works on `FetchJsonWithMeta`:
- It adds an optional `conditional: EtagStore` argument. When a stored `{etag, body, pagination}` exists for the exact URL and the current auth generation, the helper sends `If-None-Match`. `pagination` holds the response's `Link` and `x-next-page` headers (Bitbucket Cloud's `next` is already in the body).
- A 304 returns the stored body (it is handled before the non-2xx rejection at [CODE: http.ts:69-77]) with the stored pagination headers restored into the response headers, so `paginate` reads the same next link and coverage cannot turn falsely `full` when the 304 carries no `Link` or `x-next-page` (Codex R3 #7). Quota and cooldown headers are read from the fresh 304 only. A 200 with `ETag` replaces body, etag and pagination headers.
- The store is L1 only, LRU with 500 entries, keyed by `${authGeneration}\0${url}` so a sign-in change never reuses another token's body.
- It is used only for requests made while the commit is incomplete, because complete data is served from cache.
- GitHub always sends `Authorization` (the session token), so 304s are free [FACT: GitHub best practices].
- GitLab and Bitbucket send the header too, and a 200 is handled as today [FACT: ideas.md:146 "not checked" for them].

### 4. Identity, generations and webview messages (Phase 1, Phase 4 onward)

**Generations** (#4). A host-side `CiGenerations` object (`src/services/commitChecks/ciGenerations.ts`) holds:
- `authGeneration`, bumped wherever the snapshot service's `clear()` is called for credential changes and on GitHub session change or Bitbucket/GitLab token change;
- `lifecycleGeneration`, bumped on `commitChecks.enabled`/`providers` change, on the status-bar, notify and diagnostics settings changing, and on repository close.

Every host operation captures `ctx = {repoKey, authGeneration, lifecycleGeneration}` at its start. After each `await`, and immediately before publishing anything (a webview reply, diagnostics, the status bar, a toast), it calls `generations.isCurrent(ctx)` and, for HEAD-bound work, also checks that HEAD is still the hash it started for. A stale result is dropped and traced (§16) as `discarded-generation`.

**Webview messages.** Names are [PROPOSED]. The builder adds them to the existing webview message union, in whatever file holds it [ASSUMED: found by `find_symbol` on the existing commit-checks request message before Phase 4]. Every request carries `requestId` (a monotonic number per webview) and the `repoKey` of the repository the webview is showing [ASSUMED: the commit-list webview already knows its repository scope (see `tests/e2e/branchRepositoryScope.spec.ts`); Phase 4 confirms the field]. Every reply echoes both. The webview keeps, per slot (detail, preview, log, action, history, changed-since-green, bisect), the newest `requestId` it sent, and renders a reply only when `reply.requestId === newest` and `reply.repoKey === currentRepoKey` and `reply.hash === selectedHash` (#29). "Older than" is not enough: A → B → A must drop the first A reply. The preview slot also requires `reply.selectionToken === currentSelectionToken`, where the token changes on every job selection (R2 #17).

| Direction | Message | Payload | Phase |
|---|---|---|---|
| webview → host | `requestCommitCiDetail` | `{requestId, repoKey, hash, force?}` | 4 |
| host → webview | `commitCiDetail` | `{requestId, repoKey, hash, detail: CommitCiDetail}` (re-posted with the same `requestId` after each overflow-scan page, §3) | 4 |
| host → webview | `openChecksTab` | `{repoKey, hash}` (select row if loaded, switch tab) | 4 (popover), 13 (status bar/toast) |
| webview → host | `previewCiLog` | `{requestId, repoKey, hash, runId, jobId, attempt, selectionToken}` | 7 |
| host → webview | `ciLogPreview` | `{requestId, repoKey, hash, runId, jobId, selectionToken, outcome: "ready" \| "running" \| "forbidden" \| "failed", excerpt?: string, truncated?: boolean, message?}` (excerpt per K18) | 7 |
| webview → host | `openCiLog` | `{requestId, repoKey, hash, runId, jobId, attempt}` | 7 |
| host → webview | `ciLogResult` | `{requestId, repoKey, hash, outcome: "opened" \| "forbidden" \| "failed" \| "running", message?}` | 7 |
| webview → host | `runCiAction` | `{requestId, repoKey, hash, action: "rerunFailed" \| "rerunJob" \| "cancel", runId, jobId?}` | 8 |
| host → webview | `ciActionResult` | `{requestId, repoKey, hash, outcome: "ok" \| "forbidden" \| "failed" \| "uncertain", message?}` | 8 |
| webview → host | `requestCiHistory` | `{requestId, repoKey, hash, parents: string[]}` | 11 |
| host → webview | `ciHistory` | `{requestId, repoKey, hash, parent: {hash, items: CommitCheckItem[] \| null} \| null, defaultBranch: {name, tipHash, items: CommitCheckItem[] \| null} \| null}` | 11 |
| webview → host | `requestChangedSinceGreen` | `{requestId, repoKey, hash, logicalCheckId, scopeName: string \| null, checkName, loaded: {hash, parents: string[]}[]}` (`scopeName` = the selected job's workflow or pipeline name; Codex R3 #12) | 12 |
| host → webview | `changedSinceGreen` | `{requestId, repoKey, hash, logicalCheckId, scopeName, checkName, lastGreen: string \| null, unknownReason?: "ambiguous", files: CommitFile[]}` | 12 |
| webview → host | `openCiRangeDiff` | `{requestId, repoKey, fromRev, toRev, path, oldPath?, status}` | 12 |
| webview → host | `startCiBisect` / `cancelCiBisect` | `{requestId, repoKey, commits: {hash, parents: string[]}[]}` / `{requestId}` | 16 |
| host → webview | `ciBisectProgress` / `ciBisectResult` | `{requestId, done, total}` / `{requestId, repoKey, linear: boolean, jobs: {checkName, states: (CiState \| null)[], brokeAt: string \| null, flaky: {n, m, attemptsCounted: boolean} \| null}[]}` | 16 |

The handlers live in each webview host that renders `CommitInfoPane`. There are three render sites (BRIEF.md:53); the number of host providers behind them is [ASSUMED]; Phase 4 confirms it.

### 5. Logs (Phase 6 transport and in-memory store, Phase 7 preview, editor and UI)

Owner path C (2026-11-07): logs live in memory, one store per window. This removes the cross-window lock, reservations, cross-window eviction and orphan cleanup by construction (Codex Round 2 #5, #6, #10, #11: FIXED-BY-REDESIGN).

- **Key:** `sha256(providerKey + "\0" + runId + "\0" + jobId + "\0" + attempt)` as 64 hex characters.
- **Store** `CiLogMemoryStore` in `src/services/commitChecks/ciLogMemoryStore.ts` (K16). One per window, created in `src/activation/repositoryMode.ts` next to the detail service and disposed with it. The module imports no `fs` (a test asserts it).
  - `entries`: an LRU `Map<key, {text, truncated, firstErrorLine}>` of at most `MAX_CI_LOGS_IN_MEMORY = 3` logs (a deliberate design constant). `get` moves an entry to most recent; adding a fourth evicts the least recent.
  - `inflight`: `Map<key, Promise<entry>>`. Two requests for the same key in this window share one download.
  - `sources`: `Map<key, {repoKey, provider, runId, jobId, attempt}>`, the small record needed to download a log again; kept for the window's life, no text.
  - `load(key, source, signal)`: hit → entry; in-flight → join; else download, store, return. Only complete (settled) jobs are loaded; the handlers reply `outcome: "running"` for a running job before calling `load`.
  - `clear()` (called with the services' `clear()` on credential or settings change) empties `entries` and `inflight` and aborts in-flight downloads; their results are dropped by the generation check.
- **Download:** `http.ts` gains `downloadToString(url, headers, maxBytes, signal): Promise<{text: string; truncated: boolean}>` (K17), on the same request core and the redirect rules below (K20). It counts bytes as chunks arrive and stops reading at `maxBytes` = the O2 bound (50 MB) by destroying the response. The kept bytes are decoded as UTF-8 after cutting back to a UTF-8 boundary; then the line "[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]" is appended exactly once and `truncated: true` is set. A known `Content-Length` larger than the bound is not refused: the download runs up to the bound and truncates. Chunks are kept in an array and concatenated once at the end. Stream errors reject and are never swallowed; an abort rejects with an abort error. The existing 15 s timeout [CODE: http.ts:87-89] applies as an inactivity timeout [ASSUMED: it is set with `request.setTimeout`, which measures socket inactivity; Phase 6 confirms and, if it is a total timeout, gives downloads an inactivity timeout of the same 15 s].
- **Per-log bound (O2, RESOLVED by the owner 2026-11-07):** 50 MB; on reaching it the download stops, the marker line is appended, and the detail shows Open in browser.
- **Redirect helper** (#6): `followRedirects(url, headers, {maxHops: 5})` in `http.ts`, used by every log download (GitHub 302, Bitbucket Cloud 307, any provider). It follows 301/302/303/307/308 only to `https:` URLs; on any change of origin (scheme, host or port) it removes `Authorization`, `Cookie`, `Private-Token`, `Job-Token` and every header the provider lists in `credentialHeaders`; it never adds them back on a later hop, even if the chain returns to the first origin. More than 5 hops, a non-HTTPS target or a missing `Location` is an error.
- **GitHub expired link:** a 403/404/410 from the redirect target gets one fresh request to the logs endpoint, then an error.
- **GitLab:** `jobs/:jid/trace` is downloaded with the auth header through the same helper.
- **Read-only document:** scheme `intelligit-ci-log`, URI `intelligit-ci-log:/<job name>.log?k=<64-hex key>`, served by a `TextDocumentContentProvider` registered in `repositoryMode.ts` next to the store and disposed with it; registration copies the `registerReadonlyDiffContentProvider` pattern [FACT: BRIEF.md:60]. It accepts only `k` matching `^[0-9a-f]{64}$`. Hit → the stored text. Miss with a `sources` record (evicted in this window) → `load` again and return the text, or "[IntelliGit: could not load this CI log: <reason>]" on failure. Miss with no record (after a reload or restart) → "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]", with no request. VS Code copies the text into its document, so the store needs no pinning: eviction never changes an open tab [ASSUMED: VS Code keeps a content-provider document's text while a tab shows it and asks again only on reopen or `onDidChange`; the Phase 7 e2e "first tab keeps its text after a fourth log is opened" checks it].
- **First error line.** The provider declares `firstErrorPatterns: RegExp[]`: GitHub `/##\[error\]/` and GitLab `/^ERROR: /m` [ASSUMED for both; fixtures in Phase 7 settle it]. The fallback is the first line matching `/\b(error|failed)\b/i` after the failing step's start line (`##[group]<step name>` for GitHub [ASSUMED]). The last fallback is the last line. It is computed once when the log is stored. The editor opens with `selection` set to that line.
- **Excerpt** (#7, BRIEF.md:16): the host takes at most 40 lines and 8 KB around the first error line from the stored text and passes them through `sanitizeExcerpt`: strip ANSI escape sequences (`/\x1b\[[0-9;?]*[ -\/]*[@-~]/g` and OSC `\x1b]…\x07`), replace bidi controls U+202A-U+202E and U+2066-U+2069 and other C0/C1 control characters except `\n` and `\t` with U+FFFD, then cut to 8 KB on a UTF-8 boundary. The webview renders it as a React text node inside `<pre>`; no `dangerouslySetInnerHTML`, no markdown, no link detection. It is held in component state only and never written to `vscode.setState`.
- **Preview** (R2 #17): selecting a complete failed job with `capabilities.logs` posts `previewCiLog` with a new `selectionToken`. The host calls `load`, builds the excerpt and replies `ciLogPreview`; it opens no editor. A running job gets `outcome: "running"`; a 403 `forbidden`; other errors `failed`.
- **Open full log:** `openCiLog` runs `load` inside `window.withProgress` (a hit after the preview returns at once), then opens the document at the first error line. Cancelling the progress stops this waiter only; a shared download continues and lands in the store [PROPOSED].
- **Failure summary:**
  - GitHub: `GET check-runs/{checkRunId}` → `output.title` + `output.summary`, only for the selected failed job, cached with the detail.
  - GitLab: `failure_reason`.
  - Bitbucket Cloud: pipeline `error.message`.
  - The summary is truncated to 2 000 characters and rendered as text, like the excerpt.
- **Memory:** per window at most 3 × (50 MB + the marker line) in the store, plus VS Code's copies of open log tabs, plus downloads in flight (each up to 50 MB). Recorded under Risks.

### 6. Actions (Phase 8)

- **POST helper:** `http.ts` gains `httpRequestJson(method, url, headers, body?)` sharing the request core (no redirect following, same timeout, same observer). The gate wiring gets a `writeFor(providerId)` twin of `fetchFor`.
- **GitHub:** `POST runs/{id}/rerun-failed-jobs`, `POST jobs/{actionsJobId}/rerun`, `POST runs/{id}/cancel`.
- **GitLab:** `POST pipelines/:id/retry` (rerun failed), `POST jobs/:id/retry`, `POST pipelines/:id/cancel`.
- **Request gate:** write calls go through the request gate. A bucket in cooldown returns the cooldown message, and nothing is sent (and no fence is written).
- **Order:** write and await the action fence (K30, §3) → send → on `ok` or `uncertain`: `coordinator.invalidate(hash)` (snapshot and detail, §3 fence, awaited), then force-fetch both; on `forbidden`, `failed` or not sent: delete the fence.
- **On 403:** the provider's `writeScopeHelp` text with a link to `docs/commit-checks/README.md#write-actions`.
  - GitHub: "You don't have permission to re-run or cancel workflows in this repository."
  - GitLab: "Your GitLab token is read-only. Create one with the `api` scope to re-run or cancel."
- **Cancel confirmation** is an inline two-button confirm in the webview, not a native modal. Native modals are invisible to the Playwright e2e harness [FACT: memory note "native modal is invisible to Playwright"].

### 7. Required and optional (Phase 9)

- **GitHub** (C2, resolved):
  - Always call `GET rules/branches/{default}` (Metadata read) and read `required_status_checks` rules.
  - Also call `GET branches/{default}/protection/required_status_checks`. A 200 adds its `contexts`/`checks`. A 404 with body "Branch not protected" adds nothing and keeps the result `known`. A 403, or a 404 without that body, sets `requiredStatus: "partial"` (if rulesets gave any) or `"unknown"`.
  - A check in the union is `required: "yes"`. A check not in it is `"no"` when the status is `known`, and `"unknown"` otherwise.
- **Branch:** the default branch from `origin/HEAD` (§8). Required checks guard merges into it [PROPOSED].
- **Cache:** `required:<repoKey>:<branch>`, in L1 only, for 1 h.
- **GitLab:**
  - `optional = allow_failure` [FACT: ideas.md:97].
  - Required = every non-optional job when the project has "Pipelines must succeed" on [ASSUMED: project field `only_allow_merge_if_pipeline_succeeds` readable with `read_api`; Phase 9 checks against the docs and a fixture]. If the field is absent, the result is "unknown".
- **Bitbucket Cloud:** `requiredChecks: false`, so the header shows "required: unknown".
- **Bitbucket Server:** Phase 18.

### 8. Default branch (Phase 9, reused by 11)

`git symbolic-ref --quiet refs/remotes/origin/HEAD`, which gives `refs/remotes/origin/<name>`. The tip is `git rev-parse refs/remotes/origin/<name>`. Both are read on demand for every comparison and never cached (R2 #18): an ordinary `git fetch` moves the tip without bumping any generation, and the two local commands are cheap. If either is missing, the result is `null`. The UI then shows "default branch unknown — run `git remote set-head origin --auto`", and there are no "also red on main" tags and no required tags (required status "unknown"). There is no fallback to the provider's API and no "main" constant. The file is `src/services/commitChecks/defaultBranch.ts`, created in Phase 9. The required-checks cache (K21) is keyed by the branch name read this way, so a renamed default branch gets its own entry.

### 9. History join, attempts and flaky (Phase 11, 12, 16)

New file `src/services/commitChecks/ciHistory.ts` holds pure functions.

- **Logical identity** (K35, R2 #13). `logicalCheckId` in `src/shared/ci/identity.ts`:
  - GitHub Actions job: `"job\0" + workflowName + "\0" + jobName`;
  - GitLab job: `"job\0" + (pipelineName ?? "") + "\0" + jobName` [ASSUMED: the pipeline `name` field is optional; Phase 3 fixture];
  - Bitbucket Cloud step: `"job\0" + (pipelineName ?? "") + "\0" + stepName` [ASSUMED field; Phase 17 fixture];
  - status-only checks and other flat checks: `"status\0" + <provider check name or status context>`.
  The `job` prefix keeps a workflow or pipeline named `status` from colliding with a flat check (owner decision 2026-11-10, PR #414 review).
  Execution ids (`id`, `checkRunId`, job ids) identify one execution and are used only for de-duplication inside one commit (§3); they never match across commits.
- **Join rule:** for a job or item, the parent's matching item is found by `logicalId` when both sides have one; otherwise by name (the unique-name fallback), and only when the name matches exactly one parent item **and** exactly one current item within the scope (Codex R3 #11). Scope = the workflow or pipeline name when both sides carry it, else the whole commit on both sides. Zero or several matches on either side → `unknown`. Snapshot items carry `logicalId` only where the snapshot API gives the workflow or pipeline name [ASSUMED: GitHub check runs do not carry the workflow name, so GitHub parents use the unique-name fallback; Phase 11 fixture settles it per provider].
- **compare(job, parentItems):**
  - no unique match → `unknown`
  - parent incomplete for that item (pending) → no tag
  - job failure + parent success → `new`
  - failure + failure → `still`
  - success + failure → `fixed`
- **Merge commits** compare against the first parent.
- **Attempt history** (#20, R2 #14, Phase 12): `getAttemptHistory(ref, hash)` returns `CiAttemptHistory[]`, one per `(runId, logicalId)`, so same-named jobs in two workflows or two pipelines never share a history.
  - GitHub: `actions/runs/{id}/jobs?filter=all&per_page=100` for runs with `run_attempt > 1` [ASSUMED parameter; Phase 12 fixture]. `attempt` = the job's `run_attempt`; order by `run_attempt`, then `started_at`, then job id; de-duplicate by job id.
  - GitLab: `pipelines/:pid/jobs?include_retried=true&per_page=100` [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/]. Retried jobs carry no attempt number, so order by `created_at`, then job id, and number them 1..n; de-duplicate by job id.
  - Two runs of the same workflow on one commit (for example a push run and a pull-request run) are two histories.
  - A history that hits the page bound carries its `coverage`.
  - Tree and bisect use the same function.
- **flaky(logicalId, orderedHistory, attemptsByHash):**
  - `m` = number of commits with a complete result for that check.
  - A commit counts toward `n` when it is an isolated red (its nearest complete newer and older neighbours are both green) **or** one of its attempt histories shows a failure followed by a success. A commit that meets both rules counts once.
  - The tag shows when `n ≥ 1`. `attemptsCounted` is false when the provider has `attemptHistory: false` (O3 fallback); the tag then adds "(estimated)" and the tooltip says "estimated from loaded commits; re-runs not counted for this provider".
- **brokeAt(name, chain):** only on a first-parent chain (§13): the oldest commit of the newest unbroken run of reds that is preceded by a green. `null` if there is no preceding green.

### 10. HEAD monitor, status bar and toast (Phase 13)

- **Monitor** (#18). A host-side `HeadCiStatus` runs per active repository. It reads the HEAD hash on the existing repository-change signal [ASSUMED: the same signal the Git Log refresh uses; commit 64f67f35 refreshes on outside worktree changes]. For an incomplete HEAD, and for a HEAD with an action fence whatever its execution state (Codex R3 #5), it fetches the snapshot and, when `capabilities.runs` is true, the detail. Schedule (K26): the existing pending ladder `[3, 5, 10, 20, 30, 60, 60, 120] s`, then every 120 s (the last rung) until HEAD is complete (settlement `settled`, §3) and has no action fence, as long as HEAD is unchanged. No per-hash cap. While the gate bucket is in cooldown it sends nothing and shows "paused". It does not run when `commitChecks.enabled` is false, or when the status bar, notify and diagnostics settings are all off.
- **Authoritative detail for settled HEADs** (R2 #15). When `capabilities.runs` is true, the monitor also fetches the detail (a) on first load of a HEAD whose snapshot is already complete and failing (cache first), and (b) once more when a snapshot fetch shows the pending→settled transition, before the monitor stops and before the toast or diagnostics read job states, log targets or `annotationCount`. For (b) the monitor first awaits the detail service's `invalidate(hash)` and then fetches with `force: true`, so the fetch always starts after settlement and can never join a detail request started before it (`service.ts:81-82` joins in-flight work even with `force`; Codex R3 #3). Only the detail key is invalidated; the settled snapshot just read stays cached. If that detail's settlement is `unknown` (§3, Codex R3 #9), the monitor neither stops nor toasts: it keeps the 120 s tail and re-checks on every poll.
- **Background request budget** (#34): with default settings, a user who never opens the tab still pays the HEAD monitor. For one incomplete HEAD over one hour that is exactly 36 snapshot fetches (1 initial + 8 ladder rungs ending at 308 s + 27 at 120 s up to 3 548 s), plus the same number of detail fetches when the provider has runs, plus one detail fetch at settlement. GitHub sends `If-None-Match` from Phase 5, so unchanged polls cost no primary quota. A complete HEAD costs one fetch per HEAD change (zero when cached), plus one detail fetch when it is failing, plus one annotations pass per complete failing HEAD (Phase 14). With `commitChecks.enabled: false`, nothing new is sent.
- **Status bar item.** Left side, command `intelligit.ci.showHeadChecks`.
  - Text: `$(error) <failed> · $(sync~spin) <pending> · $(check) <passed>`, plus the elapsed time from the earliest `startedAt` of incomplete runs, re-rendered every 1 s while incomplete. Without a start time the elapsed part is omitted.
  - Paused: `$(debug-pause) CI paused`, tooltip with the cooldown message, command `intelligit.ci.refreshHeadChecks` (refreshes once the cooldown is over).
  - The tooltip holds the summary.
  - Hidden when checks are disabled, the state is `none` and HEAD is unpushed, there is no provider match, or `intelligit.commitChecks.statusBar` is off.
- **Pending-observed set** (#16, K27): when the monitor first sees a HEAD incomplete, it adds `{repoKey, hash, observedAt}` to `workspaceState["intelligit.ci.pendingObserved.v1"]` (awaited). At activation the monitor reads the set; if the current HEAD is in it, the first fetch that shows `complete` triggers the toast path, even if the incomplete state was never seen in this activation.
- **Toast** (#5, #17, R2 #1, R2 #12, K13). Scope: one toast per `{repoKey, hash}` per machine. Conditions: the hash is in the pending-observed set, its latest fetch is complete (settlement `settled` when the provider has runs; `unknown` never toasts, Codex R3 #9), `intelligit.commitChecks.notifyOnSettle` is true, and `window.state.focused` is true. Order inside one async function guarded by an in-memory `Set` set before the first await:
  1. ensure the parent directory exists: `fs.promises.mkdir(<globalStorageUri>/ci-toast-claims, {recursive: true})`;
  2. claim atomically: `fs.promises.mkdir(<globalStorageUri>/ci-toast-claims/<sha256(repoKey + "\0" + hash)>)`, without `recursive`. Node's `fs` is used, not `workspace.fs.createDirectory`, because only a non-recursive `mkdir` reports `EEXIST`. `mkdir` is atomic across processes on every platform; exclusive file create is not used because Windows answers it with EPERM [FACT: memory note "exclusive create answers EPERM"];
  3. `EEXIST` → another window (or this window before a reload) already toasted: remove the hash from the pending-observed set and stop. Any other error → no toast, traced, the hash stays in the set and the function runs again on the next focus;
  4. success → remove the hash from the pending-observed set, then show the toast.
  An unfocused window that sees completion keeps the hash in its pending-observed set and re-runs this function on the next `onDidChangeWindowState` with `focused: true`. If windows A and B both pass the focus check during a focus change, both call step 2 and exactly one `mkdir` succeeds. Crash semantics: at-most-once (a crash between step 2 and the toast loses the toast) [PROPOSED; matches the locked "once per hash"]. Claims are never pruned (K13; owner 2026-11-07, Codex R3 #2): no sweeper exists, so no cleanup can delete a claim another window has just created. Cost: one empty directory per toasted hash (Risks).
- **Toast buttons** reuse the Phase 7 and Phase 8 host functions, with no new provider code: **Open Checks** opens the Git Log and posts `openChecksTab`; **Open log** opens the first failed job's log when `capabilities.logs` is true; **Re-run failed** shows when `capabilities.rerunFailed` is true.

### 11. Diagnostics (Phase 14)

- One `DiagnosticCollection` named `intelligit-ci`.
- For HEAD only, and only when HEAD is `complete` with failures and `capabilities.annotations` is true, it fetches annotations for failed check runs with `annotationCount > 0`, paginated with `per_page=100` (§3). A check run whose annotations hit the page bound publishes the first 1 000 and the Checks tab shows "Showing the first 1 000 annotations".
- Phase 14 bumps `CI_DETAIL_CONTRACT_VERSION` (R2 #16): details cached before Phase 14 carry no `annotationCount`, so they become misses and are fetched again instead of suppressing every annotations fetch.
- **Path and range validation** (#8), per annotation, before any `Diagnostic` is created:
  - `path` must be relative: reject a leading `/`, `\`, a drive letter (`^[A-Za-z]:`), a UNC prefix, or any `..` segment after normalising `\` to `/`;
  - `realpath(join(repoRoot, path))` must stay inside `realpath(repoRoot)` (symlink escape); a file that does not exist is rejected;
  - `start_line`/`end_line` must be integers ≥ 1 with `end_line ≥ start_line`; the range is clamped to the document's line count when it is read; non-integer or missing → rejected;
  - rejected annotations are dropped and counted; the Checks tab shows "N annotations could not be placed"; valid annotations in the same batch are kept.
- Mapping: 1-based API lines → 0-based VS Code lines; `failure` → Error, `warning` → Warning, `notice` → Information; source `CI: <job name>`.
- Publish only if `generations.isCurrent(ctx)` and HEAD is still the hash after the last await (#4).
- Clear on HEAD change, provider disable, setting off, sign-out (`authGeneration` bump), `clear()`, and repository close.
- Setting: `intelligit.commitChecks.problemsDiagnostics` (default `true`).

### 12. CI column (Phase 15)

- Setting `intelligit.commitChecks.showCiColumn` (default `false`).
- When on, `CommitList` renders a fixed-width column whose width is taken from Figma frame `1:2` [ASSUMED width]. It is independent of the Author/Date gate (BRIEF.md:54).
- The cell shows a stacked bar (success / failure / pending proportions from `items`) and `passed/total`. Hover shows the existing summary tooltip, and a click selects the row and opens the Checks tab.
- When the column is on, the old `CommitChecksButton` cell is not rendered, so the row does not show two badges [PROPOSED].

### 13. Bisect (Phase 16)

- **Trigger:** the row context menu on a multi-row selection, **Find where CI broke**. It is webview-local, so there is no new VS Code command [PROPOSED; ASSUMED: CommitList supports multi-row selection — Phase 16 confirms, and if it does not, the action applies from the right-clicked row to HEAD within the loaded page].
- **Input** (#19, K24): the webview sends the selected loaded commits with their parent hashes. The cap is the loaded page, read from the list.
- **Chain:** the host walks first parents from the newest selected commit, staying inside the selected set. If every selected commit is on that walk, `linear: true` and `brokeAt` is computed along it. Otherwise `linear: false`, sparklines are shown in list order, and `brokeAt` is `null` with "not a straight line — no break point".
- **Fetching:** snapshots through the existing coordinator (cache first, then the request gate, 4 concurrent), and attempt histories when `capabilities.attemptHistory` is true. Progress after each commit.
- **Cancel** (#25): a `CancellationTokenSource` per bisect. The token is checked (a) before a task is queued, (b) **inside the gated callback, immediately before the HTTP call**, since the gate itself does not check it [FACT: Codex #25], and (c) before posting progress. Panel disposal cancels too.
- **Result:** per check, `states[]` (oldest → newest, `null` for no result), `brokeAt` and `flaky`, joined across commits by the §9 rule. The view sits inside the Checks tab as a "Bisect" section that replaces the tree until it is closed [ASSUMED: layout per frame `4:2`].

### 14. Changed since last green (Phase 12)

- **Walk** (#19): the webview sends the loaded commits with their parents, and the selected job's `logicalCheckId` and `scopeName` (Codex R3 #12). The host walks first parents from the selected commit using those links and stops at the first hash not in the loaded set. It reads each ancestor's snapshot from cache only (L1 then L2; no network). Each ancestor's item is matched by the §9 join rule with that identity: `logicalId` where the ancestor's item carries one, else the unique-name fallback within `scopeName`, unique on both sides (the current side is the selected commit's cached detail). The first ancestor whose matched item is `success` and complete is `lastGreen`. An ambiguous match stops the walk with `lastGreen: null` and `unknownReason: "ambiguous"`, and the detail says "Cannot match this job in older commits" [PROPOSED wording] instead of the no-green line.
- **Files:** `git diff --name-status -M -z <lastGreen> <sha>` parsed into `CommitFile[]` (NUL-separated, so names with spaces, tabs, newlines, `#`, `?` or a leading `-` survive; `--` before any path argument).
- **Two-revision diff action** (#22): clicking a file posts `openCiRangeDiff {fromRev: lastGreen, toRev: sha, path, oldPath?, status}`. The host opens `vscode.diff(left, right, title)` where both sides are read-only revision URIs served by the existing read-only diff content provider [ASSUMED: it serves a file at an arbitrary revision; Phase 12 step 1 confirms in `diffService.ts:174-178`, and if it only serves commit-vs-parent, adds a `rev` query parameter to its URI]. Added files use an empty left side, deleted files an empty right side, renames use `oldPath` on the left. Paths are encoded with `Uri.from({path})`, never string concatenation.
- This works for every provider.

### 15. Bitbucket Cloud and Server (Phases 17, 18)

**Bitbucket Cloud** (Phase 17):
- `pipelines/?target.commit.hash=<sha>&pagelen=100` [FACT: BRIEF.md:83 for the filter], paginated, then `pipelines/{uuid}/steps/?pagelen=100`, paginated, with each step mapped to a `CiJob` that has no steps. `allowNext` is the existing `normalizeBitbucketCloudNextUrl` rule, moved behind the K33 contract [CODE: bitbucketCloudProvider.ts:229-241]. A failed pipeline whose steps hit the bound gets the overflow scan (§3).
- `steps/{uuid}/log` for logs, through the redirect helper (307) [FACT: Codex #6], into the window's log store (§5).
- `stopPipeline` for cancel, with the action fence (K30).
- `creator`, `trigger`, `target.ref_name` and `build_number` for the header [FACT: ideas.md:135].
- The previous successful pipeline on the same ref created before the selected one gives "usually".
- A 403 on pipeline discovery **or** on steps keeps the flat snapshot list and shows "Steps need the `pipeline` scope" with the README link (C3, #14).

**Bitbucket Server** (Phase 18):
- `getDetail` returns `runs: []` and `otherChecks: CiFlatCheck[]` with `id` = build `key`, `logicalId` = `"status\0" + key`, `durationMs`, `required` and `usualDurationMs` (#10). Capabilities `requiredChecks` and `usualDuration` true; everything else false.
- `/rest/api/latest/projects/{p}/repos/{r}/commits/{id}/builds` first. On 404 or 405 it falls back to `/rest/build-status/1.0/commits/{id}` and memoises "legacy" per host for the session; 401/403 do not fall back (C4).
- `required-builds/latest/.../conditions` for required.
- `duration` of the previous build of the same `key` on the parent commit gives "usually" [FACT: ideas.md:110].

### 16. Diagnostic trace (Phase 1)

`src/services/commitChecks/ciTrace.ts` writes one structured line per operation to a `LogOutputChannel` named "IntelliGit CI" (created with `{log: true}`) [ASSUMED: no shared extension logger exists; Phase 1 searches for one first and uses it if found]. Fields: `op` (short random id), `kind` (detail, snapshot, scan, log, preview, action, fence, annotations, monitor, claim, history, bisect), `repoKey`, `provider`, `hash` (short), `outcome` (`hit-l1`, `hit-l2`, `fetched`, `incomplete`, `discarded-generation`, `cooldown`, `paused`, `uncertain-write`, `next-rejected`, `claim-exists`, `fenced`, `failed`), `reason`, `status` (HTTP code), `ms`. URLs are logged as origin + path only (query strings dropped). Never logged: tokens, request headers, signed URLs, log text, annotation messages, excerpt text. Level: `trace` for hits, `info` for fetches, `warn` for discards, refused next links and uncertain writes.

### Check commands (every phase)

From AGENTS.md "Pre-Commit Validation" and "Commit Checklist For English UI Strings" [CODE: AGENTS.md:30-63] and package.json scripts [CODE: package.json:1619-1662]. Each phase's **Done when** names which sets apply.

**Gate L — localization, before final validation, in every phase that adds or changes a user-facing string:**
1. `bun run l10n:sync`
2. `bun run l10n:translate -- --only-missing`
3. `bun run l10n:import`
4. `bun scripts/localization-csv.js validate`
5. `bun run l10n:validate`
6. `bun run l10n:audit`

**Gate G — standard validation, every phase, in this order:**
1. the phase's focused tests: `bun vitest run <the phase's test files>`
2. `bun run format:check`
3. `bun run lint`
4. `bun run lint:strict` (TSDoc/JSDoc coverage for new and changed functions [CODE: AGENTS.md:24-28])
5. `bun run architecture:check`
6. `bun run react-doctor`
7. `bun run typecheck`
8. `bun run build`
9. `bun run test`
10. `bun run build:prod` and `bun run package` (every phase bumps the version, and a version bump is a release [CODE: AGENTS.md:57-59])
11. GitNexus impact analysis before editing each changed symbol and `detect_changes({scope: "all"})` before the commit, not partial or truncated (project CLAUDE.md).

**Gate U — UI phases (4, 7, 8, 9, 10, 11, 12, 13, 15, 16):** design through the project-local `$impeccable` workflow, the single narrowest matching command [CODE: AGENTS.md:65-71]; after the UI tests, the affected-path Impeccable detector [ASSUMED command: AGENTS.md:71 requires it but does not name the command; Root names it before Phase 4 dispatch].

**Gate E — e2e on CI:** the phase's new spec files are added to the explicit list in `package.json` `test:e2e` [CODE: package.json:1655]; CI `bun run test:e2e` is green, existing specs included. E2E proof runs on CI, not locally [FACT: BRIEF.md:98].

## Key decisions & tradeoffs

### Contract table

| # | Contract | Value | Source | Status |
|---|---|---|---|---|
| K1 | Capability model shape | `ProviderCiCapabilities` (§1) in `src/shared/ci/capabilities.ts`, declared on each provider, attached to every served detail at read time, never persisted | this plan; #9 | RESOLVED |
| K2 | Detail wire and persisted shape | `CommitCiDetailData` persisted, `CommitCiDetail` = data + `capabilities` + `repoKey` + `actionFence?` on the wire (§2); persisted entries carry `contractVersion`, mismatch = miss; `failedScan` never persisted | this plan; #9, #10, #11; Codex R2 #2, #7, #8 | RESOLVED |
| K3 | Webview messages | table in §4; every message carries `requestId` + `repoKey`; render only the newest `requestId` per slot (detail, preview, log, action, history, changed-since-green, bisect); preview also matches `selectionToken` | this plan; #4, #29; Codex R2 #17 | RESOLVED |
| K4 | Setting `intelligit.commitChecks.showCiColumn` | boolean, default `false`, `scope: window` | design choice (feature 11 "optional") | RESOLVED |
| K5 | Setting `intelligit.commitChecks.statusBar` | boolean, default `true`, `scope: window` | design choice | RESOLVED |
| K6 | Setting `intelligit.commitChecks.notifyOnSettle` | boolean, default `true`, `scope: window` | design choice | RESOLVED |
| K7 | Setting `intelligit.commitChecks.problemsDiagnostics` | boolean, default `true`, `scope: window` | design choice | RESOLVED |
| K8 | Commands | `intelligit.ci.showHeadChecks` (status-bar click) and `intelligit.ci.refreshHeadChecks` (paused-state click); both registered, hidden from the palette (`"when": "false"` in `menus.commandPalette`), listed in both e2e command inventories | repo rule BRIEF.md:39 | RESOLVED |
| K9 | Cache keys | snapshot key unchanged; detail `${snapshotKey}#detail` in L1 and in the detail persistent store (`globalState["intelligit.commitChecks.detailCache.v1"]`, max 200 entries) | this plan | RESOLVED |
| K10 | Freshness (snapshot and detail) | complete: forever in L1, 24 h persisted; a detail is persisted only when complete and fully covered; incomplete (including an incomplete `failure`): 30 s, never persisted; fenced hash (K30): pending TTL, never persisted; none: 1 h; unavailable: 15 min | [CODE: repositoryMode.ts:256-264]; #1; Codex R2 #2, #7 | RESOLVED |
| K11 | Webview pending ladder | `[3,5,10,20,30,60,60,120] s`, cap 20 per hash [CODE: checksRefresh.ts:6-8, :26]; values unchanged; now also runs while a `failure` is incomplete; failed fetches do not retry | existing behaviour; #1 | RESOLVED |
| K12 | ETag store | L1 only, key `${authGeneration}\0${url}`, LRU 500 entries; entry = `{etag, body, pagination}` with the `Link` and `x-next-page` headers; a 304 returns the stored body and restores the stored pagination headers; quota and cooldown headers come from the fresh 304; incomplete requests only | provider `ETag` header (dynamic); Codex R3 #7 | RESOLVED |
| K13 | Toast claims | atomic cross-process claim: `fs.mkdir(<globalStorageUri>/ci-toast-claims/<sha256(repoKey + "\0" + hash)>)` without `recursive`; `EEXIST` = already toasted; focused window only; one per hash per machine; claims are never pruned (no sweeper, so no cleanup can race a new claim); no count cap | Codex R2 #1, #12; Codex R3 #2; #5, #17 | **RESOLVED** — owner 2026-11-07, Codex R3 #2: permanent claims replace the earlier 90-day retention; cost: one empty directory per toasted hash (Risks) |
| K14 | Elapsed tick | 1 s, client-side only (webview timer and status-bar timer); no requests | design choice | RESOLVED |
| K15 | Overdue threshold | elapsed > 1.5 × usual | BRIEF.md:21 | RESOLVED |
| K16 | Log store | `CiLogMemoryStore`, one per window, created and disposed in `repositoryMode.ts`; LRU of `MAX_CI_LOGS_IN_MEMORY = 3`; key = 64-hex sha256 of provider key, run id, job id, attempt; in-window join map; settled jobs only; no file system; emptied by `clear()`, a reload or a restart | owner path C, 2026-11-07; Codex R2 #5, #6, #10, #11 (FIXED-BY-REDESIGN) | RESOLVED |
| K17 | Log download bound | `downloadToString(url, headers, maxBytes, signal)`: stops at the O2 bound (50 MB), appends the marker line once, `truncated: true`; a known `Content-Length` above the bound downloads up to the bound and is never refused | O2; Codex R2 #10 | RESOLVED |
| K18 | Log excerpt to the webview | ≤ 40 lines and ≤ 8 KB around the first error; ANSI stripped; bidi and control characters replaced; rendered as a text node; never in persisted webview state; never the full log; delivered by `previewCiLog` / `ciLogPreview` | BRIEF.md:16 (owner-approved design, frame 2:2); Root triage #7; Codex R2 #17 | RESOLVED |
| K19 | Log document scheme | `intelligit-ci-log:`, key `^[0-9a-f]{64}$` only; text served from the window's store; a miss with a known source downloads again; a miss without one shows the "no longer loaded" line and sends no request; when a later `load` of the same key succeeds, the provider fires `onDidChange(uri)` for every open URI it answered with the placeholder or an error line, so that tab shows the log | this plan; Codex R3 #6 | RESOLVED |
| K20 | Redirect policy | every provider: HTTPS only, ≤ 5 hops, `Authorization`/`Cookie`/`Private-Token`/`Job-Token`/provider credential headers stripped on any origin change and never restored; GitHub expired link → one fresh 302 | [FACT: BRIEF.md:73; Codex #6] | RESOLVED |
| K21 | Required-checks cache | L1, `required:<repoKey>:<branch>`, 1 h | design choice (changes rarely, ideas.md:100) | RESOLVED |
| K22 | Default branch source | `origin/HEAD` symbolic ref and its tip, read on demand for every comparison, never cached; missing = "unknown" | BRIEF.md:22, :34; Codex R2 #18 | RESOLVED |
| K23 | "usually" source | GitHub: latest successful run with the same `workflowId` on the same branch whose `created_at` is before the selected run's; GitLab: latest successful pipeline on the same ref created before the selected one, queried with `created_before` and `order_by=id&sort=desc` [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/]; Bitbucket Cloud: latest successful pipeline on the same ref created before the selected one; job usual = that baseline's job with the same logical id (unique match only); none = `null` → "usually: unknown"; cache `usual:<repoKey>:<selectedRunId>` → `{baselineRunId, runMs, jobMs}`, L1 + 24 h persisted (a baseline is complete and immutable) | BRIEF.md:21; #21; Codex R2 #19 | RESOLVED |
| K24 | Bisect and changed-since-green input | loaded commits with parent links; first-parent walk inside the loaded set; non-linear selection → `linear: false`, no `brokeAt`; changed-since-green requests and replies carry the selected job's `logicalCheckId` and `scopeName`, and the ancestor lookup matches by them (§14) | BRIEF.md:26; #19; Codex R3 #12 | RESOLVED |
| K25 | Cancel confirmation | inline webview confirm, not a native modal | e2e visibility | RESOLVED |
| K26 | HEAD monitor schedule | pending ladder, then every 120 s until complete (settlement `settled`) with no action fence, while HEAD is unchanged; a fenced HEAD keeps this schedule after `complete`; settlement `unknown` keeps polling and never toasts; paused during cooldown; no per-hash cap; 36 snapshot fetches per incomplete hour; detail also fetched for a complete failing HEAD on first load and once on pending→settled, after the detail key's `invalidate` | #18, #34; Codex R2 #15; Codex R3 #3, #5, #9 | RESOLVED |
| K27 | Pending-observed set | `workspaceState["intelligit.ci.pendingObserved.v1"]`: `{repoKey, hash, observedAt}[]`; entry removed when its toast is claimed (or the claim exists) or after 7 days | #16 | RESOLVED |
| K28 | Annotation placement rule | §11 path and range validation; rejected ones counted, valid ones kept | #8 | RESOLVED |
| K29 | Shared module | `src/shared/ci/` (no `vscode`, no Node built-ins) + types in `src/types.ts` | [CODE: .dependency-cruiser.cjs:24-33, :59-70]; #24 | RESOLVED |
| K30 | Action fence | `workspaceState["intelligit.ci.actionFences.v1"]`: `{repoKey, hash, provider, action, targetId, runId, at, before, evidence}[]`; written and awaited before the request; `evidence` = the provider's rule, stored with the fence (`runAttempt` GitHub, `newerJobSameLogicalId` GitLab job retry, `newerJobInPipeline` GitLab pipeline retry, `cancelled` cancel); ended only by that evidence (§3 step 4), a definite failure, or the user's Refresh on a "not seen yet" target; never deleted by age; while present, results for the hash are L1 only with the pending TTL, checked inside the persistent store's `enqueue`, and the hash polls on the pending ladder whatever its execution state; "waiting" label, then "not seen yet — Refresh" at 10 min by a timer re-armed from the stored time; survives restart; built in Phase 19 | Codex R2 #2; Codex R3 #1, #4, #5, #13 | RESOLVED |
| K31 | Diagnostic trace | `LogOutputChannel` "IntelliGit CI", fields in §16, no secrets, no URLs with query strings, no log text | #35 | RESOLVED |
| K32 | Detail contract version | `CI_DETAIL_CONTRACT_VERSION` in `src/shared/ci/contractVersion.ts`, starts at 1, bumped by every phase that changes persisted detail fields (2, 3, 7, 9, 10, 12, 14, 17, 18) | #9; Codex R2 #16 | RESOLVED |
| K33 | Continuation-URL guard | `paginate` takes `allowNext(url)` per provider: parses, `https:`, same host and port as the configured API base, path under the first request's API prefix; rejected → stop paging, `coverage: {reason: "rejectedNext", shown}`, no request sent; generalises `normalizeBitbucketCloudNextUrl` | Codex R2 #4; [CODE: bitbucketCloudProvider.ts:229-241] | RESOLVED |
| K34 | Coverage | `CiCoverage = "full" \| {reason: "pageBound" \| "rejectedNext"; shown}` on the run list, each run's jobs, each attempt history, each annotation set and the flat `otherChecks` list (`otherChecksCoverage`, set by the Bitbucket Server builds reader); separate from `complete`; banners read it; a detail that is not fully covered is never persisted; a non-full `runsCoverage` or `otherChecksCoverage` makes settlement `unknown` | Codex R2 #7; Codex R3 #9, #10 | RESOLVED |
| K35 | Logical check identity | `logicalCheckId` (§9): `job` + workflow + job (GitHub), `job` + pipeline name + job (GitLab), `job` + pipeline name + step (Bitbucket Cloud), `status` + check name (flat checks); used across commits; execution ids only for dedup inside one commit; unique-name fallback only when the name is unique in both the current and the parent populations within the scope, else `unknown`; attempt histories keyed by `(runId, logicalId)` | Codex R2 #13, #14; Codex R3 #11 | RESOLVED |
| K36 | Page size | `per_page=100` (Bitbucket Cloud `pagelen=100`) on every bounded collection, listed in §3 | Codex R2 #9 | RESOLVED |
| O1 | Pagination bound per collection | 10 pages × 100 = 1 000 items per collection (runs, jobs, pipelines, steps, annotations, attempts); reaching it shows "Showing the first 1 000 … — open in browser"; on a failed run, failed jobs and steps past the bound are still fetched and listed (§3) | Codex #12, #30; Root triage #30 | **RESOLVED** — owner took the bound plus "failed jobs always kept", 2026-11-07 |
| O2 | Per-log size bound | 50 MB per log; the log text ends with a truncation line and the detail shows Open in browser | Codex #30; Root triage #30 | **RESOLVED** — owner took 50 MB, 2026-11-07 |
| O3 | Flaky fallback where attempts are unavailable | providers without `attemptHistory` (Bitbucket Cloud, Bitbucket Server, or a GitHub/GitLab parameter that turns out not to exist) count only isolated reds over loaded commits; the tag adds "(estimated)" and the tooltip says "estimated from loaded commits; re-runs not counted for this provider" | Codex #30; Root triage #30 | **RESOLVED** — owner took the estimated fallback, 2026-11-07 |
| C1 | GitHub annotations: token types and 403 wording | docs name Checks read for GitHub App tokens and `repo` for OAuth/classic tokens on private repos; IntelliGit documents classic `repo` (its token is VS Code's GitHub session); a 403 shows "Annotations unavailable with this token" in the tab and Problems stays empty | [FACT: GitHub annotations docs per Codex #33; BRIEF.md:72] | **RESOLVED** — owner took the rule, 2026-11-07 (wording of the source corrected after Codex #33) |
| C2 | GitHub required checks: classic protection vs rules API | union of both (§7); protection 403 → "partial"/"unknown" per check | BRIEF.md:75 | **RESOLVED** — owner took the union, 2026-11-07 |
| C3 | Bitbucket Cloud: `pipeline` scope | never ask up front; a 403 on pipeline discovery or on steps keeps the flat list with "Steps need the `pipeline` scope"; `docs/commit-checks/README.md` gains a section on adding `pipeline` (read) and `pipeline:write` (cancel) | BRIEF.md:84-85; PLAN-REVIEW-LOG.md:4 | **RESOLVED** — owner took the hint plus the README section, 2026-11-07 |
| C4 | Bitbucket Server endpoint fallback rule | try `/rest/api/latest/.../builds`; on 404 or 405 fall back to `/rest/build-status/1.0/commits/{id}` and memoise "legacy" per host for the session; 401/403 do not fall back | BRIEF.md:88-89 | **RESOLVED** — owner took the rule, 2026-11-07 |

### Choices

- **Completion separate from outcome, applied to the existing snapshot path too** (#1). Chosen: `complete` drives freshness, persistence, polling and the toast for both snapshots and details. Rejected: fixing only the new detail path. The HEAD monitor and the history join read snapshots, so they would inherit the premature settlement from `aggregateState` [CODE: normalize.ts:39-42]. Cost: the row badge changes behaviour (it keeps polling a red commit that still has running jobs); that is a user-visible fix with its own CHANGELOG line.
- **Coverage separate from completion** (R2 #7). Chosen: a `coverage` field on every bounded collection; only complete and fully covered details are persisted. Rejected: one `incomplete` flag on runs, which let a truncated but finished tree enter the 24 h cache as if it were whole. Cost: a run with more than 1 000 jobs is fetched again after every restart.
- **Overflow scan kept in memory and resumable** (R2 #8). Chosen: cursor and found items in the L1 detail entry, paused during cooldown, resumed with run-identity checks. Rejected: persisting the scan (a new persisted format for a rare case) and restarting the scan on every refresh (it could never reach later failures under a tight quota). Cost: a restart repeats the scan.
- **`CiState` kept separate from `CommitCheckState`.** Chosen: a job-level union with `queued` and `running`. Rejected: reusing `CommitCheckState` for jobs. It has a single `pending` (the timer needs `running`) and snapshot-only states (`none`, `unavailable`). Cost: one mapping function per provider.
- **Sibling `CommitCiDetailService` and `CiDetailPersistentCache` instead of making the existing classes generic.** Chosen: siblings with the same L1, in-flight, generation, fence and persistence logic. Rejected: generalising `CommitChecksService<T>` and `CommitChecksPersistentCache<T>`. That would move the persisted snapshot path for a single new consumer. Cost: duplicated cache logic; the Phase 1 tests mirror the existing service's generation and in-flight tests so drift shows up.
- **Per-key fence plus durable delete, not "force" alone** (#2). Rejected: relying on `force: true`, which joins an in-flight pre-action fetch [CODE: service.ts getOrFetch] and leaves the old settled entry in the persistent store because pending results never overwrite it [CODE: persistentCache.ts set].
- **Durable action fence written before the request** (R2 #2). Chosen: a `workspaceState` record per target, written before sending, ended only by evidence that the action took effect (a provider-specific rule stored with the fence, Codex R3 #4) or by the user's Refresh on a "not seen yet" target, visible as "waiting" and then "not seen yet". Rejected: the Round 1 settle window (in memory, started after the awaited invalidation, silently gone after 120 s or a restart, so an old failed result could be cached again). Rejected: deleting fences by age (Codex R3 #1: an expired fence lets the pre-action result become permanent with no evidence that the action happened). Cost: a re-run the provider never shows keeps that hash uncacheable and polled on the pending ladder until a fetch shows it or the user clicks Refresh on the "not seen yet" label.
- **`clear()` inside the store's queue** (R2 #3). Rejected: leaving `clear()` outside `enqueue` [CODE: persistentCache.ts:117-119], which lets a queued old `set` land after it.
- **Capabilities attached at read time** (#9). Rejected: persisting them inside the detail. A cached detail from an earlier release would show old flags for 24 h.
- **New response-metadata fetch type beside `FetchJson`** (#13). Rejected: changing `FetchJson` to return headers. Every existing provider and test uses it; a sibling type keeps the snapshot path untouched.
- **Continuation guard inside `paginate`** (R2 #4). Chosen: a required `allowNext` argument, so no provider can page without one. Rejected: trusting provider next links (a hostile or misconfigured link would receive the token) and per-provider checks outside the paginator (easy to forget for a new collection).
- **Shared module at `src/shared/ci/`** (#24). Rejected: `src/services/commitChecks/` (the webview may not import it [CODE: .dependency-cruiser.cjs:24-33]) and `src/utils/` (not forbidden, but host utilities there may import Node; a dedicated directory makes the "no `vscode`, no Node" rule easy to see and to check).
- **Capabilities as booleans flipped by the phase that implements them.** Rejected: declaring the final table in Phase 1. That shows dead buttons in the phases between.
- **Host-side HEAD monitor with an open-ended 120 s tail** (#18). Rejected: the webview ladder, which stops after eight rungs and only runs while the Git Log is open. Rejected: a fixed overall cap, which would stop watching ordinary long builds. Cost: a stuck queued job is polled every 120 s for as long as HEAD stays on it; ETag makes that free on GitHub, and cooldown pauses it.
- **Toast scope: per machine, focused window, atomic `mkdir` claim** (#5, R2 #1). Chosen: one claim directory per `{repoKey, hash}` under `globalStorageUri`. Rejected: the Round 1 read/write/re-read tombstone list in `globalState`, which two windows can both pass during a focus change. Rejected: per-window `workspaceState` (two windows would both toast). Rejected: exclusive file create (Windows answers EPERM). Rejected: pruning old claims (Codex R3 #2: a sweeper can delete a claim another window has just created, allowing a second toast). Cost: one empty directory per toasted hash, never removed.
- **Poll intervals unchanged after ETag.** Rejected: shortening GitHub polls to 10 s (ideas.md:145). No source of truth sets a shorter interval, and 304s save the budget at the existing pace.
- **Logs in a per-window memory store plus a content provider** (owner path C; R2 #5, #6, #10, #11). Chosen: an LRU of three logs per window, served through `intelligit-ci-log:`. Rejected: the Round 1 shared on-disk store under `globalStorageUri` (it needed a cross-process lock, space reservations, cross-window eviction coordination and orphan cleanup, the source of four Round 2 findings). Rejected: opening a saved file directly (editable, shows a storage path). Cost: a log is downloaded again after a reload, a restart, or eviction from the LRU; up to about 150 MB per window in the store (Risks).
- **A restored log tab after a reload shows a "no longer loaded" line** [PROPOSED]. Rejected: putting run, job and provider ids in the URI and downloading on restore, which sends unprompted requests at startup for every restored tab. Within one window a reopened tab does download again, from the `sources` record.
- **Separate preview request** (R2 #17). Chosen: `previewCiLog` fills the store and returns only the excerpt, so the inline excerpt appears on selection as the design shows. Rejected: returning the excerpt only from `openCiLog`, which opens an editor first.
- **Excerpt kept, escaped** (#7). Chosen per Root's triage and BRIEF.md:16: the approved design shows an excerpt. Rejected: Codex's "remove excerpts", because it drops an approved design element.
- **History join by logical identity, then unique name** (#15, R2 #13). Rejected: name only (a status named like a job hides it; same-named jobs in two workflows attach the wrong history). Rejected: execution ids across commits (they name one execution, so a normal parent never matches). Cost: more "unknown" tags where a provider's snapshot lacks the workflow name.
- **Attempt histories per run and logical job** (R2 #14). Rejected: keying by check name and de-duplicating by attempt number, which merges two workflows' same-named jobs into one false flaky history.
- **Comparisons from the per-row snapshots.** Rejected: fetching job detail for parents and the default tip. Snapshots are already fetched for every visible row (ideas.md:117-118). Cost: the join is approximate, which is why "unknown" exists.
- **Default-branch tip read on demand** (R2 #18). Rejected: caching it per lifecycle generation, which an ordinary `git fetch` makes stale.
- **Required checks against the default branch.** Rejected: "the commit's branch". Protection guards merges into the target branch. Cost: a commit aimed at another base shows the default branch's rules; the header names the branch.
- **Bitbucket Cloud has no "Re-run failed".** Its only rerun is "run a new pipeline" (ideas.md:87). `rerunFailed` and `rerunJob` stay false; a "Run pipeline again" button is not in the locked list.
- **A diagnostic trace channel** (#35). It is not the rejected "Output channel for logs": it carries one token-free line per operation, never CI log text.

### Hardcoded vs dynamic (standing rule)

| Read at run time from its source | Plain design constants (deliberate choices) |
|---|---|
| rate limits and cooldown end (headers, existing gate), ETags, "usually" (previous run), default branch and its tip (`origin/HEAD`, every comparison), required checks (provider), bisect cap (loaded rows), job/step times (provider), capabilities (installed provider, read time), first-error marker (provider declaration with fixture), next-page links (response headers or body), API base and prefix for the continuation guard (provider ref and `intelligit.commitChecks.hosts`), pending TTLs (one options object in `repositoryMode.ts`) | poll ladder (existing), 120 s monitor tail, 1.5× overdue (locked by the brief), per-log bound (O2, 50 MB), `MAX_CI_LOGS_IN_MEMORY = 3`, excerpt cap, cache sizes, 1 s tick, required-checks TTL, pending-observed age, action-fence "not seen" delay (10 min), page size (100), column width (Figma), page bound (O1) |

Every dynamic value that is missing renders "unknown", "—" or nothing, never a guessed value.

## Safety, migrations and rollout

**Invariants and the tests that go red:**

1. **Nothing is final while work is running.** Test: `serviceCompletion.test.ts` › "failed plus running item uses the pending TTL and is not persisted"; `headStatus.test.ts` › "failed plus running job keeps polling and does not toast". Mutation: make completion read only `state !== "pending"` → both red.
2. **A re-run never shows the pre-re-run result again, across restarts.** Test: `serviceCompletion.test.ts` › "a fetch started before invalidate is not cached", "force after invalidate does not join the pre-invalidate fetch", "invalidate deletes the persisted entry (new service over the same Memento misses)"; `ciActionFence.test.ts` › "a fenced key is never persisted, even complete", "a set queued before the fence but run after it is refused", "fence survives a new instance over the same workspaceState"; `ciActions.test.ts` › "fence written before the POST", "re-run on a cached failed commit never shows the old result again", "restart while waiting shows waiting, never the old failure". Mutations: drop the per-key generation check; keep the in-flight entry; skip the persistent delete; check the fence at enqueue time instead of inside the callback; keep fences in memory only; write the fence after the POST → each red.
3. **Only an excerpt reaches the webview, and it is inert text.** Test: `excerpt.test.ts` › "caps at 40 lines and 8 KB for a 30 MB log", "strips ANSI", "replaces bidi controls", "HTML stays text"; `commitChecksTab.integration.test.tsx` › "excerpt with <img onerror> renders as text". Mutations: remove the cap; skip `sanitizeExcerpt`; render with `dangerouslySetInnerHTML` → red.
4. **Credentials never cross an origin.** Test: `redirects.test.ts` › "strips Authorization on origin change", "strips on a chained redirect that returns to the first origin", "refuses http: target", "stops after 5 hops"; `githubJobLog.test.ts` › "redirect download carries no Authorization"; `bitbucketCloudDetail.test.ts` › "307 log redirect carries no Authorization". Mutation: forward headers; compare host only (ignore port); allow `http:` → red.
5. **The log content provider serves only a 64-hex key from the store.** Test: `ciLogDocument.test.ts` › "rejects ../ and non-hex keys". Mutation: drop the regex → red.
6. **Logs never touch the file system, and a window holds at most three.** Test: `ciLogMemoryStore.test.ts` › "LRU evicts the least-recent of 4", "store module imports no fs". Mutations: raise the cap to 4 or evict the most recent → red; import `node:fs` in the store → red.
7. **The byte bound holds for any response size.** Test: `ciLogMemoryStore.test.ts` › "known-length 300 MB response truncates at 50 MB with one marker", "unknown-length stream truncates at 50 MB with one marker". Mutations: refuse when `Content-Length` exceeds the bound → red; append the marker per chunk or not at all → red.
8. **Replies render only for the newest request in the current repository.** Test: `commitChecksTab.integration.test.tsx` › "A→B→A drops the first A reply", "same-hash out-of-order refresh keeps the newest", "same SHA in another repository is not reused", "a preview reply for a job no longer selected is dropped". Mutations: compare `requestId` with `<` instead of `===` newest; drop the `repoKey` check; drop the hash check; drop the `selectionToken` check → each red.
9. **Nothing publishes after sign-out, disable or repository change.** Test: `ciGenerations.test.ts`; `ciDiagnostics.test.ts` › "sign-out during the annotations fetch publishes nothing", "disable during the fetch publishes nothing". Mutation: remove the post-await `isCurrent` check → red.
10. **Once per hash per machine.** Test: `headStatus.test.ts` › "toasts once per hash across a simulated reload", "settles during the restart gap → one toast", "two hosts, one toast", "both pass the focus check, one mkdir wins", "claim taken before toast". Mutations: replace the non-recursive `mkdir` with an exists check plus `mkdir({recursive: true})`; show the toast before the claim; claim in `workspaceState` → red.
11. **Diagnostics never outlive HEAD and never point outside the repository.** Test: `ciDiagnostics.test.ts` › "clears on HEAD move", "discards a result that lands after HEAD moved", "rejects absolute, traversal, drive-letter and symlink-escape paths but keeps valid ones", "rejects end < start and non-integer lines". Mutations: remove the HEAD re-check; skip `realpath` containment; drop the traversal check → red.
12. **No UI branch on provider id.** Test: the ESLint rule or the scan test from §1. Mutation: add `provider === "github"` in a webview file → red.
13. **Webview code imports no host module.** Check: `bun run architecture:check`. Mutation: import `src/services/commitChecks/…` from a webview file → red.
14. **Background requests stay within the stated budget.** Test: `headStatus.test.ts` › "exactly 36 snapshot fetches in one incomplete hour", "zero requests when commitChecks.enabled is false", "zero requests during cooldown". Mutations: drop the 120 s tail floor (poll at 3 s) → red; poll when disabled → red.
15. **Write actions are never sent without a click.** Test: `ciActions.test.ts` › "no POST without runCiAction". Mutation: auto-retry a forbidden action → red.
16. **Failed fetches do not auto-retry** (existing). Test: `pollSchedule.test.ts` › "unavailable gets no schedule". Mutation: return the pending ladder for unavailable → red.
17. **Cancelled bisect sends no further request.** Test: `ciBisect.test.ts` › "cancel with all four gate slots busy sends nothing more". Mutation: remove the check inside the gated callback → red.
18. **Traces carry no secrets.** Test: `ciTrace.test.ts` › "no Authorization value, no query string, no log text". Mutation: log the full URL → red.
19. **Continuation links never carry credentials off the API.** Test: `paginate.test.ts` › "rejected next link stops paging, sends nothing and sets rejectedNext"; per provider › "hostile next link: http, other host, other port, other path prefix" (`githubDetail.test.ts`, `gitlabDetail.test.ts`, `bitbucketCloudDetail.test.ts`). Mutation: ignore `allowNext`; compare host only → red.
20. **Partially covered data is never cached as whole.** Test: `detailService.test.ts` › "pageBound detail is served from L1 but never persisted". Mutation: persist on `complete` alone → red.
21. **`clear()` cannot be overtaken by an old queued write.** Test: `persistentCache.completion.test.ts` › "generation change while an old set is queued → the old entry never reappears" (snapshot store and detail store). Mutation: run `clear()` outside `enqueue` → red.
22. **Failed items past the bound are kept through pause, failure and resume.** Test: `githubDetail.test.ts`, `gitlabDetail.test.ts`, `bitbucketCloudDetail.test.ts` › "failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor". Mutations: restart the scan from page 1 on resume; drop found items on a failed page → red.

**Migrations.**
- The snapshot persistent store keeps its key and `schemaVersion: 1`. Read-time eligibility now also requires completion, so incomplete `failure` entries written by older versions are ignored and refetched. `CommitCheckItem.id` and `logicalId` are optional and additive.
- New keys: `globalState["intelligit.commitChecks.detailCache.v1"]`, `globalState["intelligit.commitChecks.cache.v1.generation"]` and `globalState["intelligit.commitChecks.detailCache.v1.generation"]` (owner decision 2026-11-08: each holds a random clear generation for its store, written by `clear()`; data saved before this change has no generation and still matches; older versions ignore the keys), `workspaceState["intelligit.ci.pendingObserved.v1"]`, `workspaceState["intelligit.ci.actionFences.v1"]`, and claim directories under `<globalStorageUri>/ci-toast-claims/`. CI logs are never written to disk.
- Both persistent stores' payloads gain two optional fields: `generation` (the clear generation the entry was written under; another generation is a miss) and `unconfirmed` (key → random write id of a save not yet confirmed by its account check; an unconfirmed entry is never read). Payloads without them stay valid.

**External changes.**
- New settings K4-K7 in `package.json` `contributes.configuration`, with NLS entries in the file that holds the existing `%configuration.…%` keys [ASSUMED: `package.nls.json`; the keys are at package.json:1559-1614].
- Commands K8 go in `package.json` `contributes.commands` and `menus.commandPalette`.
- `docs/commit-checks/README.md` gains sections for the Checks tab, write actions and scopes (`#write-actions`), Bitbucket Cloud `pipeline` / `pipeline:write` (C3), logs (held in memory per window, three at a time, downloaded again after a reload), the status bar, the Problems panel (C1 wording) and the CI column.
- No new token scope is requested anywhere.

**Activation and deploy order.** Phases follow the dependency graph. Each phase ships behind its capability flags or settings, so a release cut between any two phases is coherent.

**Half-finished rollout.** If a phase halts, earlier phases are complete releases, because every phase bumps the version and the CHANGELOG. Recovery uses phase-run's handoff file, and nothing needs migrating back.

**Rollback** leaves behind the detail cache key and the two `.generation` keys (ignored by older versions [ASSUMED: older versions read only their own keys]), the pending-observed and action-fence keys (harmless), and the toast-claim directories (empty directories, a few bytes each, removed by uninstall with the rest of `globalStorageUri` [ASSUMED: VS Code deletes an extension's global storage on uninstall]). Rolling back past Phase 1 restores the old badge behaviour; snapshot entries written by the new version are valid for the old one (same shape, `id` and `logicalId` ignored).

**Failure-mode sweep:**
- **Data loss:** none. The plan writes only caches, an action-fence record, toast-claim directories and a pending-observed record.
- **Security:** redirect credential stripping for every provider (K20), the continuation-URL guard (K33), the log URI guard (K19), annotation path containment (K28), excerpt sanitising (K18), write actions only by click with an inline confirm for cancel, 403 explained and never escalated, no scope requested up front, token-free traces (K31).
- **Version compatibility:** contract-versioned detail cache (K32, bumped by Phase 14 too), capabilities never persisted, old snapshots stay valid, Bitbucket Server legacy fallback (C4).
- **Races and concurrent writers:** per-key fence (§3), `clear()` inside the store queue (§3), the action fence checked inside the persistent store's queue (§3), generations (§4), newest-request and selection-token rendering (§4), the atomic toast claim with the focused-window rule (§10), the in-window log join map (§5), bisect cancellation inside the gate (§13), and the persistent stores' `enqueue` chains. Logs are per window, so no cross-window log race exists.
- **Multi-window scope of the persistent caches (owner decision 2026-11-08):** the guarantee is (a) a `clear()` in any window keeps every save started before it, in that window or another, from being readable afterwards, and (b) a save its account check rejects is never readable. Guarantee (a) also covers each window's in-memory cache and in-flight fetches (owner decision 2026-11-08, fourth halt): once a window can see the new clear generation, neither `service.ts` nor `detailService.ts` in that window serves an in-memory entry or publishes a fetch result from before that clear; two-service tests on shared storage prove it. Finer cross-window orderings (for example two windows saving one key in the same instant, or VS Code's own delay in passing globalState between windows) are out of scope: a review finding there is recorded under the handoff's Open risks and is not a blocker. Every entry is keyed by account, so no out-of-scope ordering can show another account's data.
- **Partial failure and crash halfway:** the overflow scan keeps its found items and cursor; an `uncertain` write keeps the fence and refetches; the fence survives a restart; at-most-once toast; an interrupted log download stores nothing.
- **Deployment order:** above.
- **The user's experience during each failure:** the Failure and recovery table.

## Edge cases and acceptance evidence

| Criterion / edge case | Test | Layer | Mutation that turns it red |
|---|---|---|---|
| Failed job + running job: not complete, keeps polling, not persisted, no toast | `completion.test.ts` › "failure with a pending item is not complete"; `serviceCompletion.test.ts`; `checksRefresh.test.ts` › "incomplete failure keeps the ladder"; `headStatus.test.ts` | unit | completion from `state` only |
| Tree groups GitHub runs → jobs → steps; failed jobs expanded to the failing step | `githubDetail.test.ts` › "maps runs, jobs, steps"; `commitChecksTab.integration.test.tsx` › "expands failed job to failing step" | unit, integration (jsdom) | map `conclusion: failure` to `success`; drop the auto-expand |
| Page 2 or the final page fails → unavailable, not a partial tree | `githubDetail.test.ts` › "second page fails → unavailable", "final page fails → unavailable"; `gitlabDetail.test.ts` same | unit | return the pages read so far |
| Page bound reached → visible coverage note, exactly 1 000 kept | `paginate.test.ts` › "stops at maxPages and sets pageBound coverage"; `githubDetail.test.ts`, `gitlabDetail.test.ts`, `bitbucketCloudDetail.test.ts` › "1 001+ items: 1 000 kept, coverage pageBound shown 1000"; `commitChecksTab.integration.test.tsx` › "partial coverage shows the open-in-browser note" | unit, integration | drop the coverage; omit `per_page=100` (fixture serves the default page size, count ≠ 1 000) |
| Failed jobs past the 1 000 cutoff are listed (O1, R2 #20) | `githubDetail.test.ts` › "failed jobs at positions 1 050 and 1 900 are listed"; `gitlabDetail.test.ts` › "scope[]=failed filtered pages add failed jobs past the bound without duplicates"; `bitbucketCloudDetail.test.ts` › "failed steps past the bound are listed"; `commitChecksTab.integration.test.tsx` › "failed jobs past the first 1 000 are listed" | unit, integration | stop at 1 000; skip the overflow scan; dedup by name |
| Overflow scan: interruption, cooldown pause, resume (R2 #8, #20) | provider tests › "failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", "run attempt changed → scan restarts"; `commitChecksTab.integration.test.tsx` › "overflow scan paused shows the paused note"; `detailService.test.ts` › "scan detail is never persisted" | unit, integration | restart from page 1; queue during cooldown; persist the scan detail |
| Hostile next link (R2 #4) | `paginate.test.ts`; provider tests › "hostile next link: http, other host, other port, other path prefix" | unit | ignore `allowNext` |
| Every bounded request asks for 100 (R2 #9) | provider tests › "requests carry per_page=100" / "pagelen=100" (assert the URL of every bounded request) | unit | drop the parameter |
| Status named like a job is not hidden; third-party check with a job's name stays | `githubDetail.test.ts` › "dedup by check-run id, not name" | unit | dedup by name |
| Null step times render "—" | `githubDetail.test.ts` › "null started_at stays undefined" | unit | default a missing time to `Date.now()` |
| Capabilities from the installed provider, not the cache | `detailService.test.ts` › "served capabilities follow the provider, persisted JSON has none" | unit | persist capabilities |
| Contract version mismatch is a miss | `detailService.test.ts` › "persisted contractVersion ≠ current is a miss" | unit | skip the version check |
| `clear()` vs an old queued write (R2 #3) | `persistentCache.completion.test.ts` › "generation change while an old set is queued → the old entry never reappears" | unit | `clear()` outside `enqueue` |
| Rapid switching, A→B→A, same-hash refresh, same SHA other repo | `commitChecksTab.integration.test.tsx` (four tests, §4) | integration | `<` instead of newest; drop repoKey check; drop hash check |
| Floor provider: no empty sections, no dead buttons | `commitChecksTab.integration.test.tsx` › "floor provider renders flat list without dead controls" | integration | render the Logs section regardless of `capabilities.logs` |
| Signed out / unavailable / cooldown inside the tab | `commitChecksTab.integration.test.tsx` › "renders signed-out, unavailable and cooldown states" | integration | remove the `signInHost` branch |
| Status bar counts and elapsed | `headStatus.test.ts` › "formats counts and elapsed" | unit | swap the failed and pending counts |
| Long build watched to the end; paused in cooldown | `headStatus.test.ts` › "keeps polling every 120 s past the ladder until complete", "pauses during cooldown and shows paused" | unit | stop after the ladder; poll during cooldown |
| Settled failing HEAD has its detail (R2 #15) | `headStatus.test.ts` › "settled failing HEAD on first load fetches detail", "pending→settled fetches detail once more before stopping" | unit | fetch detail only while incomplete |
| Once per hash, reload, restart gap, two hosts, focus interleaving (R2 #1) | `headStatus.test.ts` (invariant 10 tests, real temp directory for the claims) | unit | see invariant 10 |
| Toast claims are never pruned and have no count cap (K13, Codex R3 #2) | `headStatus.test.ts` › "claims are never pruned and have no count cap" (250 claims, one with a 400-day-old mtime, all present after a new activation) | unit | cap at 200; remove claims by age at activation |
| Settlement detail never joins pre-settlement work (Codex R3 #3) | `headStatus.test.ts` › "settlement detail comes from a request started after settlement" | unit | drop the `invalidate` before the forced fetch |
| Coverage not full → settlement unknown (Codex R3 #9) | `completion.test.ts` › "settlementOf is unknown when runsCoverage is pageBound even if every returned item finished"; `headStatus.test.ts` › "a running execution past the run bound keeps polling and sends no toast" | unit | compute settlement from the returned items only |
| Flat list past the reader's bound (Codex R3 #10) | `bitbucketServerBuilds.test.ts` › "builds past the five-page reader set pageBound, are not persisted and show the banner" | unit, integration | report `"full"` for the truncated list |
| Fence: no age expiry, provider evidence, fence-driven polling (Codex R3 #1, #4, #5) | `ciActionFence.test.ts` › "reopen after 8 days with the provider still returning the old execution: fence kept, result not persisted", "GitLab job retry: a newer job id with the same logical id in the same pipeline ends the fence, even when that job already finished", "notSeen switches at 10 min by timer with no fetch", "timer re-armed after restart from the stored time"; `ciActions.test.ts` › "GitLab retry finishing before the next poll resolves the fence"; `commitChecksActions.integration.test.tsx` › "a fenced complete detail keeps polling on the pending ladder"; `headStatus.test.ts` › "fenced HEAD keeps polling after complete, across restart and cooldown" | unit, integration | delete fences by age; watch the old GitLab job id; compute notSeen only on a fetch; stop polling when complete |
| Placeholder tab replaced after a load (Codex R3 #6) | `ciLogDocument.test.ts` › "a load that replaces placeholder text fires onDidChange for that URI"; `ciLogPreview.test.ts` › "reload → placeholder tab → Open full log → tab shows the real text" | unit | skip `onDidChange` |
| ETag 304 keeps pagination (Codex R3 #7) | `httpEtag.test.ts` › "multi-page 200 then header-minimal 304 → coverage unchanged" | unit | store only body and etag |
| Gate error after acquisition pauses the scan (Codex R3 #8) | `githubDetail.test.ts` › "cooldown that begins after the precheck pauses the scan and keeps the cursor" | unit | classify the gate error as a page failure |
| Name fallback unique on both sides (Codex R3 #11) | `ciHistory.test.ts` › "two current workflows with the same job name against one parent job → unknown" | unit | check uniqueness in the parent only |
| Changed since green by logical identity (Codex R3 #12) | `changedSinceGreen.test.ts` › "same job name in two workflows with different last-green commits" | unit | match ancestors by `checkName` |
| Log larger than the webview message limit; excerpt sanitised | `ciLogMemoryStore.test.ts` › "30 MB log is stored and only the excerpt is returned"; `excerpt.test.ts` | unit | post the full text; skip sanitising |
| Byte bound on known-length 300 MB and unknown-length streams (O2, K17) | `ciLogMemoryStore.test.ts` (invariant 7 tests) | unit | refuse on `Content-Length`; marker per chunk |
| LRU of three; join map; evicted log downloads again; no `fs` | `ciLogMemoryStore.test.ts` › "LRU evicts the least-recent of 4", "two concurrent opens make one request", "a reopened evicted log triggers a new download", "store module imports no fs" | unit | cap 4; no join map (2 fetch calls); serve a stale entry; import `node:fs` |
| Content provider miss: same window downloads again, after reload shows the line | `ciLogDocument.test.ts` › "miss with a source downloads again", "miss without a source returns the no-longer-loaded line and sends nothing" | unit | return empty text; download without a source |
| Open log tab keeps its text after eviction | `ciLogEditor.spec.ts` › "first tab keeps its text after a fourth log is opened" | e2e (CI) | n/a (checks the VS Code assumption in §5) |
| Preview on selection; stale selection dropped (R2 #17) | `commitChecksTab.integration.test.tsx` › "selecting a failed job shows the excerpt without opening an editor", "a preview reply for a job no longer selected is dropped"; `ciLogPreview.test.ts` › "preview opens no editor" | integration, unit | excerpt only from `openCiLog`; drop the `selectionToken` check; call `showTextDocument` in preview |
| Expired GitHub link → one re-fetch | `githubJobLog.test.ts` › "403 on redirect target re-requests 302 once" | unit | no retry, or unbounded (asserts exactly 2 calls) |
| Redirect chains strip credentials (all providers) | `redirects.test.ts` | unit | forward headers |
| Log opens at first error line | `firstErrorLine.test.ts` › "first error line from GitHub and GitLab fixtures" | unit | always return line 0 |
| Read-only token → 403 explained, nothing else breaks | `ciActions.test.ts` › "GitLab 403 maps to forbidden with scope help", "forbidden removes the fence"; `commitChecksActions.integration.test.tsx` › "forbidden keeps the tree" | unit, integration | map 403 to `failed`; keep the fence on 403 |
| Re-run on a cached failed commit; restart while waiting (R2 #2) | invariant 2 tests | unit | see invariant 2 |
| Waiting and not-seen labels (R2 #2) | `ciActionFence.test.ts` › "after 10 min reports notSeen and stays"; `commitChecksActions.integration.test.tsx` › "shows waiting for re-run to start", "shows re-run not seen yet after 10 min" | unit, integration | delete the fence after 10 min; hide the label |
| Cancel → confirm → cancelled | `commitChecksActions.integration.test.tsx` › "cancel needs confirm, then refreshes" | integration | send on first click |
| Required endpoint 403 → "required: unknown" | `requiredChecks.test.ts` › "403 on protection yields unknown" | unit | treat 403 as "no required checks" |
| "Branch not protected" 404 stays known | `requiredChecks.test.ts` › "404 not protected is known-empty" | unit | treat every 404 as unknown |
| GitLab `allow_failure` → optional | `gitlabDetail.test.ts` › "allow_failure marks optional" | unit | ignore the field |
| usually / overdue / unknown; baseline before the selected run | `ciTiming.test.ts` › "overdue past 1.5×", "no previous run → null", "baseline excludes the selected and newer runs", "cache keyed by selected run" | unit | use `>= 1.0×`; return 0; drop the `created` filter; key by branch only |
| GitLab baseline by creation time (R2 #19) | `ciTiming.test.ts` › "earlier-created pipeline updated after the selected run began is the baseline" | unit | filter by `updated_before` without the client-side `created_at` check |
| new / still / fixed / unknown; duplicate names → unknown | `ciHistory.test.ts` › four cases + "renamed matrix job → unknown" + "two parent items with the same name → unknown" | unit | default a missing parent to `new`; take the first name match |
| Cross-commit match by logical identity (R2 #13) | `ciHistory.test.ts` › "execution ids differ across commits, logical id matches", "same job name in two workflows matched by workflow" | unit | join by execution id; join by job name only |
| also red on main; `origin/HEAD` missing; moving tip (R2 #18) | `ciHistory.test.ts` › "also red on default tip"; `defaultBranch.test.ts` › "missing origin/HEAD → null", "a remote tip that moves between two comparisons is read fresh" | unit | fall back to `"main"`; cache the tip |
| Flaky n/m; double-counted commit counts once; O3 fallback flagged | `ciHistory.test.ts` › "isolated red counts, run of reds does not", "same-commit fail-then-pass counts", "a commit meeting both rules counts once", "no attempt history → attemptsCounted false" | unit | count every red; sum both rules; drop the flag |
| Attempt histories with colliding names and attempt numbers (R2 #14) | `ciHistory.test.ts` › "same-named jobs in two workflows keep separate histories", "colliding attempt numbers in two runs do not merge", "GitLab retried jobs ordered by created_at" | unit | key by check name; dedup by attempt number; sort GitLab by id only |
| Changed since last green inside the loaded first-parent line | `changedSinceGreen.test.ts` › "lists diff from last green", "no green → null, no files", "stops at the first commit outside the loaded set", "never hits the network" | unit (real temp git repo) | walk with `rev-list` unbounded; use `getChecks` |
| Two-revision diff for add, delete, rename, odd names | `changedSinceGreen.test.ts` › "add/delete/rename map to the right sides", "names with space, tab, newline, #, ?, leading -" ; `ciChangedSinceGreen.spec.ts` | unit, e2e (CI) | diff against the parent; split on newline instead of NUL |
| Diagnostics placement and lifetime | `ciDiagnostics.test.ts` (invariant 11 tests) | unit | see invariant 11 |
| Pre-Phase-14 cached detail upgrades (R2 #16) | `ciDiagnostics.test.ts` › "a settled detail cached before Phase 14 is a miss and annotations are fetched" | unit | skip the contract-version bump |
| Bisect through the gate, cancellable with busy slots, capped, non-linear | `ciBisect.test.ts` › "uses gate", "cancel with all four gate slots busy sends nothing more", "caps to loaded rows", "brokeAt only on a first-parent chain", "non-linear selection → linear false" | unit | bypass the gate; drop the in-callback check; drop the intersection; compute brokeAt over list order |
| ETag 304 reuses the body | `httpEtag.test.ts` › "304 returns stored body", "304 without stored body re-requests", "a new auth generation does not reuse the body" | unit | return an empty body on 304; key by URL only |
| CI column off = layout unchanged | `tests/e2e/gitLogLayout.spec.ts` (existing) and `ciColumn.spec.ts` on CI; `commitCiColumn.integration.test.tsx` | e2e (CI), integration | render the column regardless of the setting |
| Bitbucket Cloud 403 on discovery or steps → flat list + hint | `bitbucketCloudDetail.test.ts` › "403 on pipeline discovery keeps flat list with hint", "403 on steps keeps flat list with hint" | unit | return unavailable on the discovery 403 |
| Bitbucket Server legacy fallback and enriched flat checks | `bitbucketServerBuilds.test.ts` › "404 on latest → legacy, memoised", "403 does not fall back", "duration, required and usual survive into the detail" | unit | fall back on 403; build the detail through the all-false floor adapter |
| Traces are token-free | `ciTrace.test.ts` | unit | log the full URL |

## Phases

Every phase:
- bumps `package.json` `version`: minor for a user-visible feature, patch for invisible work or a fix. In a parallel wave, the merge step renumbers so that versions rise in merge order and every CHANGELOG entry is kept [PROPOSED];
- adds one user-friendly `CHANGELOG.md` entry under that version (project CLAUDE.md rules);
- ships its new strings with l10n in the same phase (Gate L);
- updates `docs/commit-checks/README.md` for what it adds;
- runs GitNexus impact analysis before editing any existing symbol and warns Root on HIGH/CRITICAL or UNKNOWN risk (project CLAUDE.md).

No phase has a real dev-server URL, so no phase has a browser check. Proof is unit and integration locally, and e2e on CI (Gate E).

**Owner answers.** O1, O2 and O3 were resolved by the owner on 2026-11-07, and path C (in-memory logs, K13 retention) on the same day; no phase waits on an owner answer.

### Phase 1 — Detail contracts, shared module, completion, settlement and coverage rules, per-key cache fence
- Scope: new `src/shared/ci/` (`capabilities.ts`, `pollSchedule.ts`, `completion.ts` with `isFullyCovered` and `settlementOf`, `identity.ts` with `logicalCheckId`, `contractVersion.ts`, `excerpt.ts` with `sanitizeExcerpt` only); `src/types.ts` (detail types §2 including `CiCoverage`, `CiFailedScan`, `otherChecksCoverage`, `logicalId`, `actionFence`; `CommitCheckItem.id?` and `logicalId?`); `src/services/commitChecks/types.ts` (provider `capabilities`, optional `getDetail`, optional `continueFailedScan`, `allowNext`); all four providers (capabilities object, all false); new `src/services/commitChecks/detailService.ts`, `detailPersistentCache.ts`, `ciGenerations.ts`, `ciTrace.ts`; `service.ts` (completion-aware freshness, per-key fence, `invalidate`); `persistentCache.ts` (completion-aware eligibility on `set` and read, `delete(key)` and `clear()` inside `enqueue`); `coordinator.ts` (`getDetail`, `invalidate(hash)`, floor detail); `src/activation/repositoryMode.ts` (construct the detail service and generations next to :256, one shared TTL options object; bump generations where `clear()` is called); `src/webviews/react/commit-list/checksRefresh.ts` (import the ladder from the shared module and re-export it; incomplete failure keeps the ladder); `eslint.config.*` (provider-id rule for `src/webviews/**`); tests; version; CHANGELOG; docs. No new UI. The durable action fence (`ciActionFence.ts`, K30, its tests) moved to Phase 19 (Codex R3 #13).
- Depends on: none; K1, K2, K9, K10, K11, K29, K31, K32, K34, K35 resolved.
- Build:
  1. Create `src/shared/ci/` files. Confirm `bun run typecheck:webview` and `bun run architecture:check` accept an import of them from `checksRefresh.ts` before moving anything else [ASSUMED: `tsconfig.webview.json` includes `src/shared/**`; if not, add it there in this phase].
  2. Add the §2 types and `CommitCheckItem.id?` / `logicalId?`. Give every provider a `capabilities` object with every flag false.
  3. Completion and coverage: implement `isCompleteSnapshot`, `settlementOf`, `isCompleteDetail` and `isFullyCovered` per §2 and §3 (non-full `runsCoverage` or `otherChecksCoverage` → settlement `unknown`, Codex R3 #9); change `service.ts` `isFresh` so a non-complete snapshot uses the pending TTL; change `persistentCache.ts` so `set` and `isUsable` require completion (plus today's `none` rule). Read `CommitList.tsx:511-569` and make the webview ladder continue for an incomplete `failure`.
  4. Fence: add `keyGeneration`, `invalidate(key)` and `delete(key)` as in §3; the in-flight check runs after the fence. Move `clear()` of both persistent stores inside `enqueue` (R2 #3).
  5. (Moved to Phase 19: the durable action fence, Codex R3 #13.)
  6. `CommitCiDetailService` + `CiDetailPersistentCache` with K9/K10 freshness, the per-key fence, the coverage and settlement rules, `contractVersion` check, and capabilities attached at read time (`actionFence` is attached from Phase 19). Floor detail for providers without `getDetail`.
  7. `CiGenerations` and the `isCurrent(ctx)` check; bump calls next to the existing `clear()` calls in `repositoryMode.ts` [ASSUMED: those calls live there; the builder follows `clear` callers with `find_referencing_symbols`].
  8. `ciTrace.ts` (§16). Search for an existing extension logger first and use it if one exists.
  9. Move the ladder constants and re-export them; keep `retryDelaysForCommitChecks` output identical for every existing input.
  10. Add the ESLint provider-id rule, or `tests/unit/webviews/noProviderBranches.test.ts` if the rule cannot be narrow.
- Tests:
  - `tests/unit/shared/ci/completion.test.ts` › "failure with a pending item is not complete" (mutation: `state !== "pending"` → red), "none and unavailable are not complete", "isFullyCovered is false when any run, jobs, attempt or otherChecks coverage is not full" (mutation: check only `runsCoverage` → red), "settlementOf is unknown when runsCoverage is pageBound even if every returned item finished", "settlementOf is unknown when otherChecksCoverage is pageBound" (mutation: ignore coverage → red; Codex R3 #9, #10).
  - `tests/unit/shared/ci/identity.test.ts` › "workflow and job form the GitHub logical id", "status checks are prefixed" (mutation: drop the workflow part → red).
  - `tests/unit/shared/ci/excerpt.test.ts` › "caps at 40 lines and 8 KB", "strips ANSI", "replaces bidi controls", "HTML stays text", "cuts on a UTF-8 boundary" (mutation per case: remove that step → red).
  - `tests/unit/services/commitChecks/serviceCompletion.test.ts` › "failed plus running item uses the pending TTL and is not persisted" (mutation: completion from state only → red), "a fetch started before invalidate is not cached" (mutation: drop the per-key generation check → red), "force after invalidate does not join the pre-invalidate fetch" (mutation: keep the in-flight entry → red, fetch spy called once), "invalidate deletes the persisted entry (new service over the same Memento misses)" (mutation: skip `delete` → red).
  - `tests/unit/services/commitChecks/persistentCache.completion.test.ts` › "incomplete failure is not stored", "an incomplete entry written by an older version is ignored", "delete runs inside the enqueue chain" (mutation: delete outside the chain → a concurrent `set` resurrects the entry → red), "generation change while an old set is queued → the old entry never reappears" for both stores (mutation: `clear()` outside `enqueue` → red).
  - `tests/unit/services/commitChecks/detailService.test.ts` › "complete detail served from L1 without refetch" (mutation: treat complete as stale → red), "incomplete refetches after TTL", "pageBound detail is served from L1 but never persisted" (mutation: persist on `complete` alone → red), "persisted contractVersion ≠ current is a miss" (mutation: skip the check → red), "served capabilities follow the provider, persisted JSON has none" (mutation: persist capabilities → red), "clear() drops a late result" (mutation: remove the generation check → red), "unknown settlement is never cached as complete" (mutation: use `d.complete` alone → red).
  - `tests/unit/services/commitChecks/ciGenerations.test.ts` › "auth bump makes a captured ctx stale", "lifecycle bump makes it stale", "different repoKey is stale" (mutation: compare only repoKey → red).
  - `tests/unit/services/commitChecks/ciTrace.test.ts` › "no Authorization value, no query string, no log text" (mutation: log the full URL → red).
  - `tests/unit/services/commitChecks/capabilities.test.ts` › "every provider declares all false in Phase 1" (mutation: set gitlab `jobs: true` → red), "floor detail carries the provider's capabilities" (mutation: hard-code all-false in the adapter → red, using a stub provider with one true flag).
  - `tests/unit/webviews/checksRefresh.test.ts` (extend the existing test file if it exists [ASSUMED]) › "unavailable gets no schedule", "incomplete failure keeps the ladder" (mutation: state-only check → red), "re-exports are identical".
  - Architecture: `bun run architecture:check` passes; adding an import of `src/services/commitChecks/types.ts` to a webview file turns it red (Root runs this mutation once).
  - Existing `tests/unit/services/commitChecks/*` stay green.
- Done when: the tests above pass, and Gate L (the trace channel name and any new strings) and Gate G exit 0. Patch bump with CHANGELOG "A commit whose CI failed while other jobs were still running now keeps updating until every job finishes."
- Review gate: reviewer (`code-reviewer` / `build-verifier`) checks that the K1/K2 shapes match this plan, that no provider throws, that the ladder values are unchanged, that `clear()` and `delete` run inside `enqueue`, that settlement is `unknown` whenever run or flat coverage is not full, and that every per-key fence path has its red mutation. R1 (Fable) review: persisted format and cache invalidation.

### Phase 2 — GitHub detail, response metadata transport, guarded pagination and the overflow scan
- Scope: `src/services/commitChecks/http.ts` (`FetchResponse`, `FetchJsonWithMeta`, `createHttpGetJsonWithMeta` sharing the request core); `src/activation/repositoryMode.ts` (`fetchWithMetaFor(providerId)` through the gate); new `src/services/commitChecks/paginate.ts` (with `allowNext`); `detailService.ts` (overflow-scan driver: cursor and found items in the L1 entry, pause on cooldown, resume with identity checks, re-post per page); `requestGate.ts` (a read-only cooldown-end accessor only if step 1 finds none); `githubProvider.ts` (`getDetail`, `continueFailedScan`, `allowNext`; capabilities `runs`, `jobs`, `steps`, `runHeader` true; snapshot items get `id`; jobs get `logicalId`); GitHub fixtures; tests; version; CHANGELOG; docs. No UI.
- Depends on: 1; O1, K2, K32, K33, K34, K36 resolved.
- Build:
  1. Read `requestGate.ts` for how cooldown is exposed; add a read-only accessor for the cooldown end if none exists. Also read how the gate reports a cooldown or budget error thrown after a task was queued or acquired (`requestGate.ts:223-235`); the scan driver classifies that error as `paused`, never as a page failure (§3, Codex R3 #8); add an error class there if the error cannot be told apart. Test: `githubDetail.test.ts` › "cooldown that begins after the precheck pauses the scan and keeps the cursor" (the gate rejects page 12 with its cooldown error after the precheck passed; asserts `failedScan.state: "paused"`, found items and cursor kept, and a resume after the cooldown end; mutation: classify the gate error as a page failure → `stopped` → red).
  2. Add the metadata fetch type beside `FetchJson`; the existing type, `createHttpGetJson` and `httpGetJson` keep their behaviour (existing tests stay green).
  3. `paginate` per §3 with `maxPages` from O1's resolution and the required `allowNext`.
  4. GitHub `getDetail`: the runs and jobs requests from the §3 page-size table, both paginated by `Link`, guarded by GitHub's `allowNext` (API base from the provider ref). Map `status`/`conclusion` to `CiState`; `workflow_id`, `name`, `event`, `actor.login`, `head_branch`, `run_number`, `run_attempt`, `created_at`, `run_started_at`, `updated_at`; job `id` (Actions job id), `check_run_url` → `checkRunId` (last path segment) [ASSUMED field name; fixture], `name`, `started_at`, `completed_at`, `html_url`; steps; `logicalId` from the run's workflow name and the job name. `complete`, `runsCoverage` and `jobsCoverage` per §3. `otherChecks` per the identity rule (§3). Any page error → `unavailable` with `error` and `signInHost` as `getChecks` does; never throw.
  5. Overflow scan: `continueFailedScan` reads pages past the bound of a failed run's jobs and returns only failed jobs; the detail service drives it per §3.
  6. Snapshot items: set `id` to the check-run id or status context.
  7. Record fixtures under `tests/fixtures/commitChecks/github/` from the docs' example payloads, including a two-page jobs list and a generated failed run with 2 000 jobs whose failed jobs sit at positions 1 050 and 1 900. If the docs contradict `filter=latest`, `Link` paging or `check_run_url`, write it in the phase log and stop for Root.
  8. Bump `CI_DETAIL_CONTRACT_VERSION`.
- Tests: `tests/unit/services/commitChecks/githubDetail.test.ts` › "maps runs, jobs, steps" (mutation: failure → success → red), "Actions job id and check-run id are distinct" (mutation: use job id for `checkRunId` → red), "null started_at stays undefined" (mutation: default to now → red), "second page fails → unavailable", "final page fails → unavailable" (mutation: return pages read → red), "dedup by check-run id, not name" (mutation: dedup by name → red), "requests go through the gate" (mutation: call fetch directly → red), "fetch error returns unavailable, does not throw" (mutation: rethrow → red), "requests carry per_page=100" (mutation: drop it → red), "1 001+ items: 1 000 kept, coverage pageBound shown 1000" (mutation: drop the coverage → red), "failed jobs at positions 1 050 and 1 900 are listed" (mutation: stop at 1 000 → red), "failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor" (mutation: restart from page 1 → request log shows page 11 twice → red; drop found items on failure → red), "run attempt changed → scan restarts" (mutation: skip the identity check → red), "hostile next link: http, other host, other port, other path prefix" (mutation: ignore `allowNext` → a request reaches the hostile URL → red). `tests/unit/services/commitChecks/paginate.test.ts` › "follows Link until no next" (mutation: stop after page 1 → red), "stops at maxPages and sets pageBound coverage" (mutation: drop the coverage → red), "rejected next link stops paging, sends nothing and sets rejectedNext" (mutation: ignore `allowNext` → red). `tests/unit/services/commitChecks/httpMeta.test.ts` › "headers reach the caller" (mutation: return `{}` headers → red), "existing FetchJson unchanged". `detailService.test.ts` › "scan detail is never persisted", "each scan page re-posts with the original requestId".
- Done when: the tests pass, and Gate G exits 0 (Gate L if a coverage or scan string is added here). Patch bump with CHANGELOG "IntelliGit now reads the workflows, jobs and steps behind a commit's GitHub checks, ready for the new Checks tab."
- Review gate: reviewer checks the mapping table, identity dedup, the page-failure rule, the continuation guard, the scan's pause and resume, and that `FetchJson` callers are untouched. R1 (Fable) review: exported signature (`http.ts` types used by every provider) and credential handling on next links.
- Owner amendment (2026-11-10, last round after wave 6; supersedes the takeover's handoff amendment that the scan cursor carries the single-run read's attempt):
  1. One attempt per detail. Every job a GitHub detail shows, the first 1 000 and every overflow-scan page alike, comes from the same run attempt as the run it is shown under. A page, single-run read or jobs list that names another attempt is never appended; the scan stops with the existing "Remote data changed. Reload and try again." string, the detail stays `complete: false` and is never saved, and Refresh reads again from scratch. No read or scan restarts without bound. Test: attempt-1 run and jobs with an attempt-2 single-run read and attempt-2 overflow pages → no attempt-2 job appears under attempt 1 (Codex re-review #3 finding 1, `githubProvider.ts:339`).
  2. `src/shared/ci/completion.ts:38` (`hasUnfinishedWork`): a test fails when the pending-flat-check guard is removed (Codex re-review #3 finding 2, mutation M12).
  3. Stop rule. Phase 2 is accepted once 1 and 2 hold, the gates pass, and no REQUIRED finding shows, in this phase's own code, wrong data shown or saved, a crash, an unbounded loop or request storm, data loss, or a credential or security leak. Any other new finding (a mutation survivor outside this phase's diff, a wiring or concurrency path the unit harness cannot drive, a hardening idea) is not blocking: the builder lists it under "Follow-ups" in the handoff with file:line, and the reviewer marks it allowed, quoting this line.
  4. Owner amendment after wave 7 (2026-11-10, one narrow round for one finding): the overflow scan's job budget is fixed when the scan starts. It is the run attempt's `total_count` as first read (or the first scan page's, if the first 1 000 carried none), saved in the scan cursor. No later page, continuation, cooldown resume or Refresh may raise it; a later page's `total_count` is never compared in its place. A missing first total still refuses the next link. Test in `githubDetail.test.ts`: attempt 1 kept, page 11 returned again under a new query parameter, `total_count` raised by 100 per response → the scan makes no more overflow requests than the first budget allows (Codex takeover review, REQUIRED, `githubProvider.ts:425`/`:434`). This round's review blocks only on this finding or on a new finding of a class item 3 names as blocking; everything else goes under Follow-ups.
  5. Owner amendment after wave 8 (2026-11-10, last round on the scan budget): a scan page dropped because its requester went stale or the scan stopped being live (`detailService.ts:463`) still hands its frozen budget to the scan's cursor. When the cursor has no `jobsTotal` yet (`undefined`), it takes the dropped page's `next.jobsTotal`, a number or the `null` marker; the dropped page's jobs are still never published, and the cursor does not move to the dropped page's next link. Test first, red before the fix: real provider, coordinator, detail service and generations; neither the first 1 000 nor the first overflow page carries a total; a lifecycle bump (a discovered repository closes, `repositoryMode.ts:402-410`) makes the requester stale while that page is in flight; a later request on the same scan sees `total_count` 2 000 → exactly one overflow request (Codex's probe failed with `same scan retains its first missing budget after a lifecycle interruption: expected [ Array(10) ] to deeply equal [ 11 ]`). Cap: this is the last round on the budget rule. After it, any further finding that the overflow scan's budget can be lost, raised or read again is not blocking, unless it makes requests without bound; the builder lists it under Follow-ups with file:line and the reviewer marks it allowed, quoting this line. This round's review blocks only on this finding or on a new item-3 blocking class outside the budget rule.

### Phase 3 — GitLab pipelines and jobs detail
- Scope: `src/services/commitChecks/gitlabProvider.ts` (`getDetail`, `continueFailedScan`, `allowNext`; capabilities `runs`, `jobs`, `runHeader` true; jobs get `logicalId`), GitLab fixtures, tests, version, CHANGELOG, docs.
- Depends on: 2; O1, K2, K32, K33, K34, K36 resolved.
- Build:
  1. `GET projects/:id/pipelines?sha=<sha>&per_page=100` (paginated); per pipeline `GET projects/:id/pipelines/:pid` for `user.username`, `duration`, `started_at`, `finished_at`, `source`, `ref`, `iid`, `name` (#13); `GET projects/:id/pipelines/:pid/jobs?per_page=100` paginated by `x-next-page`, guarded by GitLab's `allowNext`.
  2. Map `stage`/`name`, `status`, `started_at`, `finished_at`, `web_url`, `allow_failure` (kept for Phase 9) and the header fields; `logicalId` from the pipeline name (empty when absent) and the job name. `complete` and coverage per §3.
  3. Overflow scan: `continueFailedScan` reads `pipelines/:pid/jobs?scope[]=failed&per_page=100` from its first page [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/], skipping job ids already listed.
  4. Statuses that do not belong to a pipeline go to `otherChecks` with their identity.
  5. Through the gate; never throw. Bump `CI_DETAIL_CONTRACT_VERSION`.
- Tests: `tests/unit/services/commitChecks/gitlabDetail.test.ts` › "maps pipeline → jobs" (mutation: drop the stage grouping → red), "header comes from the single-pipeline request" (mutation: read user from the list → red, the list fixture has none), "pages jobs by x-next-page" (mutation: stop after page 1 → red), "requests carry per_page=100" (mutation: drop it on the pipelines request → red), "second page fails → unavailable", "final page fails → unavailable", "1 001+ items: 1 000 kept, coverage pageBound shown 1000", "scope[]=failed filtered pages add failed jobs past the bound without duplicates" (mutation: no dedup by id → red; skip the scan → red), "failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", "hostile next link: http, other host, other port, other path prefix", "error → unavailable" (mutation: rethrow → red), "steps capability stays false" (mutation: set it true → red).
- Done when: the tests pass, and Gate G exits 0. Patch bump with CHANGELOG "IntelliGit now reads GitLab pipelines and jobs for a commit, ready for the new Checks tab."
- Review gate: reviewer checks paging, the single-pipeline request, the filtered scan, the mapping table, and that only `read_api` is used.

### Phase 4 — Checks tab UI (tree, header, states, Open in Checks)
- Scope: `src/webviews/react/commit-info/CommitInfoPane.tsx` (Files | Checks tabs; the tab choice persisted like `groupByDir`); new `src/webviews/react/commit-info/checks/` (`ChecksTab.tsx`, `CheckTree.tsx`, `CheckJobDetail.tsx`, `ChecksHeader.tsx`, `useCommitCiDetail.ts`); `src/webviews/react/commit-list/CommitChecksPopover.tsx` (**Open in Checks**); host handlers for `requestCommitCiDetail` / `commitCiDetail` / `openChecksTab` in each host behind `CommitGraphPanel.tsx:631`, `CommitInfoApp.tsx:105` and `undocked/UndockedLayout.tsx:433`; the message union file; new `tests/e2e/ciChecksTab.spec.ts` and its entry in `test:e2e`; l10n; tests; version; CHANGELOG; docs.
- Depends on: 1; K3, K29, K34.
- Build:
  1. Before UI code: find how existing e2e specs feed commit-check data (for example `tests/e2e/fileContextGitHub.spec.ts`) [ASSUMED: a stub path exists]. If none exists, add an e2e-only fixture seam that the shipped manifest cannot reach (the repo already guards e2e-only manifest commands with `scripts/verifyNoE2eManifestCommand.js` [CODE: package.json:1620, :1642]), and record it in the phase log.
  2. Read Figma frame `2:2` in `checks-tab.html` for layout, through Gate U. The tab bar has "Files" and "Checks"; Files is the default.
  3. `useCommitCiDetail(repoKey, hash, active)` posts `requestCommitCiDetail` only while the Checks tab is active and a hash is selected. It stores the newest `requestId` and renders a reply only if `requestId`, `repoKey` and `hash` all match (§4), including re-posts after scan pages. It re-polls incomplete detail on the K11 ladder while active.
  4. Header: state icon, duration ("—" when unknown), and "<event> by <actor> · <ref> · #<runNumber>" when `capabilities.runHeader` is true. Buttons render only for capabilities that are true; Refresh (`force: true`) is always shown, and Open in browser when `url` is present.
  5. Tree: run → job → step with state icon, duration and start time. Failed jobs expand to their first failed step. `otherChecks` sit under "Other checks", omitted when empty. With `runs: []`, the flat list renders with no group header (the floor). Coverage notes read `runsCoverage` and `jobsCoverage` (`pageBound` and `rejectedNext` wording from journey 1); `failedScan` shows "Loading more failed jobs…", the paused note, or the stopped note with Refresh.
  6. Job detail panel: name, state, duration, the step list, the link. Sections that later phases fill render only when their capability is true.
  7. States: loading, none, disabled (+ settings link), signed out (Sign in, reusing the popover's sign-in message), unavailable (error + Refresh), cooldown (the gate message).
  8. Popover **Open in Checks**: closes the popover, selects the row and switches the tab.
  9. Host handlers call `coordinator.getDetail` with a captured `ctx` and check `isCurrent(ctx)` before posting.
- Tests: `tests/integration/webviews/commitChecksTab.integration.test.tsx` ›
  - "shows the tree for the selected commit" (mutation: render `otherChecks` only → red)
  - "expands failed job to failing step" (mutation: remove auto-expand → red)
  - "drops a detail reply for a commit that is no longer selected" (mutation: delete the hash check → red)
  - "A→B→A drops the first A reply" (mutation: accept any `requestId` ≥ the reply's slot minimum, i.e. `<` instead of newest → red)
  - "same-hash out-of-order refresh keeps the newest" (controlled promise resolution: reply 2 then reply 1; mutation: delete the `requestId` check → red)
  - "same SHA in another repository is not reused" (mutation: drop the `repoKey` check → red)
  - "no detail request while the Files tab is active" (mutation: request on mount → red)
  - "floor provider renders flat list without dead controls" (mutation: render a log button regardless of capability → red)
  - "renders signed-out, unavailable and cooldown states" (mutation: remove the signInHost branch → red)
  - "partial coverage shows the open-in-browser note" (mutation: ignore `jobsCoverage` → red)
  - "failed jobs past the first 1 000 are listed" (fixture detail with 1 000 jobs plus two scan-found failed jobs; mutation: render only the first 1 000 → red)
  - "overflow scan paused shows the paused note" (mutation: ignore `failedScan` → red)
  - "tab choice persists" (mutation: skip persist → red)

  Also `tests/integration/webviews/commitChecksPopover.openInChecks.integration.test.tsx` › "Open in Checks selects row and switches tab" (mutation: do not switch → red); `tests/unit/views/ciDetailHandler.test.ts` › "host drops a reply after a generation bump" (mutation: no `isCurrent` → red) [ASSUMED location of host handler tests]; the existing `commitChecksEnabled-gating.integration.test.tsx` stays green. E2E `tests/e2e/ciChecksTab.spec.ts` › "Checks tab shows the tree in light and dark themes, narrow and wide pane", "Open in Checks from the popover".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass (CI `bun run test:e2e` green, existing specs included; layout unchanged with Files as default). Minor bump with CHANGELOG "A new Checks tab next to a commit's changed files shows its CI workflows, jobs and steps with their durations, opening straight to the step that failed."
- Review gate: reviewer checks the newest-request guard, that no component compares provider ids, that banners read `coverage`, and that all three hosts handle the messages. Root walks journeys 1-3, 15 and 16 against the integration tests.

### Phase 5 — ETag conditional polling
- Scope: `http.ts` (optional conditional store on the metadata fetch), new `src/services/commitChecks/etagStore.ts`, the providers' incomplete-state requests, tests, version, CHANGELOG.
- Depends on: 2; K12.
- Build:
  1. `EtagStore`: LRU of 500 `{etag, body, pagination}` entries keyed by `${authGeneration}\0${url}`; `pagination` holds the response's `Link` and `x-next-page` headers (Codex R3 #7).
  2. Send `If-None-Match` when an entry exists. Handle 304 before the non-2xx rejection: return the stored body with the stored pagination headers restored into the response headers; with no entry, repeat once without the header. A 200 with `ETag` stores body, etag and pagination headers.
  3. The 304 response headers still reach `observeResponse` so the gate sees the quota [CODE: requestGate.ts:79; http.ts:65].
  4. Only requests for incomplete commits use the store.
- Tests: `tests/unit/services/commitChecks/httpEtag.test.ts` › "sends If-None-Match from store", "304 returns stored body" (mutation: empty body → red), "304 without stored body re-requests" (mutation: return an error → red), "304 headers reach the gate" (mutation: skip observe → red), "complete requests do not use the store" (mutation: always use it → red), "a new auth generation does not reuse the body" (mutation: key by URL only → red), "multi-page 200 then header-minimal 304 → coverage unchanged" (a two-page 200 with `Link`, then a 304 for page 1 with no `Link`; asserts both pages are read, coverage stays `full`, and quota is taken from the 304; mutation: store only body and etag → paging stops after page 1 → red).
- Done when: the tests pass, and Gate G exits 0. Patch bump with CHANGELOG "Watching running CI now uses less of your GitHub request allowance."
- Review gate: reviewer checks that a 304 can never return another URL's or another token's body and that the change is additive. R1 (Fable) review: cache invalidation.

### Phase 6 — Log transport and in-memory log store
- Scope: `http.ts` (`followRedirects`, `downloadToString` with byte bound, marker and abort signal); new `src/services/commitChecks/ciLogMemoryStore.ts` (LRU of three, join map, sources record, `clear()`); new `src/services/commitChecks/ciLogDocument.ts` (content provider for `intelligit-ci-log:`, registered in `src/activation/repositoryMode.ts` next to the store and disposed with it); `repositoryMode.ts` (construct the store next to the detail service; call its `clear()` with the services' `clear()`); first-error-line finder and excerpt builder (host side, using `sanitizeExcerpt`); l10n for the "no longer loaded" line and error messages; tests; version; CHANGELOG. No provider wiring and no webview change.
- Depends on: 2; O2, K16, K17, K19, K20 resolved.
- Build: implement §5 transport and the store exactly, using O2's resolved bound. Confirm how the existing 15 s timeout is set (§5) before writing `downloadToString`. The content provider records each URI it answered with the "no longer loaded" line or an error line; when a later `load` of the same key succeeds, it fires `onDidChange(uri)` for those URIs, so an open placeholder tab shows the log (K19, Codex R3 #6).
- Tests:
  - `tests/unit/services/commitChecks/redirects.test.ts` › "strips Authorization on origin change" (mutation: forward headers → red), "port change counts as an origin change" (mutation: compare host only → red), "chained redirect back to the first origin stays stripped" (mutation: re-add headers on return → red), "refuses an http: target" (mutation: allow → red), "stops after 5 hops" (mutation: no limit → red).
  - `tests/unit/services/commitChecks/ciLogMemoryStore.test.ts` (fake transport) › "LRU evicts the least-recent of 4" (mutation: cap 4 or evict most recent → red), "two concurrent opens make one request" (mutation: no join map → 2 fetch calls → red), "known-length 300 MB response truncates at 50 MB with one marker" (fake transport announces `Content-Length: 314572800` and streams chunks; asserts text length, one marker, `truncated: true`, and that the response was destroyed after the bound; mutation: refuse on `Content-Length` → red), "unknown-length stream truncates at 50 MB with one marker" (mutation: append per chunk → red), "a reopened evicted log triggers a new download" (mutation: keep a stale entry → red), "30 MB log is stored and only the excerpt is returned", "stream error stores nothing and rejects every waiter" (mutation: swallow → red), "clear() empties the store and aborts in-flight downloads" (mutation: no abort → red), "store module imports no fs" (reads the module's import list; mutation: import `node:fs` → red).
  - `tests/unit/services/commitChecks/ciLogDocument.test.ts` › "rejects ../ and non-hex keys" (mutation: drop the regex → red), "miss with a source downloads again" (mutation: return empty text → red), "miss without a source returns the no-longer-loaded line and sends nothing" (mutation: download anyway → red), "a load that replaces placeholder text fires onDidChange for that URI" (mutation: skip `onDidChange` → red).
  - `tests/unit/services/commitChecks/firstErrorLine.test.ts` › "pattern, then step fallback, then last line" (mutation: always line 0 → red).
- Done when: the tests pass, and Gate L and Gate G exit 0. Patch bump with CHANGELOG "IntelliGit can now download CI logs safely and keep the most recent ones ready to open in an editor."
- Review gate: reviewer checks the redirect rule, the URI guard, stream error handling, the byte bound and marker, the LRU and join map, and that nothing in the store touches the file system. R1 (Fable) review: security boundary (credentials, untrusted input) and in-window concurrency (join map, abort on `clear()`).

### Phase 7 — Failure summary, log preview and full log in an editor (GitHub, GitLab)
- Scope: `githubProvider.ts` (`getJobLog` via the logs endpoint and `followRedirects`, `failureSummary` via `GET check-runs/{checkRunId}`, `firstErrorPatterns`); `gitlabProvider.ts` (`getJobLog` via trace, `failure_reason`); capabilities `logs` and `failureSummary` true for both; `CheckJobDetail.tsx` (summary, "Loading excerpt…", excerpt as text, **Open full log in editor**, truncated note); host handlers `previewCiLog` and `openCiLog` (the latter with `window.withProgress`; cancel stops this waiter); log fixtures under `tests/fixtures/commitChecks/logs/`; new `tests/e2e/ciLogEditor.spec.ts` and its `test:e2e` entry; l10n; tests; version; CHANGELOG; docs.
- Depends on: 3, 4, 6; K3, K18, K19, K20, K32.
- Build: wire §5 for GitHub and GitLab. Selecting a complete failed job posts `previewCiLog` with a new `selectionToken`; the host fills the store and replies `ciLogPreview` with the excerpt only; no editor opens. A running job replies `outcome: "running"` to both messages. `openCiLog` loads (a hit after the preview) and opens the document at the first error line. The webview keeps the excerpt in component state only. After a reload, `openCiLog` for a restored placeholder tab's key loads the log, which fires `onDidChange` (Phase 6), so the same tab shows the text (Codex R3 #6). Bump `CI_DETAIL_CONTRACT_VERSION` (failure summary is persisted).
- Tests:
  - `tests/unit/services/commitChecks/githubJobLog.test.ts` › "redirect download carries no Authorization" (mutation: bypass `followRedirects` → red), "403 on redirect target re-requests 302 once" (mutation: no retry, or unbounded → red; asserts exactly 2 calls to the logs endpoint), "failure summary uses checkRunId, not the Actions job id" (mutation: swap → red).
  - `tests/unit/services/commitChecks/gitlabJobLog.test.ts` › "trace downloaded with the auth header", "failure_reason mapped".
  - `tests/unit/services/commitChecks/firstErrorLine.test.ts` › "first error line from GitHub and GitLab fixtures" (mutation: line 0 → red).
  - `tests/unit/services/commitChecks/ciLogPreview.test.ts` › "preview opens no editor" (spy on `showTextDocument`; mutation: open in preview → red), "open after preview makes no second request" (mutation: bypass the store → 2 fetch calls → red), "running job gets outcome running and no request", "reload → placeholder tab → Open full log → tab shows the real text" (new store and provider instances; the provider first returns the no-longer-loaded line; then `openCiLog`; asserts one `onDidChange` for that URI and the real text on the next read; mutation: skip `onDidChange` → red).
  - `tests/integration/webviews/commitChecksTab.integration.test.tsx` › "selecting a failed job shows the excerpt without opening an editor" (mutation: excerpt only from `openCiLog` → red), "a preview reply for a job no longer selected is dropped" (A selected, B selected before A's reply; mutation: drop the `selectionToken` check → red), "running job shows no log button", "403 shows cannot-read message", "excerpt with <img onerror> renders as text" (mutation: `dangerouslySetInnerHTML` → red), "excerpt is not written to webview state" (spy on `setState`; mutation: persist it → red), "truncated log shows Open in browser".
  - E2E `tests/e2e/ciLogEditor.spec.ts` › "Open full log opens a read-only editor at the first error line", "first tab keeps its text after a fourth log is opened".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "In the Checks tab, a failed job now shows why it failed with a short excerpt, and Open full log opens the whole log in an editor tab at the first error."
- Review gate: reviewer checks that only the excerpt crosses to the webview, the sanitising, the selection-token guard, and the job-id/check-run-id split. R1 (Fable) review: untrusted input rendering and token handling.

### Phase 8 — Re-run failed, re-run job, cancel run (GitHub, GitLab)
- Scope: `http.ts` (`httpRequestJson` for POST); `repositoryMode.ts` (`writeFor(providerId)` through the gate); `githubProvider.ts` and `gitlabProvider.ts` (`runAction`; capabilities `rerunFailed`, `rerunJob`, `cancel` true; `writeScopeHelp`; `actionEvidence(action)` per §3 step 4, Codex R3 #4); fence-driven polling in `useCommitCiDetail` and the host re-post on the fence's change event (Codex R3 #5); Refresh on a "not seen yet" target through the fence's `endByUserRefresh` (Codex R3 #1); new `src/services/commitChecks/ciActions.ts` (fence write, outcome mapping, fence delete on definite failure, `invalidate`, forced fetch); host handler `runCiAction`; `ChecksHeader.tsx` / `CheckJobDetail.tsx` buttons with busy state, the inline cancel confirm, and the "Waiting for re-run to start" / "not seen yet — Refresh" labels from `detail.actionFence`; new `tests/e2e/ciActions.spec.ts` and its `test:e2e` entry; l10n; tests; version; CHANGELOG; docs (`#write-actions`, GitLab `api` token).
- Depends on: 3, 4, 19; K25, K30.
- Build: implement §6. Order: gate cooldown check → write and await the fence (Phase 19 `begin`, with `before` read from the current detail and `evidence` from the provider's `actionEvidence(action)`) → send. Outcome mapping: 2xx → `ok`, 403 → `forbidden`, 401 → the sign-in state, timeout or network error after send → `uncertain`, other → `failed`. On `ok` or `uncertain`: await `coordinator.invalidate(hash)`, then force-fetch snapshot and detail; each result goes through the fence's `resolve`. On `forbidden`, `failed`, 401 or not sent: delete the fence. In the Checks tab, `useCommitCiDetail` keeps the pending ladder while `detail.actionFence` is present, even when the detail is complete; the host re-posts the detail with the slot's newest `requestId` when the fence store's timer or `resolve` changes it. Refresh while `notSeen` is true calls `endByUserRefresh(hash, targetId)` before the forced fetch; Refresh before that keeps the fence.
- Tests:
  - `tests/unit/services/commitChecks/ciActions.test.ts` › "GitHub endpoints per action" (mutation: swap rerun-failed with rerun → red), "rerun job uses the Actions job id" (mutation: use checkRunId → red), "fence written before the POST" (call-order spy; mutation: write after → red), "GitLab 403 maps to forbidden with scope help" (mutation: map to failed → red), "forbidden removes the fence" (mutation: keep it → red), "uncertain keeps the fence and invalidates" (mutation: refresh without invalidate → red), "re-run on a cached failed commit never shows the old result again" (old result cached in L1 and L2, a slow pre-action fetch in flight; mutation: skip `invalidate` → red), "restart while waiting shows waiting, never the old failure" (new coordinator over the same mementos; the provider still returns the old failed attempt; mutation: fence in memory only → red), "no POST without runCiAction" (mutation: retry on forbidden → red), "cooldown sends nothing and writes no fence" (mutation: bypass the gate → red), "GitLab retry finishing before the next poll resolves the fence" (the first post-action fetch already shows a finished job with the same logical id and a higher id; mutation: watch the old job id → fence stays → red; Codex R3 #4), "GitHub re-run job is resolved by the run attempt, not the old job id" (mutation: watch the old job id → red), "Refresh on a not-seen target ends the fence and caches the fetched result" (mutation: keep the fence → red; Codex R3 #1), "Refresh before not-seen keeps the fence" (mutation: end on any Refresh → red).
  - `tests/integration/webviews/commitChecksActions.integration.test.tsx` › "cancel needs confirm, then refreshes" (mutation: send on first click → red), "forbidden keeps the tree" (mutation: clear the detail on error → red), "busy state blocks double click" (mutation: no busy → 2 posts → red), "shows waiting for re-run to start" (mutation: ignore `actionFence` → red), "shows re-run not seen yet after 10 min" (mutation: ignore `notSeen` → red), "a fenced complete detail keeps polling on the pending ladder" (fake timers; mutation: stop when complete → red; Codex R3 #5), "the not-seen label appears by timer with no request" (mutation: wait for a fetch → red).
  - E2E `tests/e2e/ciActions.spec.ts` › "inline cancel confirm and Keep running".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "You can now re-run failed jobs, re-run one job, or cancel a run from the Checks tab on GitHub and GitLab; if your token can't do that, IntelliGit tells you how to get one that can."
- Review gate: reviewer checks that no scope is requested, that cancel is confirmed, the outcome mapping, and the fence-then-send-then-invalidate order. R1 (Fable) review: authz boundary, retries and idempotency, and the fence across restart.

### Phase 9 — "blocks merge", "optional", "required: unknown"
- Scope: new `src/services/commitChecks/defaultBranch.ts` (§8), new `src/services/commitChecks/requiredChecks.ts`, `githubProvider.ts` (`getRequiredChecks` per C2), `gitlabProvider.ts` (`optional` from `allow_failure`; required per §7), capabilities `requiredChecks` (GitHub, GitLab) and `optionalJobs` (GitLab), detail `required` / `optional` / `requiredStatus`, tree tags and header "required: unknown", l10n, tests, version, CHANGELOG, docs.
- Depends on: 3, 4; K21, K22, K32, C2 (resolved).
- Build: implement §7 and §8; the default branch and its tip are read on every call, never cached. Tags: "blocks merge" (red) on failed or incomplete jobs with `required: "yes"`; "optional" (muted) on `optional: true`; header "required: unknown" when `requiredStatus` is not `known` or the capability is false. Cache per K21. Bump `CI_DETAIL_CONTRACT_VERSION`.
- Tests:
  - `tests/unit/services/commitChecks/requiredChecks.test.ts` › "403 on protection yields unknown" (mutation: 403 → empty known → red), "404 not protected is known-empty" (mutation: every 404 unknown → red), "union of rules and protection" (mutation: rules only → red), "cached for 1 h" (mutation: no cache → 2 calls → red).
  - `tests/unit/services/commitChecks/defaultBranch.test.ts` › "missing origin/HEAD → null" (mutation: fall back to "main" → red), "tip read from origin/<name>", "a remote tip that moves between two comparisons is read fresh" (update the remote ref between two calls; mutation: cache the tip → red), using a real temp repo.
  - `gitlabDetail.test.ts` › "allow_failure marks optional" (mutation: ignore the field → red).
  - `commitChecksTab.integration.test.tsx` › "Bitbucket Cloud shows required: unknown" (mutation: hide the header line → red).
- Done when: the tests pass, and Gate L, Gate U and Gate G exit 0. Minor bump with CHANGELOG "The Checks tab now marks checks that block merging and jobs that are allowed to fail, and says so plainly when your provider won't tell us."
- Review gate: reviewer checks that C2 is implemented verbatim, that the default branch is never cached, and that "unknown" is never shown as an error.

### Phase 10 — Live elapsed, "usually ~Xm", "overdue"
- Scope: new `src/services/commitChecks/ciTiming.ts`, `githubProvider.ts` and `gitlabProvider.ts` (`getUsualDuration`; capability `usualDuration`), detail `usualDurationMs` on runs and jobs, `CheckTree.tsx` (1 s timer while any item runs; "usually ~Xm"; "overdue"), l10n, tests, version, CHANGELOG.
- Depends on: 3, 4; K14, K15, K23, K32.
- Build:
  1. GitHub: `GET actions/workflows/{workflowId}/runs?branch=<b>&status=success&created=<<selected run created_at>&per_page=1` [ASSUMED: the `created` filter accepts `<`; confirm in the workflow-runs docs before coding; if not, page newest-first with `per_page=100` and take the first run whose `created_at` is earlier and whose id differs from the selected run]. Run usual = `updated_at - run_started_at`. Job usual from that run's jobs, unique logical-id match only.
  2. GitLab (R2 #19): `pipelines?ref=<b>&status=success&created_before=<selected created_at>&order_by=id&sort=desc&per_page=1` [FACT: GitLab docs read by a web lane 2026-11-07, https://docs.gitlab.com/api/pipelines/ and https://docs.gitlab.com/api/jobs/]; skip a result whose id equals the selected pipeline's. Then the single-pipeline `duration`, and its jobs' `duration` by unique logical id.
  3. None → `null`. Cache per K23 keyed by the selected run id. Bump `CI_DETAIL_CONTRACT_VERSION`.
  4. One interval in the tab, cleared on unmount and when nothing runs.
- Tests: `tests/unit/services/commitChecks/ciTiming.test.ts` › "overdue past 1.5×" (mutation: `>= 1.0` → red), "no previous run → null" (mutation: return 0 → red), "baseline excludes the selected and newer runs" (fixture where the newest success is newer than the selected run; mutation: drop the `created` bound → red), "baseline uses the same workflow" (mutation: drop `workflowId` → red), "cache keyed by selected run" (older run after a newer one gets its own baseline; mutation: key by branch → red), "earlier-created pipeline updated after the selected run began is the baseline" (GitLab fixture, run against whichever query path step 2 chose; mutation: `updated_before=<selected created_at>` without the client filter → red). `tests/integration/webviews/commitChecksTiming.integration.test.tsx` › "elapsed ticks with fake timers", "timer cleared when complete" (mutation: no clear → red via fake-timer count), "usually: unknown shown for null".
- Done when: the tests pass, and Gate L, Gate U and Gate G exit 0. Minor bump with CHANGELOG "Running jobs now show how long they have been going, how long they usually take, and when they are running late."
- Review gate: reviewer checks the baseline rule, the GitLab query path recorded in the phase log, that no duration constant stands in for a missing source, and timer cleanup.

### Phase 11 — "new" / "still" / "fixed" and "also red on main"
- Scope: new `src/services/commitChecks/ciHistory.ts` (`join`, `compare`), providers' snapshot mapping (`CommitCheckItem.logicalId` where the snapshot API gives the workflow or pipeline name), host handler `requestCiHistory` (parent and default-tip snapshots through the coordinator, cache first), `defaultBranch.ts` reuse, tree tags, header line "default branch unknown — …", l10n, tests, version, CHANGELOG.
- Depends on: 4, 9; K22, K35.
- Build: implement §9 `join` and `compare` with logical identity first and the unique-name fallback, and the "also red" check. Record per provider whether snapshot items can carry `logicalId` (fixture), and set it where they can. The webview sends the commit's parents from the row it already holds [ASSUMED: commit rows carry parent hashes; otherwise the host runs `git rev-parse <sha>^1`]. The default tip comes from §8, read for this request.
- Tests: `tests/unit/services/commitChecks/ciHistory.test.ts` › "new", "still", "fixed", "renamed matrix job → unknown" (mutation: missing parent → new → red), "two parent items with the same name → unknown" (mutation: take the first match → red), "execution ids differ across commits, logical id matches" (mutation: join by execution id → unknown → red), "same job name in two workflows matched by workflow" (mutation: join by job name only → wrong tag → red), "parent incomplete → no tag", "also red on default tip" (mutation: compare against the parent → red), "merge commit uses first parent" (mutation: second parent → red), "two current workflows with the same job name against one parent job → unknown" (mutation: check uniqueness in the parent only → red; Codex R3 #11).
- Done when: the tests pass, and Gate L, Gate U and Gate G exit 0. Minor bump with CHANGELOG "Failed jobs now say whether they broke in this commit, were already broken, or are also failing on your main branch."
- Review gate: reviewer checks the join rule (logical identity, never execution ids across commits) and that no "main" constant exists.

### Phase 12 — Flaky badge, attempt history and "Changed since last green"
- Scope: `ciHistory.ts` (`flaky`), `githubProvider.ts` and `gitlabProvider.ts` (`getAttemptHistory`; capability `attemptHistory`), detail `attemptHistory`, new `src/services/commitChecks/changedSinceGreen.ts` (host: first-parent walk over the loaded set, cache-only lookup, `git diff --name-status -M -z`), host handlers `requestChangedSinceGreen` and `openCiRangeDiff`, the read-only revision URI support in `src/services/diffService.ts` if step 1 finds it missing, `CheckJobDetail.tsx` (file list opening diffs), tree tag "flaky n/m", new `tests/e2e/ciChangedSinceGreen.spec.ts` and its `test:e2e` entry, l10n, tests, version, CHANGELOG.
- Depends on: 11; O3, K24, K32, K35, K36 resolved.
- Build:
  1. Read `diffService.ts:174-178` and the read-only diff URI format; confirm it can serve a path at an arbitrary revision, or add that.
  2. Attempt history per §9: one history per `(runId, logicalId)`, `per_page=100`, paginated with `allowNext`, provider-specific ordering and de-duplication, `coverage` set. Bump `CI_DETAIL_CONTRACT_VERSION`.
  3. `flaky` per §9 with the O3 resolution.
  4. Changed since green per §14, matching ancestors by the request's `logicalCheckId` and `scopeName` (Codex R3 #12); `openCiRangeDiff` opens `vscode.diff` with two revision URIs.
  5. The file list reuses the changed-files row component from `CommitChangedFilesPanel` where props allow [ASSUMED].
- Tests:
  - `ciHistory.test.ts` › "isolated red counts, run of reds does not" (mutation: count every red → red), "same-commit fail-then-pass counts" (mutation: ignore attempts → red), "a commit meeting both rules counts once" (mutation: sum both rules → red), "same-named jobs in two workflows keep separate histories" (one fails only, the other passes only; mutation: key by check name → false flaky → red), "colliding attempt numbers in two runs do not merge" (mutation: dedup by attempt number → red), "GitHub attempts ordered by run_attempt then started_at", "GitLab retried jobs ordered by created_at" (mutation: sort by job id only → red on a fixture whose ids are out of time order), "no attempt history → attemptsCounted false" (mutation: drop the flag → red), "no tag when n=0".
  - `githubDetail.test.ts` / `gitlabDetail.test.ts` › "attempt requests carry per_page=100" (mutation: drop it → red).
  - `tests/unit/services/commitChecks/changedSinceGreen.test.ts` with a real temp git repo › "lists diff from last green" (mutation: diff against the parent → red), "no green → null, no files" (mutation: return the parent → red), "stops at the first commit outside the loaded set" (mutation: unbounded `rev-list` → red), "follows first parents only" (mutation: second parent → red), "never hits the network" (mutation: use `getChecks` → fetch spy called → red), "add/delete/rename map to the right sides" (mutation: always use `path` on the left → rename red), "names with space, tab, newline, #, ?, leading -" (mutation: split on newline instead of NUL → red), "same job name in two workflows with different last-green commits" (ancestor snapshots carry logical ids; each request gets its own `lastGreen`; mutation: match by `checkName` → both get the same commit → red; Codex R3 #12), "same name, no logical ids on ancestors, two current workflows → ambiguous" (mutation: take the first name match → red).
  - E2E `tests/e2e/ciChangedSinceGreen.spec.ts` › "clicking a file opens a two-revision diff".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "Jobs that pass and fail at random are now marked flaky, and a failed job lists the files changed since it last passed, each opening its diff."
- Review gate: reviewer checks the cache-only rule, the loaded-set walk, the flaky definition and history keying against §9, and the diff sides.

### Phase 13 — HEAD monitor, status-bar item and settle toast
- Scope: new `src/services/commitChecks/headStatus.ts` (monitor, settled-HEAD detail fetches, atomic toast claim; no claim sweep, Codex R3 #2); registration in `src/extension.ts`; commands `intelligit.ci.showHeadChecks` and `intelligit.ci.refreshHeadChecks` (`package.json` `contributes.commands` + hidden in `menus.commandPalette`); settings `intelligit.commitChecks.statusBar` and `intelligit.commitChecks.notifyOnSettle` with NLS; host → webview `openChecksTab`; both e2e command inventories (`tests/e2e/coverage-manifest.ts` and `scripts/knownManifestCommands.json`, per Risks); new `tests/e2e/ciHeadStatus.spec.ts` and its `test:e2e` entry; l10n; tests; version; CHANGELOG; docs.
- Depends on: 7, 8; K5, K6, K8, K13, K14, K26, K27.
- Build: implement §10. The claim uses Node `fs.promises.mkdir` under `context.globalStorageUri.fsPath`, non-recursive for the claim itself. **Open log** calls the Phase 7 log open for the first failed job when `capabilities.logs` is true. **Re-run failed** calls Phase 8 `ciActions`. Every publish (status bar text, toast) checks `isCurrent(ctx)` and HEAD. Settlement fetch: await the detail service's `invalidate(hash)`, then fetch with `force: true` (§10, Codex R3 #3). Stop and toast only on settlement `settled` (Codex R3 #9). A HEAD with an action fence keeps the schedule after `complete` (Codex R3 #5).
- Tests: `tests/unit/services/commitChecks/headStatus.test.ts` ›
  - "formats counts and elapsed" (mutation: swap counts → red)
  - "failed plus running job keeps polling and does not toast" (mutation: stop on aggregate failure → red)
  - "keeps polling every 120 s past the ladder until complete" (mutation: stop after the ladder → red)
  - "exactly 36 snapshot fetches in one incomplete hour" (fake timers; mutation: poll at the first rung forever → red)
  - "pauses during cooldown and shows paused" (mutation: poll during cooldown → red)
  - "settled failing HEAD on first load fetches detail" (mutation: fetch detail only while incomplete → red)
  - "pending→settled fetches detail once more before stopping" (asserts a forced detail fetch before the toast; mutation: stop on the settled snapshot → red)
  - "settlement detail comes from a request started after settlement" (a pre-settlement detail request is held open; the snapshot settles; asserts the toast reads job states from a second detail request started after settlement; mutation: drop the `invalidate` → the forced fetch joins the held request → red; Codex R3 #3)
  - "a running execution past the run bound keeps polling and sends no toast" (the detail has `runsCoverage: pageBound` and every returned run finished; mutation: settlement from the returned items only → toast → red; Codex R3 #9)
  - "fenced HEAD keeps polling after complete, across restart and cooldown" (fence present, detail complete; a new instance over the same mementos keeps polling; a cooldown pauses requests while the not-seen label still switches at 10 min; mutation: stop on complete → red; Codex R3 #5)
  - "toasts once per hash across a simulated reload" (new instance over the same fake mementos and the same temp claim directory; mutation: skip the claim → red)
  - "settles during the restart gap → one toast" (pending-observed written, instance disposed, new instance's first fetch is complete; mutation: require an in-activation pending observation → red)
  - "no toast when the hash was never seen incomplete" (mutation: toast on any complete → red)
  - "claim taken before toast" (fake `showInformationMessage` asserts the claim directory exists; mutation: claim after → red)
  - "two hosts, one toast" (two instances on one temp claim directory, one focused; then focus moves; mutation: no focus check → red)
  - "both pass the focus check, one mkdir wins" (two instances, controlled promises hold both after the focus check, then both claim; asserts exactly one toast; mutation: exists check plus `mkdir({recursive: true})` → two toasts → red)
  - "mkdir error other than EEXIST → no toast, hash kept" (mutation: toast anyway → red)
  - "claims are never pruned and have no count cap" (250 claims, one with a 400-day-old mtime, all present after a new activation; mutation: cap at 200 → red; remove claims by age → red; Codex R3 #2)
  - "hidden when disabled / unpushed none / no provider" (mutation: always show → red)
  - "zero requests when commitChecks.enabled is false" (mutation: poll anyway → red)
  - "a result after sign-out does not update the status bar" (mutation: no `isCurrent` → red)

  E2E `tests/e2e/ciHeadStatus.spec.ts` › "status bar item opens the Checks tab", "toast buttons appear per capability"; both commands listed in both inventories.
- Done when: the tests pass, and Gate L, Gate G and Gate E pass, plus `bun run verify:manifest`. Minor bump with CHANGELOG "The status bar now shows your current commit's CI at a glance and keeps watching long builds, and one notification tells you when everything has finished, with buttons to open the checks, open the log, or re-run what failed."
- Review gate: reviewer checks completion-based stopping, the settled-HEAD detail fetches, the claim-before-toast order, the non-recursive `mkdir`, the focused-window rule and the request budget. R1 (Fable) review: async ordering and cross-window concurrency.

### Phase 14 — Failure annotations as Problems diagnostics (GitHub)
- Scope: new `src/services/commitChecks/ciDiagnostics.ts` (fetch, validation, publish, clear); `githubProvider.ts` (`getAnnotations`, paginated with `per_page=100` and `allowNext`; capability `annotations` true; `annotationCount` mapped); setting `intelligit.commitChecks.problemsDiagnostics` with NLS; Checks tab "Annotations" section (file:line list opening the file, "N annotations could not be placed", "Showing the first 1 000 annotations"); new `tests/e2e/ciDiagnostics.spec.ts` and its `test:e2e` entry; l10n; tests; version; CHANGELOG; docs (C1 wording).
- Depends on: 13; K7, K28, K32, C1 (resolved).
- Build: implement §11, driven by `HeadCiStatus` HEAD changes, its settled-HEAD detail fetches and generation bumps. The 403 text follows C1. Bump `CI_DETAIL_CONTRACT_VERSION` (R2 #16): `annotationCount` is a new persisted field.
- Tests: `tests/unit/services/commitChecks/ciDiagnostics.test.ts` › "maps levels and 1-based lines" (mutation: no −1 → red), "source is CI: <job>", "clears on HEAD move" (mutation: no clear → red), "discards a result that lands after HEAD moved" (mutation: no re-check → red), "sign-out during the annotations fetch publishes nothing" and "disable during the fetch publishes nothing" (mutation: no `isCurrent` → red), "only HEAD, only failed runs with annotationCount > 0" (mutation: fetch for all → red), "a settled detail cached before Phase 14 is a miss and annotations are fetched" (persistent cache seeded with a pre-bump entry without `annotationCount`; mutation: skip the version bump → no annotations fetched → red), "annotation requests carry per_page=100", "second annotations page fails → nothing published, unavailable shown", "rejects absolute, traversal, drive-letter and symlink-escape paths but keeps valid ones" (real temp dir with a symlink; mutation: skip `realpath` containment → red; skip the `..` check → red), "rejects end < start and non-integer lines" (mutation: accept → red), "403 leaves Problems empty and reports unavailable". E2E `tests/e2e/ciDiagnostics.spec.ts` › "Problems lists CI annotations and clicking opens the line".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "On GitHub, CI failures for your current commit now appear in the Problems panel on the exact file and line."
- Review gate: reviewer checks the HEAD-only rule, path containment, clearing on every lifecycle event, the contract-version bump, and the C1 wording. R1 (Fable) review: untrusted input (paths from the provider).

### Phase 15 — Optional CI column in the Git Log
- Scope: `src/webviews/react/CommitList.tsx` (column gate and header), `src/webviews/react/commit-list/CommitRow.tsx` and `CommitListRows.tsx` (cell; old badge hidden when the column is on), new `src/webviews/react/commit-list/CiColumnCell.tsx`, setting `intelligit.commitChecks.showCiColumn` with NLS and its plumbing to the webview, new `tests/e2e/ciColumn.spec.ts` and its `test:e2e` entry, l10n, tests, version, CHANGELOG, docs.
- Depends on: 4; K4.
- Build: implement §12, taking the width from frame `1:2`. The cell reads the same snapshot the badge reads [FACT: BRIEF.md:55]. Click → select the row and switch to the Checks tab.
- Tests: `tests/integration/webviews/commitCiColumn.integration.test.tsx` › "off by default, layout unchanged" (mutation: default true → red), "bar proportions and passed/total" (mutation: count pending as passed → red), "old badge hidden when column on" (mutation: render both → red), "click opens Checks tab". E2E `tests/e2e/ciColumn.spec.ts` › "column on in light and dark themes at narrow and wide pane widths keeps Author and Date visible"; CI `tests/e2e/gitLogLayout.spec.ts` stays green.
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "You can turn on a CI column in the Git Log that shows each commit's passed, failed and running checks as a small bar."
- Review gate: reviewer checks that column widths at narrow pane sizes do not push the deficit onto Author/Date (memory note "a layout fix pushes its deficit onto a sibling"). Root inspects the e2e width assertions.

### Phase 16 — CI bisect: "Find where CI broke"
- Scope: new `src/services/commitChecks/ciBisect.ts`, host handlers `startCiBisect` / `cancelCiBisect`, `CommitList.tsx` row context menu entry (sends selected commits with parents), new `src/webviews/react/commit-info/checks/BisectView.tsx` (sparkline per job, "broke at" or "not a straight line", flaky tag, progress, cancel, cap note), new `tests/e2e/ciBisect.spec.ts` and its `test:e2e` entry, l10n, tests, version, CHANGELOG, docs.
- Depends on: 12; K24, O3 (through Phase 12).
- Build: implement §13 using `ciHistory.brokeAt`, `flaky`, the §9 join and attempt histories. Confirm multi-row selection in `CommitList.tsx` first (§13 fallback). Read frame `4:2` for the layout.
- Tests: `tests/unit/services/commitChecks/ciBisect.test.ts` › "uses gate" (mutation: bypass → red), "cached commits cost no request" (mutation: force → red), "cancel stops queued" (mutation: ignore the token → red), "cancel with all four gate slots busy sends nothing more" (four held requests plus queued tasks; cancel; release; assert no further fetch; mutation: remove the in-callback check → red), "caps to loaded rows" (mutation: no intersection → red), "brokeAt only on a first-parent chain" (mutation: list order → red), "non-linear selection → linear false, brokeAt null" (mutation: ignore parents → red), "progress posted per commit", "disposal cancels". Integration › "bisect view shows cap note, not-a-straight-line note and flaky tag". E2E `tests/e2e/ciBisect.spec.ts` › "Find where CI broke from the row menu".
- Done when: the tests pass, and Gate L, Gate U, Gate G and Gate E pass. Minor bump with CHANGELOG "Select a range of commits and choose Find where CI broke to see, per job, the commit where it started failing."
- Review gate: reviewer checks cancellation inside the gate, the chain rule and the cap. R1 (Fable) review: concurrency (queued work after cancel or dispose).

### Phase 17 — Bitbucket Cloud: pipelines, steps, logs, cancel, header, usual
- Scope: `src/services/commitChecks/bitbucketCloudProvider.ts` (`getDetail` with pagination at `pagelen=100`, `allowNext` built from `normalizeBitbucketCloudNextUrl`, `continueFailedScan` for steps, `getJobLog` through `followRedirects` into the log store, `runAction` cancel only with the action fence, `getUsualDuration`; capabilities `runs`, `jobs`, `runHeader`, `logs`, `failureSummary`, `cancel` and `usualDuration` true; `credentialHeaders`; `writeScopeHelp` per C3; steps get `logicalId`), fixtures, tests, version, CHANGELOG, docs (C3 scope section).
- Depends on: 7, 8, 10; C3 (resolved), K20, K23, K32, K33, K36.
- Build: implement §15 (Cloud part). Pagination uses `paginate` with the body's `next` and the existing next-URL rule as `allowNext`; the snapshot path keeps calling the same rule. A 403 on pipeline discovery or on steps keeps the floor detail plus the hint (C3, #14). Bump `CI_DETAIL_CONTRACT_VERSION`.
- Tests: `tests/unit/services/commitChecks/bitbucketCloudDetail.test.ts` › "maps pipeline → steps as jobs" (mutation: steps capability true → red), "403 on pipeline discovery keeps flat list with hint" (mutation: unavailable → red), "403 on steps keeps flat list with hint" (mutation: unavailable → red), "second page fails → unavailable", "requests carry pagelen=100" (mutation: drop it → red), "failed steps past the bound are listed" (mutation: stop at the bound → red), "failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", "hostile next link: http, other host, other port, other path prefix" (mutation: ignore `allowNext` → red), "stopPipeline maps 403 to forbidden with pipeline:write help and removes the fence", "307 log redirect carries no Authorization" (mutation: bypass `followRedirects` → red), "usual baseline created before the selected pipeline" (mutation: newest success → red), "rerunFailed/rerunJob stay false" (mutation: set true → red).
- Done when: the tests pass, and Gate L, Gate G and Gate E (existing specs) pass. Minor bump with CHANGELOG "Bitbucket Cloud pipelines now show their steps, logs, timings and a Stop button in the Checks tab."
- Review gate: reviewer checks that no scope is requested up front, the C3 wording, the next-link rule, and the redirect path. R1 (Fable) review: authz and credential handling.

### Phase 18 — Bitbucket Server: builds endpoint with fallback, required builds, usual duration
- Scope: `src/services/commitChecks/bitbucketServerProvider.ts` (`getDetail` returning enriched `CiFlatCheck`s; new endpoint with the C4 fallback; `getRequiredChecks` via `required-builds/latest/.../conditions`; `getUsualDuration` from the previous build of the same `key`; capabilities `requiredChecks` and `usualDuration` true; everything else stays false; `otherChecksCoverage` from the builds reader, Codex R3 #10), the Checks tab's coverage note for the flat list (`src/webviews/react/commit-info/checks/CheckTree.tsx`), fixtures, tests, l10n, version, CHANGELOG, docs.
- Depends on: 9, 10; C4 (resolved), K32, K36.
- Build: implement §15 (Server part).
  1. Read `match` and the ref type first and confirm the ref already carries the project and repository keys [FACT: Codex #31; not re-read by this author]. If it does not, write that in the phase log and stop for Root; do not add remote parsing silently. Read the existing five-page builds reader [FACT: Codex R3 #10]: when it stops at its bound, the detail gets `otherChecksCoverage: {reason: "pageBound", shown}` and the tab shows "Showing the first N builds — open the commit in the browser for the rest" [PROPOSED wording]; add `limit=100` if its requests name no page size (K36). A detail with that coverage is never persisted and its settlement is `unknown` (§3).
  2. Duration per build from `duration` when present, else `updatedDate - createdDate`, else "—".
  3. Bump `CI_DETAIL_CONTRACT_VERSION`.
- Tests: `tests/unit/services/commitChecks/bitbucketServerBuilds.test.ts` › "404 on latest → legacy, memoised" (mutation: no memo → 2 latest calls → red), "403 does not fall back" (mutation: fall back → red), "required conditions map to blocks merge" (mutation: ignore → red), "duration, required and usual survive into the detail" (mutation: build the detail through the all-false floor adapter → red), "builds past the five-page reader set pageBound, are not persisted and show the banner" (fixture with more builds than the reader's bound; mutation: report `"full"` → persisted, no banner → red; Codex R3 #10). `commitChecksTab.integration.test.tsx` › "floor provider renders flat list without dead controls" extended with required tags and duration, and "flat list past the reader's bound shows the open-in-browser note".
- Done when: the tests pass, and Gate L, Gate U and Gate G exit 0. Minor bump with CHANGELOG "Bitbucket Server and Data Center builds now show their duration and which builds are required, and keep working on older servers."
- Review gate: reviewer checks that older servers keep working (the legacy path test) and that no Server control appears without a capability.

### Phase 19 — Durable action fence
- Scope: new `src/services/commitChecks/ciActionFence.ts` (§3 action fence, K30: `workspaceState` record with `before` and the stored `evidence` rule, in-memory mirror, `begin`, `fail`, `resolve`, `isFenced`, `endByUserRefresh`, the not-seen timer and a change event); `persistentCache.ts` and `detailPersistentCache.ts` (`isFenced` inside the `set` callback); `service.ts` and `detailService.ts` (a fenced hash is L1 only with the pending TTL; `actionFence` attached to the served detail at read time); `src/services/commitChecks/types.ts` (optional `actionEvidence(action)` on `CommitChecksProvider`; a provider without it gets `cancelled` for cancel, and re-run actions require it); `src/activation/repositoryMode.ts` (construct the fence store next to the detail service and load it before the first fetch); tests; version; CHANGELOG. No UI and no write calls: Phase 8 calls `begin`, `fail` and `endByUserRefresh`. Split out of Phase 1 (Codex R3 #13).
- Depends on: 1; K10, K30 resolved.
- Build:
  1. The record, the in-memory mirror and the awaited `workspaceState` write per §3 steps 1-3 and K30.
  2. `resolve(hash, detail)` with the four evidence rules of §3 step 4, as pure functions over `CommitCiDetailData` and the stored `before`.
  3. No age-based deletion anywhere (Codex R3 #1). `endByUserRefresh(hash, targetId)` deletes the fence only when its `notSeen` is true; otherwise it does nothing.
  4. Not-seen timer per §3 step 7: armed at `begin` and at activation from the stored `at`, fired at once when already past, cleared on resolve, fail and dispose; it fires a change event and sends no request.
  5. Both persistent stores call `isFenced` inside the `set` callback; both services serve a fenced hash from L1 only with the pending TTL and attach `actionFence`.
- Tests: `tests/unit/services/commitChecks/ciActionFence.test.ts` ›
  - "a fenced key is never persisted, even complete" (mutation: drop the fence check → red)
  - "a set queued before the fence but run after it is refused" (mutation: check at enqueue time → red)
  - "fence survives a new instance over the same workspaceState" (mutation: memory only → red)
  - "reopen after 8 days with the provider still returning the old execution: fence kept, result not persisted" (fake clock, new instance; mutation: delete fences older than 7 days → red; Codex R3 #1)
  - "GitHub: a run attempt rise or a move to queued/running ends a re-run fence" (mutation: end on any result → red)
  - "GitLab job retry: a newer job id with the same logical id in the same pipeline ends the fence, even when that job already finished" (mutation: watch the old job id for an attempt rise → red; Codex R3 #4)
  - "GitLab job retry: a newer job with another logical id does not end the fence" (mutation: accept any newer id → red)
  - "GitLab pipeline retry: a job id above before.maxJobId ends the fence"
  - "cancel fence ends when the target run is cancelled or complete"
  - "the evidence rule is read from the stored record after a restart" (stub provider whose declared rule changed; mutation: re-derive the rule from the provider → red)
  - "notSeen switches at 10 min by timer with no fetch" (fake timers; fetch spy stays at 0; mutation: compute notSeen only on a fetch → red; Codex R3 #5)
  - "timer re-armed after restart from the stored time" (new instance at 9 min; advance 1 min; mutation: arm from activation time → red)
  - "notSeen switches while the request gate is in cooldown" (mutation: tie the switch to a fetch → red)
  - "after 10 min reports notSeen and stays" (mutation: delete after 10 min → red)
  - "endByUserRefresh ends a not-seen fence and does nothing before" (mutation: end on any call → red)

  Also `detailService.test.ts` › "served actionFence follows the fence store" (mutation: omit it → red).
- Done when: the tests pass, and Gate G exits 0. Patch bump with CHANGELOG "Groundwork: IntelliGit can now remember a CI re-run or cancel across a restart, so an old result never comes back while the new run starts."
- Review gate: reviewer checks that the fence is awaited before any send path can run, that the check runs inside the `enqueue` callback, that no code deletes a fence by age, that each evidence rule matches §3 step 4, and that the timer is re-armed from the stored time. R1 (Fable) review: persisted format and async ordering.

### Dependency graph and waves

`Depends on:` lines (Revision 3: Phase 19 split out of Phase 1 and Phase 8 gains 19, Codex R3 #13; the rest unchanged): 1 → none; 2 → 1; 3 → 2; 4 → 1; 5 → 2; 6 → 2; 7 → 3, 4, 6; 8 → 3, 4, 19; 9 → 3, 4; 10 → 3, 4; 11 → 4, 9; 12 → 11; 13 → 7, 8; 14 → 13; 15 → 4; 16 → 12; 17 → 7, 8, 10; 18 → 9, 10; 19 → 1.

Wave shape `phase-run` derives from those lines, taking ready phases lowest id first, at most 3 per wave [ASSUMED: phase-run's ordering among ready phases; the graph above is what binds]:
- Wave 1: 1
- Wave 2: 2, 4, 19
- Wave 3: 3, 5, 6
- Wave 4: 7, 8, 9
- Wave 5: 10, 11, 13
- Wave 6: 12, 14, 15
- Wave 7: 16, 17, 18


## Risks / open questions

**Resolved by the owner, 2026-11-07 (Codex Round 1 #30).** Each narrows a locked feature, so the owner decided. Answers: O1 the 1 000-item bound plus "failed jobs always kept"; O2 50 MB; O3 the estimated fallback. Kept below for the reasoning; the contract table holds the rules.

- **O1 — Pagination bound per collection.**
  - Impact: feature 1 (tree), feature 4 (annotations) and feature 15 (attempts). A run with more than 1 000 jobs, or a check run with more than 1 000 annotations, shows only the first 1 000.
  - Reproduction: a GitHub workflow with a matrix over 1 000 jobs, or a GitLab pipeline with over 1 000 jobs; the jobs list has more than 10 pages at `per_page=100`.
  - Proposed: keep the bound at 10 pages × 100 items per collection; the tree shows "Showing the first 1 000 jobs — open the run in the browser for the rest" with Open in browser. Alternative: no bound (read every page; cost: one request per 100 items, through the gate).
  - Blocks: Phases 2 and 3, and through them 5-14 and 16-18.
- **O2 — Per-log size bound.**
  - Impact: feature 3. A log over 50 MB opens truncated.
  - Reproduction: a GitHub job whose log is over 50 MB (for example a verbose test run); download it with Open full log.
  - Proposed: keep 50 MB; the log text ends with "[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]" and the detail shows Open in browser. Alternative: no per-log bound (a single very large log would be held in memory whole).
  - Blocks: Phase 6, and through it 7, 13, 14 and 17.
- **O3 — Flaky fallback where re-run attempts are unavailable.**
  - Impact: feature 15. On Bitbucket Cloud and Server (and on GitHub/GitLab if `filter=all` / `include_retried` turn out not to exist), "failed then passed on the same commit" is not detected.
  - Reproduction: on Bitbucket Cloud, re-run a failed pipeline on the same commit so it passes; the flaky tag counts only isolated reds.
  - Proposed: keep the fallback; the tooltip says "re-runs not counted for this provider" so the user can see the difference. Alternative: hide the flaky tag on providers without attempt history.
  - Blocks: Phases 12 and 16.

**Resolved by the owner, 2026-11-07** (kept for the reasoning; see the contract table for the rules).

- **C1 — GitHub annotations and token types.** The docs name Checks read for GitHub App tokens and `repo` for OAuth/classic tokens on private repositories [FACT: Codex #33]. IntelliGit uses VS Code's GitHub session [CODE: src/types.ts:155-156], an OAuth token [ASSUMED: scope list at githubProvider.ts:116 per ideas.md:85], so the docs describe classic `repo`; a 403 shows "Annotations unavailable with this token". Carried by Phase 14.
- **C2 — GitHub required checks.** Union of rules and protection, "partial"/"unknown" when protection is refused. Carried by Phase 9.
- **C3 — Bitbucket Cloud `pipeline` scope.** No scope requested up front; the hint on a 403 from discovery or steps; a README section on `pipeline` and `pipeline:write`. Carried by Phase 17.
- **C4 — Bitbucket Server endpoint fallback.** Carried by Phase 18.
- **Path C and K13 (Codex Round 2 #5, #6, #10, #11, #12; Round 3 #2).** The owner chose to simplify: logs held in memory per window instead of a hardened shared disk store. Toast claims, first given a 90-day retention, are now never pruned (owner 2026-11-07, Codex R3 #2), so no sweeper exists to race a new claim. Carried by Phases 6, 7 and 13.

**Other risks, each with its cheapest early check**

- **Peak memory per window from logs.** The store holds at most 3 × 50 MB (plus the marker line), VS Code holds its own copy of every open log tab, and downloads in flight hold up to 50 MB each until they finish; chunk concatenation briefly doubles one log [ASSUMED: V8 stores plain-ASCII text at one byte per character; a log with non-Latin-1 characters can take twice as much]. A user who opens many large logs can push one window's extension host into the hundreds of MB. Cheapest check: the Phase 6 test that the store never holds more than three entries, and in Phase 7 the builder records the extension host's heap after opening four 50 MB fixture logs in the phase log. If it is unacceptable, lowering `MAX_CI_LOGS_IN_MEMORY` is a one-constant change.
- **VS Code keeps a content-provider document's text while its tab is open** [ASSUMED]. If it re-asks the provider (for example after the tab is hidden for a long time), an evicted log is downloaded again in the same window (the `sources` record makes that work) rather than breaking. Cheapest check: Phase 7 e2e "first tab keeps its text after a fourth log is opened".
- **`mkdir` atomicity on unusual home folders.** `mkdir` is atomic on local file systems; on a network-mounted home folder [ASSUMED: atomic on common network file systems, not verified] two windows could both succeed. Cheapest check: the Phase 13 interleaving test on a local temp directory; remote setups stay unverified and fall back to the focused-window rule.
- **The request gate may not expose its cooldown end** [ASSUMED]. The overflow scan's pause and resume need it. Cheapest check: Phase 2 step 1 reads `requestGate.ts`; if absent, a read-only accessor is added there.
- **An action fence the provider never resolves** keeps that hash uncacheable (L1 only, shown as "not seen yet — Refresh") and polled on the pending ladder until the user clicks Refresh on that label; nothing deletes it by age (Codex R3 #1). Cost: refetches for that one commit while it is shown or is HEAD, and one small `workspaceState` record until then. Cheapest check: the Phase 19 test "reopen after 8 days with the provider still returning the old execution".
- **Toast claims are never removed** (K13, Codex R3 #2). Each toasted HEAD hash leaves one empty directory under `<globalStorageUri>/ci-toast-claims/` for good. The extension never lists that directory (a claim is a `mkdir` on a known name), so the count costs only file-system entries; uninstall removes them with the rest of global storage [ASSUMED, as under Rollback]. Cheapest check: the Phase 13 test "claims are never pruned and have no count cap". Pruning later would need a cross-window lock, which is why none exists.
- **`ciHistory.ts` lives in `src/services/` but its tags render in the webview** [ASSUMED: the host computes the tags and returns them with the `ciHistory` reply, or the pure functions move to `src/shared/ci/`]. Cheapest check: `bun run architecture:check` in Phase 11; if the webview needs `compare`, move the pure functions to `src/shared/ci/history.ts` in that phase.
- **`src/shared/ci/` is reachable from both sides** [FACT: Root probe 2026-11-07 — a throwaway `src/shared/ci/probe.ts` imported from `src/webviews/react/` and from `src/services/` passed `bun run typecheck:webview`, `bun run typecheck:ext` and `bun run architecture:check`; probe removed]. `tsconfig.webview.json` lists only `src/webviews/react/**` and `src/types.ts` as roots, but follows imports. Phase 1 step 1 still runs the same three commands on the real module.
- **E2E needs a provider stub.** Real providers cannot be called from CI e2e. Cheapest check: Phase 4 step 1 looks at `tests/e2e/fileContextGitHub.spec.ts` for an existing stub path before any UI work.
- **The Impeccable affected-path detector** is `npx --yes impeccable detect <changed UI paths>` [FACT: earlier plans docs/superpowers/plans/2026-09-30-issue-286/PLAN.md:243 and 2026-08-27-editable-diff-performance.md:676; AGENTS.md:67-71 names the requirement but not the command]. Every UI phase runs it on its own changed webview paths.
- **A new command lands in two e2e inventories:** `tests/e2e/coverage-manifest.ts` (one entry per command id, with `mutating:`) and `scripts/knownManifestCommands.json` (read by `scripts/verifyNoE2eManifestCommand.js`) [FACT: finder lane 2026-11-07]. `tests/unit/e2e/coverageManifest.test.ts` may pin counts [ASSUMED: not re-read]; Phase 13 updates it if so.
- **Requests already queued in the gate cannot be cancelled by the gate itself** [FACT: Codex #25; requestGate.ts:219-232 not re-read]. The bisect checks cancellation inside the callback. Cheapest check: the Phase 16 "four slots busy" test.
- **`globalState` size.** The detail cache (200 entries) lives in `globalState`, which VS Code loads at startup. Cheapest check: Phase 1 logs the serialized size of a 200-entry detail cache from the GitHub fixture; if it exceeds 1 MB, lower the entry count before Phase 2 [PROPOSED threshold].
- **Assumed provider parameters:** GitHub `check_run_url`, `Link` paging, `filter=latest`, `filter=all` and the `created` filter; the GitLab pipeline `name` field (GitLab `scope[]=failed`, `include_retried` and `created_before` are now FACT, see Current state); Bitbucket Cloud `pagelen=100` as the maximum; each provider's API path prefix for `allowNext`. Confirm on the docs pages and fixtures before Phases 2, 3, 10, 12 and 17; each has a stated fallback.
- **Log markers (`##[error]`, `ERROR: `) are assumed.** Phase 7 fixtures settle them; the fallback chain keeps the feature working.
- **GitLab "required" source (`only_allow_merge_if_pipeline_succeeds`) is assumed.** If it is unreadable with `read_api`, GitLab shows "required: unknown" and keeps "optional".
- **The read-only diff provider may only serve commit-vs-parent.** Phase 12 step 1 checks and extends it.
- **Duplicated cache logic** between the snapshot and detail services can drift. Cheapest check: the Phase 1 tests mirror the existing service's generation and in-flight tests.
- **Parallel waves conflict** on `package.json` version, `CHANGELOG.md`, l10n catalogs and the provider files (Wave 4 edits `githubProvider.ts` and `gitlabProvider.ts` in three phases). The merge step resolves them per the Phases preamble. Cheapest check: the Wave 2 merge.
- **A stuck queued job is polled every 120 s while HEAD stays on it.** ETag makes it free on GitHub; on other providers it costs 30 requests an hour. The status bar tooltip shows how long it has been waiting.
- **Re-runs started in the browser** do not reach a complete commit cached for 24 h. Existing behaviour; Refresh forces a fetch.
- **Required checks use the default branch.** A commit aimed at another base shows the default branch's rules; the header names the branch.
- **`format:check` can fail on untracked output folders** (memory note "untracked output/ fails prettier"). Builders keep generated output out of the tree before Gate G.

## Out of scope

- An Activity Bar container, a bigger popover, and an Output channel for CI logs (ideas.md §5).
- Requesting wider token scopes up front.
- "Run pipeline again" for Bitbucket Cloud. It is not a re-run of failed jobs and is not in the locked list.
- Mapping annotations for non-HEAD commits through blame or diff (feature 4 is HEAD only).
- Changing the webview poll ladder's intervals.
- Live updates for re-runs started outside IntelliGit on already-complete commits (existing 24 h cache behaviour).
- Fixing GitLab statuses paging on the existing snapshot path (`per_page=100`, no paging, ideas.md:19). Mentioned, not fixed; Phase 3 pages the new pipeline and job calls only.
- Sharing downloaded CI logs between windows, or keeping them across a reload or restart (owner path C, 2026-11-07).

## Sources and provenance

- `docs/superpowers/plans/2026-11-07-ci-checks-tab/BRIEF.md` (whole file, read 2026-11-07, including the updated excerpt rule at :16).
- `docs/superpowers/plans/2026-11-07-ci-checks-tab/PLAN-REVIEW-LOG.md` "## Round 1" (Codex findings #1-#36) and "### Claude's response (Round 1 triage)", read 2026-11-07. Every FIXED item is applied as the triage states; #7 follows the triage, not Codex; #30 is O1-O3.
- `docs/superpowers/plans/2026-11-07-ci-checks-tab/PLAN-REVIEW-LOG.md` "## Round 2 — Codex" (findings R2 #1-#20) and "### Claude's position (Round 2 …)", and `REVISION-2-BRIEF.md` (owner path C, 2026-11-07), read 2026-11-07. Round 2 findings are cited in this plan as "R2 #n" or "Codex R2 #n"; Round 1 findings keep their bare "#n". Round 2 ledger:

| R2 # | Status | Where |
|---|---|---|
| 1 | FIXED — atomic `mkdir` claim | §10, K13, Failure and recovery, invariant 10, Phase 13 |
| 2 | FIXED — durable action fence | §3, §6, K30, journey 6, invariant 2, Phases 1, 8 |
| 3 | FIXED — `clear()` inside `enqueue` | Current state, §3, invariant 21, Phase 1 |
| 4 | FIXED — `allowNext` continuation guard | §3, K33, invariant 19, Phases 2, 3, 12, 14, 17 |
| 5 | FIXED-BY-REDESIGN — in-memory log store, no lock | §5, K16, Phase 6 |
| 6 | FIXED-BY-REDESIGN — no cross-window eviction | §5, K16, Phase 6 |
| 7 | FIXED — `coverage` separate from `complete` | §2, §3, K34, invariant 20, Phases 1, 4 |
| 8 | FIXED — resumable, pausable overflow scan | §3, Failure and recovery, invariant 22, Phases 2, 3, 4, 17 |
| 9 | FIXED — page size on every bounded collection | §3 table, K36, Phases 2, 3, 10, 12, 14, 17, 18 |
| 10 | FIXED-BY-REDESIGN — bound truncates, never refuses | §5, K17, invariant 7, Phase 6 |
| 11 | FIXED-BY-REDESIGN — nothing on disk to orphan | §5, K16 |
| 12 | RESOLVED by the owner — 90-day retention; superseded by Codex R3 #2 (claims never pruned, owner 2026-11-07) | K13, Risks |
| 13 | FIXED — logical identity across commits | §2, §9, K35, Phase 11 |
| 14 | FIXED — histories per run and logical job | §2, §9, K35, Phase 12 |
| 15 | FIXED — detail for settled failing HEAD and at settlement | §3, §10, K26, journey 4, Phase 13 |
| 16 | FIXED — Phase 14 bumps the contract version | §11, K32, Phase 14 |
| 17 | FIXED — `previewCiLog` | §4, §5, K3, K18, journey 5, Phase 7 |
| 18 | FIXED — default-branch tip read on demand | §8, K22, journey 9, Phase 9 |
| 19 | FIXED — `created_before` with `order_by=id` (verified in the GitLab docs 2026-11-07) | K23, Phase 10 |
| 20 | FIXED — overflow acceptance tests per provider | Edge cases, Phases 2, 3, 4, 17 |

- `docs/superpowers/plans/2026-11-07-ci-checks-tab/PLAN-REVIEW-LOG.md` "## Round 3 — Codex" (findings R3 #1-#13) and "### Claude's position (Round 3)", and `REVISION-3-BRIEF.md` (owner 2026-11-07: fix all 13, permanent toast claims), read 2026-11-07. Round 3 findings are cited as "Codex R3 #n". Round 3 ledger:

| R3 # | Status | Where |
|---|---|---|
| 1 | FIXED — no age-based fence deletion; a fence ends on evidence or the user's Refresh on "not seen yet" | §3 step 6, K30, Failure and recovery, journey 6, Choices, Hardcoded vs dynamic, Risks, Phases 8, 19 |
| 2 | FIXED — toast claims never pruned (owner 2026-11-07) | §10, K13, Failure and recovery, Choices, Hardcoded vs dynamic, Risks, Phase 13 |
| 3 | FIXED — detail `invalidate(hash)` before the settlement fetch | §3, §10, K26, Phase 13 |
| 4 | FIXED — provider evidence rule stored with the fence; GitLab newer job id | §3 step 4, K30, Phases 8, 19 |
| 5 | FIXED — fence-driven polling; timer-driven "not seen yet" | §3 step 7, §10, K26, K30, Phases 8, 13, 19 |
| 6 | FIXED — `onDidChange` when a load replaces placeholder text | K19, Failure and recovery, Phases 6, 7 |
| 7 | FIXED — ETag entry keeps pagination headers; quota from the fresh 304 | §3, K12, Failure and recovery, Phase 5 |
| 8 | FIXED — gate cooldown or budget error after acquisition = paused | §3, Failure and recovery, Phase 2 |
| 9 | FIXED — non-full run or flat coverage makes settlement `unknown` | §2, §3, §10, K26, K34, Phases 1, 13 |
| 10 | FIXED — `otherChecksCoverage`; the Server builds reader reports `pageBound` | §2, §3 table, K34, Phases 1, 18 |
| 11 | FIXED — name fallback unique in both populations | §9, K35, Phase 11 |
| 12 | FIXED — changed-since-green carries `logicalCheckId` and `scopeName` | §4, §14, K24, Phase 12 |
| 13 | FIXED — durable action fence split into Phase 19 | Goal, Phase 1, Phase 19, Phase 8 Depends on, waves |

- `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/fable/ideas.md` (read for the first version of this plan).
- Design HTML `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/9de5de96-fd19-45fb-beee-4eff2daffbf7/scratchpad/design/checks-tab.html` and Figma https://www.figma.com/design/sB9RPn3wTLcbpWZIwKyrUB frames `1:2`, `2:2`, `3:2` and `4:2`. Not read by this author; Root's check is cited under Reference behaviour.
- `~/.claude/skills/plan-standard/SKILL.md` (template and rules).
- `AGENTS.md` (repository root, whole file, read 2026-11-07): localization, TSDoc, pre-commit validation, Impeccable.
- Code read at `main` `846f8506` for the Round 1 revision:
  - `src/services/commitChecks/service.ts` (whole file)
  - `src/services/commitChecks/persistentCache.ts` (whole file)
  - `src/services/commitChecks/normalize.ts:1-140`
  - `src/services/commitChecks/http.ts:1-95`
  - `src/activation/repositoryMode.ts:235-279`
  - `src/types.ts:120-169`
  - `.dependency-cruiser.cjs:1-86`
  - `package.json:1615-1663`
- Code read for the first version and still cited: `src/services/commitChecks/coordinator.ts:1-90`, `src/services/commitChecks/types.ts:1-33`, `src/services/commitChecks/requestGate.ts:1-80`, `src/webviews/react/commit-list/checksRefresh.ts:1-72`, `src/webviews/react/commit-info/CommitInfoPane.tsx:135-264`, search hits for `Authorization` in `githubProvider.ts:133`, `bitbucketCloudProvider.ts:167-170`, `bitbucketServerProvider.ts:4, :186-187`, and `tests/e2e/coverage-manifest.ts:514`.
- Cited from Claude's Round 2 position, not re-read by this author: `persistentCache.ts:117-119` (`clear()` outside `enqueue`), `bitbucketCloudProvider.ts:229-241` (`normalizeBitbucketCloudNextUrl`).
- Cited from Codex Round 1 and Root's triage, not re-read by this author: `requestGate.ts:219-232` (#25), `CommitList.tsx:548-554` (#18), `diffService.ts:866-907` (#22), the Bitbucket Server ref fields (#31). Root spot-checked `normalize.ts:39-42`, `service.ts:81-82`, `persistentCache.ts:99`, `.dependency-cruiser.cjs:29-32` and `checksRefresh.ts:6-8, :26`.
- Cited from the brief, not re-read: `CommitList.tsx:441-457, :511, :521, :569, :719`; `CommitRow.tsx:542-550`; `CommitListRows.tsx:113-116`; `CommitChecksPopover.tsx`; `diffService.ts:174-178`; `extension.ts:41`; `bitbucketServerProvider.ts:237`; `gitlabProvider.ts:29-35, :225`; `githubProvider.ts:116`.
- Provider docs as listed in BRIEF.md:66-90, checked by a web-research lane on 2026-11-07: https://docs.github.com/en/rest/actions/workflow-runs, https://docs.github.com/en/rest/actions/workflow-jobs, https://docs.github.com/en/rest/checks/runs, https://docs.github.com/en/rest/branches/branch-protection, https://docs.github.com/en/rest/repos/rules, https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api, https://docs.gitlab.com/api/jobs/, https://docs.gitlab.com/security/tokens/access_token_scopes/, https://api.bitbucket.org/swagger.json, Atlassian BSERV-13381 and BSERV-19724. Added from Codex Rounds 1 and 2 (not opened by this author): https://docs.gitlab.com/api/pipelines/ (including `#list-project-pipelines`), https://docs.gitlab.com/api/rest/#pagination, https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/, https://docs.github.com/en/rest/checks/runs#list-check-run-annotations, https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run.
- Memory notes referenced, by title only: "native modal is invisible to Playwright", "exclusive create answers EPERM", "a new command must land in two e2e inventories", "a layout fix pushes its deficit onto a sibling", "untracked output/ fails prettier".
