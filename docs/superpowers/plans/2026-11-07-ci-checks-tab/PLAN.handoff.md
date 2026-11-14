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
- Phase 8: accepted b5a56002, manual; owner OK 2026-11-13 ("A: fix by hand").
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 8 state
- Built (0.43.10, e356954d): POST helper, `writeFor` through the request gate, GitHub/GitLab `runAction`, `ciActions.ts`, fence re-post and re-read, header buttons, cancel confirm, labels, 14 webview strings in 11 locales, README, CHANGELOG, e2e spec, coverage manifest entry.
- Fix round 1 (dc2b08a2): sign-in recheck after the fence write, busy action released on invalidation or repo/commit change, header keyed per commit, redundant `notSeen` guard dropped.
- Takeover (after round 2's review): the fence write (`beforeSend`) now runs inside the admitted request-gate callback (`WriteJson` 5th argument; `writeFor` awaits it, then rechecks sign-in, then sends; both providers pass it through). So a cooldown refuses before any fence, and the live-repository and provider-generation guard runs after any queue wait. `send()` maps ENOTFOUND, EAI_AGAIN and ECONNREFUSED to `RequestNotSentError` (fence deleted). Tests: commitChecksProviders.test.ts "a queued write runs its pre-send check once admitted…" and "a cooldown starting during the credential lookup…" (both providers), http.test.ts "a DNS or connection refusal…" and "a rejected beforeSend sends nothing". Five mutants on a copy all red.
- Fix round 2 (0be960b4), review findings 1-5 and 7:
  - `writeFor` captures the context before queueing and throws `RequestNotSentError` (superseded) inside the admitted gate callback when the sign-in or settings changed; the fence is removed (`ciActions.ts`).
  - `coordinator.actionGuard(ctx, liveRepoKey)` replaces `isCurrentContext`: it holds the provider generation captured at the start and reads the live repository at the check. `runCiAction` takes the live repository as a 5th argument; the host passes `() => source.repoKey()`.
  - `redactError` (normalize.ts) removes the provider's token from a write failure at each provider's write boundary; class, status and headers stay.
  - `send()` turns a synchronous throw while building the request (Node's invalid-header rejection) into `RequestNotSentError`; `runCiAction` treats it as a definite failure and deletes the fence.
  - A 401 (before or after the fence) returns outcome `signedOut` with the sign-in message, after dropping the commit from every cache and fetching again; the pane asks for the detail again, which is the existing signed-out detail with its Sign in button. Nothing is retried.
- Mutations on a copy, all red naming a test: gate recheck removed, live repository ignored, provider generation ignored, redaction off, sync catch removed, 401 outcome back to failed, no reload after 401, not-sent branch removed, superseded message dropped.
- Hand fix (b5a56002): `send()` settles once on a cut-off or missing response, and "never sent" is read from the socket (never connected) instead of a code list alone. Real-Node tests in httpWire.test.ts.
- Phase 18's delete list now names `answerCiActionMessage`'s switch check and the switch-off half of the ciActionHandler.test.ts test.

## Decisions and why
- Takeover: the fence moved into the gate callback instead of deleting a fence the gate refused, because plan §6 says a cooldown writes no fence at all; it holds one gate slot for the fence write. DNS/refused codes are a fixed list, not "socket never connected", because a reused keep-alive socket emits no connect event.
- Finding 6 (GitHub `summaryMissed` makes a finished execution incomplete) is not in Phase 8's diff: it came in with Phase 7 (36bef4be, in base accf570d) and Phase 8 touches neither it nor `githubJobLog.test.ts`. The reviewer saw it by diffing against 6fef8c59. Left unchanged; see "Found outside scope".
- Redaction mutates the thrown error's message in place instead of rebuilding it, so `RequestGateCooldownError` and its `until` survive.
- The live repository is a function argument, not a coordinator field: the coordinator is per window and never knew which repository the pane shows.
- The 401 outcome re-reads through the host instead of marking the pane signed out locally, so one source of truth (the detail's `signInHost`) drives the Sign in button.

## Open risks
- Finding 7 (exact-worktree GitNexus detect_changes) is still unrun: `.gitnexus/run.cjs` is missing in the worktree and `detect-changes --repo <worktree>` answers "Repository not found" (only the two main checkouts are registered). Indexing the worktree would add a third entry to the shared registry; not done. Changed symbols by hand: runCiAction, refused (new), CommitChecksCoordinator.actionGuard (replaces isCurrentContext, one caller), writeFor, send, createHttpRequestJson users, GitHubProvider.runAction, GitLabProvider.runAction, useCiAction, ciActionAccess, answerCiActionMessage.
- Phase 8 e2e spec not run locally (runs on CI).
- Fable R1 (hand fix): a 502/504 from a gateway after the provider ran the action deletes the fence (K30 step 2, PLAN.md:333, treats every 5xx as definite), so a second click could start a second GitLab job. Owner's call; not changed.
- `bun run test` (takeover): 8 failed / 8012 passed; the 8 are commit-list-column-resize.test.tsx, also red at base accf570d under Node v26.5.0.

## Next phase: 9

## Found outside scope
- Phase 7 code: githubProvider.ts:513 marks a finished execution incomplete when an optional failure-summary lookup fails (`summaryMissed`), and githubJobLog.test.ts pins it. A reviewer says this contradicts the completion contract (plan lines 288/316); decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on base accf570d (8 tests).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules; pass with it.
- l10n audit lists 13 pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees; the CLI cannot check a worktree.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- The repo-wide `.gitignore` rules `logs` and `*.log` hide any future fixture folder named `logs`.
- impeccable hook flags a placeholder `<img>` at commitChecksTab.integration.test.tsx:1261 (pre-existing test markup).
- `git archive` run from a subfolder of a worktree packs only that subfolder; base copies need `git -C <root>`.
