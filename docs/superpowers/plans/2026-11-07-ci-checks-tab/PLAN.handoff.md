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
- Build 96e3c78e (0.43.17, hidden behind the Checks tab switch); fix round 1 19458d72; fix round 2 5c036b03; takeover 5be27e64; owner answer "For phase 13 A" (2026-11-21, plan amended in d2a11190); the owner-answer build is f31f88dd; fix round 1 of review 13-4 is ccdfacf9; fix round 2 of review 13-4 is the commit after it. A fresh review is next.
- Fix round 2 (review 13-4): the overflow scan's `isCurrent` is now the caller's `live()` (it was only the generation check) and `continueScan` re-checks `live()` right before `continueFailedScan` (coordinator.ts); `registerHeadChecks` subscribes to the fence store's `onDidChange` and restarts the monitor for the same repository, the listener sitting in `context.subscriptions` beside the monitor (headChecks.ts). Tests: "round 4 fix round 2" in headStatus.round3.test.ts and one in headChecks.test.ts, both red before ("expected vi.fn() to not be called at all, but actually been called 1 times"; "expected 1 to be greater than 1"), green after (red-r5.log). Proof: every step exit 0 except `bun run test` (the same 8 commit-list-column-resize Node 26 reds, 8567 of 8575 pass). No mutation copy run; the red-before runs are the evidence. The fence-store listener is tested with a fake store, not the real one.
- Fix round 1 (review 13-4): fenced HEAD fetches the detail whatever the snapshot outcome (headStatus.ts settlementDetail); readRequired takes the caller's `live` and throws StaleCallerError inside its fetch, right before provider.getRequiredChecks (coordinator.ts); a manual Refresh forces the settlement detail fetch too; README request count and notification text corrected. Tests: round 4 describe in headStatus.round3.test.ts (3 red before, green after; red-r4.log). Proof chain: all steps exit 0 except `bun run test` (the same 8 commit-list-column-resize Node 26 reds, 8565 of 8573 pass); build:prod, package, verify:manifest, l10n sync/validate exit 0 when run after it. No mutation copy run this round; the red-before runs are the evidence.
- Owner answer A built (review 13-3 evidence: /private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/96ae0985-286f-496a-992b-d3fa5b57f64c/scratchpad/p13-halt/):
  - Findings 3, 4 and 6 retired (switch-only, out of scope per PLAN.md Phase 13 "Where the switch is checked"); not fixed, their tests not ported.
  - Finding 1: the monitor passes its poll's `current` as `isCurrent` to the snapshot; `CommitChecksCoordinator.fetchSnapshot` re-checks it right before `provider.getChecks` (after remote resolution, the account read and the snapshot caches).
  - Finding 2: `getDetail` re-checks `isCurrent` inside the detail fetch (after the detail cache reads) and before each usual-duration lookup.
  - Finding 5: a detail with `refreshError` (failed forced refresh) is a failed read on both paths (incomplete and settled): "CI unavailable" with the error, no automatic retry, cooldown pause kept, the user's Refresh forces a fresh fetch.
  - Finding 7: tests/unit/activation/headChecks.test.ts now runs both commands through `registerHeadChecks` (red under reviewer mutations A10 and A11).
  - Extra reds: failed pending-observed removals are traced (`{kind: "claim", outcome: "failed", reason: "storage"}`, also after EEXIST); the notification text is now "CI passed on <short hash>" / "CI failed on <short hash>: <first failed job>" (snapshot-only providers name the first failed check). Old string removed and both new strings in all 12 catalogs and the localization CSV; e2e ciHeadStatus.spec.ts filter updated.
- Tests: tests/unit/services/commitChecks/headStatus.round3.test.ts (reviewer's kept tests word for word, plus 7 builder tests), headChecks.test.ts (2 new), 2 assertions in headStatus.test.ts updated to the new text and option shape. Red before the fix: 15 (red-r3.log). Mutants M01-M13 on a copy each red naming their test (mutations-build-1.json under the TMPDIR phase-run/PLAN folder).
- Gates green: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, verify:manifest exit 0; l10n:sync/validate/audit exit 0. `bun run test`: 8 red of 8570, all the known commit-list-column-resize Node 26 reds.

## Decisions and why
- Per-forge cooldown, three-way monitor fence, pending-observed `unsaved` set with 7-day expiry: as in rounds 1 and 2.
- Takeover decisions kept (detail `isCurrent`, any failed detail read is "CI unavailable", claim only on the claim's own mkdir EEXIST, removal awaited before the toast, ticker stop, show re-check).
- A stale caller's shared fetch rejects with a private `StaleCallerError` so nothing is sent or cached; a still-live caller that joined that fetch (for example the Git Log badge) starts its own instead of getting an error or a blank badge. A stale snapshot caller gets the no-badge snapshot, a stale detail caller `undefined`.
- One stale check before `provider.getChecks` instead of a second one right after remote resolution: the later check covers every await before the request, so the earlier one could not be told apart by any test.

## Open risks
- E2E not run locally (CI runs `ciHeadStatus.spec.ts`; its toast assertion now expects "CI failed on" and ": unit-tests").
- R1 (Fable) review still due for Phase 13: async ordering and cross-window claim concurrency.
- GitNexus detect-changes (main checkout runner on this worktree): 18 files, 11 symbols, 0 processes, risk low, but the index is stale (headStatus.ts symbols unseen), so not a clean check.
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
