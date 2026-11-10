# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 4: accepted f005d90f, verification incomplete.
- Phase 19: accepted f005d90f, verification incomplete.

## Phase 2: review pending, started at f005d90f47f5a45cb30e5a31cc19f8e1b96e51d6
- Review range for this narrow round (owner amendment item 4): 336ff8fd..d41b4585. Whole phase: f005d90f..d41b4585 (2cdbaaf8 and 336ff8fd are owner plan amendments, docs only).
- d41b4585 (Opus takeover of item 4): the scan cursor's `jobsTotal` may be `null`, meaning the first scan page was read and named no `total_count`. continueFailedScan reads a page's total only while `jobsTotal === undefined` (stores `?? null`), so a missing first total stays missing through Refresh, cooldown resumes and error stops (kept() now carries `null` too). The refusal check reads `jobsTotal === null`.
- 018dbbb5 (fix round 2): budget taken as soon as the page answers; every stop or pause that keeps the scan returns `next` = same page's cursor with the budget. types.ts `{error}`/`{pausedUntil}` take optional `next`; detailService applies it.
- ee59d01f (fix round 1): a page that stops on its refused next link returns its own cursor with `jobsTotal`.
- 392fdf68 (item 4): the cursor carries `jobsTotal`, first read in getDetail's first 1 000, or the first scan page's when they named none.
- Earlier: 64d390b0 merge; 3d1b6d85 amendment items 1-2; daf653e3 fix 1; 16b8c295 fix 2; e1176e56 takeover.

## Evidence (takeover, d41b4585)
- Red before fix: githubDetail "a missing first scan total cannot become a larger budget on Refresh" (Codex's probe): `a missing first total still refuses the next link after Refresh: expected [ Array(10) ] to deeply equal [ 11 ]`.
- Mutations on copy mut-2-takeover-1: `??=` re-read of null -> red on that assertion; no `?? null` marker -> red on `a missing first total refuses the next link`; `=== null` -> `=== undefined` survives as an equivalent mutant (`jobsRead >= null` coerces null to 0 and also refuses). Control 64/64.
- Gate chain exit 0 in one run: focused 121/121; format..build passed; `bun run test` 7650/7650 (500 files); build:prod and package passed (88 entries). Pre-commit hook passed.
- detect-changes (unstaged): medium risk, ReadDetail flows; index behind (64d390b) so symbol mapping is unreliable.

## Evidence (earlier rounds)
- 018dbbb5: 3 cases red `<case>: the resumed scan must retain the first 1100-job budget`; 4 mutations red; chain 7649/7649.
- ee59d01f: red `Refresh must retain the first scan's 1100-job budget`.
- 392fdf68: red `growing total reads only the first budget`.

## Decisions and why
- Missing-total marker (2 options): `null` in `jobsTotal` over a separate boolean flag; one field keeps "budget known / read and absent / not read yet" in one place and no new field travels through carryScans.
- Budget source: first total_count in the first 1 000 over the first scan page's (owner text "as first read").
- paginate.ts unchanged; no version bump or CHANGELOG (Phase 2's patch bump shipped in the merge).
- A remote-changed scan is not carried, so Refresh starts a new scan with a newly read budget.

## Open risks
- A scan whose first scan page names no total stays stopped on every Refresh until the run id or attempt changes or the detail service clears; the plan's rule ("a missing first total still refuses the next link") requires this.
- The `jobsTotal === null` check is redundant at runtime (null coerces to 0); it exists for the type checker.
- A query-param alias of a read page is re-read until the frozen budget runs out.
- The budget trusts the first `total_count`; an inflated first count is bounded only by that number.
- The 429/quota-403 pause path carries `next` like the tested gate-cooldown path but has no test of its own (Codex's probe file review-2-2/.../reviewBudgetProbe.test.ts has one).
- Earlier risks stand (old attempt shown until next read after a stop; 30 s re-read of a disagreeing commit; hidden job leaves a short list; 429/403 inside a scan stops it; case-sensitive /repos/ prefix; getSession per scan page; extra suite-count request).

## Follow-ups (stop rule, PLAN.md Phase 2 amendment item 3)
- continueFailedScan: catching a query alias on its first repeat needs page identity by content (job ids).

## Next phase
- Per the phase-run dry run after Phase 2 is accepted: 3, 5 or 6. Phase 15 is not part of this run.

## Found outside scope
- `bun run test` in the main checkout times out git-heavy tests under load; green alone. operationBenchmark.test.ts flaked once under /tmp TMPDIR.
- localization.test.ts:352 (vsce ls) exceeds 120 s while ~100 worktrees sit under .claude/worktrees.
- `bun run package` can pack ignored leftovers under `output/`; this run gave 88 entries.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run fails the fixture socket-path limit unless TMPDIR is short.
- knip hint: tests/integration/shelf/selectedRemovalCrashWorker.ts can leave `ignoreUnresolved` in knip.jsonc.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- CI strings carry English text in every locale cell of the localization CSV.
- tsconfigCoverage and screenshotComparatorMeta resolve tools at <repo>/node_modules, failing in a worktree without its own.
- GitNexus index is behind HEAD (last indexed 64d390b); re-run `node .gitnexus/run.cjs analyze --index-only`.

## Owner answer after wave 8 (2026-11-10): Phase 2 option A with a cap (Root note)
- Phase 2 stays review pending at d41b4585 (started at f005d90f47f5a45cb30e5a31cc19f8e1b96e51d6). Phase 15 is not part of this run.
- Open finding (Codex REQUIRED, `detailService.ts:463`): a page dropped because its requester went stale loses its frozen budget, so a later total of 2 000 allows 10 overflow requests instead of 1. Path: `repositoryMode.ts:402-410` bumps the lifecycle when a discovered repository closes.
- Fix: PLAN.md Phase 2 amendment item 5. Test first, red before the fix, with real provider, coordinator, detail service and generations.
- Cap: last round on the budget rule. Any further budget-path finding is a Follow-up unless it makes requests without bound.

## Phase 2 lifted onto Phase 1's PR (2026-11-10)
- Branch feat/396-ci-checks-phase-2, stacked on feat/395-ci-checks-phase-1 (PR #414); its own PR closes #396. Phase 19 action-fence code is not on this branch.
- Amendment item 5 built test first here (runScan's dropped-page branch); narrow Codex round ACCEPT, its one MINOR fixed with a second test case. Details in the review log.
- Version 0.43.3 with its own CHANGELOG entry.
- Keep in step with #414: rebase --onto its new tip and port its review fixes.
