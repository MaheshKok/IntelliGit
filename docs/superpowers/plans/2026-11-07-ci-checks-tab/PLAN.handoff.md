# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (gaps in #443; squash-merged as #444, 29efe7ec). Phase 13: owner accepted by hand 2026-11-21 at 3b31283b; gaps in #447 (squash-merged as #448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 ("C: targeted fix") (squash-merged as #450, f3cf1afa).
- Phase 15: accepted 20240fdf (squash-merged as #452; the wave accepted dd67fe22, verification incomplete).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), fix rounds 4c5c4abb, 98670525, 621c69be, 7ae74a53, takeover b8ab4529: "Find where CI broke" over 2+ Git Log rows, shown hidden. Earlier rounds' detail: this file's git history.
- Owner "B + compact now" (1711495d): a generation-fence stop posts one `ciBisectProgress` with `stopped: true` (Run again / Close); the compact Git Log offers Find where CI broke, relayed to the Changed Files view's Checks tab (CommitInfoViewProvider runs it with its own CommitCiDetailLoops).
- Owner "A: 8.5 MiB" (429e6e3f): verifyVsixPackage.js MAX_UNCOMPRESSED_BYTES 8.5 MiB.
- Fix round 1 (6e6445d1): dispose stops the sidebar bisect; replies carry `repoKey`; flat status apart from a same-named job; Retry reads once (`refreshUnavailable`); amber from pass/failure/unread neighbours. Fix round 2 (9c5a28dc): KindIndex split; host `isolated[]`; useCiBisect retires on a repository change.
- Takeover after round 2 (4 findings): CommitInfoViewProvider.clear() ends the sidebar bisect on a repository change (`clear` names `ciRepoKey`), CommitInfoApp retires it; null squares read "no result"; failed-reads note "Commits with incomplete CI data". Tests: ciBisectRepositorySwitch, ciBisectLabels.
- Owner answer 2026-11-25 "B: require all 4", built in the commit after fd636852, review pending:
  - (1) Card Git Log: `resetFilters()` disposes `ciBisectRuns`, so A -> B -> A never revives A's run (the fence alone reads the current repository). (2) Undocked: `resetRepositoryScopedState()` does the same. An abort posts nothing (ciBisectHandler returns on `signal.aborted` before the stopped reply).
  - (3) Compact relay: new sidebar-only option `relayRepoKey` (repositoryMode passes `() => repoRoot`); a replacing `loadCommits` page carries `repoKey`; NativeCommitGraph keeps it from replacing pages only and posts it on `findCiBreakInChecks` (now `repoKey: string`); the host drops a click with no, a non-string or another repository. (4) The loaded-rows check is gone: the range goes on whole and the bisect caps it to the sidebar's loaded page with the cap note.
  - Tests (the four owner-named, red before the fix): "review: card A-B-A retires an active run before it can send", "review: undocked A-B-A retires an active run before it can send", "review: compact delayed click from A cannot be relayed in B with shared history", "review: compact same-repository page replacement still hands off a range for capping"; plus host "a compact click that names no repository, or another one, is not relayed", "the compact graph's pages name their repository for the relay", webview "names the repository of the page the rows came from, not a later appended page", "sends no range from rows whose page named no repository", and the extension wiring test pins `relayRepoKey` to the card's `ciRepoKey` with no `ciRepoKey` on the sidebar.

## Decisions and why (this build)
- Budget raise: no new unit test pins 8.5 MiB (it would only mirror the constant); the outside check is `bun run package`, red before and green after.
- Stopped reply = a progress message with `stopped: true`, not a new message type: one field, and done/total stay valid for the view.
- A repository change posts no stopped reply: its text ("sign-in or CI settings changed") would be false, and that repository's view is gone.
- Compact layout relays to the Changed Files view's Checks tab (like Open in Checks), because the compact webview has no Checks tab of its own; the bisect's cap there is the sidebar graph's loaded page.
- Fix round 1, Retry: one `getChecks` call per commit with `refreshUnavailable` (not a second `force` call), because the bisect cannot tell a cached error from a fresh one; passed on counting `sendGuard` calls (a gate-less provider never calls it).
- Fix round 2: `isolated` is a required field of `CiBisectJob` (host decides, view only draws).
- Takeover, switch: the host retires in clear() by comparing repo keys (a branch-filter clear in the same repository keeps the run), not in a new repositoryMode call; the webview learns the pane's repository from the `clear` message, because a switch may show no commit in B. Passed on a stopped reply (its text would be false).
- Takeover, labels: one "no result" for the null square (not a new unread flag in the protocol).
- Owner "B" build, relay key: a separate `relayRepoKey` option, not `ciRepoKey` on the sidebar, because `ciRepoKey` turns on the sidebar host's own Checks handlers. The key rides on the replacing page (the rows' own repository), not on `setBranches`, so a click before B's first page still names A and is dropped. A click with no key is dropped in the webview and the host (fail closed).
- Owner "B" build, run abort: dispose in the hosts' repository resets (not a repositoryMode call), so every caller of a reset is covered; the same-repository undocked reset also aborts, as the owner's text ("its repository reset aborts the bisect") says.

## Decisions and why (earlier rounds)
- Finding 6: owner 2026-11-22 "C: drop both + issue" (#453): result text is only "broke at <short sha>".
- Send guard checked inside the gate after the slot wait; concurrency 4 (the gate's per-bucket slots); the pre-queue cancel check has a witness.
- Sparkline: fixed 72 px strip, 9 px squares, 2 px gap; over 6 commits the strip scrolls. Chain = loaded first parents intersected with the selection; `limitedTo`, `commits`, `failedReads` in the section 4 result.
- Ships hidden (owner 2026-11-20, "A: hide them"): menu entry behind `isChecksTabEnabled()`, both host handlers behind `isE2eControlChannelActive()`; Phase 18 turns them on.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e); no E2E drives the compact relay or the stopped reply yet.
- A bisect stopped by a repository switch tells no view (by design above); the new repository's view never showed it.
- A long range shows a thin horizontal scrollbar under the sparkline (strip a few px taller).
- The four 2026-11-24 takeover findings are fixed (owner "B"), none left as a risk. No E2E drives the compact relay's repository check; unit, integration and extension wiring tests do.
- Owner questions carried: Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 without `--localstorage-file`; tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- A worktree has an empty node_modules until linked to the main checkout's node_modules.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18).
- knip hint: tests/integration/shelf/selectedRemovalCrashWorker.ts can leave ignoreUnresolved in knip.jsonc.
