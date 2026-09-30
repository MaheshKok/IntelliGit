# Pull with Local Changes — Issue #286 Implementation Plan

> **For agentic workers:** Execute this frozen plan using the repository's current Builder/Root routing and verification rules. Use `superpowers:executing-plans` for task tracking; the repository's explicit routing and commit requirements override generic skill recommendations. Steps use checkboxes. This document authorizes no implementation, commit, PR, or release by itself.

**Goal:** Allow existing Pull and current-branch Update actions to update a repository with local changes while preserving saved tracked edits, their staged/unstaged distinction, and ordinary nonignored untracked files, with explicit recovery when integration or restoration cannot finish.

**Architecture:** A small Git orchestration unit owns one named stash, runs the existing rebase strategy with native autostash disabled, restores the exact stash object with its index state, retains that backup even on success, and returns a structured outcome. The shared native command flow handles consent, progress, recovery messages, and repository-scoped refresh. The existing common-directory mutation gate protects the entire mutation sequence; no new recovery journal, settings system, or conflict engine is introduced. This feature never automatically drops, pops, or clears a stash.

**Tech stack:** Existing TypeScript, VS Code native dialogs/progress, Git CLI, Vitest, and native VS Code Playwright/Electron harness. No new dependency.

**Planning baseline:** `main` at `ac59017c9daa31e19c5e9c3c098aa3b860d1aef6`, investigated on 2026-09-30. Paths and line numbers below refer to that baseline. This is a proposed implementation, not a claim that the feature exists or its tests pass.

## Goal and acceptance contract

The feature is done when a user can invoke an existing Pull action, or Update on the current branch, explicitly allow temporary saving, receive upstream changes, and find their saved local work restored with its staging state. It is also done only if unsuccessful paths retain recoverable work and explain whether the update or the local restoration stopped.

| ID | Required behavior | Contract test that proves it |
| --- | --- | --- |
| A1 | A clean repository follows the existing rebase strategy without a consent prompt or an unnecessary stash. | `clean update rebases without creating a stash` |
| A2 | Dirty tracked work and ordinary untracked files survive a successful update; remote content actually changes. | `dirty update restores tracked and untracked bytes after changed upstream` |
| A3 | Staged edits stay staged and unstaged edits stay unstaged, including two disjoint edits in the same file. | `restoration preserves split index and worktree edits in one file` |
| A4 | Cancel/dismiss before mutation changes no Git state, files, stash entries, or remote refs. | `cancelled consent performs no mutation` |
| A5 | A backup belongs to this operation and is applied by immutable OID; it remains after success or failure, and this feature deletes no stash. | `stash insertion does not change the applied backup identity`; `successful dirty update retains owned and unrelated stashes without deletion` |
| A6 | A rebase conflict leaves local work saved and never applies it into the active rebase. | `integration conflict retains backup without attempting restoration` |
| A7 | Failed restoration is reported even without unmerged paths; wording distinguishes successful from failed integration, retains both diagnostics when both fail, and identifies the backup without complete-success messaging. | `untracked collision is a restoration failure with both versions recoverable`; `index restoration failure is not reported as success`; `failed pull and failed indexed restoration without unmerged paths reports both failures` |
| A8 | Failed integration with no active operation attempts restoration only from a verified safe state; any uncertainty retains the backup. | `network failure restores saved work when repository is still safe`; `changed repository retains backup instead of applying it` |
| A9 | The clicked repository/worktree remains the owner through consent, mutation, recovery actions, and refresh, even if the active root changes. | `active-root switch during consent cannot retarget update or recovery` |
| A10 | Dirty Sync remains refused and never pulls or pushes. Existing clean Sync ordering and raw push-rejection retry remain unchanged. | `dirty Sync never invokes preservation pull or push`; existing clean Sync/push-retry tests |
| A11 | Current-branch Update uses the enhanced Pull flow; noncurrent-branch Update still fetches its ref without touching local work. | `current Update restores local work`; `noncurrent Update remains fetch-only` |
| A12 | Linked worktrees share the mutation gate without nested acquisition; an operation never acts on the other worktree's files. | `linked-worktree update serializes common-directory mutations without deadlock` |
| A13 | Unsupported/unsafe starting states refuse before backup creation, with a reason the user can act on. | `no upstream refuses before stash`; `active operation or unmerged index refuses before stash`; `dirty submodule or nested repository refuses before stash` |
| A14 | Continue/Abort/restart does not falsely promise automatic restoration; the named stash remains available for deliberate recovery. | `retained backup survives restart and is recoverable after continue or abort` |
| A15 | Saving failure, refresh failure, and interrupted execution cannot masquerade as a complete update; no outcome performs stash deletion. | Failure cases in the outcome matrix and Task 3 |

The backup contract covers Git-reported staged/unstaged tracked changes and ordinary nonignored untracked files saved on disk. It is not a snapshot of the whole workspace. Ignored files and unsaved editor buffers are excluded. Git may overwrite an ignored file if upstream begins tracking that path; this was observed during investigation and must be documented. Do not use `stash --all`, forced checkout, reset, clean, automatic Save All, or an index-losing restore fallback to widen this contract silently.

## Evidence and why this approach

The current refusal is in `src/views/commitPanelActions.ts:739-744`; `warnIfUncommittedChanges` at `:550-556` blocks both Pull and Sync. `src/git/operations.ts:775` includes untracked files when detecting dirty state. `pullRebase` at `:1269` invokes `pull --rebase`. Removing the warning alone therefore does not solve tracked dirty worktrees.

Current-branch Update already shares Pull (`src/commands/branchCommands.ts:764-780`), while Update on another branch fetches a ref (`:783-799`). File Pull captures the clicked repository (`src/commands/fileContextCommands.ts:965-989`), and registration refreshes only the matching active root (`src/activation/repositoryCommands.ts:883-905`). Preserve these ownership rules.

Existing primitives demonstrate the required Git operations: `stashSave` includes untracked files and `stashApplyByHash` supports `--index` (`src/git/operations.ts:1510,1536`). The existing `stashDeleteIfHashMatches` (`:1562`) is not used by this feature: checking a mutable selector before deleting it cannot prevent an independent Git process from changing that selector between commands. The common-directory gate provides an ungated runner (`src/git/executor.ts:107-131`). Calling an already gated helper while holding that gate can deadlock.

Root verification ran `python3 /private/tmp/issue286-git-probes.py`: **18 assertions passed, exit 0**, using Apple Git 2.54.0. Commands/results are in `/private/tmp/issue286-git-aw9k63rs/commands.log`. These are Git semantic probes, not implementation or native UI tests. They verified successful explicit stash/index restoration, split staging, prior-stash preservation in an isolated fixture, integration-conflict recovery after Continue and Abort, and an untracked collision retaining both versions. They also demonstrated three reasons not to use native autostash alone: staged classification can be lost; untracked collisions are not protected; and pull can exit zero while restoration leaves conflicts. A deterministic check/insert/drop interleaving deleted a newer unrelated stash after its selector had previously identified the owned stash; this confirms the reason for retaining backups instead of attempting automatic deletion.

The issue's wider comparison needs qualification: [VS Code already exposes `git.autoStash`](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/package.json), default false. The missing experience here is IntelliGit's own dirty Pull flow. [JetBrains supports Merge/Rebase and Stash/Shelve choices](https://www.jetbrains.com/help/idea/settings-version-control-git.html); implementing all those choices is a separate product scope. [Git stash documentation](https://git-scm.com/docs/git-stash) supports the chosen include-untracked, exact-object apply, and index-restoration semantics, including restoration failure limitations.

Investigation packets: `BRIEF.md` beside this plan, `/private/tmp/issue286-service-evidence.md`, `/private/tmp/issue286-ui-tests-evidence.md`, and `/private/tmp/issue286-research-evidence.md`. Temporary packets are evidence pointers for this session; this plan retains the implementation decisions needed if those files disappear.

## Approach and concrete interaction

1. Capture the original scoped GitOps, repository/worktree root, branch, and upstream using the existing command route, before any prompt. Use that captured context for every subsequent callback.
2. Perform read-only preflight. Refuse an unsupported state before temporarily saving anything. A missing upstream keeps the existing actionable refusal. Dirty Sync keeps its existing refusal.
3. Clean Pull proceeds through the new orchestration without a consent prompt. Dirty Pull/current Update shows one native modal warning with the repository and branch clearly identified. Proposed copy: **“Pull with local changes?”** Detail: **“Your saved tracked and untracked changes will be stashed, then restored after the pull. Staged changes will stay staged when restoration succeeds. A named backup will remain until you remove it through stash management. Ignored files and unsaved editor changes are not included.”** Actions: **“Save Changes and Pull”** and Cancel. Current Update may use “Save Changes and Update” while retaining the same underlying flow. Dismissal means cancel. No remember-choice setting in v1.
4. Acquire the existing common-directory mutation gate only after consent. Recheck repository/branch/upstream and unsafe Git states inside the gate. Do not hold the gate while waiting for user input. If an initially clean repository is now dirty and consent was not granted, release the gate and request consent before restarting preflight; never silently save it. If the selected branch/upstream changed, stop with an explicit stale-context message rather than operating on the replacement branch.
5. Use native noncancellable progress for the mutation sequence: saving local changes, pulling, then restoring. Cancellation is available before mutations begin. Do not terminate Git in the middle of a backup/restore solely because a progress token or view was disposed. If existing lifecycle cancellation can interrupt it, classify the interruption using the same failure/retained-backup rules below; do not imply rollback happened.
6. On complete integration and restoration, refresh the captured repository. Clean updates show existing success behavior. Dirty updates show normal success with expected backup retention: **“Pull completed and your local changes were restored. A backup remains in {stashName} ({shortHash}); you can remove it through stash management after checking your changes.”** This is not a warning or cleanup failure. Each dirty update leaves one additional recovery copy until the user deliberately removes it; no apply is retried.
7. On integration conflict, refresh that repository, use its existing conflict session, and report: **“The pull needs conflict resolution. Your local changes are saved in {stashName} ({shortHash}). After completing or aborting the rebase and checking that the worktree is clean, use Unstash Changes → matching backup → Apply → Reinstate Index.”** Do not apply saved work while the rebase is active, and do not claim continuation/abort will restore it automatically.
8. On restoration failure, branch the message on the recorded integration outcome. After successful integration: **“The pull completed, but some local changes could not be restored. Your saved copy is {stashName} ({shortHash}). Review the current files before recovery.”** After failed integration: **“The pull failed, and local changes could not be fully restored. Your saved copy is {stashName} ({shortHash}). Review both errors and the current files before recovery.”** Preserve both Git diagnostics and the full backup OID in the result/error details when both phases fail. If Git actually has unmerged paths, open the existing conflict session. If it does not, still report failure: untracked collisions and index failures are real restoration failures. Recovery guidance must describe inspection and separate-path/manual recovery because existing Unstash refuses a dirty worktree; do not direct the user to reapply the entire stash into partially restored files. Never automatically apply or retry the stash.
9. On reload/restart, the descriptive stash is ordinary Git state visible to existing Unstash Changes. No background restore or operation resumption occurs. User documentation covers both after-rebase recovery and partially applied restoration, which require different next steps.

Final copy must use existing localization conventions and be reviewed in the native UI. Do not put internal operation IDs, state-machine vocabulary, or raw command output in a success message. A short stash identity identifies the expected retained backup on success and the recovery copy on incomplete outcomes.

## Key decisions

### One bounded orchestration unit

Create `src/git/updateWithLocalChanges.ts` for this sequence and its result contract. Add one narrow GitOps entrypoint in `src/git/operations.ts`, proposed name `pullRebasePreservingLocalChanges`, which delegates under `runWithinMutationGate`. Its options convey consent to temporary saving and the expected repository/branch context; its result distinguishes outcomes below. The helper receives the existing ungated runner and the minimum context needed for preflight and naming. Reuse executor types after checking the actual source; do not invent a parallel executor interface, event bus, repository abstraction, or retry framework.

Leave `pullRebase()` unchanged: push-rejection retry also uses it. Only the shared operation's `pull` arm calls the new entrypoint. The `sync` arm keeps the existing dirty guard, then its existing pull/push path.

The proposed result is a discriminated union with these semantic cases. Exact TypeScript spelling may follow existing conventions, but do not collapse these distinctions into a single boolean or generic thrown error:

| Outcome | Required data | UI consequence |
| --- | --- | --- |
| `complete` | Integration and any required restoration succeeded; retained-backup identity whenever a backup was created | Normal success; dirty updates explicitly identify the expected retained backup |
| `confirmation-required` | Repository became dirty before any mutation | Release gate and ask consent |
| `refused` | Actionable preflight reason; no mutation | Explain refusal; no success |
| `integration-conflict` | Active operation/conflict state; owned backup identity if one exists | Existing conflict UI; manual restoration later |
| `restore-failed` | Explicit integration success/failure, original integration error when failed, restore error, unmerged-path state, owned backup identity | Distinguish completed pull with incomplete restoration from failed pull and failed restoration; retain both diagnostics; no auto-retry |
| `failed` | Phase, original error, whether local work is untouched/restored/still saved/uncertain, backup identity when captured | Accurate failure with recovery instructions |

Consent cancellation stays in the UI before the mutation method. A dirty restore result with `complete` must mean `apply --index` succeeded and postconditions passed, not merely that pull exited zero. Exceptions unexpected by the orchestrator are handled by its outer failure path with the captured backup identity retained; presentation errors are handled separately from Git outcomes.

### Preflight rejects states that cannot meet the contract

Before creating a stash, confirm a valid attached branch with usable upstream and no merge, rebase, cherry-pick, revert, or unmerged-index state. Refuse unborn/detached states through an actionable existing or narrowly added message. After waiting for the gate, repeat the checks that can change.

Explicitly detect dirty submodule working directories and untracked nested repositories; refuse them before saving. `stash --include-untracked` does not establish a backup guarantee for their contents. Check existing status/parser capability first; do not assume the current generic dirty boolean identifies these cases. Use a narrowly scoped Git/status and filesystem-boundary check if necessary. A clean initialized submodule is not grounds to refuse an otherwise supported update. A staged gitlink change without submodule worktree dirt is an implementation preflight question: prove its save/index-restore behavior with a real fixture before enabling it; otherwise explicitly reject it with the same unsupported-state explanation.

Test intent-to-add and Git index states that make stash creation fail. They may receive an explicit preflight refusal or a save-failure outcome, but never proceed to pull on an uncertain backup. Honor Git's actual reported state; do not advertise preservation of files hidden from Git by index flags or external ignore rules as a whole-workspace guarantee.

### Save, integrate, restore, retain

The following is an algorithm contract, not a pasted implementation. Implement it using the verified executor API and Git error types.

1. **Remember starting state.** Under the gate, capture current branch/HEAD/upstream and the existing stash identities. Create a unique, recognizable message such as `IntelliGit update: <branch> <timestamp> [<operation-id>]`. The repository remains the captured worktree; the operation ID is an ownership token, not a new persisted schema.
2. **Save only when needed.** Run `git stash push --include-untracked --message <unique-message>` using an argument array. Check the command result and enumerate stash entries to locate exactly the newly created entry carrying that unique token. Resolve its full OID. Do not identify it solely by the current top entry, English stdout, or an assumed unchanged stash index. Verify it was not already in the pre-save set. A no-change race must not make an older user stash look owned.
3. **Handle save ambiguity conservatively.** On a failed/interrupted save, inspect for a stash with the owned token: Git may have written the backup before cleanup failed. Do not pull. Retain/report any owned entry and current worktree state; do not blindly apply a snapshot over partially cleaned local files. If ownership cannot be established unambiguously, stop and show the unique name to locate in existing recovery UI. Never claim the original workspace was untouched without checking it.
4. **Verify ready-to-pull state.** After successful save, require the supported dirty state to be cleared and require the same branch plus no active operation/unmerged index. Residual changes, a nested repository, changed branch, or detected concurrent mutation stops the update and retains the backup. Restoring into that unexpected state needs user review, not a forced apply.
5. **Integrate.** Run `git pull --rebase --no-autostash` with the ungated runner. The explicit option prevents user Git autostash configuration from creating a second restoration mechanism. Avoid an initial `-c` argument: the existing executor's mutation classifier examines `args[0]` (`src/git/executor.ts:349-379`). Do not change global/local Git configuration. Preserve the existing upstream resolution and rebase behavior.
6. **Classify integration.** Inspect the exit result and real operation/index state. Any active rebase/merge or unmerged index means no automatic stash restoration. Preserve the owned backup, refresh, and expose the existing conflict recovery. A failed pull with no active operation is eligible for restoration only if the original branch/worktree still matches and the worktree is safe for it. Git failure does not imply HEAD was unchanged; record/report the actual state.
7. **Restore once.** If there was no owned backup, restoration is unnecessary. Otherwise verify the expected post-integration state has no unexpected local changes/active operation, confirm the saved object still exists, and run `git stash apply --index <owned-OID>` exactly once. Never fall back to applying without `--index`, `pop`, forced checkout, or automatic second application. On failure, retain the stash even if no unmerged paths exist: application may already have restored some files.
8. **Verify restoration outcome.** Require apply exit zero, no active operation or unmerged paths, and unchanged branch ownership. Use real-Git tests to prove the staging/content guarantees under supported cases; runtime status alone is not a byte-for-byte reconstruction proof. If an unexpected external mutation makes the result uncertain, retain the backup and report the uncertainty rather than announcing complete restoration.
9. **Retain the backup on every outcome.** Leave the owned named stash in place after successful restoration as well as failure. No branch of this feature calls stash drop, pop, clear, or the checked-delete helper. Apply only the captured OID; changing stash selectors cannot retarget that application. The user can inspect and deliberately remove a redundant copy through existing stash management. This intentionally accumulates one recovery copy per dirty update until manually managed; clean updates create none.
10. **Release then present.** Finish mutation work and release the gate before prompts, conflict UI, recovery UI, or refresh callbacks. Return the structured result to the shared action. Refresh failures cannot change a successful Git outcome into “pull failed,” and cannot cause the operation to run again.

The common-directory gate serializes IntelliGit mutations, including linked worktrees. It does not lock editor writes or independent external Git processes. Revalidation must detect observable interference and report an uncertain or missing backup rather than inventing preservation. Tests prove cooperation inside IntelliGit plus response to detected external changes. This feature cannot delete an unrelated stash because it performs no stash deletion at all; exact-OID application protects restoration identity when the stash stack changes. The recorded check/drop race is the reason this retention policy is fixed, not an implementation uncertainty. Document that concurrent external Git operations must finish before using this workflow; do not introduce a home-grown ref-lock protocol.

### Failure and recovery matrix

| Event | Required action | Preserved work and user instruction |
| --- | --- | --- |
| Cancel before gate/mutation | Return with no mutation | Original files/index/stashes unchanged |
| No upstream, detached/unborn, active operation, unsupported dirt | Refuse before save | Explain the specific prerequisite |
| Save fails before or after creating a backup | Do not pull; inspect ownership/current state | Original files and/or named saved copy; describe actual evidence |
| Pull fails, original branch safe, no active operation | Attempt one exact-OID indexed restoration | Report pull failure and whether local restoration succeeded |
| Pull fails, then indexed restoration fails with no unmerged paths | Retain both errors and the owned OID; no second apply and no deletion | Report both pull failure and incomplete local restoration; never say the pull completed or show complete success |
| Pull fails and branch/state is unsafe | Do not apply | Named backup retained; manual recovery after state is understood |
| Rebase conflicts | Do not apply or delete | Finish/abort rebase; with a clean worktree, select matching Unstash backup → Apply → Reinstate Index |
| Pull succeeds but restore fails | No deletion, no fallback, no automatic retry | State that pull completed but restoration is incomplete; some changes may already be present and the named backup retains the saved snapshot |
| Untracked path collides with an incoming tracked file | Keep incoming worktree version and retained stash | Original untracked bytes remain in the stash's untracked parent; recover to a separate path before deciding which version to keep |
| Pull and restoration succeed | Retain owned backup; no second apply and no stash deletion | Update is complete; identify the expected recovery copy and existing manual stash management |
| Extension reload/process interruption after save | No invented automatic rollback | Discoverable named stash survives; inspect Git state before manual recovery |
| Refresh fails after a Git outcome | Preserve that outcome; report display refresh error separately | No rerun of save, pull, or restore |

The existing Unstash flow already captures the clicked repository (`src/commands/fileContextCommands.ts:541-554`), offers **Apply** (`:638-640`) and **Reinstate Index** (`:695-697`), and applies the selected OID/index choice (`:719`). It requires a clean worktree both before and after prompts (`:556-562,598-605`). Clean post-rebase recovery therefore uses **Unstash Changes → matching name/hash → Apply → Reinstate Index**; no new index option or recovery UI entrypoint is needed. Partial restoration requires inspecting current state and recovering needed files to separate paths/manual reconciliation before any further application; it must not be routed into a whole-stash reapply that the existing flow correctly refuses.

## File map and dependency order

| File | Planned responsibility |
| --- | --- |
| `src/git/updateWithLocalChanges.ts` — new | Preflight/save/pull/restore algorithm, unconditional backup retention, and structured outcome; uses supplied ungated executor runner |
| `src/git/operations.ts` | One scoped wrapper for that algorithm; existing `pullRebase` contract unchanged; only minimal helper reuse if necessary |
| `src/views/commitPanelActions.ts` | Split dirty Pull from dirty Sync; native consent/progress; map outcomes to correct messages/recovery/refresh |
| `src/commands/branchCommands.ts` | Capture current-Update mutation, refresh, and conflict ownership before consent; avoid duplicate presentation; keep noncurrent Update unchanged |
| `src/activation/repositoryCommands.ts` | Preserve clicked-root refresh and bind current-Update refresh/conflict callbacks to the captured repository rather than the later active root |
| `tests/unit/git/updateWithLocalChanges.test.ts` — new | Orchestration ordering, error classification, single apply, identity checks, no nested gate |
| `tests/integration/git/updateWithLocalChanges.integration.test.ts` — new | Disposable real repositories prove content/index/untracked/stash/remote guarantees |
| `tests/unit/views/commitPanelActions.test.ts` | Replace only dirty Pull rejection; retain dirty Sync refusal; test consent/outcomes/refresh |
| `tests/unit/commands/branchUpdateCommand.test.ts` | Enhanced current Update; unchanged noncurrent fetch behavior |
| `tests/unit/activation/repositoryCommands.test.ts` | Captured-root consent/recovery and refresh-error behavior |
| `tests/integration/extension/extension.integration.test.ts` | Existing mocked activation/current-branch routing coverage adjusted narrowly |
| `tests/e2e/fileContextPull.spec.ts` | Real native dirty Pull, cancellation, and restoration-failure proof; preserve clean proof |
| `tests/e2e/currentBranchUpdate.spec.ts` — new | Native current-branch Update reuses the same consent/restoration flow |
| `tests/e2e/flows/matrix.ts` | Keep existing clean Changes-toolbar rebase row; add/adjust assertions only when required |
| `tests/e2e/coverage-manifest.ts` | Record exactly the native surfaces/scenarios actually proven |
| `package.json` | Register the new dedicated E2E spec in the explicitly enumerated script (`:1593`); later one authorized version bump, no new command/config contribution |
| `docs/features/pull-with-local-changes.md` — new | Supported coverage, conflict/restart/manual recovery, ignored/unsaved limitations |
| `CHANGELOG.md` | One short user-facing entry during implementation delivery |
| `docs/localization/localization_translation_review.csv` and existing generated catalogs | Reviewed translations imported using the repository pipeline |

Do not touch every conditional file preemptively. Tests may demonstrate an existing route already meets the contract. New test paths are proposed files, not claims about existing coverage. `vitest.config.ts:10` includes `tests/**/*.test.ts` and `tests/**/*.test.tsx`, so the proposed integration suite is already included; no Vitest configuration change is needed. Use existing real-Git fixture conventions. Existing Unstash source is a verified reuse point, not a planned source change.

Dependency order: **Task 1 preflight/contract → Task 2 successful transaction → Task 3 failures/concurrency → Task 4 command integration → Task 5 native proof → Task 6 documentation/localization → Task 7 final gates/review.** Task 6 copy drafting can run after Task 4 while native verification proceeds if separate ownership is maintained. A single primary Builder should own production mutation changes.

## Task 1 — Freeze executable contracts and implementation preflight

**Files:** Existing source/test anchors in the file map; new unit/integration test files above. No production edits until the relevant contract tests are in place.

- [ ] Verify checkout, worktree, branch, status, current base, and issue state again. This planning baseline does not authorize creating/switching a branch or assume main has not moved.
- [ ] Read applicable repository rules and `docs/localization/README.md`. Resolve the actual runner type, Git error result shape, operation-state detection helpers, and stash metadata/list support. These are known implementation preflight checks, not permission to redesign other services. Reuse the source-verified Unstash Apply → Reinstate Index flow within its clean-worktree precondition.
- [ ] Refresh stale graph orientation as required. Run upstream impact for the actual changed symbols, including the shared action and any reused stash helper. The investigation's LOW result had unresolved receivers and is a lower bound, not approval to ignore callers. Report HIGH/CRITICAL before editing; confirm UNKNOWN with actual call sites.
- [ ] Create disposable-repository fixture support inside the new integration test file using existing conventions. Each case owns its temp directory, local bare origin, deterministic branch/upstream, and exact-byte assertions; cleanup only that fixture. No network remote is needed.
- [ ] Write the A1–A3/A5 happy-path tests first. Assert upstream changed a real file, local branch/upstream identity remains correct, staged and unstaged diffs match the expected local edits, untracked bytes survive, and origin refs do not change. Include untracked-only work and a pre-existing stash. Assert the operation-owned named backup remains after successful restoration and no stash deletion command is issued.
- [ ] Run the focused files and read their named failures. Initial failure should identify the missing orchestration or absent behavior; after the seam exists, each regression must fail for its own contract. Do not accept a timeout, unrelated setup error, or test-count change as evidence.

Run after files exist: `rtk vitest run tests/unit/git/updateWithLocalChanges.test.ts tests/integration/git/updateWithLocalChanges.integration.test.ts --reporter=verbose`.

Expected initially: named failing assertions for unsupported dirty update. Expected after Task 2: selected happy-path cases pass; unimplemented failure cases are added and proven separately in Task 3. The proposed integration path is covered by the existing Vitest include pattern; verify the run lists the named tests instead of assuming an exit-zero command discovered them.

## Task 2 — Implement the smallest successful transaction

**Create:** `src/git/updateWithLocalChanges.ts`. **Modify:** `src/git/operations.ts`. **Tests:** New unit/real-Git files.

- [ ] Add the structured outcome types and narrow GitOps wrapper described above with meaningful JSDoc: ownership, lock boundary, backup coverage, side effects, failure outcomes, and manual recovery limits.
- [ ] Implement preflight, no-stash clean path, unique owned stash capture, `pull --rebase --no-autostash`, one `apply --index <OID>`, and unconditional retention of the backup using only the supplied ungated runner while the gate is held. Add no stash deletion command or cleanup phase.
- [ ] Ensure raw `pullRebase` and its push-retry callers are unchanged. Do not modify executor mutation classification merely to support this operation's command shape.
- [ ] Run the focused happy-path cases. Assert actual index/worktree content, not just method calls or successful Git exits.
- [ ] Add and run path-sensitive cases for spaces, Unicode, renames/deletions, binary bytes, and a clean initialized submodule where supported by the test host. Argument arrays must prevent path/message shell interpretation. Do not use platform skips as a substitute for reporting unverified mode/symlink behavior.
- [ ] Inspect the diff and confirm no helper recursively acquires the mutation gate. A completion assertion under a bounded test timeout must prove a single operation finishes; “test did not hang yet” is not evidence.

Expected: A1–A3/A5 pass against real Git; source changes remain limited to the new orchestration and its wrapper. A failed compatibility probe becomes a documented preflight refusal or a resolved implementation defect before UI adoption.

## Task 3 — Prove failures, recovery, and mutation ownership

**Files:** New orchestration/tests; minimal wrapper corrections only.

- [ ] Add named tests before implementing each missing outcome: no upstream, active rebase/merge/cherry-pick/revert, unmerged index, detached/unborn state, dirty submodule/nested repository, intent-to-add save failure, save failure with/without a newly created stash, and residual dirt after save. Assert no pull when the backup is unverified.
- [ ] Add real-Git integration-conflict cases. Save staged/unstaged/untracked work, produce a commit rebase conflict, assert no stash apply occurred, then separately Continue and Abort the rebase and deliberately apply the retained OID with `--index`. Assert restored local content and staging. These tests simulate manual recovery; they do not imply the extension will automatically restore later.
- [ ] Add restore-failure cases with (a) unmerged paths, (b) an incoming tracked file colliding with a saved untracked file, and (c) index restoration failure without relying on unmerged-path detection. Assert retained OID, no deletion, no second apply, actual partial worktree state, and recoverable original bytes. For the collision, inspect `<OID>^3:<path>` and the incoming worktree file independently.
- [ ] Add failed pull with no active operation and a safe clean state: one restoration is attempted and the result remains “pull failed, local work restored.” Add `failed pull and failed indexed restoration without unmerged paths reports both failures`: assert explicit failed integration, both original diagnostics, retained owned OID, exactly one indexed apply, zero stash deletion, and no pull-complete/success wording in the paired UI test. Add changed branch, active operation appearing, missing backup object, and unexpected new dirt: no blind restoration.
- [ ] Add post-save interruption at each boundary using controlled runner failure: before pull, during pull, before restore, and during restore. Assert the recovery identity survives the result and no unconditional-finally restore runs into an active operation. Add consent cancellation separately at the UI layer in Task 4.
- [ ] Add gate tests for two linked worktrees using their common directory and distinct roots. The second IntelliGit mutation cannot enter midway through the first transaction. Assert root ownership and that both finish when released.
- [ ] Add external-stash-change tests: pre-existing entries, a newly inserted user entry shifting the owned selector, duplicate references to the same saved object, and a missing owned backup object. Apply only the captured OID; assert pre-existing, later-added, and owned entries survive every operation-controlled outcome and that no drop/pop/clear command is issued. Missing objects produce explicit incomplete recovery information, not a substitute application.
- [ ] Assert successful restoration returns the retained backup identity as expected normal success. Clean updates return success without creating a backup. No outcome includes cleanup-failure classification, automatic deletion, or an extra apply.
- [ ] Mutation-prove the high-consequence assertions: remove `--index` (split-stage assertion red); apply current top instead of OID (owned-backup content assertion red); insert stash deletion after success or failure (no-deletion/backup-retention assertions red); ignore restore exit status (no-false-success assertion red); replace failed-integration restore copy with pull-complete wording (double-failure presentation assertion red); restore into active rebase (no-apply assertion red); release/reacquire the gate between phases (serialization assertion red). Restore each mutation and rerun the affected test. Record test names and actual failure assertions.

Run: `rtk vitest run tests/unit/git/updateWithLocalChanges.test.ts tests/integration/git/updateWithLocalChanges.integration.test.ts --reporter=verbose`.

Expected: all intended cases pass; each deliberate mutation produces the named assertion failure rather than a hang. If two attempts at a fix fail, stop that diagnosis and use the repository's required consultation/reset rule before a third attempt.

## Task 4 — Integrate existing Pull and current Update UI

**Modify:** `src/views/commitPanelActions.ts`; conditional routing files in the map. **Tests:** Existing three unit suites plus mocked extension integration coverage.

- [ ] Replace the old parameterized dirty Pull/Sync test (`tests/unit/views/commitPanelActions.test.ts:121-140`) with separate contracts: dirty Pull asks consent and uses the new method; dirty Sync still warns before upstream lookup and invokes neither pull nor push.
- [ ] Write consent tests: explicit approval, Cancel, dismissal, repository disappearing before execution, branch/upstream change, and initially clean state becoming dirty before the gated check. Assert cancellation performs no mutation and no success/refresh event implying work occurred.
- [ ] Write presentation tests for every outcome. A zero-exit pull with failed restoration must never use the complete-success toast. Add `failed pull and failed indexed restoration without unmerged paths reports both failures`: assert both diagnostics and backup identity are available, the pull is described as failed, and no “pull completed” or complete-success wording appears. Integration conflicts and restoration conflicts need different recovery text. Successful dirty update uses normal success with expected retained-backup identity; assert no push for any Pull outcome.
- [ ] Add the native dialog and noncancellable mutation progress; retain existing native VS Code patterns. Keep prompts outside the gate. The shared action consumes the structured result rather than letting a generic catch mislabel every recovery state.
- [ ] Update current-branch Update tests (`tests/unit/commands/branchUpdateCommand.test.ts:97-154`) to use the shared enhanced flow; preserve noncurrent fetch refspec and raw no-merge assertions. Add a current-Update consent/root-switch test proving mutation, retained-backup identity, conflict handling, and refresh stay bound to the initially selected repository. Replace its global refresh/live conflict callbacks with the minimum scoped callbacks needed. Avoid duplicate error/conflict UI if the shared action now owns it.
- [ ] Extend clicked-root tests (`tests/unit/activation/repositoryCommands.test.ts:863-944`) by switching the active repository during the consent promise. Assert mutation, backup/recovery actions, and status refresh stay bound to the originally clicked root; retain Windows normalization coverage.
- [ ] Test refresh error after completed update separately from Git failure. Verify no second pull/restore and no false “pull failed.” Refresh conflict/incomplete outcomes so visible state is not stale.
- [ ] Use the existing scoped Unstash Apply → Reinstate Index route for documented clean post-rebase recovery. Test that partial-restoration guidance calls for separate-path/manual recovery and never suggests blindly reapplying the whole stash into a dirty tree. Add no new Unstash option or recovery entrypoint.
- [ ] Run the focused command tests and existing mocked routing tests. Inspect the diff: graph, commit panel, undocked view, and file menu should inherit the shared behavior without separate copies of the transaction.

Run: `rtk vitest run tests/unit/views/commitPanelActions.test.ts tests/unit/commands/branchUpdateCommand.test.ts tests/unit/activation/repositoryCommands.test.ts tests/integration/extension/extension.integration.test.ts --reporter=verbose`.

Expected: changed dirty Pull/current Update contracts pass; dirty Sync and noncurrent Update still pass their original boundaries; captured-root and refresh-error cases pass. Mutation-remove the dirty Sync guard and captured-root callback binding separately; their named no-push/wrong-root assertions must fail.

## Task 5 — Native VS Code proof on real repositories

**Modify:** `tests/e2e/fileContextPull.spec.ts`, `tests/e2e/coverage-manifest.ts`, and the explicit E2E spec registration in `package.json:1593`. **Create:** `tests/e2e/currentBranchUpdate.spec.ts`. **Preserve:** clean toolbar flow in `tests/e2e/flows/matrix.ts:523-581`.

- [ ] Extend the file-context fixture to have an upstream commit that changes actual bytes, disjoint local tracked changes, staged and unstaged edits in one file, and an ordinary untracked file. Do not reuse only the old identical-tree upstream commit as evidence of restoration.
- [ ] Open the native Explorer/editor Pull menu, wait for the real consent dialog/action to be visible, approve it, and wait for the correct outcome. Read final HEAD, branch/upstream, index blob, worktree bytes, untracked bytes, stash list, and origin refs from the fixture. Assert A2/A3/A5, including the expected retained backup and preserved unrelated entries, not just toast visibility.
- [ ] Add native Cancel/dismiss proof with all those values unchanged. Wait for the visible dialog before Escape or clicking; a premature Escape is not cancellation proof.
- [ ] Add native restoration-failure proof with an untracked incoming-path collision. Assert failure wording, absence of complete-success wording, visible recovery identity, retained stash, both versions recoverable, and no automatic second apply. This catches the case where `git status` has no unmerged entry.
- [ ] Add the current-branch Update native test through its actual branch action. Assert the same consent and successful restoration. Preserve the distinct noncurrent Update unit/route contract; do not claim native coverage for surfaces that were not exercised.
- [ ] Register `tests/e2e/currentBranchUpdate.spec.ts` in the existing enumerated E2E script so normal E2E delivery runs it as well as the dedicated command below.
- [ ] Run the existing clean Changes-toolbar rebase flow as regression evidence: local commit rebased, origin unchanged, incoming badge removed, outgoing badge retained. Its verified selector is `tests/e2e/flows/flows.spec.ts --grep 'pull pull$'`; the matrix file is not the standalone Playwright spec.
- [ ] Record coverage manifest entries only after the native scenarios pass. Keep explicit gaps for untouched graph-title/other surfaces unless independently proven.

Build: `bun run build`.

Run dedicated native proof: `rtk test bunx playwright test --config=playwright.e2e.config.ts tests/e2e/fileContextPull.spec.ts tests/e2e/currentBranchUpdate.spec.ts --workers=1 --retries=0`.

Run the existing clean toolbar regression: `rtk test bunx playwright test --config=playwright.e2e.config.ts tests/e2e/flows/flows.spec.ts --grep 'pull pull$' --workers=1 --retries=0`.

Expected: real VS Code tests pass on the configured host with no retry masking. The investigated harness pins VS Code 1.137.0, one worker, zero retries; the extension floor is `^1.107.0`. A pass on the pinned host is not minimum-version or cross-platform proof. Test the floor separately if APIs used differ from existing native APIs, or state that compatibility remains unverified. Use disposable profiles/extensions/control-channel directories and the existing fixture helpers.

After UI tests run: `npx --yes impeccable detect src/views/commitPanelActions.ts src/commands/branchCommands.ts src/activation/repositoryCommands.ts` using only actually affected paths. Expected: inspect and address relevant findings; do not treat the detector as proof of native interaction. Use the project-local Impeccable workflow for any user-facing UI editing, choosing one narrow command rather than chaining overlapping audits.

## Task 6 — Recovery documentation and static localization

**Create:** `docs/features/pull-with-local-changes.md`. **Modify:** `CHANGELOG.md`, reviewed translation CSV, generated catalogs through the existing import workflow.

- [ ] Document the exact backup boundary: saved Git-reported tracked changes, staging state when restoration succeeds, ordinary nonignored untracked files; exclude ignored files, unsaved buffers, and unsupported nested/submodule dirt. Say explicitly that ignored local files can be replaced by incoming tracked files under normal Git behavior.
- [ ] Document complete update with expected retained backup; integration conflict with local work still saved; completed pull with incomplete restoration; failed pull with local work restored; and failed pull with failed restoration. The double-failure case retains both diagnostics and backup identity, and must never say the pull completed. Include Continue and Abort followed, once the worktree is clean, by **Unstash Changes → matching name/hash → Apply → Reinstate Index**; do not imply either automatically restores local changes.
- [ ] Document restart discovery by stash message/OID and partial-restore caution. Existing Unstash requires a clean tree; partially restored files need inspection and separate-path/manual reconciliation. Explain that an untracked collision's saved file can be inspected in the stash untracked parent and recovered to a separate path; do not recommend applying the entire stash again over partially restored files or overwriting the incoming version. Avoid copy-ready destructive recovery commands.
- [ ] Explain that every dirty update deliberately retains its named backup, including after full success, and that clean updates create none. State the tradeoff: one additional recovery copy per dirty update until the user inspects/removes it through existing stash management. No automatic drop/pop/clear, expiry, or background cleanup occurs. Explain the external-Git concurrency limit without implying the common-directory lock covers other applications.
- [ ] Draft one plain-language changelog entry, for example: “Pull and current-branch Update can now temporarily save local changes and restore them afterward, with recovery guidance when conflicts occur.” Do not claim full IntelliJ parity or automatic recovery after restart.
- [ ] Run the required localization pipeline; review surrounding UI context and established terminology before importing. Protect placeholders, codicons, Git literals, and repository/stash identities. Do not add runtime translation.

Run in order: `bun run l10n:sync`; `bun run l10n:translate -- --only-missing`; `bun run l10n:import`; `bun scripts/localization-csv.js validate`. These scripts were confirmed available during investigation; recheck at implementation time. If any is unavailable or translation cannot run, report the exact failure and use existing validation without claiming the omitted step succeeded. The CSV remains the source of truth; generated catalogs must come from `scripts/localization-csv.js`.

Expected: placeholder/codicon/plural/literal/catalog-sync validation succeeds, and new messages read correctly in native UI. Translation generation alone is not a review of the terminology or screenshot.

## Task 7 — Final validation, adversarial review, and delivery

- [ ] Run focused tests first after the final production/localization changes. Rerun native proof if message handling, consent, recovery routing, or fixture inputs changed. Avoid repeating unaffected suites without a stated purpose.
- [ ] Run the full required standard set once on the integrated batch: `bun run format:check`, `bun run lint`, `bun run lint:strict`, `bun run architecture:check`, `bun run react-doctor`, `bun run typecheck`, `bun run build`, `bun run test`, `bun run l10n:validate`, `bun run l10n:audit`. Record exact exit codes/counts and recoverable logs. Never infer a command passed from a later command or truncated output.
- [ ] Because this alters shared Pull behavior, run `bun run test:coverage` unconditionally in final validation; report coverage scope, not just the percentage. Do not add redundant tests solely to inflate coverage.
- [ ] Run graph change analysis before an authorized commit: `node .gitnexus/run.cjs detect-changes --scope all --repo .` or the equivalent MCP call. `partial`, `truncated`, UNKNOWN, or unresolved receivers require a bounded follow-up; they are not a clean verdict. Combine graph evidence with changed-symbol review and actual tests.
- [ ] Root reads the final diff and verifies every acceptance row against actual evidence. Pay particular attention to false success, wrong-root recovery, partially applied restore, backup ownership, and accidental Sync/push-retry adoption.
- [ ] Use the required R1 Astra consultation before commit because the final change touches async mutation ordering and shared API contracts. Supply the actual diff and test/mutation evidence; ask “find the counterexample; which mutation would survive these tests.” Root owns the verdict and reruns any gate it reports. Record the trigger/question/decision impact.
- [ ] Confirm no product behavior slipped beyond the frozen scope. A requirement for a durable journal, a merge strategy preference, automatic continuation recovery, or atomic coordination with external processes is a plan revision, not incidental hardening.
- [ ] During authorized implementation delivery only, follow the repository's one-feature/one-version-bump/final-commit conventions and required PR process. Run production build/package checks if the authorized delivery changes release/packaging: `bun run build:prod`, `bun run package`. Do not publish, tag, merge, or create a PR during this planning task.

Final delivery evidence must distinguish: real Git semantics; unit/mocked routing results; native VS Code interaction; current platform/host-version limits; localization validation; and any hosted CI result. A local pass does not establish hosted CI completion. “Implemented” requires source/diff/status verification in the intended worktree, not this plan's existence.

## Out of scope

- Separate Update Project command/dialog, Merge/Rebase settings, automatic-save preference, remember-consent setting, multiroot batch update, or full JetBrains parity.
- Dirty Sync adoption or changes to push-rejection retry/publishing behavior.
- Durable update journal, new persisted schema, background operation observer, automatic restore after Continue/Abort/restart, or changes to interactive-rebase manifests.
- Automatic stash drop/pop/clear, backup expiry, background cleanup, retention settings, special recovery refs, or a protocol for locking independent external Git processes.
- Replacing Git stash with shelf, extending the shelf journal, or inventing a new conflict engine.
- Saving ignored files, unsaved editor buffers, nested repositories, or submodule worktree dirt automatically; force/reset/clean recovery.
- General executor refactors, unrelated command cleanup, dependency additions, or changing Git configuration.

## Remaining uncertainties and implementation stop conditions

The product choices above are fixed defaults for this plan. Remaining factual checks are the actual executor/error types and availability of operation-state and nested/submodule detection helpers. Resolve those before coding the affected seam. Unstash Apply → Reinstate Index and its clean-tree requirement, Vitest inclusion of the proposed suite, the explicit E2E registration requirement, and the clean toolbar selector are source-verified above, not open design questions. Report any source drift from the baseline and adjust only the corresponding concrete file/command fact.

The strongest objection is recovery complexity and accumulated backups: explicit saving gives stronger staging/untracked guarantees than native autostash, but failure handling is now IntelliGit's responsibility and every dirty update leaves one recovery copy until manually removed. The bounded response is one owned stash, one restoration attempt, no automatic deletion, explicit incomplete outcomes, and manual recovery after conflicts/restart. If any failure cannot preserve a recoverable copy or clearly describe its state, the feature is not ready to ship. Do not weaken the contract to make the happy path green.

This plan's evidence does not establish Windows/Linux Git behavior, native UI behavior, compatibility with every Git version, or safety under arbitrary simultaneous external Git operations. Those limits must remain visible until the matching checks run. No product code or repository validation suite was run by the plan author.
