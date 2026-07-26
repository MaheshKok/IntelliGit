# Phase 6 Shelve parity QA

## Status

The scripted IntelliGit drill passed on 2026-07-23:

```text
bun run test -- tests/integration/shelf/shelf-roundtrip.integration.test.ts tests/integration/shelf/shelf-conflicts.integration.test.ts tests/integration/shelf/shelf-recovery-contention.integration.test.ts tests/integration/shelf/shelf-structural.integration.test.ts tests/integration/shelf/shelf-import-export.integration.test.ts

Test Files  5 passed (5)
Tests       23 passed (23)
```

`PASS` below means the IntelliGit target behavior has automated evidence. The
[parity matrix](pycharm-parity-matrix.md) is deliberately not a record of a
live PyCharm session, so every PASS still needs a later live-PyCharm comparison
before it can be presented as live-IDE parity.

| Matrix row                | Verdict     | Automated IntelliGit evidence                                                                                                                                                                                                                        | Required live/manual verification                                                                                                                                                                                                                                |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shelve Changes            | PASS        | `keeps flattened unshelve index bytes identical and restores exact staged and unstaged layers` proves captured staged and unstaged changes round-trip with the defined layer guarantees.                                                             | Before live-parity sign-off, run **Git > Shelve Changes…** in a current PyCharm scratch repository with staged and unstaged edits; record dialog fields/defaults and post-shelve state, then compare IntelliGit **Commit panel > Shelve Changes…**.              |
| Save to Shelf             | PASS        | `records Save to Shelf without changing worktree or index bytes` proves IntelliGit `keepLocal` capture.                                                                                                                                              | In PyCharm, use **Git > Save to Shelf** on staged plus unstaged edits; record whether both layers remain unchanged, then compare IntelliGit **Save to Shelf** with `git diff` and `git diff --cached`.                                                           |
| Unshelve default          | PASS        | `keeps flattened unshelve index bytes identical and restores exact staged and unstaged layers` proves the flattened default preserves the pre-unshelve index.                                                                                        | In PyCharm, unshelve into a repository with a pre-existing staged change; record dialog defaults, removal behavior, and resulting index, then compare IntelliGit **Unshelve** defaults.                                                                          |
| Exact state               | PASS        | `keeps flattened unshelve index bytes identical and restores exact staged and unstaged layers` and `refuses exact-state index divergence without changing the divergent tree or index` prove this labeled IntelliGit extension and its refusal path. | In IntelliGit, restore different staged and unstaged versions, then introduce index divergence and record the typed refusal. Keep this labeled as an IntelliGit-only extension, not PyCharm parity.                                                              |
| Unversioned files         | NEEDS-HUMAN | Scripted shelf coverage establishes the storage/apply path, but this matrix row requires a live IDE comparison and visible label check.                                                                                                              | In PyCharm, try to shelve an unversioned file and record the current behavior. In IntelliGit, shelve one and confirm the explicit IntelliGit-extension label; capture both screens.                                                                              |
| Base revisions disabled   | PASS        | `opens a pinned history base without base-object recording, then rejects it after real history pruning` proves repository-history fallback and the unavailable-base result.                                                                          | Turn off `intelligit.shelf.recordBaseRevisions`, create a text conflict, and compare its pinned-history outcome with current PyCharm after disabling its base-revision option.                                                                                   |
| Drag and drop             | NEEDS-HUMAN | No integration test in the scripted drill proves rendered drag targets or modifier-key feedback.                                                                                                                                                     | In PyCharm, drag a shelf/entry to the target once normally and once with Ctrl; record move/apply versus copy/keep behavior. Repeat in IntelliGit: Commit-tab file to Shelf and Shelf entry to Commit; verify Ctrl-drag keeps the shelf and capture the UI state. |
| Already unshelved shelves | PASS        | `uses real merge-file conflict markers, resolves only the worktree, and ghosts the completed shelf` proves ghost creation; `reveals ghost rows only when requested and restores a ghost with its generation` proves the rendered restore route.      | In PyCharm, unshelve with removal enabled and record whether its shelf remains until deletion; compare IntelliGit's dimmed ghost row, restore action, and explicit deletion.                                                                                     |
| Clean Up Shelf            | PASS        | `keeps ghosts when automatic cleanup is zero and deletes only ghosts older than its strict day boundary` plus `sends cleanup candidates selected by all ghosts or strictly older than days` prove the default and both cleanup selections.           | Create at least two ghosts in PyCharm and IntelliGit; compare **Clean Up Shelf** options/defaults and confirm `cleanupAfterDays = 0` performs no automatic deletion.                                                                                             |

## Summary

- `PASS`: 7 matrix rows.
- `NEEDS-HUMAN`: 2 matrix rows.
- Non-PASS rows: Unversioned files; Drag and drop.

## Scripted drill evidence

These are existing integration tests, not a new Phase 6 script:

- Flattened and exact staged round-trips: `keeps flattened unshelve index bytes identical and restores exact staged and unstaged layers` and `reverses B/A cancellation and restores it through flattened and exact-state modes` in `tests/integration/shelf/shelf-roundtrip.integration.test.ts`.
- Text conflict: `uses real merge-file conflict markers, resolves only the worktree, and ghosts the completed shelf` in `tests/integration/shelf/shelf-conflicts.integration.test.ts`.
- Structural conflict: `keeps, deletes, or applies a shelved delete through observable structural choices` in `tests/integration/shelf/shelf-structural.integration.test.ts`.
- Fingerprint rollback: `retains a third-party change rather than overwriting it during restart rollback` in `tests/integration/shelf/shelf-recovery-contention.integration.test.ts`.
- Contention: `serializes independent services and rejects a stale catalog generation without store corruption` in `tests/integration/shelf/shelf-recovery-contention.integration.test.ts`.
- Linked worktree: `targets the linked worktree and keeps the main checkout untouched` in `tests/integration/shelf/shelf-roundtrip.integration.test.ts`.

The scripted drill does not establish visual parity, current PyCharm dialog
defaults, or live modifier-key behavior. Attach the requested screenshots,
PyCharm build number, and scratch-repository commands to this report before
changing any matrix verdict to `PASS`.
