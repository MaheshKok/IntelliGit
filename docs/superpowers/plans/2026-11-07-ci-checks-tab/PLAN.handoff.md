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
- Phase 13: owner accepted Phase 13 by hand 2026-11-21 at 3b31283b (answer "For phase 13 A"; its stop rule sends a second halt to a hand accept and an issue); open gaps in #447; the review log's last Phase 13 line stays HALT (squash-merged as #448, 49893e1f).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 14: review pending, started at d66a616891a674b603e0cf846901e30463e78112
- Build acf6e21c (0.43.18, hidden behind the Checks tab switch). Fix round 1 (13fa2d0d) cleared Codex round 1's findings 1-4. Fix round 2 (29d53c89) moved the failure branch's HEAD await before its final checks.
- Takeover (the commit after 29d53c89) cleared review round 2's four findings, each with a test red before and green after, 7 mutations on a copy each red naming its test: (1) Problems URIs are the validated real path, not the provider's alias, and a synchronous `realpathSync.native` check just before publishing drops a file swapped for a symlink since placement (counted as rejected); (2) `open()` rereads HEAD after its realpath and reruns the publishing show's own `live()` (sequence, enabled, auth and lifecycle generations) plus the switch before opening; (3) `getAnnotations` takes the caller's `isCurrent` (now required on the provider interface) and checks it before every page request, including the first after the session await; the coordinator passes it; (4) `show()` rereads HEAD before each later job's request. A fresh review is next.
- Fix round 1: `open()` re-contains the file (realpath inside the repository) at click time and opens the real path; the failure branch of `show()` rechecks switch, liveness and HEAD like the success path; `CiAnnotationsView.truncated` became `coverage: CiCoverage` (worst of the jobs, a refused link outranks a page bound) and the tab prints a new `annotationsRejectedNext` line (12 locales + CSV); real provider tests drive ten pages, an eleventh never fetched, and a cross-host next link (one request, no token elsewhere). 8 mutations on a copy, each red naming its test.
- Built: `src/services/commitChecks/ciDiagnostics.ts` (HEAD-only fetch for failed jobs with annotationCount > 0, path and line validation with realpath containment, 0-based lines, source `CI: <job>`, publish only while current and HEAD unchanged, clear on HEAD change, settings, sign-out, clear(), repository close and monitor dispose); GitHub `getAnnotations` (per_page=100, bounded) and `annotationCount`; capability `annotations`; contract version 9; `openCiAnnotation` handler on 3 hosts; Checks tab "Annotations" section; l10n in 11 locales; README section under a Planned note; `tests/e2e/ciDiagnostics.spec.ts` in `test:e2e`.
- Switch checks (owner answer "A: hide them"): request, publish and handler each check `isE2eControlChannelActive()`, each with a switch-off test that went red when its check was removed.
- Takeover proof: every step of the phase chain exit 0 except `bun run test` (10 of 8654 red, the same set as below; tsconfigCoverage and screenshotComparatorMeta pass in a copy with linked node_modules).
- Build proof: every step of the phase chain exit 0 except `bun run test` (10 of 8635 red: 8 known commit-list-column-resize Node 26 reds, plus tsconfigCoverage and screenshotComparatorMeta, which read `<repo>/node_modules` by path and pass in a copy with linked node_modules). verify.py gates --stage round GREEN. 16 mutations on copies, each red naming its test.

## Decisions and why
- The Problems collection is created on the first publish, not at activation: every integration test's vscode mock lacks `languages`, and nothing should appear in Problems while the switch is off.
- few/many plural forms added by hand to es, fr, pt-br, pt-pt, ru, pl for `commit.checks.tab.annotationsRejected`: the CSV carries only en's one/other, and the l10n test requires every Intl.PluralRules category.
- `handleChangedSinceGreenMessage` renamed `handleCiFileMessage` and shared with `openCiAnnotation`, keeping the provider's complexity under the lint limit.
- `CheckAnnotations` takes the loaded detail and renders nothing without annotations, so ChecksTab stays under complexity 25.
- The setting is read with its default and not contributed (Phase 18 contributes it, per the plan).
- Takeover: the final containment check is synchronous so no await sits between it and the publish; the native resolver matches `fs.promises.realpath`'s spelling on Windows. The HEAD recheck runs only before the second and later jobs, because the first is already checked just before the loop. The redundant "same published object" check in `open()` was dropped: any clear or newer show already turns `live()` false.

## Open risks
- E2E not run locally (CI runs `ciDiagnostics.spec.ts`).
- R1 (Fable) review due: untrusted provider paths reach the file system check.
- A file swapped between the realpath check and the read, between the click's realpath and the open, or after publishing is a filesystem race no check can close; the publish step itself is now rechecked synchronously.
- With several failed jobs the tab's coverage line names the worst job's count, not a total.
- The sign-out and repository-close clears in repositoryMode have no activation-level test; covered only through the `CiDiagnostics.clear()` and monitor tests.
- The annotations subscription in the detail handler lives until its `stopped` signal aborts.
- GitNexus detect-changes/impact not run (no GitNexus tool in the builder session, worktree not indexed): OWNER must run it on an indexed checkout or waive it. Hand trace instead: the changed symbols' only users are `CiDiagnostics.show/open` (called by `ciAnnotationHandler` and `HeadCiStatus`) and `CheckAnnotations`; `bun run typecheck` is green.

## Next phase: per the phase-run dry run (Phase 15 depends on 4 and is ready; Phases 16-18 per their Depends on lines)

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
- This worktree has no node_modules folder: tsconfigCoverage and screenshotComparatorMeta read `<repo>/node_modules` by path and fail here only; this worktree is also not in the GitNexus index.
