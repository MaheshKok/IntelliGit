# Issue #286 planning brief

Date: 2026-09-30. Investigation and planning only; no product implementation is authorized in this task.

## Locked intent

Issue https://github.com/MaheshKok/IntelliGit/issues/286 is open with no comments. It requests IntelliJ-like updating while uncommitted changes exist. The implementation recommendation must address the existing Pull/current-branch Update experience, preserve users' local work, and make conflict recovery explicit.

Base: `/Users/maheshkokare/PycharmProjects/IntelliGit`, `main`, commit `ac59017c9daa31e19c5e9c3c098aa3b860d1aef6`; clean before planning. Do not change branches or write product code. Root model/effort verified from live turn metadata: `gpt-6-astra`, `xhigh`. Reader lanes used `gpt-6.1-sol`, `xhigh`.

## Default scope and user experience

- Upgrade existing Pull entrypoints and current-branch Update. Do not introduce a separate Update Project dialog or new merge/rebase preference in this issue. Preserve existing rebase strategy.
- Keep dirty Sync refusal in v1: Sync includes a Push, while this issue requests updating/pulling. Protect this boundary with a test. Do not route the new preservation behavior into push-rejection retries. A later Sync expansion must gate Push on BOTH integration and restoration completing successfully.
- Clean-worktree behavior stays the same. Dirty-worktree action should explain temporary saving and restoration through a native VS Code action; choose a concrete low-friction flow in the plan, with cancel before any mutation.
- Success restores tracked edits, staged/unstaged distinction (including split edits within one file), and ordinary nonignored untracked files. Never silently discard local data, change its staging classification as a fallback, or remove a user's pre-existing stash.
- Integration conflicts and restoration conflicts are distinct outcomes. Preserve the exact owned stash and present its identity plus recovery route through existing Unstash Changes. Do not report complete or auto-push while local work is still saved or conflicted.
- V1 does NOT promise automatic restoration after the user later continues/aborts a conflicted rebase or restarts VS Code. Retaining a descriptively named normal Git stash plus explicit existing recovery UI is the bounded recovery contract. Explain this limit candidly. Do not introduce a durable recovery journal, new persisted schema, background observer, or new conflict engine merely to remove this manual step.
- If update fails without an active Git operation, attempt safe restoration under the same ownership rules; restoration failure remains a distinct recoverable outcome. Never use an unconditional `finally` to apply a stash into an active rebase.
- Scope each operation to its original repository/worktree across prompts and callbacks. Coordinate all extension mutations via the existing common-directory gate, with no nested-gate deadlock. External Git processes are outside this lock: revalidation and retaining backups must account for that limit.
- Backup coverage is tracked changes plus ordinary nonignored untracked files, NOT ignored files or unsaved editor buffers. Do not introduce `stash --all`, reset, clean, or forced overwrite. Do not promise ignored-file preservation: root proved ordinary rebase can overwrite an ignored file when upstream starts tracking the same path. This is inherited Git behavior outside the backup contract; state the limitation in the plan and documentation, without presenting this as a whole-workspace snapshot. Nested repositories/submodule dirt need an explicit preflight policy rather than a promise Git stash cannot meet. Prefer clear bounded rejection for unsupported dirty states.

## Confirmed code evidence from reader lanes

Service lane report: `/private/tmp/issue286-service-evidence.md` (read when ready).
UI/tests lane report: `/private/tmp/issue286-ui-tests-evidence.md` (read when ready).
External reference lane: `/private/tmp/issue286-research-evidence.md`.

- `src/views/commitPanelActions.ts:739-744`: shared Pull/Sync rejects dirty state through `warnIfUncommittedChanges` at `:550-556`.
- `src/views/commitPanelActions.ts:537-540`: existing Pull/Sync contract is rebase only.
- `src/git/operations.ts:775`: `hasUncommittedChanges` includes untracked; `pullRebase` at 1269 executes bare `pull --rebase`.
- `src/commands/branchCommands.ts:764-780`: current-branch Update routes to shared Pull. At `:783-799`, noncurrent-branch Update fetches the remote ref without altering worktree; preserve that distinct behavior.
- A push-rejection retry also calls `pullRebase`; do not globally alter that low-level method's behavior unintentionally.
- `src/git/operations.ts:1510,1536,1562`: `stashSave(paths?, message)` uses include-untracked, `stashApplyByHash(hash, reinstateIndex)` supports exact-OID apply with `--index`, and `stashDeleteIfHashMatches(index, hash)` checks identity inside a gate. Capture an operation-owned identity; never apply/pop the current top entry by assumption.
- `src/git/executor.ts:107-131`: `runWithinMutationGate` supplies an ungated runner under the common-directory lock, including linked worktrees. Do not call gated helpers recursively inside it. Normal executor mutation classification at `:349-379` checks `args[0]`, so command-line `-c` prefixes require special care; prefer `pull --rebase --no-autostash` in this bounded flow.
- `src/git/interactiveRebase/control.ts:228-270`: existing Continue/Abort only runs Git commands and has no generic stash recovery hook. Interactive-rebase manifest at `src/git/interactiveRebase/types.ts:80-100` has no stash field; do not repurpose it.
- Existing shelf service recovery handles its own journal. Shelf's exact-state/structural-change constraints make it a poor default for this narrowly scoped operation.
- There is no separate Update Project command, update-method setting, or automatic-save setting in current source/package according to the lanes. Do not describe existing Update as full IntelliJ parity.
- File-context Pull already retains the clicked repository and only refreshes the matching active root. Existing tests intentionally assert dirty Pull/Sync rejection: replace those contracts precisely.
- `tests/e2e/fileContextPull.spec.ts` is the existing native Pull proof, currently a clean fast-forward with an identical-tree upstream commit. The implementation needs a real changed-upstream fixture plus local changes.

If a fact is missing, label it as an implementation preflight check rather than inventing source contents. GitNexus service impact returned LOW but was a lower bound with two unresolved receiver sites, not complete safety clearance.

## Root verification: actual Git, isolated fixtures

Root ran `python3 /private/tmp/issue286-git-probes.py` successfully on Apple Git 2.54.0. Latest result: **18 assertions passed**, exit 0. Full raw commands and exits: `/private/tmp/issue286-git-aw9k63rs/commands.log`. No product code changed.

Verified:

1. Plain merge pull accepts disjoint tracked edits.
2. Plain merge pull rejects overlapping edits while retaining them.
3. Plain rebase pull rejects even disjoint tracked edits.
4. Native rebase autostash restores file content on clean application.
5. Native rebase autostash loses staged classification.
6. Native autostash can return exit 0 while restoring changes leaves unmerged paths.
7. That restoration-conflict case retains a recovery stash.
8. Native autostash does not protect an incoming-path collision with an untracked file.
9. Explicit `stash push --include-untracked`, capture OID, pull with native autostash disabled, `stash apply --index <OID>` restores index/worktree/untracked state in a clean case.
10. A prior user stash survives operation-stash cleanup in the isolated fixture.
11. An untracked incoming-path collision retains the remote file in the worktree and original local content in `<OID>^3`, with the stash retained.
12. Explicit restoration preserves staged and unstaged edits in the SAME file in a clean case.
13-16. A rebase integration conflict retains the saved work; completing OR aborting that rebase followed by explicit stash restoration restores staged and unstaged work.
17. `stash --include-untracked` excludes ignored files. An additional observation showed a pull/rebase returning exit 0 and replacing an ignored local file with an upstream tracked file at the same path. Therefore ignored data is explicitly outside the automatic-backup guarantee.
18. A deterministic interleaving reproduced the cleanup race: resolve/check `stash@{0}` as the owned stash, insert a new stash via another Git invocation, then drop the previously checked selector. Git deleted the newer user stash and left the owned stash. This verifies the reason for the revised retention policy, rather than treating the race as hypothetical.

These verify Git semantics only. No new product feature, VS Code interaction, platform matrix, or full repository test suite has been verified. The simple probe cleans up `stash@{0}` only in a closed fixture; production cleanup must resolve/check exact OID rather than copy that fixture assumption.

## Official references

- JetBrains Git settings, checked by root: https://www.jetbrains.com/help/idea/settings-version-control-git.html — Update can use Merge/Rebase and clean with Stash/Shelve.
- Git stash docs, checked by root: https://git-scm.com/docs/git-stash — `--include-untracked`, `apply --index`, identity via commit, conflict limitations.
- VS Code source, checked by research lane: https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/package.json (3849-3853), https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/repository.ts (2249-2263, 3013-3030), https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/git.ts (2310-2313). Native VS Code already supports `git.autoStash`, default false. Correct the issue's blanket novelty claim without dismissing the requested IntelliGit experience.
- Git sequencer source, checked by research lane: https://raw.githubusercontent.com/git/git/master/sequencer.c (4450-4460, 4502-4520): native autostash creates tracked snapshot and applies without `--index`.

## Options rejected for this plan

- Only remove the dirty guard: plain rebase still rejects dirt; no preservation/recovery.
- Just add `--autostash`: observed staging loss, untracked limitation, success exit with restoration conflicts.
- `stash pop` against a mutable index: cannot safely identify owned backup across other stash activity; use captured OID and separate checked cleanup.
- Change every `pullRebase` caller: affects push-rejection retry outside request.
- Full JetBrains parity in one issue: new strategy/settings/shelf/multiroot behavior broadens scope beyond reported inability to pull with local edits.
- Durable automatic recovery after restart/continue: useful future expansion, but requires a new persisted contract and additional lifecycle correctness. Named retained stash + current recovery UI is the smaller complete v1 contract.

## Required plan output

### Root review decisions, 2026-09-30

The first plan draft exposed two inconsistencies. These decisions supersede any earlier automatic-cleanup wording in this brief or reports:

1. **Retain the operation backup by default in v1, including after successful restoration.** Never automatically run stash drop/pop/clear in this feature. Stash selector check-then-drop is not atomic against an independent Git process changing the stash list, so an absolute promise to leave unrelated stashes untouched was incompatible with automatic cleanup. Keep the ordinary named stash, show a normal complete-with-backup-retained message, and let the user inspect/remove it through existing explicit stash management. This is deliberate expected behavior, not a cleanup failure. State the tradeoff candidly: one additional recovery copy per dirty update until manually removed. Clean updates create no backup. Do not add expiry, background cleanup, extra preference, special refs, or external lock protocol. Tests must assert no deletion at all, exact-OID application, and preservation of pre-existing/later-added stashes. This is a root design verdict; the author implements it in PLAN.md.
2. **Restore failure presentation depends on integration outcome.** If pull succeeded but restore failed, say pull completed and local restoration is incomplete. If pull failed and then restore failed, say both failed/incomplete, retain both diagnostics and backup identity. Add the second case to failure matrix, named UI assertion, and documentation. Never print the successful-integration wording just because the outcome kind is restore-failed.

The Sol review settled current facts (full review `/private/tmp/issue286-plan-review.md`): `vitest.config.ts:10` includes the proposed integration test path, so no Vitest configuration change is needed. `package.json:1593` explicitly enumerates E2E specs, so register the new current-branch spec. Existing clean toolbar regression command is `rtk test bunx playwright test --config=playwright.e2e.config.ts tests/e2e/flows/flows.spec.ts --grep '^pull pull$' --workers=1 --retries=0`. Existing Unstash already offers matching stash → Apply → Reinstate Index (`src/commands/fileContextCommands.ts:638-640,695-697,719`) and binds the clicked repository (`:541-554`). It requires a clean worktree before/after prompts (`:556-562,598-605`). Therefore no new index option or recovery UI entrypoint is needed; partial restoration specifically needs separate-path/manual instructions, not an instruction to reapply the whole stash into dirty state. Treat these as verified facts and remove speculative conditional source edits.

UI/test lane's verified existing test anchors: `tests/unit/views/commitPanelActions.test.ts:121-140` parameterizes dirty Pull/Sync rejection; `tests/unit/commands/branchUpdateCommand.test.ts:97-154` covers shared rebase, dirty refusal, noncurrent refspec; `tests/unit/activation/repositoryCommands.test.ts:863-944` covers clicked-root refresh/failure behavior. Runtime native fixtures: `tests/e2e/fileContextPull.spec.ts:21-96`, `tests/e2e/flows/matrix.ts:523-581`; coverage gaps at `tests/e2e/coverage-manifest.ts:70-79,144-146`. `src/activation/repositoryCommands.ts:883-905` binds file Pull to clicked root. Sync currently pulls then pushes consecutively at `src/views/commitPanelActions.ts:796-797`. All required localization scripts exist. Native harness pins VS Code 1.137.0, one worker, zero retries. Read lane artifact for exact runnable command strings.

Write exactly `docs/superpowers/plans/2026-09-30-issue-286/PLAN.md` with Goal, Approach, Key decisions, Out of scope, concrete interaction flow, outcomes/failure behavior, file-by-file tasks, contract-derived tests, dependency order, regression risks, and verification commands. Include source evidence and known verification limits.

Map each criterion to a named test scenario BEFORE implementation. Cover dirty tracked, untracked only, split staged/unstaged, user stash stack changes, linked worktrees/common-dir gate, cancellation, refresh root, update integration conflict, restore conflict without unmerged entries (untracked collision/index failure), failures and cancellation after backup creation, no stash needed, no upstream/active operation/unsafe unsupported state, Sync push ordering, no false success, and no blind retry of a partially applied restore.

Use existing helpers and patterns; introduce the smallest dedicated orchestration unit if shared command flow needs a seam. Include meaningful JSDoc for new/changed APIs. Preserve localization pipeline via reviewed CSV import; read repository instructions from evidence reports.

Verification sequence: focused unit/real-Git tests, native VS Code runtime proof for relevant user interaction, `npx --yes impeccable detect` on affected UI paths after tests, localization pipeline before final standard validation, `format:check`, `lint`, `lint:strict`, `architecture:check`, `react-doctor`, `typecheck`, `build`, `test`, `l10n:validate`, `l10n:audit`, and pre-commit graph analysis. State which commands actually exist based on UI/test report. Version/commit/release packaging happens only during authorized implementation; no commit, PR, publish, tag, or merge now.

Plan author runs no tests/commands and changes only PLAN.md. Root corrects factual errors only; fresh Sol reviewer reviews completed plan, then root owns final verdict and verification.
