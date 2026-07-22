# Plan Review Log: PyCharm-Parity Shelve for IntelliGit

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. Reviewer: gpt-5.6-sol (effort: R1 ultra, mid xhigh, final ultra).

Grill decisions locked:
1. Storage: patch files + metadata, PyCharm mechanics (not git refs).
2. Location: globalStorage per-repo + `intelligit.shelf.path` override.
3. No changelists — shelve maps to commit-panel selection, unshelve to working tree.
4. Scope: all three tiers (T1 core, T2 advanced parity, T3 polish).
5. Worktree/branch: `codex/pycharm-shelve-parity` stacked on `codex/pycharm-stash-parity`.

## Round 1 — Codex (gpt-5.6-sol, effort ultra)

VERDICT: REVISE. Full critique:

1. **Critical — combined diff can destroy staged-only content.** `git diff HEAD` plus rollback collapses index and working-tree layers: HEAD=A, staged=B, working tree restored to A produces an empty patch, then rollback destroys B. Fix: store separate HEAD→index and index→working-tree patches, or reject mixed-layer states before any rollback.
2. **Critical — capture-to-revert TOCTOU can delete newer edits.** Re-reading the stored patch does not detect an editor autosave or external Git change after capture but before checkout/clean. Fix: capture HEAD/index/path fingerprints and byte hashes, revalidate atomically before reverting; abort on mismatch.
3. **Required — the claimed operation gate does not exist.** CommitPanelRepositoryRuntime has none; both providers invoke stash actions directly. Fix: one activation-owned per-repository mutation queue shared by all mutation paths.
4. **Required — `git apply --3way` violates unshelve semantics.** Git 2.50.1: `--3way` implies `--index`, requires matching index/working copies, stages applied changes; `--whitespace=nowarn` only suppresses warnings. Fix: plain-apply clean changes; temp index or `git merge-file` fallback; assert real index unchanged.
5. **Required — existing merge editor cannot accept shelf content.** No base/current/incoming payload in options; reads Git conflict stages, writes UTF-8, stages result, exposes merge-abort. "Cancel leaves untouched" false after failed apply. Fix: distinct content-backed shelf-conflict mode with no staging/abort; restore pre-apply state first.
6. **Required — partial path filtering based on nonexistent API.** `git apply` accepts `--include/--exclude` patterns, not trailing literal pathspecs; rename source/target cannot be selected independently. Fix: per-logical-change patch blocks, rename pairs atomic.
7. **Required — patchText not byte-safe.** GitExecutor.run returns decoded strings; non-UTF-8 hunks corrupt; `diff --no-index` exit 1 rejected by executor. Fix: Buffer/stream + exit-code-aware runner; write patch bytes to disk; hash-verify untracked data before deletion.
8. **Required security — validation covers webview, not hostile patches or tampered shelves.** assertRepoRelativePath permits `.git/...`, no symlink-escape prevention; imports unbounded, no strip-level rules. Fix: canonical containment, forbid `.git`, type allowlist, size/count limits, PyCharm + malicious fixtures.
9. **Required security — secret-bearing storage lacks scope/permission rules.** Override could be workspace-controlled or shared across repositories; modes unspecified. Fix: user/machine scope, always append repoId, reject symlinked roots, restrictive permissions.
10. **Required schema — WorkingFile[] cannot represent shelf state.** Lacks renamedFrom, binary, untracked, applied state, mode, type change, symlink, submodule. Fix: dedicated ShelfFileEntry with stable change ID and lifecycle state; support or reject every Git status explicitly.
11. **Required durability — manifest updates have no recoverable state machine.** Positional blobs, no schemaVersion/generation; temp+rename insufficient for rename/ghost/partial-apply, crashes, two windows. Fix: versioned manifests, immutable IDs, content-addressed blobs, checksums, cross-process lock, parent-dir fsync, pending→applied journal.
12. **Required edge case — unborn repositories fail immediately.** Diff and base capture assume HEAD. Fix: empty-tree OID, baseCommit null; pin captured OID; reject moved HEAD before rollback.
13. **Required correctness — diff sides and labels contradict.** Base→patched displayed but labeled "Shelved"/"Local"; current-file-as-missing-base fabricates history. Fix: separate "Before Shelving → Shelved" and "Shelved → Current Local" views; explicit unavailable-base placeholder.
14. **Required observability — failures disappear.** Corrupt shelves silently skipped; completion ack carries only requestId. Fix: typed outcomes, shelf-health in UI + Output channel, never log patch contents.
15. **Required architecture — integration file map incomplete.** Both host providers + React reducer/state/accordion hard-coded for stash; useFileDrag only handles unversioned→track. Fix: explicit tasks/tests for both providers, reducer, multi-repo routing, shelf-specific drag payload.

### Claude's response (Round 1)

All 15 accepted — none rejected. Codex verified findings 3, 4, 5, 7, 8, 10, 15 against actual code; the draft had assumed infrastructure that isn't there. Plan v2: new Phase 0 (mutation queue + byte-safe runner); dual-layer capture; fingerprint revalidation; `--3way` → merge-file; content-backed conflict session; block-indexed patches; hostile-input boundary; machine-scoped storage; ShelfFileEntry; versioned/journaled store + lockfile; unborn-HEAD; two honest diff views; typed outcomes; explicit provider/reducer/accordion/drag tasks.

## Round 2 — Codex (gpt-5.6-sol, effort xhigh)

VERDICT: REVISE. Fully resolved: 4, 5, 6, 8–10, 13, 15. Partially resolved: 1–3, 7, 11, 12, 14, plus new contradictions:

1. **Critical — staged-only unshelve semantics contradictory.** B/A case: composed worktree patch empty; default mode cannot recover B while the unconditional index assert is impossible with restoreStagedState. Fix: define flattened vs exact-state; retain unapplied layers; expected-index comparison.
2. **Critical — fingerprint revalidation does not close TOCTOU.** Writes can land after the final check. Fix: journaled revert — atomic move to recovery before replacement; index locking/CAS.
3. **Required — runBinary insufficient.** textconv default-on; filters/EOL diverge. Fix: fixed flags, materialize-test, raw after-blobs.
4. **Required — patch export cannot round-trip dual-layer state.** Fix: document flattened/lossy.
5. **Required — queue inventory and interactive lifetime incomplete.** checkout/reset/cherry-pick/rebase/revert/pull mutate too; holding across conflict UI deadlocks. Fix: full inventory; short transactions; precondition re-acquire.
6. **Required — text 3-way does not cover the change model.** Fix: merge-file for text M/M only; explicit choice actions otherwise.
7. **Required — imported plain diffs lack a base.** Fix: `baseAvailability`; clean-apply-only; retain + inspect on failure.
8. **Required — shelve-revert crash recovery unspecified.** Fix: `shelvePendingRevert` with per-path progress and resume/rollback.
9. **Required — unborn handling contradicts revert.** Fix: revert only vs pinned OID; unborn = empty tree.
10. **Required — manifest generation not enforced by protocol.** Fix: generation in snapshots + requests, CAS, discriminated status + IDs + newGeneration.
11. **Security — binary expansion unbounded.** Fix: decoded-output/hunk/declared-size limits, streaming.
12. **Required — invalid names silently rewritten.** Fix: reject explicitly.

### Claude's response (Round 2)

All 12 accepted — genuine contradictions introduced by v2. Plan v3: two named unshelve modes with per-mode post-conditions; journaled `shelvePendingRevert` with move-to-recovery; fixed patch flags + materialize-test + after-blobs; export documented lossy; extended queue inventory + precondition re-acquire; merge restricted to text M/M + structural choices; `baseAvailability`; unborn vs empty tree; generation CAS + discriminated completions; expansion bounds; names rejected not rewritten.

## Round 3 — Codex (gpt-5.6-sol, effort xhigh)

VERDICT: REVISE. All 12 round-2 findings addressed; new transactional and parity blockers:

1. **Critical — recovery cannot guarantee same-volume rename** (globalStorage vs repo → EXDEV). Fix: stage recovery beside source; copy+fsync into storage; abort otherwise.
2. **Critical — move-to-recovery still loses concurrent writes** (path recreate, open descriptors; immediate pruning). Fix: no-replace creation, hash verify, abort on reappearance, retain snapshots beyond commit.
3. **Critical — cross-window mutations unserialized** (queue is activation-local). Fix: cross-process repo transaction lock + per-step revalidation + rollback.
4. **Required — exact-state lacks index-conflict contract**; intent-to-add/unmerged/skip-worktree/assume-unchanged unpreserved. Fix: refuse divergence; reject exotic states at shelve.
5. **Required — materialization against wrong target.** Fix: per-layer checks (base→index blobs; index→worktree sequential).
6. **Required — after/ blobs lack an apply strategy.** Fix: raw before+after; merge matching representations or structural choice.
7. **Required — one path/status pair cannot model per-layer structural divergence.** Fix: per-layer block references; rename-chain tests.
8. **Required — store atomicity underspecified** (dir replacement; PID-reuse lock stealing). Fix: immutable generation dirs + current pointer; nonce/heartbeat/liveness.
9. **Required — "every mutation has shelf generation" impossible** (create/import/cleanup). Fix: operation-specific unions + catalog generation + idempotency token.
10. **Required — conflict-session preconditions omit working-file hash.** Fix: per-path fingerprints; stale → preserve both + explicit choice.
11. **Security — path validation not platform-complete or race-safe** (.GIT casing, drive/UNC/ADS/devices, symlink swap). Fix: platform-aware segments + verified parent handles.
12. **Required parity gap — PyCharm behavior assumed until Phase 5.** Official docs: unversioned files cannot be shelved; Save to Shelf exists; history fallback for bases; Ctrl-drag keeps; unshelved retained until explicit deletion. Fix: parity matrix to Phase 0; add the behaviors; label divergences.

### Claude's response (Round 3)

All 12 accepted (2 and 3 with named boundaries). Plan v4: same-FS recovery staging + EXDEV abort; O_EXCL + reappearance abort + retention; cross-process repo lock + per-step revalidation (third-party git declared unlockable — detect + roll back); exotic index states rejected, exact-state refusal; layer-correct materialization; raw before/after bypass for inexact files; per-layer `indexBlock`/`worktreeBlock`; generation dirs + pointer + nonce/heartbeat/liveness locks; operation-specific CAS unions; per-path conflict-session fingerprints + both-versions preservation; platform-aware path validation; parity matrix to Phase 0, Save to Shelf, history fallback, Ctrl-drag keep, ghosts retained (cleanup default 0), untracked labeled an extension.

## Round 4 — Codex (gpt-5.6-sol, effort xhigh)

VERDICT: REVISE. All 12 round-3 findings addressed textually; new blockers:

1. **Critical — rollback after third-party git interference can destroy the third party's result.** Fix: roll back only paths still matching transaction-written fingerprints; otherwise retain both states + explicit recovery.
2. **Required — literal `.git/intelligit` fails in linked worktrees** (`.git` is a file → ENOTDIR). Fix: resolve git dirs via Git; lock in common dir; recovery in the worktree git dir.
3. **Required — `exactReconstruction` branch inverted** between step 10 and decision 6. Fix: `exactReconstruction: false` skips `git apply`; true uses patches.
4. **Required security — parent-handle-relative writes assume APIs Node does not expose.** Fix: document the race; O_NOFOLLOW + lstat bracketing + fail-closed + retention backstop.
5. **Required — recovery retention bound undefined.** Fix: minimum retention window, never evict inside it, refuse new destructive work when full, purge decoupled from shelf deletion.
6. **Required schema — `refused` missing from completion payload; no structural-resolution message.** Fix: per-entry discriminated results incl. refused; guarded `shelfResolveStructural`.
7. **Required — idempotency token semantics incomplete.** Fix: durable token→payload→result ledger replayed before CAS; reject reuse with different payloads.
8. **Required performance — immutable generations duplicate large artifacts.** Fix: content-addressed objects dir; manifests reference; lock-protected GC.

### Claude's response (Round 4)

All 8 accepted. Plan v5: fingerprint-guarded rollback (third-party results never overwritten); git-dir resolution via rev-parse (lock in common dir, recovery in worktree git dir, linked-worktree tests); exactReconstruction inversion fixed; honest O_NOFOLLOW/lstat fail-closed discipline with Node's openat gap as second named residual; minimum recovery-retention window + refuse-when-full + decoupled purge; `PerEntryResult` union + `shelfResolveStructural` + `shelfPurgeRecovery`; durable idempotency ledger; content-addressed `objects/` + GC.

## Round 5 — Codex (gpt-5.6-sol, effort ultra) — FINAL

VERDICT: APPROVED.

"No plan-level blockers remain. All eight round-4 findings are concretely addressed: linked-worktree paths, common-directory locking, fingerprint-safe rollback, fail-closed writes, and bounded recovery retention; correct exactReconstruction behavior and typed structural/refusal outcomes; durable idempotency and content-addressed generation storage with guarded GC. No new plan-level flaws found. Transaction recovery, GC reader coordination, lock ordering, and ledger retention remain difficult implementation details, but the plan now defines sufficient invariants and tests to resolve them without changing the specification."

## Resolution

Converged in 5 rounds (47 findings total: 15 + 12 + 12 + 8, all accepted with logged rationale; 0 rejected). PLAN.md v5 is the locked artifact. Awaiting user sign-off before any implementation.
