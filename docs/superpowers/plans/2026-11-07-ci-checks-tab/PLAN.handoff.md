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
- Build commit 96e3c78e (0.43.17, ships hidden behind the Checks tab switch). Fix round 1 (13 Codex findings) is the commit after it, on the same branch; a fresh Codex review of it is next.
- Every finding has a regression test that was red before the fix (red lines in `/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/red1.log`) and a mutation on a copy that went red naming that test: M01-M19 all red after strengthening the M08 and M16 tests. The M06-survivor test (failed plus running) passes before the fix by design and goes red only under its mutation.
- Gates green: focused tests, format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, verify:manifest, Gate L (l10n import/validate/audit). `bun run test`: 18 red of 8518 under load; 8 are the known commit-list-column-resize reds (Node 26), the other 10 (git integration, shelf, fixtures, e2e known-bad, changeWorkflowHost) pass when rerun alone except one timing flake that also passes alone: unrelated to this diff.
- GitNexus detect-changes (scope all, main checkout runner on this worktree): 30 files, 24 symbols, 0 flows, risk low.

## Decisions and why
- Per-forge cooldown: providers expose `apiUrl(ref)`; `coordinator.requestBucket(hash)` names HEAD's own provider and API-origin bucket; `headCooldownEnd` reads only that bucket (all four providers, so Bitbucket NearLimit still pauses). `latestCooldownEnd` is removed (orphaned by this).
- The monitor is fenced three ways: `lookup` (HEAD lookups), `pollSequence` (older poll vs newer settled refresh) and the `current()` closure, which now also checks the switch.
- Pending-observed keeps an in-memory `unsaved` set so a failed or slow write still counts for the session; the write failure is traced and polling continues.
- A non-EEXIST claim failure returns `"retry"` so the next focused-window event tries again.
- Ordinary unavailable results show "CI unavailable" (new l10n string, 11 locales) with the error as tooltip; click retries.
- A held Checks request carries its repoKey and is dropped, not relabelled, after a repository switch.

## Open risks
- E2E not run locally (CI runs `ciHeadStatus.spec.ts`); the status bar locator and focus assumptions are unchanged.
- R1 (Fable) review still due for Phase 13: async ordering and cross-window claim concurrency.

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
