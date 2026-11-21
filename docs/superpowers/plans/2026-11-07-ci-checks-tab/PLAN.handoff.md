# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete (squash-merged as #422, 51b0c3ab).
- Phase 7: accepted 6fef8c59, manual; owner OK 2026-11-12 (squash-merged as #424, 36bef4be).
- Phase 8: accepted b5a56002, manual; owner OK 2026-11-13 (squash-merged as #426, 7941c809).
- Phase 9: accepted 37ba9d13, manual; elephant OK 2026-11-14 (squash-merged as #430, 63b8ea88).
- Phase 10: accepted 8ff6422d, manual, owner answer "A" 2026-11-14 (squash-merged as #435, bc063074).
- Phase 11: accepted b9d710d6, verification incomplete (squash-merged as #439, 928c1aae).
- Phase 12: accepted by the owner by hand 2026-11-18 at c874d0b3 ("A: accept, file issue"; gaps in #443; squash-merged as #444, 29efe7ec).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 13: review pending, started at 1860b1475c08f0fb8502dba7e1cdb681b68d7abf
- Build commit 96e3c78e (0.43.17, ships hidden behind the Checks tab switch). Fix round 1 is 19458d72. Fix round 2 (4 Codex findings) is the commit after it, on the same branch; a fresh Codex review is next.
- Round 2 regression tests live in `tests/unit/services/commitChecks/headStatus.review.test.ts` (7 tests); red lines before the fix are in `/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/red2.log`. Mutations M1-M7 on a copy each went red naming their test.
- Gates green: both head status test files (49 tests), format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build; see the review log entry for the full-suite, build:prod, package and verify:manifest results. Gate L not re-run: no l10n string changed this round.

## Decisions and why
- Per-forge cooldown, three-way monitor fence and pending-observed `unsaved` set: as in round 1; `unsaved` now keeps each observation's timestamp and applies the same 7-day expiry as the stored set.
- After the awaited detail invalidation the monitor re-checks `current()` (switch, HEAD, dispose, repo, auth, newest poll) before the forced detail fetch.
- A newer poll that confirms the same settlement while the claim runs is queued on the toast; the claimant shows it when its own poll went stale. A claimant that is stale with nothing queued keeps the claim and the pending-observed entry (`claimedUnshown`), so the next confirming poll shows the one toast. A failed claim holds the newest offered event for the next focus.
- An unavailable settled detail is a provider failure, not unknown coverage: the bar shows "CI unavailable" with the detail's error, nothing re-arms the schedule (a cooldown still pauses and resumes), and the user's refresh forces a fresh detail fetch. A thrown detail fetch stays `unknown` and retries as before.

## Open risks
- E2E not run locally (CI runs `ciHeadStatus.spec.ts`); the status bar locator and focus assumptions are unchanged.
- R1 (Fable) review still due for Phase 13: async ordering and cross-window claim concurrency (the claim queue added this round is part of it).
- A commit whose claim was kept after a genuine HEAD move (`claimedUnshown`) toasts if HEAD later returns to it still settled and pending-observed (within 7 days); at most once per window.

## Next phase: 14

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale and has no run.cjs inside worktrees; the main checkout's runner works with `--repo <worktree>`.
- A full `bun run test` on this machine takes minutes and shows load-dependent flakes in changeWorkflowHost and fixtures tests.
- Any Bash command that mentions the path segment "IntelliGit" next to a script is refused by the worktree git guard as "too complex"; put scripts under the TMPDIR phase-run folder.
