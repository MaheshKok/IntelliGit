# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Earlier build records, the Phase 3 GitNexus answer and the Phase 5 impact run: git history of this file (650a6919) and PLAN.review-log.md.

## Phase 5: review pending, started at 15a47c9d68fbe1646bfe02e50752f00d5d7a2709
- 15a47c9d is on the pre-squash Phase 3 branch, not an ancestor of HEAD. The build sits on 650a6919, so review 650a6919..HEAD.
- Built in 20b1c353: `EtagStore` (LRU 500, key `${authGeneration}\0${url}`), conditional `createHttpGetJsonWithMeta`, GitHub and GitLab snapshot and detail reads conditional for incomplete commits. Patch 0.43.7.
- Fix round 1 (this commit) clears all five Codex findings:
  - Each entry records `requestHash`, a SHA-256 of the request headers (token included) it was read with; a request whose headers differ never sends that etag and never gets that body. Covers a request queued under an old token (finding 1) and a token changed by another window (finding 2).
  - The body-less-304 re-request is its own gated request: `gatedFetchWithMeta` = `recoverBodylessNotModified` over a gated `createConditionalRequest`, so the gate admits, counts and cooldown-checks it (finding 3).
  - The re-request strips `If-None-Match` in any letter case (finding 5).
  - Bitbucket Cloud and Server snapshot reads are conditional for incomplete commits (finding 4; plan §3 line 399). Server's commit key is host + hash, the scope of its global build-status endpoint.
- GitNexus: the impact run recorded in 650a6919 under the owner's "A: use old map"; do not halt on PLAN.md:844 for Phase 5.

## Decisions and why
- Credential binding by a header digest in the entry, not by bumping `CiGenerations.bumpAuth` on a detected token change: bumpAuth also fences the snapshot, detail and action caches, a wider effect than this phase owns. The key stays `${authGeneration}\0${url}` (K12 verbatim); the digest only adds a check.
- The re-request runs after the first slot is released (two admissions), never nested inside the slot: nesting would deadlock when all four slots retry at once.
- Codex's scratch test "bodyless-304 retries count against the fallback request budget" expects 300 such reads to succeed, which honest counting cannot allow (each read costs two admissions). Replaced by a test that 150 reads use the 300 budget and read 151 is refused with 429.
- Incomplete-commit memory per provider key and hash (`forCommit` / `noteCommit`) as before; first read unconditional, savings from the third poll.

## Open risks
- The incomplete-commit set is an LRU of 500 per window; a commit pushed out reads unconditionally once.
- A token change that keeps identical headers is impossible by construction; any header change (Accept included) makes the next request unconditional once.

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
- tsconfigCoverage and screenshotComparatorMeta resolve tools at <repo>/node_modules; they pass once the worktree has its own install (`bun install --frozen-lockfile`).
- GitNexus index is behind HEAD (last indexed 64d390b); the worktree guard refuses compound commands naming git paths.
- Bitbucket detail reads (Phases 17/18) should pass the same store when they add metadata fetches.
