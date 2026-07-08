import * as fs from "fs/promises";
import * as path from "path";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { mapWithConcurrency } from "../utils/concurrency";

// Bound on concurrent `git rev-parse` resolutions during discovery. High enough to
// hide subprocess latency across many repositories, low enough not to swamp the OS.
// ponytail: fixed cap; tie to os.cpus() only if a profiler says it matters.
const GIT_RESOLVE_CONCURRENCY = 8;

const IGNORED_DIRS = new Set([
    ".git",
    ".idea",
    ".venv",
    ".vscode",
    "coverage",
    "dist",
    "node_modules",
    "vendor",
]);

/**
 * Repository root discovered within one of the active workspace folders.
 *
 * Roots are normalized through `realpath` when possible and labels are stable
 * workspace-relative display names for repository pickers.
 */
export interface DiscoveredRepository {
    /** Absolute filesystem path to the Git repository root. */
    root: string;
    /** Display label relative to the containing workspace folder when possible. */
    label: string;
}

/**
 * Resolves a directory candidate to its actual Git root, or `null` when it is not a repository.
 *
 * Tests can inject this contract to avoid spawning Git while production uses
 * `GitOps` so worktrees and nested repository roots resolve the same way as
 * runtime commands.
 */
export type ResolveGitRoot = (candidateRoot: string) => Promise<string | null>;

/**
 * Options that customize repository discovery without changing filesystem traversal.
 */
export interface DiscoverGitRepositoriesOptions {
    /** Optional resolver used to validate and canonicalize each `.git` marker hit. */
    resolveGitRoot?: ResolveGitRoot;
}

/**
 * Default resolver that asks Git whether a candidate directory is a repository root.
 *
 * Discovery callers receive `null` for non-repositories instead of a user-facing
 * error because missing or inaccessible nested folders are expected during scans.
 */
async function defaultResolveGitRoot(candidateRoot: string): Promise<string | null> {
    const gitOps = new GitOps(new GitExecutor(candidateRoot));
    // A single `git rev-parse --show-toplevel` both validates that the candidate is
    // inside a work tree and returns its canonical root: non-repositories reject and
    // resolve to `null`. This replaces the former is-repository + show-toplevel pair,
    // halving Git subprocesses per candidate during discovery.
    try {
        const root = await gitOps.getRepositoryRoot();
        return root || null;
    } catch {
        return null;
    }
}

async function normalizeRoot(root: string): Promise<string> {
    const resolved = path.resolve(root);
    try {
        return await fs.realpath(resolved);
    } catch {
        return resolved;
    }
}

function isWithin(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

function labelForRoot(root: string, workspaceRoots: string[]): string {
    for (const workspaceRoot of workspaceRoots) {
        if (!isWithin(workspaceRoot, root)) continue;
        const relative = path.relative(workspaceRoot, root);
        return relative || path.basename(root) || root;
    }
    return path.basename(root) || root;
}

/**
 * Adds a resolved repository root when it remains inside one of the workspace roots.
 *
 * The containment check prevents a `.git` file or symlink from causing discovery
 * to report repositories outside the workspace the user opened.
 */
async function addResolvedRoot(
    candidateRoot: string,
    workspaceRoots: string[],
    seen: Map<string, DiscoveredRepository>,
    resolveGitRoot: ResolveGitRoot,
): Promise<void> {
    const resolved = await resolveGitRoot(candidateRoot).catch(() => null);
    if (!resolved) return;
    const root = await normalizeRoot(resolved);
    // Accept when the git root is inside the workspace (the common monorepo case) OR
    // when the workspace is inside the git root (e.g. user opened a project subdirectory
    // while the .git lives one level above). Reject roots that are completely outside to
    // prevent a .git symlink from pulling in an unrelated external repository.
    if (
        !workspaceRoots.some(
            (workspaceRoot) => isWithin(workspaceRoot, root) || isWithin(root, workspaceRoot),
        )
    )
        return;
    if (seen.has(root)) return;
    seen.set(root, { root, label: labelForRoot(root, workspaceRoots) });
}

/**
 * Recursively collects directories containing a `.git` marker while skipping heavy dependency dirs.
 *
 * Only the cheap filesystem walk happens here; Git resolution of each candidate is
 * deferred so it can run bounded-parallel. Inaccessible directories are ignored so
 * discovery stays best-effort during activation and no-repository onboarding flows.
 */
async function collectGitMarkerDirs(directory: string, candidates: string[]): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) {
            // A `.git` marker makes `directory` a repository/worktree/submodule root
            // candidate; the actual Git resolution runs later, in parallel.
            if (entry.name === ".git") candidates.push(directory);
            continue;
        }
        if (!entry.isDirectory()) continue;
        // The walk stays sequential to keep recursive filesystem IO bounded and ordered.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await collectGitMarkerDirs(path.join(directory, entry.name), candidates);
    }
}

/**
 * Discovers Git repositories contained by the provided workspace roots.
 *
 * Workspace roots are normalized before scanning, discovered repositories are
 * de-duplicated by canonical root, and results are sorted by display label.
 * Passing an empty workspace root list is safe and returns an empty result.
 */
export async function discoverGitRepositories(
    workspaceRoots: string[],
    options: DiscoverGitRepositoriesOptions = {},
): Promise<DiscoveredRepository[]> {
    const roots = await Promise.all(workspaceRoots.map(normalizeRoot));
    const seen = new Map<string, DiscoveredRepository>();
    const resolveGitRoot = options.resolveGitRoot ?? defaultResolveGitRoot;

    // Phase 1 — cheap filesystem walk that only collects candidate directories. Each
    // workspace root is itself a candidate (the user may have opened a repository or a
    // subdirectory of one) alongside every nested `.git` marker.
    const candidates: string[] = [...roots];
    for (const workspaceRoot of roots) {
        // Sequential walk keeps recursive filesystem IO bounded.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await collectGitMarkerDirs(workspaceRoot, candidates);
    }

    // Phase 2 — resolve candidates through Git concurrently. Git resolution (one
    // subprocess per candidate) dominated activation time with many repositories, so it
    // runs bounded-parallel instead of one-at-a-time. De-duplicating candidate paths
    // first, then keying `seen` by canonical root and sorting by label at the end, keeps
    // results deterministic regardless of the order resolutions complete in.
    await mapWithConcurrency([...new Set(candidates)], GIT_RESOLVE_CONCURRENCY, (candidate) =>
        addResolvedRoot(candidate, roots, seen, resolveGitRoot),
    );

    // Spread already isolates the map values before sorting; no shared array is mutated.
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
