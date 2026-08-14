/**
 * Shared types for the canonical fixture-workspace snapshot (PLAN.md Phase 1 step 9). Every
 * section of a snapshot is a {@link Section}: either really `captured`, carrying real data, or
 * explicitly `not-captured`, carrying a reason. There is no third state and no silent empty --
 * that binary contract is this module's whole reason to exist. See the module doc comment on
 * `snapshot.ts` for why: a `not-captured` section that could compare equal to a captured-but-empty
 * one is exactly the false-green defect class this plan exists to eliminate.
 */

/** One snapshot section: real captured data, or an explicit, reasoned absence. Never a third state. */
export type Section<T> =
    | { readonly status: "captured"; readonly data: T }
    | { readonly status: "not-captured"; readonly reason: string };

/** Wraps real data as a captured section. */
export function captured<T>(data: T): Section<T> {
    return { status: "captured", data };
}

/** Wraps a reason as a not-captured section. The reason must say *why*, not just *that*. */
export function notCaptured<T>(reason: string): Section<T> {
    return { status: "not-captured", reason };
}

/** What an on-disk entry is, independent of platform-specific stat bit layout. */
export type FsEntryType = "file" | "directory" | "symlink" | "special";

/**
 * One filesystem entry captured by {@link inventoryDirectory} (see `fsInventory.ts`).
 *
 * `mode` keeps only the permission bits (`stats.mode & 0o7777`) -- the file-type bits are already
 * redundant with `type` and vary in ways this suite has no interest in. `digest` is the SHA-256 of
 * raw file bytes, present only for `"file"` entries. `text` is the same file's UTF-8 decoding when
 * it round-trips and stays under the capture limit -- populated for small textual git-admin files
 * (`config`, `commondir`, `gitdir`, `FETCH_HEAD`, ...) so `normalizeSnapshot` can rewrite an
 * embedded absolute template path *before* the content is compared, something a byte digest alone
 * cannot support. `symlinkTarget` is the literal, unresolved target text for `"symlink"` entries.
 */
export interface FsEntry {
    readonly relativePath: string;
    readonly type: FsEntryType;
    readonly mode: number;
    readonly digest: string | null;
    readonly text: string | null;
    readonly symlinkTarget: string | null;
}

/** One entry from `git for-each-ref` over the full, unrestricted ref namespace. */
export interface RefEntry {
    readonly name: string;
    readonly objectType: string;
    readonly objectId: string;
}

/** The `HEAD` pseudo-ref, read directly off disk so detached vs symbolic is never lost. */
export type HeadRef =
    | { readonly kind: "symbolic"; readonly target: string }
    | { readonly kind: "detached"; readonly target: string };

/**
 * One index entry, merging `git ls-files --stage` (authoritative mode/object/stage) with
 * `git ls-files -v` (the single-letter flag: uppercase for a plain state, lowercase when
 * assume-unchanged is set -- see `git help ls-files`). `stage` is 0 for a normal entry and 1/2/3
 * for the ours/theirs/base sides of an unmerged path, so an unmerged index is visible as three
 * entries sharing one path rather than being flattened away.
 */
export interface IndexEntry {
    readonly path: string;
    readonly stage: 0 | 1 | 2 | 3;
    readonly mode: string;
    readonly objectId: string;
    readonly flag: string;
}

/** One object from `git cat-file --batch-all-objects` -- every object git knows about. */
export interface ObjectStoreEntry {
    readonly objectId: string;
    readonly objectType: string;
    readonly size: number;
}

/**
 * `objects/info/alternates`, captured but not judged: {@link assertAlternatesContained} (in
 * `snapshotObjectStore.ts`) is the pure, separately callable assertion a test proves can fail.
 * `resolvedAbsolutePaths` resolves each raw line against the repository's own `objects/` directory,
 * exactly as git itself does, so the assertion never has to re-derive that resolution.
 */
export interface AlternatesInfo {
    readonly present: boolean;
    readonly rawLines: readonly string[];
    readonly resolvedAbsolutePaths: readonly string[];
}

/** Object-store integrity: every known object, plus the alternates file's declared reach. */
export interface ObjectStoreSnapshot {
    readonly objects: readonly ObjectStoreEntry[];
    readonly alternates: AlternatesInfo;
}

/** One row of `git worktree list --porcelain`, plus the admin directory it resolves to. */
export interface WorktreeInfo {
    readonly path: string;
    readonly gitDir: string;
    readonly head: string | null;
    readonly branch: string | null;
    readonly bare: boolean;
    readonly detached: boolean;
    readonly locked: string | null;
    readonly prunable: string | null;
}

/**
 * Every private admin file under one git directory (the common directory, or one resolved
 * worktree's own admin directory), keyed by that directory's identity. Built by a *recursive walk
 * with a documented exclusion list*, never a hand-written include list (PLAN.md step 9) -- see
 * `snapshotGitDirState.ts` for the exact exclusions and why each one is safe to drop.
 */
export type GitDirStateByRoot = Readonly<Record<string, readonly FsEntry[]>>;

/** The full restorable domain for one repository -- called once for the workspace, once for the bare origin. */
export interface RepositorySnapshot {
    readonly repoRoot: string;
    readonly commonDir: string;
    readonly isBare: boolean;
    readonly workingTree: Section<readonly FsEntry[]>;
    readonly index: Section<readonly IndexEntry[]>;
    readonly refs: Section<readonly RefEntry[]>;
    readonly head: Section<HeadRef>;
    readonly reflogs: Section<readonly FsEntry[]>;
    readonly worktrees: Section<readonly WorktreeInfo[]>;
    readonly gitDirState: Section<GitDirStateByRoot>;
    readonly objectStore: Section<ObjectStoreSnapshot>;
}

/**
 * Durable extension-host state (PLAN.md step 10): shelf files on disk, both Memento scopes,
 * SecretStorage (presence + digest, never a value), VS Code configuration in every scope, and
 * per-webview persisted state. The shape a {@link DurableStateProvider} must fill in -- step 24
 * implements the provider by wrapping the E2E control channel documented at `src/e2e/`; this
 * module only defines the contract and the not-captured fallback.
 */
export interface DurableStateSnapshot {
    readonly shelfFiles: readonly FsEntry[];
    readonly memento: {
        readonly global: Readonly<Record<string, unknown>>;
        readonly workspace: Readonly<Record<string, unknown>>;
    };
    readonly secrets: Readonly<Record<string, { readonly present: boolean; readonly digest?: string }>>;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly webviewState: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Caller-supplied seam into a running extension host's durable state. Nothing in this package
 * implements it -- `snapshotWorkspace` runs in the test process, where no host is running, and the
 * real implementation needs the E2E control channel at `src/e2e/` (step 24's job, not this one's).
 */
export interface DurableStateProvider {
    snapshotDurableState(): Promise<DurableStateSnapshot>;
}

/** Everything {@link snapshotWorkspace} captures: both repositories, plus durable host state. */
export interface WorkspaceSnapshot {
    readonly workspace: RepositorySnapshot;
    readonly origin: RepositorySnapshot;
    readonly durableState: Section<DurableStateSnapshot>;
}
