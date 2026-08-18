/**
 * Comparison-only normalization (PLAN.md step 8: "Normalization is comparison-only: when
 * producing an inventory or diff, those concrete paths are mapped to the canonical placeholders
 * `<ROOT>`, `<ORIGIN>`, `<PROFILE>` so two workspaces at different paths compare equal. Placeholders
 * never touch the filesystem"). This module only ever returns a new, rewritten in-memory value; it
 * never writes to disk, and it is exported from `snapshot.ts` so step 8's `harness.ts` can produce
 * a normalized diff against the template.
 *
 * The placeholder-substitution mechanics themselves (longest-needle-first ordering, realpath
 * duality) live in `placeholderCanonicalization.ts`, the one shared core PLAN.md step 12 asks for
 * so the Phase 2 recorder can reuse "the same canonicalization" this module uses -- see that
 * module's doc comment for the full rationale. Everything below this point is specific to
 * `WorkspaceSnapshot`'s own shape: digest recomputation, and walking each snapshot section's
 * particular fields.
 *
 * Digest recomputation: an `FsEntry.text` capture (small git-admin files: `config`, `commondir`,
 * `gitdir`, `FETCH_HEAD`, ...) can embed an absolute template path. Once `text` is rewritten to a
 * placeholder, the pre-normalization `digest` -- a hash of the *original* bytes -- would no longer
 * agree with the normalized text and would still differ across two workspaces at different roots,
 * silently defeating the whole point of normalizing. So whenever `text` changes here, `digest` is
 * recomputed from the normalized text. Entries without a captured `text` (binary or over the size
 * cap) keep their original digest: re-hashing arbitrary binary content after a byte-level
 * substring replace is both slow and semantically doubtful for true binary data, and no working-
 * tree fixture in this suite embeds an absolute path inside binary content.
 *
 * Case sensitivity: this module does no case-folding anywhere, deliberately. Two `FsEntry` arrays
 * are compared with plain string equality on `relativePath`, which is already case-sensitive --
 * exactly the property PLAN.md step 8 requires ("Case-insensitive filesystems (macOS default) are
 * covered by making the inventory comparison case-sensitive on recorded names").
 *
 * Linked worktrees are a deliberate exception, not a gap: PLAN.md step 8 returns exactly three
 * roots (`root`, `originRoot`, `profileDir`), and step 9 itself says linked worktree *directories*
 * "live outside the repo root" and are discovered dynamically, not fixed like the three named
 * roots. A linked worktree's absolute path therefore has no placeholder to normalize onto and is
 * deliberately left as a real, un-normalized path; a caller comparing scenarios that create linked
 * worktrees must account for that separately. Only the *primary* worktree entry -- whose path is
 * always exactly `root` -- benefits from the realpath fix in the shared core.
 */

import { createHash } from "node:crypto";
import {
    buildPlaceholderReplacements as orderedReplacements,
    normalizeString,
    normalizeUnknownDeep as normalizeUnknownDeepShared,
    type PlaceholderReplacement,
    type PlaceholderRoots,
} from "./placeholderCanonicalization";
import type {
    AlternatesInfo,
    DurableStateSnapshot,
    FsEntry,
    GitDirStateByRoot,
    ObjectStoreSnapshot,
    RepositorySnapshot,
    Section,
    WorktreeInfo,
    WorkspaceSnapshot,
} from "./snapshotTypes";

export type { PlaceholderRoots } from "./placeholderCanonicalization";

function normalizeFsEntry(
    entry: FsEntry,
    replacements: readonly PlaceholderReplacement[],
): FsEntry {
    const symlinkTarget =
        entry.symlinkTarget === null ? null : normalizeString(entry.symlinkTarget, replacements);
    const text = entry.text === null ? null : normalizeString(entry.text, replacements);
    const digest = text !== null && text !== entry.text ? recomputeDigest(text) : entry.digest;
    return { ...entry, symlinkTarget, text, digest };
}

function recomputeDigest(text: string): string {
    return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function normalizeFsEntries(
    entries: readonly FsEntry[],
    replacements: readonly PlaceholderReplacement[],
): readonly FsEntry[] {
    return entries.map((entry) => normalizeFsEntry(entry, replacements));
}

function normalizeWorktreeInfo(
    info: WorktreeInfo,
    replacements: readonly PlaceholderReplacement[],
): WorktreeInfo {
    return {
        ...info,
        path: normalizeString(info.path, replacements),
        gitDir: normalizeString(info.gitDir, replacements),
        head: info.head === null ? null : normalizeString(info.head, replacements),
        branch: info.branch === null ? null : normalizeString(info.branch, replacements),
        locked: info.locked === null ? null : normalizeString(info.locked, replacements),
        prunable: info.prunable === null ? null : normalizeString(info.prunable, replacements),
    };
}

function normalizeGitDirState(
    byRoot: GitDirStateByRoot,
    replacements: readonly PlaceholderReplacement[],
): GitDirStateByRoot {
    const normalized: Record<string, readonly FsEntry[]> = {};
    for (const [key, entries] of Object.entries(byRoot)) {
        normalized[normalizeString(key, replacements)] = normalizeFsEntries(entries, replacements);
    }
    return normalized;
}

function normalizeAlternates(
    alternates: AlternatesInfo,
    replacements: readonly PlaceholderReplacement[],
): AlternatesInfo {
    return {
        ...alternates,
        rawLines: alternates.rawLines.map((line) => normalizeString(line, replacements)),
        resolvedAbsolutePaths: alternates.resolvedAbsolutePaths.map((p) =>
            normalizeString(p, replacements),
        ),
    };
}

function normalizeObjectStore(
    objectStore: ObjectStoreSnapshot,
    replacements: readonly PlaceholderReplacement[],
): ObjectStoreSnapshot {
    return {
        ...objectStore,
        alternates: normalizeAlternates(objectStore.alternates, replacements),
    };
}

function normalizeSection<T>(
    section: Section<T>,
    normalizeData: (data: T) => T,
    replacements: readonly PlaceholderReplacement[],
): Section<T> {
    if (section.status === "not-captured") {
        return { status: "not-captured", reason: normalizeString(section.reason, replacements) };
    }
    return { status: "captured", data: normalizeData(section.data) };
}

/** Normalizes one repository's snapshot in place (returning a new value; the input is untouched). */
function normalizeRepositorySnapshot(
    snapshot: RepositorySnapshot,
    roots: PlaceholderRoots,
): RepositorySnapshot {
    const replacements = orderedReplacements(roots);
    return {
        ...snapshot,
        repoRoot: normalizeString(snapshot.repoRoot, replacements),
        commonDir: normalizeString(snapshot.commonDir, replacements),
        workingTree: normalizeSection(
            snapshot.workingTree,
            (data) => normalizeFsEntries(data, replacements),
            replacements,
        ),
        index: snapshot.index,
        refs: snapshot.refs,
        head: snapshot.head,
        reflogs: normalizeSection(
            snapshot.reflogs,
            (data) => normalizeFsEntries(data, replacements),
            replacements,
        ),
        worktrees: normalizeSection(
            snapshot.worktrees,
            (data) => data.map((info) => normalizeWorktreeInfo(info, replacements)),
            replacements,
        ),
        gitDirState: normalizeSection(
            snapshot.gitDirState,
            (data) => normalizeGitDirState(data, replacements),
            replacements,
        ),
        objectStore: normalizeSection(
            snapshot.objectStore,
            (data) => normalizeObjectStore(data, replacements),
            replacements,
        ),
    };
}

/**
 * Normalizes durable state. Almost all of it is arbitrary provider-defined JSON, so it goes
 * through the shared core's {@link normalizeUnknownDeepShared} rather than a snapshot-shaped
 * walker -- Phase 2's recorder reuses that same core, which is the point of extracting it.
 *
 * `shelfFiles` is the one exception, and it cannot go through the deep walker. It is typed
 * `readonly FsEntry[]`, not arbitrary JSON, so it needs the digest recomputation the module doc
 * comment above requires: the deep walker sees an `FsEntry` as a plain object, rewrites its
 * `text` and leaves `digest` hashing the ORIGINAL bytes, so a shelf file embedding an absolute
 * root would normalize to equal text and unequal digest -- a difference the equivalence oracle
 * reports that does not exist on disk. It therefore goes through {@link normalizeFsEntries}.
 */
function normalizeDurableState(
    durableState: DurableStateSnapshot,
    replacements: readonly PlaceholderReplacement[],
): DurableStateSnapshot {
    return {
        ...(normalizeUnknownDeepShared(durableState, replacements) as DurableStateSnapshot),
        shelfFiles: normalizeFsEntries(durableState.shelfFiles, replacements),
    };
}

/** Normalizes the full workspace snapshot -- both repositories, plus durable state if captured. */
export function normalizeSnapshot(
    snapshot: WorkspaceSnapshot,
    roots: PlaceholderRoots,
): WorkspaceSnapshot {
    const replacements = orderedReplacements(roots);
    return {
        workspace: normalizeRepositorySnapshot(snapshot.workspace, roots),
        origin: normalizeRepositorySnapshot(snapshot.origin, roots),
        durableState: normalizeSection(
            snapshot.durableState,
            (data) => normalizeDurableState(data, replacements),
            replacements,
        ),
    };
}
