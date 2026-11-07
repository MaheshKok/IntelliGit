# Revision 2 brief — CI Checks tab plan (after Codex Round 2)

Owner decision, 2026-11-07: **path C — simplify, fix, review once more.** Revise `PLAN.md` in place. Every rule in `BRIEF.md` still holds (hardcoded vs dynamic: a value is read at run time from its source of truth and fails loudly when missing; deliberate design constants stay plain constants).

Source of each finding: `PLAN-REVIEW-LOG.md` → "## Round 2 — Codex" (findings #1–#20, numbered as there) and "### Claude's position (Round 2 …)". Apply Claude's position for every finding, with the design change below replacing the disk log store.

## 1. Design change: per-window in-memory log store (replaces §5 disk store)

Removes Codex #5, #6, #10, #11 by construction. Mark them FIXED-BY-REDESIGN.

- **Delete** from the plan: `context.globalStorageUri/ci-logs/`, the `.lock` directory lock, reservations, `.part` files, rename-to-publish, the 200 MB directory cap (K17), the 24 h sweep, `ciLogStore.twoProcess.test.ts`, the "another window is busy" and "space cannot be reserved" failure rows, the journey-5 disk refusal message, and `downloadToFile`. Rewrite K16/K17 and every test row, failure row, recovery row and phase scope that names them (pointers: PLAN.md lines ~157-158, 364-369, 556-557, 595, 620, 651-655, 680, 821-827).
- **New store** `CiLogMemoryStore` (extension host, one per window, created in `repositoryMode.ts` next to the detail service, disposed with it):
  - LRU of at most 3 logs (`MAX_CI_LOGS_IN_MEMORY = 3`, a deliberate design constant). Key = the same sha256 log key as today.
  - Download with `downloadToString(url, headers, maxBytes, signal)` in `http.ts`, built on the same request core and redirect rules (K20) as the rest. A byte counter stops at the O2 bound (50 MB); the marker line "[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]" is appended after the stop, and `truncated: true` is set. Known Content-Length larger than the bound is NOT refused: it downloads up to the bound and truncates (fixes the old #10 shape).
  - In-window join map: two requests for the same key share one download.
  - Only complete (settled) jobs are stored; a running job replies `outcome: "running"` as today.
  - Served to the editor through a `TextDocumentContentProvider` on the existing `intelligit-ci-log:` scheme. VS Code copies the text into its document, so the store needs no pinning: eviction never breaks an open tab. Reopening a closed tab after eviction re-downloads.
  - Restart or window reload = empty store; logs re-download on demand. State this in Current state / journeys as the accepted cost.
  - Peak memory per window: at most 3 × 50 MB in the store plus VS Code's copies of open tabs. Add one row to Risks.
- Tests (unit, fake transport): LRU evicts the least-recent of 4; join map makes one request for two concurrent opens; byte bound truncates both a known-length 300 MB response and an unknown-length stream and appends the marker exactly once; a reopened evicted log triggers a new download; nothing touches the file system (assert no `fs` import in the store module).

## 2. Other Round 2 findings — apply Claude's position

- **#1** Toast claim: atomic cross-process claim by `fs.mkdir(<globalStorageUri>/ci-toast-claims/<sha256(repoKey+hash)>)`; `EEXIST` = another window already toasted. Claims older than 90 days are removed at activation. Test the exact interleaving Codex names (A and B both pass the focus check, one mkdir wins). Keep the focused-window rule.
- **#2** Durable action fence: before sending re-run/cancel, write `{repoKey, hash, targetId, action, at}` to `workspaceState`; while it exists, results for that target are volatile (L1 only, no persistent cache) and the UI shows "waiting for re-run to start". It clears only when the provider shows the action took effect (new attempt id / state change). No silent 120 s expiry; after 10 min unresolved, show "re-run not seen yet — Refresh" (state stays visible). Survives restart. Update K30.
- **#3** `persistentCache.clear()` goes through `enqueue` (confirmed bug: `persistentCache.ts:117-119`). Test: generation change while an old `set` is queued → the old entry never reappears.
- **#4** Continuation-URL guard: `paginate` takes `allowNext(url): boolean` per provider, generalising `normalizeBitbucketCloudNextUrl` (`bitbucketCloudProvider.ts:229-241`): https only, same host as the configured API base, path under the same API prefix. A rejected link stops paging and marks coverage incomplete; credentials are never sent. Hostile-link tests per provider.
- **#7** Separate `coverage: "full" | {reason: "pageBound", shown}` from execution `complete`. Data with `coverage !== "full"` may be shown but is never written to the immutable persistent cache as full; banners read from `coverage`.
- **#8** Failed-item overflow scan keeps its progress (next URL + found items) in the in-memory detail entry, pauses visibly when the request gate cools down ("Loading more failed jobs — paused for rate limit"), resumes with run-identity checks, keeps all failed items found.
- **#9** Every bounded collection request names `per_page=100` (or the provider's equivalent, e.g. Bitbucket `pagelen=100`); list them in §3.
- **#12** RESOLVED by the owner 2026-11-07 (picked path C, which carried Claude's recommendation): toast claims kept 90 days. Write it into K13 as RESOLVED with that reason.
- **#13** Logical check identity for cross-commit matching (`workflowName + jobName` / `pipelineName? + jobName`, provider check name for status-only checks); execution ids only for dedup inside one commit. Unique-name fallback stays.
- **#14** Attempt history keyed by logical identity scoped to its workflow/pipeline; chronological normalisation per provider stated; test colliding names and attempt numbers.
- **#15** Detail is fetched for a settled failing HEAD on first load and once more on the pending→settled transition before the monitor stops.
- **#16** Phase 14 bumps `CI_DETAIL_CONTRACT_VERSION` (add 14 to K32's list); test upgrading a pre-existing settled cache.
- **#17** New `previewCiLog` webview→host message (run id, job id, selection token) that fills the in-memory store and returns only the bounded escaped excerpt, no editor open; stale-selection test (A selected, B selected before A's reply → A's reply dropped).
- **#18** Default-branch tip resolved on demand per comparison (no lifecycle-generation cache).
- **#19** GitLab baseline: use `created_before` if the GitLab pipelines docs list it [mark ASSUMED, verify in the phase fixture]; otherwise `updated_before` plus a client-side creation-time filter. State both.
- **#20** Acceptance tests with failed jobs past the 1 000 cutoff per provider, filtered pagination (GitLab `scope[]=failed`), interruption and resume; UI and cache assertions.

## 3. Bookkeeping

- Provenance line: "revised after Codex Round 2 (path C)".
- Phase scopes, Depends-on lines and waves updated if Phase 6 shrinks or any phase changes; keep at most the current 18 phases unless a split is forced by size.
- Every changed contract row stays RESOLVED with its source (`Codex R2 #n`).
- Do not touch C1–C4 or O1–O3 decisions.
