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
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 12: review pending, started at b9d710d60cb6a5b929ad4ef7e32c1293090b550b
- Effective base 90731f87 (Phase 11 squash-merged, then the Phase 12 slice rewritten as groundwork); b9d710d6 is not its ancestor. Not a halt.
- Built 02881057, fix rounds 36c1f1b9 and 5a06ca01, takeover 6e448ca8, halted; owner answer 2026-11-16 (E3): rerun with items (a) to (e), built as cd700bab on 23cce0fc.
- (a) Cache-only reads never join a running fetch; they serve a valid stored copy (L1, then L2) with the generation and fence checks. (b) changedSinceGreen drops an ancestor check whose known logical id is not the selected job's before the match. (c) `CiRangeDiffGrant` opens only an exact entry of the latest answer for the current repository. (d) GitHub `filter=all` and GitLab `include_retried` confirmed in current docs 2026-11-16. (e) The reviewer's red cases live in changedSinceGreenCaches.test.ts.
- Fix round 1 (92ae2acb): an older reply never replaces the newest request's grant; status comparison tested.
- Fix round 2 (1842cf4a): `firstParentLine` stops at the selected commit; walk and handler mutation gaps tested.
- Takeover (this commit, on 1842cf4a): Codex K34 finding. An attempt history read in part (pageBound or rejectedNext) for the job, in the commit's own detail or a loaded ancestor's, now shows "Showing the first N attempts — open the run in the browser for the rest" / "… — the provider's next-page link was refused" in the job row next to the flaky tag, with Open in browser for the commit's own run. New strings in all 12 locales plus the review CSV; docs/commit-checks/README.md "Flaky jobs" updated.
- Takeover proof: 4 new tests in commitChecksChangedSinceGreen.integration.test.tsx red before the fix ("expected 'no attempts note' to contain 'Showing the first 1000 attempts …'"), green after; 5 mutations on copies, each red at a named assertion (log).
- Halt: rerun with Fable (wf_7d0f1196-c25) stopped at "PHASE 12: HALT review still failing after takeover" on 4834dbc7; two Codex K34 findings open.

### Owner answer 2026-11-18 (E3): one more rerun, Fable R1 only; a further halt goes to the owner's manual accept
- (a) Finding 1, src/webviews/react/commit-info/checks/CheckTree.tsx:439-444: `.find(...)` keeps only the first partial attempt list. Show every partial history for the job, the commit's own run and each loaded ancestor, each with its own reason (page bound, refused next page). Keep Open in browser only for the commit's own run. Red test: "discloses each own and ancestor partial history when reasons differ".
- (b) Finding 2, src/services/commitChecks/coordinator.ts:328-329: a failed ancestor attempt read returns `[]`, which the screen counts as a complete history ("flaky 1/4" with no warning). Keep an "unavailable" state for that read, show it to the user, and let Refresh read it again. Rule: unread attempts never become an empty, fully counted history. Red test: "a failed ancestor attempt page must not look like a fully counted history".
- (c) Copy these 7 tests into the branch as permanent tests, each assertion and its message word for word (adapt only how `vscode` is mocked, the repo's way). Sources, all under /private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/96ae0985-286f-496a-992b-d3fa5b57f64c/scratchpad/:
  - Codex's 2 red tests above: p12-halt2-reviewerPhase12Coverage.test.tsx (Codex ran it with a `vscode` alias to a one-line l10n stub: p12-halt2-vscode-stub.ts and e3-review.vitest.config.ts in the same folder).
  - The 3 halt-1 tests "known identities from unrelated workflows do not block an older exact green", "stored passing ancestor remains visible during refresh after restart", "stored selected detail remains usable during refresh after restart": p12-halt/tests/unit/services/commitChecks/reviewer.round3.test.ts.
  - E3's 2 stored-copy tests (snapshot and detail: shown during a pending forced refresh after restart, kept after it fails): p12-halt2/tests/unit/services/commitChecks/e3.l2survive.test.ts.
- (d) Retired: reviewer.round3.test.ts's two "restart: ... L2 survives a rejected concurrent forced refresh" tests (its lines 41 and 48 expect a miss while a forced refresh is pending). Answer 2026-11-16 (a) replaced that rule; do not copy them and do not satisfy them. E3's 2 stored-copy tests replace them.
- Proof asked for: each of the 7 tests red under a named mutation of the fix it guards.

## Decisions and why
- (b) in the walk, not in `matchCheck`: changing the shared join would turn Phase 11's "unknown" tag into "new" for an unidentified parent beside another workflow's identified one.
- (c) the grant also compares the file's status: part of what the host sent, one comparison.
- The selected commit is never in its own first-parent line (a commit is not its own ancestor).
- Attempt coverage note shows whenever the flaky line is computed and a partial history for that job exists, even with no tag: re-runs not read may hold a flake, so a missing tag is unproven too (K34 "banners read it").
- The note covers ancestors' histories as well as the commit's own, since the count reads both; an ancestor's run is not in this detail, so its note has no browser link.
- The note's Open in browser stops the click there, so it does not also select the job row it sits in.
- File list is a plain button list, not CommitChangedFilesPanel (plan step 5 is "[ASSUMED] where props allow").
- scopeName = the run's name. Flaky tag only when the commit's run, job and flat lists are whole.
- Handlers answer only while isE2eControlChannelActive is on (as Phase 11).

## Open risks
- Grant and repository switch: a switch away and back with no open in between keeps the record (only files the host sent for that repository). Hosts have no shared repository-switch hook.
- Local `bun run test`: Node 26 reds commit-list-column-resize (8 tests, `localStorage` undefined, red at 90731f87 too); this takeover's run: 530 of 531 files, 8398 of 8406 tests passed. The chain therefore did not pass as one command; build:prod and package ran separately and passed.
- A badge request on a long loaded line sends up to one attempt-history read per cached ancestor (memoized 60 s). Not measured against a real forge.
- GitNexus impact and detect-changes not run: the worktree has no `.gitnexus`; Root runs both in an indexed checkout before merge, or the owner waives them.
- Gate E not run locally; the spec runs on CI. Contract 8 empties persisted CI detail caches once on upgrade.

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
