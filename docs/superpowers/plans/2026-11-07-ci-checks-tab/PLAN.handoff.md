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
- Build 96e3c78e (0.43.17, hidden behind the Checks tab switch); fix round 1 19458d72; fix round 2 5c036b03; takeover (7 findings of review 13-2) is the commit after 5c036b03 on the same branch. A fresh review is next.
- Takeover regression tests: `tests/unit/services/commitChecks/headStatus.independent.test.ts` (the reviewer's reproductions plus 4 tests for branches the fix added). Red run before the fix: `/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/red-takeover.log` (8 red). Mutants M1-M11 on copies each went red naming their test.
- Gates green: focused head status + coordinator tests (125), format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, verify:manifest. `bun run test`: 8 red of 8545, all the known commit-list-column-resize Node 26 reds. Gate L not needed (no new string).

## Decisions and why
- Per-forge cooldown, three-way monitor fence, pending-observed `unsaved` set with 7-day expiry: as in rounds 1 and 2.
- The monitor passes its poll liveness check as `isCurrent` in the detail options; `CommitChecksCoordinator.getDetail` checks it after the remote resolution and after the account read, so no provider request starts once the switch, HEAD, repository, sign-in or lifecycle changed. Other callers pass no `isCurrent` and are unchanged.
- Any failed detail read (unavailable outcome or a throw), incomplete or settled HEAD, is a provider failure per the Failure table's HEAD monitor row: "CI unavailable" with the error tooltip, the scheduled poll is cancelled, a cooldown still pauses and resumes, and the user's refresh fetches again. This replaces round 2's "a thrown detail stays unknown and retries".
- Toast claim: only the claim's own non-recursive mkdir answers EEXIST = already toasted; a parent-folder error is a storage failure (observation kept, retried on focus). After the parent mkdir the switch and the offering poll (or the newer queued one) are re-checked before the claim mkdir.
- Section 10 order kept: the pending-observed removal is awaited before the toast; if the poll went stale during it, the observation is written back and the claim kept (`claimedUnshown`), so the next confirming poll shows the one toast.
- The elapsed ticker re-checks the switch each second; off = hide the item and stop the monitor (timer cleared, HEAD forgotten so the next repository-change signal starts over).
- Show HEAD Checks re-checks the switch and dispose after its HEAD lookup.

## Open risks
- E2E not run locally (CI runs `ciHeadStatus.spec.ts`).
- R1 (Fable) review still due for Phase 13: async ordering and cross-window claim concurrency.
- GitNexus index is stale: detect-changes saw only coordinator.ts (risk low); headStatus.ts symbols are not in the index.
- A commit whose claim was kept after a genuine HEAD move toasts if HEAD later returns to it still settled and pending-observed (within 7 days); at most once per window.

## Next phase: 14

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale and has no run.cjs inside worktrees; the main checkout's runner works with `--repo <worktree>`.
- A full `bun run test` on this machine takes about 8 minutes and shows load-dependent flakes in changeWorkflowHost and fixtures tests.
- Any Bash command that mentions the path segment "IntelliGit" next to a script, or ".gitnexus", is refused by the worktree git guard as "too complex"; put scripts under the TMPDIR phase-run folder.
