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
- History: built 02881057; fixes 36c1f1b9, 5a06ca01; takeover 6e448ca8 halted; rerun (owner 2026-11-16) cd700bab, fixes 92ae2acb, 1842cf4a, takeover 4834dbc7 halted (two Codex K34 findings). Details: PLAN.review-log.md.
- Owner answer 2026-11-18 (E3): one more rerun, Fable R1 only; a further halt goes to the owner's manual accept.
- Rerun 3 (this commit, on 76ab0067), items (a) to (d):
  - (a) CheckTree lists every attempt history of the job read in part (own and each loaded ancestor), each with its own reason; Open in browser only on the commit's own run's notes (an ancestor sharing the run id gets none).
  - (b) `readAttemptHistory` returns `null` (unread) on a failed read or a repository switch mid-read; the line commit then carries `attemptsUnavailable: true` (src/shared/ci/history.ts). The job row of every job with a result on that ancestor says "Re-runs on some loaded commits could not be read — the flaky count may be incomplete" with Refresh (refetches the detail, which asks for the line again; failures are never memoized). New string in 12 locales plus the review CSV; README "Flaky jobs".
  - (c) The 7 tests, assertions and messages verbatim: Codex's 2 plus its 4 sibling K34 cases in tests/integration/webviews/commitChecksAttemptCoverage.integration.test.tsx; the 3 halt-1 tests were already verbatim in changedSinceGreenCaches.test.ts; E3's 2 stored-copy tests added there.
  - (d) The two retired "L2 survives ... miss while pending" tests were not copied.
- vscode mocking: the jsdom test also drives the host coordinator, and the browser transform refuses an unresolvable `vscode` import before `vi.mock` applies. vitest.config.ts now aliases exactly `vscode` to tests/setup/vscodeModule.ts, which throws on load, so every test still has to `vi.mock("vscode")` as before.
- Proof: mutations M1-M12 on a copy, each red at a named assertion (log). Chain: every step green except `bun run test` (8 of 8418 red, all commit-list-column-resize, Node 26.5.0, recorded red at 90731f87).

- Fix round 1 (rerun 3 review, this commit): finding 1 fixed. `CiFlakyCommit.unread` marks an ancestor with no read snapshot, an ambiguous match, or a partial list with no identity match; `flaky()` keeps it as a neighbour, so a red beside it is not isolated (history.ts). Finding 2 dropped by its own caveat: CheckTree passes `history.line` only when `complete` (the same test as changedSinceGreen's `nameProvesJob`) holds, so a name-only match is never counted under pageBound/rejectedNext. Tests: ciHistory.test.ts "an ancestor that was not read breaks isolation" (2 red before, 1 control).
- Proof, round 1: every step green except `bun run test` (8 of 8421 red, the same commit-list-column-resize file, Node 26.5.0).
- Fix round 2 (this commit): `flakyLineOf` drops ancestor items whose logicalId is set and differs from the check's before `matchCheck` (as changedSinceGreen does), so unrelated Deploy/Lint jobs are no result, not an unread ancestor. Tests in ciHistory.test.ts: "known Deploy/Lint identities cannot hide CI/unit..." (red before: expected null to deeply equal { n: 1, m: 3, attemptsCounted: true }) and "an ambiguous ancestor cannot prove the next red isolated" (green on the fix, red under M04 = the `found === "ambiguous"` marker removed, on a copy: expected { n: 1, m: 3, attemptsCounted: true } to be null).
- Proof, round 2: every step green except `bun run test` (8 of 8423 red, the same commit-list-column-resize file, Node 26.5.0).

## Decisions and why
- Unread attempts are a separate flag, not a coverage value on an empty list: `CiCoverage` describes a list that was read; an unread page has no list, and the flag never reaches a persisted shape (the history reply is not stored).
- A repository switch mid-read is unread too (null), not empty: the answer belongs to another account or repository.
- The unread note uses the attempts-note test id with role="status" and sits in each affected job row, like the K34 notes.
- (b) of 2026-11-16 in the walk, not in `matchCheck` (Phase 11's "unknown" tag); grant compares status; the selected commit is never its own ancestor; scopeName = the run's name; handlers answer only while isE2eControlChannelActive is on.

## Open risks
- Grant and repository switch: a switch away and back with no open in between keeps the record (only files the host sent for that repository).
- A badge request on a long loaded line sends up to one attempt-history read per cached ancestor (memoized 60 s, failures not memoized). Not measured against a real forge.
- GitNexus impact and detect-changes not run: the worktree has no `.gitnexus`; Root runs both in an indexed checkout before merge, or the owner waives them.
- Gate E not run locally; the spec runs on CI. Contract 8 empties persisted CI detail caches once on upgrade.
- The vitest `vscode` alias is repo-wide test config: a test that relied on `vscode` failing to resolve would now fail on the stub's throw instead (full suite shows no such test).

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
