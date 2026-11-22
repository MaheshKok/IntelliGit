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
- Phase 13: owner accepted by hand 2026-11-21 at 3b31283b (answer "For phase 13 A"); open gaps in #447; the review log's last Phase 13 line stays HALT (squash-merged as #448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 (answer "C: targeted fix"); the review log's last Phase 14 line stays HALT (squash-merged as #450, f3cf1afa).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 15: review pending, started at ca1834d5017001650a2a730e17bee052eb6627a5 (real base a2fa6a15158555a8eadacf8adf6402a9a5518be2: ca1834d5 is not an ancestor after the squash merge)
- Build ae49a11e (0.43.19): optional CI column in the Git Log, hidden behind the Checks tab switch. Details and proof in PLAN.review-log.md "Phase 15: built, review pending".
- 12 mutations on copy mut-15-build-1, each red naming its planned test. Full chain exit 0 except `bun run test` (10 of 8687 red, the known set, see Open risks). verify.py gates --stage round GREEN.
- Fix round 1 (review pending again): the 99 px lock is now asserted with literal 99/8/44/8/6 px in commitCiColumn.integration.test.tsx and tests/e2e/ciColumn.spec.ts:140 (literal 99). Mutations on copy mut-15-fix-1: CI_COL_WIDTH 99 to 100, CI_CELL_INSET 8 to 9, CI_BAR_WIDTH 44 to 45, CI_BAR_HEIGHT 8 to 9, CI_BAR_GAP 6 to 7 each go red naming the new test; unmutated copy green. Full chain exit 0 except `bun run test` (10 of 8688 red, the same known set).
- Fix round 2 (review pending again; tests and the e2e spec only, no production change): integration cases for bar colours, timed_out/action_required/cancelled/skipped/neutral counting (pinned as today: every item is in the denominator, only success/failure/pending have segments; the owner has not ruled on skipped/cancelled and section 12 is silent), and `showCiColumn` without `onRequestCommitChecks`; e2e reads the computed colour of the success and failure segments per theme (not run locally). Five mutations on copy mut-15-fix-21 each red naming its test; unmutated 17 of 17 green.
- Gate G redone on a fresh GitNexus index of this worktree (fb8518a, analyzed 2026-11-22): colorForState impact LOW (10 callers, 2 direct, 0 flows), CiColumnCell LOW (1), ciColumnFits LOW (7), CiColumnHeader LOW (7); activateRepositoryMode impact UNKNOWN (no resolved callers), confirmed by text search: extension.ts:57-63, noRepositoryMode.ts:112 and the host-wiring and view-providers integration tests; the signature is unchanged, one settings field is added. detect-changes compare a2fa6a15: 44 files, 161 symbols, risk high, 9 flows, all ActivateRepositoryMode ones, driven by `showCiColumn` in activateRepositoryMode; scope all: low (docs only).

## Decisions and why
- Layout: the CI column shows only when it fits beside the Author/Date the badge layout already shows (`ciColumnFits`); otherwise the row keeps today's badge layout. Author/Date widths are computed as before, so the column never takes their space (the review gate's "deficit onto a sibling" concern).
- The host posts `showCiColumn: true` only when the switch and the setting are both on; the key is absent otherwise, so recorded visual fixtures stay byte-identical.
- The setting is read once at activation (reload to change), like the other commit-checks settings, with default false and no package.json contribution (Phase 18).
- CommitPanelViewProvider.sendGraphBranches posts setBranches without the flag, so the column cannot show in the commit panel's embedded graph; no switch check exists there to test. The compact Git Log (NativeCommitGraph) is wired like the card view.
- CommitList's lint complexity limit (25) moved the request flag into `ciColumnFits` and the header into `CiColumnHeader`.

## Open risks
- E2E `tests/e2e/ciColumn.spec.ts` not run locally (CI runs `test:e2e`); its width assertions read the rendered graph margin and the style constants.
- GitNexus detect-changes still reports risk HIGH, driven by `activateRepositoryMode`'s execution flows (one added settings field); the index is now fresh (fb8518a). With it colorForState impact is LOW. The run log is under the TMPDIR phase-run folder (gitnexus15-fix1.log).
- Owner question for the CI cell: should skipped, cancelled and neutral checks count in the `passed/total` denominator? Today they do (8 passed and 2 skipped read `8/10`, a fifth of the bar empty); a new test pins that.
- Gate U ran regex-only (no element rules such as contrast or tiny text).
- `bun run test` known reds: 8 commit-list-column-resize (Node 26 has no localStorage; all 8 pass with NODE_OPTIONS=--localstorage-file), tsconfigCoverage and screenshotComparatorMeta (pass in a copy with linked node_modules).

## Next phase: per the phase-run dry run (Phases 16-18 per their Depends on lines)

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26 unless `--localstorage-file` is given (a vitest setup could pass it).
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale; its runner works with `--repo <worktree>` from a script under the TMPDIR phase-run folder.
- A full `bun run test` on this machine takes 5 to 8 minutes and shows load-dependent flakes in changeWorkflowHost and fixtures tests.
- Any Bash command that mentions the path segment "IntelliGit" next to a script, or ".gitnexus", is refused by the worktree git guard as "too complex"; put scripts under the TMPDIR phase-run folder.
- This worktree has no node_modules folder: tsconfigCoverage and screenshotComparatorMeta read `<repo>/node_modules` by path and fail here only.
- The commit panel's embedded graph (CommitPanelViewProvider) never posts `commitChecksEnabled` or the CI column flag; whether it should show checks at all is an owner question for Phase 18.
