/**
 * Comparison-only normalization (PLAN.md step 8: "Normalization is comparison-only: when
 * producing an inventory or diff, those concrete paths are mapped to the canonical placeholders
 * `<ROOT>`, `<ORIGIN>`, `<PROFILE>` so two workspaces at different paths compare equal. Placeholders
 * never touch the filesystem"). This module only ever returns a new, rewritten in-memory value; it
 * never writes to disk, and it is exported from `snapshot.ts` so step 8's `harness.ts` can produce
 * a normalized diff against the template.
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
 * Realpath duality (found empirically, not in the plan text): `git worktree list --porcelain`
 * always reports the *realpath'd* form of the primary worktree's own path -- confirmed empirically
 * against a real macOS checkout, where `/var` is itself a symlink to `/private/var` and every
 * `mkdtemp(os.tmpdir())` root therefore has two valid spellings. Every other captured field
 * (`repoRoot`, `commonDir`, the literal text of `.git/config`'s `remote.origin.url`) instead
 * carries whatever literal spelling the caller passed as `options.root` / `options.originRoot`.
 * A needle list built from only the literal spelling leaves the realpath'd spelling's OS-specific
 * prefix (e.g. `/private`) stitched onto the placeholder (`/private<ROOT>`) instead of the clean
 * `<ROOT>` the contract promises -- a real, reproducible defect that a same-machine two-copy
 * comparison can still miss, because both copies leak the *same* constant prefix and therefore
 * still compare equal to each other on that one machine (`tests/unit/fixtures/snapshotNormalize.test.ts`
 * proves the leak directly, in its "realpath duality" suite). So every root's needle list includes
 * both its literal spelling and its realpath'd spelling (when they differ and the path exists), longest-first, so either
 * spelling collapses to the same placeholder regardless of which one a given captured field used.
 *
 * Linked worktrees are a deliberate exception, not a gap: PLAN.md step 8 returns exactly three
 * roots (`root`, `originRoot`, `profileDir`), and step 9 itself says linked worktree *directories*
 * "live outside the repo root" and are discovered dynamically, not fixed like the three named
 * roots. A linked worktree's absolute path therefore has no placeholder to normalize onto and is
 * deliberately left as a real, un-normalized path; a caller comparing scenarios that create linked
 * worktrees must account for that separately. Only the *primary* worktree entry -- whose path is
 * always exactly `root` -- benefits from the realpath fix above.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
    AlternatesInfo,
    FsEntry,
    GitDirStateByRoot,
    ObjectStoreSnapshot,
    RepositorySnapshot,
    Section,
    WorktreeInfo,
    WorkspaceSnapshot,
} from "./snapshotTypes";

/** The three concrete-path roots a copy carries after live rehydration (PLAN.md step 8). */
export interface PlaceholderRoots {
    readonly root: string;
    readonly originRoot: string;
    readonly profileDir: string;
}

/**
 * Resolves `candidate` to its realpath'd spelling, falling back to the literal candidate whenever
 * it does not exist yet or realpath otherwise fails -- normalization must stay usable even when
 * called before the directory exists (e.g. a not-yet-created `profileDir`) or against a purely
 * in-memory, fabricated snapshot in a test.
 */
function realpathOrSelf(candidate: string): string {
    try {
        return realpathSync(candidate);
    } catch {
        return candidate;
    }
}

/**
 * Both spellings of one root -- literal and realpath'd -- mapped to the same placeholder. See the
 * module doc comment's "Realpath duality" section for why both are needed.
 */
function spellingsFor(root: string, placeholder: string): ReadonlyArray<readonly [needle: string, placeholder: string]> {
    if (root.length === 0) return [];
    const realRoot = realpathOrSelf(root);
    const spellings = new Set([root, realRoot]);
    return Array.from(spellings, (spelling) => [spelling, placeholder] as const);
}

/** Longest-prefix-first so a root nested inside another root -- or a root's realpath'd spelling
 * nested inside its own literal spelling (or vice versa) -- is never partially replaced. */
function orderedReplacements(roots: PlaceholderRoots): ReadonlyArray<readonly [needle: string, placeholder: string]> {
    return [
        ...spellingsFor(roots.root, "<ROOT>"),
        ...spellingsFor(roots.originRoot, "<ORIGIN>"),
        ...spellingsFor(roots.profileDir, "<PROFILE>"),
    ].sort(([a], [b]) => b.length - a.length);
}

function normalizeString(value: string, replacements: ReadonlyArray<readonly [string, string]>): string {
    let result = value;
    for (const [needle, placeholder] of replacements) {
        result = result.split(needle).join(placeholder);
    }
    return result;
}

function normalizeFsEntry(entry: FsEntry, replacements: ReadonlyArray<readonly [string, string]>): FsEntry {
    const symlinkTarget = entry.symlinkTarget === null ? null : normalizeString(entry.symlinkTarget, replacements);
    const text = entry.text === null ? null : normalizeString(entry.text, replacements);
    const digest = text !== null && text !== entry.text ? recomputeDigest(text) : entry.digest;
    return { ...entry, symlinkTarget, text, digest };
}

function recomputeDigest(text: string): string {
    return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function normalizeFsEntries(
    entries: readonly FsEntry[],
    replacements: ReadonlyArray<readonly [string, string]>,
): readonly FsEntry[] {
    return entries.map((entry) => normalizeFsEntry(entry, replacements));
}

function normalizeWorktreeInfo(
    info: WorktreeInfo,
    replacements: ReadonlyArray<readonly [string, string]>,
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
    replacements: ReadonlyArray<readonly [string, string]>,
): GitDirStateByRoot {
    const normalized: Record<string, readonly FsEntry[]> = {};
    for (const [key, entries] of Object.entries(byRoot)) {
        normalized[normalizeString(key, replacements)] = normalizeFsEntries(entries, replacements);
    }
    return normalized;
}

function normalizeAlternates(
    alternates: AlternatesInfo,
    replacements: ReadonlyArray<readonly [string, string]>,
): AlternatesInfo {
    return {
        ...alternates,
        rawLines: alternates.rawLines.map((line) => normalizeString(line, replacements)),
        resolvedAbsolutePaths: alternates.resolvedAbsolutePaths.map((p) => normalizeString(p, replacements)),
    };
}

function normalizeObjectStore(
    objectStore: ObjectStoreSnapshot,
    replacements: ReadonlyArray<readonly [string, string]>,
): ObjectStoreSnapshot {
    return { ...objectStore, alternates: normalizeAlternates(objectStore.alternates, replacements) };
}

function normalizeSection<T>(
    section: Section<T>,
    normalizeData: (data: T) => T,
    replacements: ReadonlyArray<readonly [string, string]>,
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
        workingTree: normalizeSection(snapshot.workingTree, (data) => normalizeFsEntries(data, replacements), replacements),
        index: snapshot.index,
        refs: snapshot.refs,
        head: snapshot.head,
        reflogs: normalizeSection(snapshot.reflogs, (data) => normalizeFsEntries(data, replacements), replacements),
        worktrees: normalizeSection(
            snapshot.worktrees,
            (data) => data.map((info) => normalizeWorktreeInfo(info, replacements)),
            replacements,
        ),
        gitDirState: normalizeSection(snapshot.gitDirState, (data) => normalizeGitDirState(data, replacements), replacements),
        objectStore: normalizeSection(snapshot.objectStore, (data) => normalizeObjectStore(data, replacements), replacements),
    };
}

/** Deeply normalizes arbitrary JSON-shaped durable-state data, whose shape is provider-defined. */
function normalizeUnknownDeep(value: unknown, replacements: ReadonlyArray<readonly [string, string]>): unknown {
    if (typeof value === "string") return normalizeString(value, replacements);
    if (Array.isArray(value)) return value.map((item) => normalizeUnknownDeep(item, replacements));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                normalizeUnknownDeep(item, replacements),
            ]),
        );
    }
    return value;
}

/** Normalizes the full workspace snapshot -- both repositories, plus durable state if captured. */
export function normalizeSnapshot(snapshot: WorkspaceSnapshot, roots: PlaceholderRoots): WorkspaceSnapshot {
    const replacements = orderedReplacements(roots);
    return {
        workspace: normalizeRepositorySnapshot(snapshot.workspace, roots),
        origin: normalizeRepositorySnapshot(snapshot.origin, roots),
        durableState: normalizeSection(
            snapshot.durableState,
            (data) => normalizeUnknownDeep(data, replacements) as typeof data,
            replacements,
        ),
    };
}
