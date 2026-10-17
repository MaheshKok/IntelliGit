# Selected Operations and Lazy Statistics

This extends the existing selected-change editor and commit trees. It does not
replace the whole-file workflow or add a semantic merge engine.

## Working-Tree Statistics

The docked and undocked Changes views request lazy statistics. At most 200 status
rows retain the existing eager behavior. Larger snapshots return the
porcelain file list before calculating line counts.

A shared browser IntersectionObserver requests counts only for visible file
rows and a small margin. This includes small changelist groups below the fold,
not just virtualized lists. Messages contain a host refresh identity and at most
128 known paths. The host coalesces duplicate panes, limits queued paths to 512
and runs one two-process statistics batch at a time. Git receives literal
pathspecs, NUL-delimited output, no external diff or text conversion, a path-byte
budget, an output budget and a read deadline. Rename sources and destinations
are captured from the trusted status snapshot.

Counts remain advisory. They never authorize a commit, determine selected
content or replace a transaction snapshot. Incremental replies carry only path,
side, counts and availability, not icons or full status rows. Stale responses cannot overwrite a
later refresh or another repository. Unknown counts display a pending marker;
failed reads are unavailable, not an exact zero. Aggregate line totals remain
hidden until complete. Refreshes cancel reads and release their cache.

Git status, icon discovery, graph loading and SSH transport still have their own
costs. Small backend measurements must not be described as native-renderer or
remote end-to-end latency results.

## Selected-Change Actions

Open the ordinary-text partial editor and select blocks or individual changed
lines. The action menu uses the same compact menu as the rest of the workbench.

- **Export selected patch** asks for a native Save destination. Git builds the
  patch from an isolated index containing exactly the selected content. Only
  native file destinations on the workspace host are supported; other URI
  schemes are refused rather than interpreted as local paths.
- **Save to Shelf** copies only that selection; working files and the real index
  stay unchanged.
- **Shelve selected changes** saves the patch and its available base durably,
  then removes only selected working and staged content. Other changes remain.
- **Rollback selected changes** confirms first and retains a recovery shelf
  before removing the selection. The existing Shelf UI can restore that content.
- **Amend latest commit** is an explicit checkbox and confirmed history rewrite.
  Only selected text is added to the current commit. Git retains the original
  parent list and author, runs configured hooks and signing, and publishes only
  after exact tree/parent/author validation. No automatic push or force push is
  performed.

Amend-message prefill reads the snapshot's immutable commit in UTF-8 with a
256 KiB output limit. A non-UTF-8 commit-message configuration requires the
native commit workflow rather than silently mislabeling UTF-8 UI text.

Save to Shelf and Shelve follow the distinction in JetBrains' documented Shelf
workflow. The selection and commit boundaries follow its partial-commit model.
This does not imply full JetBrains parity, editor-gutter integration, task
contexts or arbitrary commit selection for amend.

Selected shelves use the existing shelf format and three-way unshelve path.
They restore content without reconstructing the selection's original staging.
The existing base-revision setting still determines whether the base is stored
or must remain available in history.

## Destructive Boundaries

The host resolves every snapshot and line ID. No browser patch, filesystem
destination or Git argument is accepted for a mutation. Export destinations come
from the native picker, never from a browser message. Their parent paths are
canonicalized; source/Git-metadata destinations and symlink targets are refused.
An existing regular patch is replaced atomically rather than truncated through
a hardlink, and a new target is created exclusively. Dirty target buffers are
also protected.

Selected removal requires a working-tree snapshot. It verifies canonical root,
HEAD/ref, operation state, the entire original index, file bytes, conversion
attributes and dirty native buffers. Git performs inverse three-way
reconciliation of staged content. Ambiguous staged overlaps are refused rather
than resetting a whole file. CRLF writes must round-trip through Git's clean and
smudge conversion; unsupported byte layouts are refused.

A schema-2 partial-index journal durably records original/result worktree bytes,
their hashes and the prepared index before any file replacement. The operation
holds an exclusively created, inode/device-verified index lock, atomically
replaces the regular worktree file, revalidates, and reconciles the real index.
Older index-only clients refuse this newer journal rather than deleting its
evidence. The changelist storage schema is unchanged.

Restart recovery never overwrites a working file. It can finish the index only
when the expected completed file transition, original HEAD/ref, attributes,
index and owned lock are verified again. Divergent files, corrupt backups,
foreign locks and changed refs retain evidence for review. An uncertain
publication remains non-retryable even when HEAD later looks unchanged.

Publication uses the existing root metadata lease and inclusion CAS. A proven
unpublished refusal restores only this attempt's overwritten fields; completed
or uncertain transitions retain their fence. Success consumes only removed
ownership and clears inclusion for the captured scope and All. Other list
ownership and commit drafts are preserved; uncertain remaining identities
require review.

The existing 2 MiB/100,000-line/16,384-byte-line text limits, 1–64 file/16 MiB
selected-commit limits and 32-record recovery bounds remain. Structural,
binary, filtered, sparse or unsupported paths retain the whole-file/native
fallback. Hooks' own worktree or external side effects are not rolled back.

The editor stays busy through its post-operation snapshot reload and only
re-enables actions after the host releases its lease. A known successful
operation followed by a view-read failure is reported as success requiring
reload, not a retryable Git failure. Reload-required views keep mutation
controls disabled while retaining the user's draft.

## Backend Measurement

An isolated local measurement on October 17, 2026 used macOS arm64, 32 GiB RAM,
Node 22.23.1 and Apple Git 2.39.5. Each tracked text file had 100 base lines and
one appended line. Five warm rounds alternated eager and lazy ordering:

| Changed Files | Full-Stat Median | List-Only Median | First 40 Counts Median |
| --- | --- | --- | --- |
| 1,000 | 157.4 ms | 22.7 ms | 23.6 ms |
| 10,000 | 1,276.9 ms | 67.3 ms | 29.6 ms |

The full status call ran three Git processes. The list-only call ran one; its
separate viewport batch ran two bounded path-scoped diffs. Counts and file sets
were checked against the eager result. Owned fixture repositories were removed
afterward.

These are synthetic real-Git backend medians, not cold-cache results, native
first-paint measurements, SSH round-trip latency or performance guarantees.

## Verification

Focused tests exercise real Git staging splits, patch selection, Shelf
round-trips, CRLF, native-buffer and foreign-lock refusal, corrupt recovery,
actual process termination at the worktree boundary, and amend parents/authors
and hooks. Browser tests cover viewport batches, retired replies, translated
menus, cancellation and ID-only dispatch. Native VS Code checks drive the
actions against disposable repositories.

Linux pixel baselines must be generated with the pinned Linux renderer.
Diagnostic macOS screenshots do not replace them. Test outcomes and measured
performance are recorded only after those runs actually complete.
