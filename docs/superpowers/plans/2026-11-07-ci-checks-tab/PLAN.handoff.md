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
- History: built 02881057; fixes 36c1f1b9, 5a06ca01; takeover 6e448ca8 halted; rerun (owner 2026-11-16) cd700bab, fixes 92ae2acb, 1842cf4a, takeover 4834dbc7 halted; owner answer 2026-11-18 (E3): one more rerun, Fable R1 only, a further halt goes to the owner's manual accept. Rerun 3 ca830528, fixes 1fc1925c, 1fb5b95b, then this takeover. Details: PLAN.review-log.md.
- Rerun 3 summary: CheckTree lists every attempt history read in part with its reason; an unread attempt read is `null` and the line commit carries `attemptsUnavailable: true` with a Refresh note; `flakyLineOf` treats an unread, ambiguous or name-only ancestor as a neighbour (never isolating a red) and drops ancestor items whose logicalId differs from the check's.
- Takeover (this commit), finding 1: "Changed since last green" now renders each file through the shared `TreeFileRow` (the row `CommitChangedFilesPanel` uses via `FileTreeRows`) inside a `role="tree"` labelled by the section title; the hand-rolled button, `FILE_STATUS_COLOR` and `fileButtonStyle` are gone. A click or Enter opens the two-revision diff (wired as `onSelect`). Test: commitChecksChangedSinceGreen.integration.test.tsx "each file is the commit pane's shared changed-files row" (CI row outerHTML equals a standalone TreeFileRow's). Red before: `expected '<button type="button" data-testid="ci…' to be '<div tabindex="0" role="treeitem" ari…'`. The reviewer's .review-evidence/row-reuse.test.tsx passes on a copy of the fixed tree (2 of 2).
- Takeover, finding 2: GitNexus 1.6.12 run on an index of this worktree (built into a scratch storage path, `--index-only --skip-agents-md --skip-skills`, registry entry removed after). detect-changes scope all (this diff): 3 symbols, 0 processes, risk low. detect-changes compare 90731f87 (whole phase): 77 files, 725 symbols, 268 flows, risk "critical"; the flow count is driven by name-matched `getData` flows, and the changed `CommitCiDetailService.getData` itself is impact LOW (6). Impact: `flakyLineOf` LOW (4, Checks module), `CheckJobDetail` HIGH (5, all in Checks/Commit-info/Components), `readAttemptHistory` LOW (3 per candidate). The spec's "impact before each edit" cannot be run retroactively; these runs are the substitute, recorded for the owner.
- Owner accepted Phase 12 by hand 2026-11-18 at c874d0b3 (answer "A: accept, file issue"); open gaps in #443; the review log's last Phase 12 line stays HALT.

## Decisions and why
- Row reuse wires `onSelect` (not `onActivate`) to the diff, so one click opens it as the old button did; a double click opens it twice, as before. The rename tooltip "old → new" is lost: the shared row's title is the path and has no title prop; the spec asks only that renames diff on the right sides, which `openCiRangeDiff` still carries (`oldPath`).
- Unread attempts are a separate flag, not a coverage value on an empty list; a repository switch mid-read is unread (null), not empty.
- The unread note uses the attempts-note test id with role="status" in each affected job row, like the K34 notes.

## Open risks
- Whole-phase GitNexus risk reads "critical" from name-matched flows; per-symbol impact is LOW except `CheckJobDetail` HIGH (5, all inside the Checks tab). Owner to accept or ask for more.
- Grant and repository switch: a switch away and back with no open in between keeps the record.
- A badge request on a long loaded line sends up to one attempt-history read per cached ancestor (memoized 60 s, failures not memoized). Not measured against a real forge.
- Gate E not run locally; the spec runs on CI (ciChangedSinceGreen.spec.ts clicks the row by text "ci-changed.txt", a top-level file, so the shared row still matches). Contract 8 empties persisted CI detail caches once on upgrade.
- The vitest `vscode` alias is repo-wide test config: a test that relied on `vscode` failing to resolve would now fail on the stub's throw instead.

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale (indexed 64d390b, checkout at 3d70e16).
