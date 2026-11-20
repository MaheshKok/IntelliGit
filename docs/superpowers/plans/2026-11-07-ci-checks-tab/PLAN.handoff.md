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
- Built test-first, no Codex round yet. New: `src/services/commitChecks/headStatus.ts` (status bar, settle notification, monitor), `src/activation/headChecks.ts` (wiring, both commands), `tests/unit/services/commitChecks/headStatus.test.ts` (29 tests, the 25 spec names plus 4), `tests/e2e/ciHeadStatus.spec.ts` (not run locally; CI runs it). Coordinator gained `invalidateDetail` and `capabilities`; request gates `latestCooldownEnd`; CommitGraphViewProvider `openChecksTab` (held until the webview is ready) and `headChecksSource`.
- Mutations on a copy: 24 of 24 red, each red line names the planned test. Not mutated: "claims are never pruned" (no pruning code exists to break) and "settles during the restart gap" (no in-memory-set variant tried).
- Gates: format, lint:strict, typecheck, architecture, react-doctor, verify:manifest, Gate L (l10n sync/import/validate/audit), build, build:prod, package green. `bun run test` 8 of 8498 red, all in tests/webview/unit/commit-list-column-resize.test.tsx (Node 26.5.0), also 8 of 8 red at 1860b147 on an extracted copy: PRE-EXISTING. "claim taken before toast" once flaked under full-suite load (waited a fixed tick count for the fake's async read); it now awaits the fake's own promise, and 24 parallel runs passed.

## Decisions and why
- Wiring lives in `src/activation/headChecks.ts` (called from repositoryMode.ts), not extension.ts: repository mode owns the providers, generations and gates the monitor reads.
- Cooldown pauses read the latest end across all request-gate buckets (`latestCooldownEnd`); in a multi-forge workspace another forge's cooldown also pauses HEAD (comment at the call site).
- A pushed `none` HEAD uses the short HEAD_NONE ladder, then stops; `unavailable` hides the item and stops until the next HEAD change or restart.
- The toast is at most once: a HEAD that moves during the claim loses its notification. A non-EEXIST mkdir error keeps the hash and the next focus retries.
- Without workspace or global storage (activation test contexts) the monitor is not created; the commands still register and do nothing.
- K7 (diagnostics) is not read here; Phase 14. Settings K5/K6 are read with `get(key, default)` and are not contributed (Phase 18); verify:manifest and the l10n checks accept that.
- The e2e spec restarts the monitor through the visible "Refresh Commit Check Badges" command (the two new commands are hidden from the palette).

## Open risks
- GitNexus detect-changes (scope all, scratch index): 40 files, 38 symbols, 23 flows, risk "critical", driven by flows through `refreshActiveRepositoryWithGuard` and `activateRepositoryMode` (one added line each). Impact before edits: CommitChecksCoordinator HIGH (53), CommitChecksRequestGateRegistry HIGH (15), CommitGraphViewProvider HIGH (11), activateRepositoryMode UNKNOWN; every edit there is additive.
- E2E not run locally: the status bar locator assumes the only status entry with both `codicon-error` and `codicon-check` is ours; the toast test relies on the window being focused (the spec calls `focus()`).
- R1 (Fable) review still due: async ordering and cross-window claim concurrency.

## Next phase: 13
- Owner's answer 2026-11-20, "A: hide them": Phase 13 ships hidden behind the Checks tab switch (`isE2eControlChannelActive()` on the host). While it is off there is no status bar item, no settle notification, and the HEAD watcher starts no timer and sends no CI request for HEAD; the two `intelligit.ci.*HeadChecks` commands stay registered (both e2e inventories) and do nothing; the `statusBar` and `notifyOnSettle` settings are read with their defaults but contributed (package.json + NLS) only in Phase 18; Patch bump with a groundwork CHANGELOG line, and Phase 18 carries the visible line and deletes the switch checks and their switch-off tests.

## Next phase: 14

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale (indexed 64d390b, checkout at 3d70e16).
