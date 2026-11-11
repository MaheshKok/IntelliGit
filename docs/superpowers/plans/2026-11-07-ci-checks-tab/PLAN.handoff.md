# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Earlier build records, the Phase 3 GitNexus answer and the Phase 5 impact run: git history of this file (650a6919) and PLAN.review-log.md.

## Phase 5: review pending, started at 15a47c9d68fbe1646bfe02e50752f00d5d7a2709
- 15a47c9d is on the pre-squash Phase 3 branch, not an ancestor of HEAD. The build sits on 650a6919 (c246d0d4 + the GitNexus record), so review 650a6919..HEAD.
- Built: `EtagStore` (etagStore.ts: LRU of 500 `{etag, body, pagination}` keyed `${authGeneration}\0${url}`); `createHttpGetJsonWithMeta(…)(url, headers, conditional?)` sends `If-None-Match`, answers a 304 with the stored body and stored `link` / `x-next-page`, re-requests a body-less 304 once without the header, stores a 200 with an `ETag`; `gatedFetchWithMeta` forwards the store; GitHub and GitLab snapshot and detail reads pass it only for commits whose last read was incomplete. `createCommitChecksProviders` gains a 4th parameter `generations` (repositoryMode.ts passes `ciGenerations`). Patch 0.43.7, CHANGELOG, README "Rate limits and caching".
- GitNexus: the impact run recorded in 650a6919 under the owner's "A: use old map"; do not halt on PLAN.md:844 for Phase 5.

## Decisions and why
- Which commit is incomplete is remembered inside the store per provider key and hash (`forCommit` / `noteCommit`, detail keys end `#detail`), because the coordinator and detailService are off limits (delivery lead) and `getChecks(ref, hash)` carries no state. Cost: a commit's first read is unconditional, the second stores the etag, savings start from the third poll.
- Key and stored entry are taken when the request is sent, so a 304 answers the etag that was sent and a 200 is stored under the auth generation whose token read it.
- The stored body is raw JSON text, parsed anew per 304: `fetchAllCheckRuns` pushes later pages into the first page's array, so a shared parsed object would grow on every poll (test "multi-page check runs polled with 304s are never counted twice").
- Auth generation read live as `generations.capture("").authGeneration`; `bumpAuth` makes the next key new, so no body crosses a sign-in.
- The body-less-304 re-request runs inside the same gate slot (one slot, two requests); both responses reach the observer.
- Non-conditional paths unchanged: `FetchJson`, `createHttpGetJson`, and every request when no store is passed (additive).

## Open risks
- Bitbucket Cloud and Server are not conditional: they have no metadata fetch yet. Phases 17 and 18 can pass the store.
- The key follows `bumpAuth` (called from refreshCommitCheckBadges, repositoryMode.ts); a token change that does not reach `bumpAuth` keeps the old generation, so a 304 could still reuse a body read with the previous token for the same URL. Not checked which sign-in paths skip it.
- The incomplete-commit set is an LRU of 500 per window; a commit pushed out reads unconditionally once.

## Next phase
- Phase 6 (wave 3: 3, 5, 6).

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on 05085924 too.
- GitHub carryScans also treats two missing `runAttempt` values as the same run; a GitHub-scope fix if run_attempt can be absent.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; localization.test.ts:352 slow with many worktrees.
- `bun run package` can pack ignored leftovers under `output/` (88 entries).
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the fixture socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- tsconfigCoverage and screenshotComparatorMeta resolve tools at <repo>/node_modules, failing in a worktree without its own.
- GitNexus index is behind HEAD (last indexed 64d390b); the worktree guard refuses compound commands naming git paths.
- Bitbucket conditional requests (Phase 5 covers GitHub and GitLab only); wire the store when Phases 17/18 add metadata fetches.
