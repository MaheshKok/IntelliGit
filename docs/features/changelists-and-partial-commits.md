# Changelists and Selected Changes

Changelists are worktree-scoped metadata, not branches, stashes or separate Git
indexes. The Changes panel groups files by list, including a separate occurrence
for each owner of a split file. Selecting a group changes the commit scope; the
independent Active label identifies the list that owns newly discovered changes.
Group expansion is remembered per repository and list.

Create or edit a list's name and description from its actions. Creation can also
make the new list active; moving whole files can create a destination list in the
same operation. The original list can be renamed or removed. Removal asks for a
surviving destination, preserves ownership and inclusion metadata, and redirects
the active list and open scope when necessary. Removing the last list creates a
fresh list named Changes. Ambiguous combined selections require explicit review;
whole-file moves refuse to discard partial ownership or saved selections.

Open **Partial changes** for one checked ordinary text file. Select blocks or
individual added/deleted lines; the read-only, syntax-highlighted preview shows
the complete proposed file. Assign selected changes to a list, stage/unstage them,
use the selection in the Commit panel, or explicitly commit the selection.

The Commit panel routes partial inclusion through the selected-content workflow,
not its existing whole-file `commit --only` path. Committing a list includes only
its ownership in split files. Successful partial commits consume committed
ownership and leave an explicit empty inclusion for that scope; selecting the
whole file again is an explicit choice to include its remaining changes.

Each list and the explicit All scope have separate commit drafts for each
worktree. Descriptions never serve as commit messages. The composer label names
its scope, and the native SCM input mirrors the last focused composer. Draft
writes capture their repository and list, use compare-and-swap, and retain local
text when another pane wins a conflict. Switching scope cancels message generation
and ignores its late reply. Successful commits clear only the captured scope's
unchanged message when the clear-last-commit setting is enabled. Removal with two
nonempty drafts requires a choice to append both or keep one.

## Supported Scope

- Existing tracked UTF-8 regular files, at most 2 MiB, 100,000 lines and 16,384
  bytes per line; Git-compatible CRLF clean conversion.
- A partial-selection commit includes 1 to 64 text files, at most 16 MiB of selected text.
- A named changelist can commit more files or combined text when every changed line
  belongs to that list, tracking is current, and no explicit inclusion is recorded.
  This whole-owned text route retains the per-file limits above and the same
  snapshot, ownership, hook, publication and recovery checks.
- Detached HEAD and separate Git worktrees are supported.
- Binary/non-UTF-8 files, adds/deletes/renames/mode changes, submodules, sparse or
  assume-unchanged entries and custom filters/working-tree encodings use the
  existing whole-file/native workflow instead.
- The partial editor can export a selected patch, Save to Shelf without removing
  local content, shelve or roll back selected working changes, and explicitly
  amend the latest commit with selected text. Selected removal first saves a
  recoverable content-only shelf. Unshelving that selection restores content,
  not its original staging choices.
- Named-list amend, partial Git stash and commits mixing supported partial text
  with structural changes remain separate whole-file/native actions. Partial
  removal is available on the working-tree side, not the index-side preview.
- No semantic/AST merge engine, LSP integration or full JetBrains equivalence is
  implied. Pure browser extension hosts without the Node Git backend are outside
  this workflow.

## Transaction Boundaries

The host computes Git diffs and owns immutable snapshots. Webviews send snapshot
and line IDs, never patches or arbitrary Git arguments. Snapshots fence the
canonical worktree, HEAD/ref, entire index, file bytes, operation state, attributes
and clean conversion. Dirty native buffers and symlink aliases are checked.

Partial stage/unstage builds an alternate index and atomically publishes it under
an exclusively acquired, inode-verified `index.lock`. It never writes the
worktree or advances HEAD.

Selected commits use an isolated Git directory with the original branch name,
the actual worktree, effective identity/signing settings, real hooks and a
selected index. Hook rejection and signer failure are failures, not bypasses.
The resulting tree and parent must match the selection before the commit object
is imported and the real ref is updated by compare-and-swap. Hooks can have their
own worktree/external side effects; those are not rolled back. Changes that hooks
add to the selected tree are refused, rather than silently committed.

The real index retains unrelated staging and is reconciled with the new HEAD.
Durable journals live under the worktree Git directory at
`intelligit/partial-index`. Recovery never deletes a foreign lock or overwrites
externally changed refs/indexes. An interrupted published commit reports that it
already succeeded and needs reconciliation, not another commit. POSIX directory
fsync is used; Windows has no equivalent directory fsync through this Node API.

Refused recovery records move to `intelligit/partial-index-quarantine`. Only a
lock with matching inode/device and prepared content is removed; changed/foreign
locks remain untouched. Recovery validates lock identity and bytes again before
publication. The Changes toolbar exposes a recovery-review action; confirmed
dismissal removes only the selected quarantined record, never Git history,
index, worktree or locks. Live foreign PIDs are reported conservatively and
are not unlocked or discarded; one such record does not block other recovery
entries or read-only snapshots.

Missing, invalid or oversized journal files are reported individually, not used
to block every recovery entry. Native review can explicitly discard their contained,
regular record directories even when the journal cannot be parsed. Pending records
that have become valid are not discarded through this unreadable-record path.
Unknown index locks are never removed with their metadata.

List writes use an authoritative schema-4 record in the worktree's own Git directory,
`intelligit/changelists/state.json`. Canonical root and Git-directory identities separate
linked worktrees and clones. Atomic replacement, file fsync, POSIX directory fsync and a
separate metadata lease protect updates; Windows lacks directory fsync through this Node
API. Revision checks reload the record under that lease. The lease remains held throughout
a selected commit, preventing another extension process from moving its ownership.
Windows poll for metadata revisions once per second. Corrupt or missing authoritative
records are refused, never replaced by cached workspace metadata.

On first connection, version-1 or version-2 workspace metadata is validated and preserved
in `intelligit/changelists/migration.json`. Version-1 IDs, labels, ownership, explicit empty
selections and legacy All drafts survive. The original v1 backup key remains available.
A schema-4 sentinel stays at `intelligit.changelists.v1` so older clients refuse the record.
Conflicting pre-existing workspace state is saved separately as `migration-conflict-*.json`
and requires review. Restore/recovery should inspect these copies; deleting the authoritative
record is not a reset procedure. Metadata recovery never changes Git refs, index or worktree.

Full range snapshots live in immutable `intelligit/changelists/evidence/<sha256>.json`
files. The manifest keeps compact references plus mutable owner and inclusion maps. Each
snapshot is bound to its canonical worktree, Git directory and repository-relative file;
its digest and repeated headers are checked before reconciliation. Warm metadata reads,
revision polls and draft edits do not load these payloads. Publication checks the directory
name set once for missing references; changing one file hydrates only that file's current
and two historical snapshots. The complete mapping evidence and ambiguity rules are retained.

Schema-3 upgrades run under the metadata lease and preserve exact original bytes in immutable
`state-v3.<sha256>.backup.json` generations before publishing schema 4. Interrupted upgrades
can retain several generations when an old live writer publishes between attempts. Those
backups and workspace migration evidence are never collected. Older clients refuse the new
schema. Payloads become durable before the manifest references them; collection removes only
unreferenced controlled payload names while holding the same lease as readers. Cleanup failure
after publication leaves harmless orphan files and reports a diagnostic; connection retries
collection and leaves unknown filenames untouched.

The 64 MiB limit remains for each individual snapshot and for the compact manifest. Aggregate
unchanged-line evidence no longer consumes the manifest budget, but sufficiently large mutable
owner/selection maps can still reach it. Cold connection validates all referenced evidence
sequentially and therefore scales with its total bytes. A missing referenced filename prevents
publication; corruption of an unaccessed payload after connection is discovered when that file
is reconciled or on the next connection. Metadata-only edits preserve such evidence rather than
replacing it or silently changing inclusion.

## Ownership Through Later Edits

For supported saved text, the host retains hashed base/worktree lines, prior coordinates,
change hashes and bounded surrounding context. Unique, order-preserving matches carry
ownership through line shifts and hunk splits/joins. Editing inside a single owned insertion
keeps its owner. Independent new blocks use the active list at observation; activation first
reconciles the saved working tree. Unsaved native buffers are still rejected by partial
mutations; live unsaved-buffer attribution and gutter interactions are later editor work.

Repeated or overlapping evidence that cannot establish one owner requires review. A concurrent
revision that prevents proving attribution also keeps a review fence. Base changes can consume
ownership only when the resulting working content is verified unchanged. A simultaneous base
and local-content change remains conservative and requires review. Renaming a tracked split
file preserves its old metadata and fences the destination instead of guessing a new owner.

Two recent exact-content snapshots support undo/redo ownership restoration. History never
restores a previously included selection. Explicit emptiness stays empty; a nonempty selection
is carried forward only when every selected line maps exactly. Changed selected content needs
review. Each compact manifest and individual evidence payload has a 64 MiB budget; failed or
oversized writes do not replace the last good record. Range hashes and history stay in the host and are omitted from
webview state.

Selected inclusion is persisted for its scope and the All view before Git
publication. A persistence failure aborts before committing; failed post-commit
metadata consumption leaves a durable old-snapshot fence and a success-with-review
warning, not a whole-file fallback. Index-side unstaging does not alter saved
working-tree inclusion.

If publication has not started and the captured repository/HEAD/ref remain
unchanged, a failed commit restores only the inclusion fields overwritten by that
attempt. Confirmed or uncertain ref publication keeps the new fence, even if
another process subsequently resets HEAD back to its old value. Failed metadata
restoration is reported for review instead of silently broadening the selection.

Working-tree staging also reserves the shared metadata lease and persists only
its current scope before publishing the index. A refused stage restores that
scope's prior inclusion under compare-and-swap, so dismissing a dirty native
buffer does not change what a later Commit panel action includes. A published
index requiring recovery retains its inclusion; failed rollback persistence
reports an explicit selection-review warning.

## Performance and Verification

Saved modified text is observed once per file, independently of the number of lists.
Unchanged worktree bytes plus HEAD/ref/index/config context avoid repeated diff capture
within a running host; reloads rebuild that observation cache. Text/snapshot caches are bounded. Large commit trees virtualize above 200 visible rows using the
existing scroller and row components; small trees keep the existing layout.
The partial diff and CodeMirror preview also render bounded viewports.

The October 14 prototype measurement on an M2 Pro/32 GiB macOS host, Chromium
153.0.8010.12, production bundle and 20 lists measured a 10,000-file first render
of 69.8 ms, checkbox p95 of 33.4 ms, 40 rendered file rows and 6.81 MiB retained
JS heap growth. Before virtualization, the comparable file-list baseline measured
3,182.5 ms first render, 1,065.1 ms checkbox p95 and 335.85 MiB heap growth.
These small-sample, warm-cache harness results are not Electron IPC, remote
filesystem latency or a bound on hook/signing time. Those renderer-only numbers predate automatic range tracking. Cold range capture adds
Git reads and durable metadata writes per supported changed file; it is not covered by
that timing result. High-volume end-to-end behavior remains a phase-five validation item.

A separate October 15 macOS/Bun metadata benchmark used 20-line files, each split across
two owners with an explicit empty All selection. It measured the schema-3 record, including
range hashes, at 1,000/10,000 files and 20/100 lists:

| Files | Lists | Reload | Browser projection | Durable draft update | Map all shifted files |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 20 | 25 ms | 26 ms | 57 ms | 32 ms |
| 1,000 | 100 | 22 ms | 28 ms | 56 ms | 25 ms |
| 10,000 | 20 | 216 ms | 284 ms | 541 ms | 218 ms |
| 10,000 | 100 | 196 ms | 252 ms | 538 ms | 244 ms |

The largest record was 45.9 MB and its browser projection was 4.1 MB. The benchmark
process peaked around 863 MiB RSS while retaining fixture objects; this is not an isolated
extension-host memory measurement. These single-sample results exclude Git capture,
Electron rendering, undo history, remote storage and competing processes. That schema-3 implementation used
whole-record persistence and synchronous reads with a measurable cost at 10,000 split
files; the phase-five end-to-end checks must include that cost rather than reuse the older
renderer-only result.

Initial full-stat host refresh
cost roughly one second at 10,000 changed files in that prototype. The Changes
views now skip full-stat scans above 200 status rows and request bounded literal
path batches for visible rows. A status-only scan still walks the repository;
this is not a claim of constant-time Git status or remote end-to-end latency.

See [selected operations and lazy statistics](selected-operations-and-lazy-stats.md)
for operation semantics, recovery and validation boundaries.

Focused verification:

```sh
bun x vitest run tests/unit/changes tests/integration/changes
bun x playwright test --config playwright.visual.config.ts tests/visual/partialChanges.spec.ts
bun x playwright test --config playwright.e2e.config.ts --project=e2e tests/e2e/partialChanges.spec.ts
```

Pixel baselines must come from the repository's pinned Linux renderer. macOS
screenshots are diagnostic evidence, not replacement Linux baselines.

The reproducible storage benchmark separates one-time schema-3 migration from normal
reconnection, polling, projection, draft updates and single-file reconciliation. It uses
real parsed change anchors and preserves two historical snapshots during rotation:

```sh
bun x esbuild scripts/benchmark-changelist-storage.ts --bundle --platform=node --outfile=/tmp/intelligit-storage-benchmark.cjs
node --expose-gc /tmp/intelligit-storage-benchmark.cjs 10 20 # fixture self-check
node --expose-gc /tmp/intelligit-storage-benchmark.cjs 1000 20
```

Use 1,000 or 10,000 files with 20 or 100 lists. Fixture creation is outside operation
timings. These are Node host measurements, not UI latency or initial tracking throughput.
Migration writes and fsyncs each evidence payload, so large first connections can be slow;
normal reconnection validates existing payloads without rewriting them. Original workspace
migration seeds remain retained for compatibility and are not covered by the disk-fixture
heap measurements.
