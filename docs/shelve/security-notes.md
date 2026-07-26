# Shelf security notes

## Storage and disclosure

IntelliGit Shelve stores patch and recovery data outside the repository. The
default root is VS Code `globalStorage/shelves/<repoId>/`, where `repoId` is the
first 16 hexadecimal characters of a SHA-256 hash of the normalized
repository-root realpath. `intelligit.shelf.path` is machine-scoped; it changes
the storage base but still appends the repository identifier.

Shelf patches, stored file content, and recovery objects are plaintext. They
may include source, credentials, or other secrets present in changed files.
IntelliGit creates directories with `0700` and private files with `0600` where
the platform supports those modes. Those permissions reduce local exposure;
they do not encrypt data and do not make shared, backed-up, or synced storage
safe for secrets.

## Untrusted patches and shelf data

Imported patches and re-read shelf manifests are untrusted input. Path handling
rejects absolute and traversal paths, `.git` segments case-insensitively,
Windows drive and UNC forms, NTFS alternate data streams, and reserved device
names. Containment and symlink checks are repeated at write time; unsupported
file types are rejected.

Patch processing has bounded work: per-file and aggregate decoded-output
limits, hunk and line-count limits, declared result-size validation before
allocation, and bounded streaming decode. These bounds are safety limits, not a
promise that a hostile patch is harmless; rejected input is surfaced rather
than partially applied.

## Mutations, locks, and recovery

IntelliGit serializes its own repository mutations with an in-process queue and
a repository lock in the Git common directory. A lock owner has a random nonce,
PID, and heartbeat. A stale heartbeat alone never permits takeover: the owner
must also fail a liveness probe, so a lock is never stolen solely because of
age. A busy lock is reported instead of being silently replaced.

Destructive shelve reverts move originals into recovery staging under the
worktree Git directory. Recovery writes are fail-closed where supported and
are journaled. Rollback is fingerprint-guarded: IntelliGit restores only a
path or index entry that still matches the state written by the transaction.
If a third-party Git operation changed it, automatic rollback does not
overwrite that result; both states are retained for explicit recovery.

Recovery snapshots follow their own retention window
(`intelligit.shelf.recoveryRetentionHours`, minimum-window semantics) and are
decoupled from shelf deletion. `IntelliGit: Purge Shelf Recovery` deletes
retained snapshots early and permanently; purging removes the safety copy that
backs the named residual risks below.

## Named residual risks

- An external process holding an open descriptor or hard link can write a moved
  file after checks complete. The original inode is retained for the configured
  recovery window, but the race cannot be eliminated by the extension.
- Node does not expose `openat`-family confinement. IntelliGit bounds that gap
  with `O_NOFOLLOW`, `lstat` bracketing, containment checks, and fail-closed
  refusal where the required guarantees are unavailable; it does not claim
  perfect filesystem confinement.
- IntelliGit cannot lock out third-party Git processes. It revalidates state
  and uses fingerprint-guarded rollback instead of claiming exclusive control.

## PyCharm divergences

- IntelliGit supports untracked-file shelving and labels it as an IntelliGit
  extension.
- IntelliGit offers opt-in `exactState` unshelve in addition to the
  PyCharm-compatible flattened working-tree mode.
- IntelliGit stores shelves outside the repository and does not read or write
  JetBrains `.idea/shelf` XML.
- Exported `.patch` files are flattened and lossy for staging metadata; they
  are interoperability artifacts, not full-fidelity backups.

## Out of scope

Shelve does not provide encryption at rest, cross-machine or remote sync,
changelists, direct JetBrains shelf-store interoperability, a custom
full-fidelity export archive, or a way to prevent third-party Git processes.
VS Code native SCM-view integration is out of scope beyond Command Palette
mirrors. Shelves are strictly per repository root; cross-repository shelving is
rejected. Git stash behavior remains separate and unchanged.
