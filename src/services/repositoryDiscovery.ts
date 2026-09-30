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
    /** Native Git classification based on the resolved worktree and common Git directories. */
    kind: "repository" | "worktree";
}

/**
 * Git metadata resolved from one candidate directory through `git rev-parse`.
 *
 * The directory pair distinguishes linked worktrees from standalone or nested repositories.
 */
interface ResolvedGitRepository {
    /** Absolute repository root reported by Git. */
    root: string;
    /** Absolute Git directory for this worktree. */
    gitDir: string;
    /** Absolute Git directory shared by linked worktrees. */
    commonDir: string;
}

/** Resolves candidate Git metadata without relying on the filesystem form of `.git`. */
export type ResolveGitRepository = (candidateRoot: string) => Promise<ResolvedGitRepository | null>;

/**
 * Default maximum directory depth to scan for Git repositories within workspace folders.
 */
export const DEFAULT_REPOSITORY_SCAN_MAX_DEPTH = 2;

/**
 * Reads folder-scoped settings when running inside VS Code. Standalone discovery
 * callers fall back to the default depth when the extension API is unavailable.
 */
function getVsCodeConfiguration(
    scope?: string | import("vscode").Uri,
): { get<T>(section: string, defaultValue?: T): T | undefined } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require("vscode") as typeof import("vscode");
        const resource = typeof scope === "string" ? vscode.Uri.file(scope) : scope;
        return vscode?.workspace?.getConfiguration?.("intelligit", resource);
    } catch {
        return undefined;
    }
}

/**
 * Options that customize repository validation and filesystem traversal.
 */
export interface DiscoverGitRepositoriesOptions {
    /** Optional resolver used to validate and canonicalize each `.git` marker hit. */
    resolveGitRepository?: ResolveGitRepository;
    /** Maximum directory depth to search for `.git` markers. Defaults to configured setting or {@link DEFAULT_REPOSITORY_SCAN_MAX_DEPTH}. */
    maxDepth?: number;
    /** Optional configuration surface to read repository scan settings from. */
    configuration?:
        | {
              get<T>(section: string, defaultValue?: T): T | undefined;
          }
        | ((resource?: string) =>
              | {
                    get<T>(section: string, defaultValue?: T): T | undefined;
                }
              | undefined);
}

/**
 * Resolves the effective maximum depth for Git repository discovery.
 *
 * Checks explicit options first, followed by VS Code workspace settings
 * (optionally scoped to a specific resource), falling back to {@link DEFAULT_REPOSITORY_SCAN_MAX_DEPTH}.
 * A value of -1 indicates unlimited scan depth.
 */
export function resolveRepositoryScanMaxDepth(
    options?: DiscoverGitRepositoriesOptions,
    resource?: string,
): number {
    if (typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth)) {
        if (options.maxDepth === -1) {
            return Infinity;
        }
        if (options.maxDepth >= 0) {
            return Math.floor(options.maxDepth);
        }
    }
    const config =
        typeof options?.configuration === "function"
            ? options.configuration(resource)
            : (options?.configuration ?? getVsCodeConfiguration(resource));
    if (config) {
        const configured = config.get<number>("repositoryScanMaxDepth");
        if (typeof configured === "number" && Number.isFinite(configured)) {
            if (configured === -1) {
                return Infinity;
            }
            if (configured >= 0) {
                return Math.floor(configured);
            }
        }
    }
    return DEFAULT_REPOSITORY_SCAN_MAX_DEPTH;
}

/**
 * Reads the configured repository scan maximum depth from configuration or VS Code settings.
 */
export function readRepositoryScanMaxDepth(
    configuration?:
        | {
              get<T>(section: string, defaultValue?: T): T | undefined;
          }
        | ((resource?: string) =>
              | {
                    get<T>(section: string, defaultValue?: T): T | undefined;
                }
              | undefined),
    resource?: string,
): number {
    return resolveRepositoryScanMaxDepth({ configuration }, resource);
}

/**
 * Default resolver that asks Git for repository metadata from a candidate directory.
 *
 * Discovery callers receive `null` for non-repositories instead of a user-facing
 * error because missing or inaccessible nested folders are expected during scans.
 */
async function defaultResolveGitRepository(
    candidateRoot: string,
): Promise<ResolvedGitRepository | null> {
    const gitOps = new GitOps(new GitExecutor(candidateRoot));
    // `getGitDirectories` validates the candidate and concurrently resolves its root plus
    // Git directories, so discovery does not need another Git call for classification.
    try {
        return await gitOps.getGitDirectories();
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
    resolveGitRepository: ResolveGitRepository,
): Promise<void> {
    const resolved = await resolveGitRepository(candidateRoot).catch(() => null);
    if (!resolved) return;
    const root = await normalizeRoot(resolved.root);
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
    seen.set(root, {
        root,
        label: labelForRoot(root, workspaceRoots),
        kind: resolved.gitDir === resolved.commonDir ? "repository" : "worktree",
    });
}

/**
 * Recursively collects directories containing a `.git` marker while skipping heavy dependency dirs.
 *
 * Only the cheap filesystem walk happens here; Git resolution of each candidate is
 * deferred so it can run bounded-parallel. Inaccessible directories are ignored so
 * discovery stays best-effort during activation and no-repository onboarding flows.
 */
async function collectGitMarkerDirs(
    directory: string,
    candidates: string[],
    maxDepth: number = DEFAULT_REPOSITORY_SCAN_MAX_DEPTH,
    depth = 0,
): Promise<void> {
    if (depth > maxDepth) return;

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
        await collectGitMarkerDirs(
            path.join(directory, entry.name),
            candidates,
            maxDepth,
            depth + 1,
        );
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
    const resolveGitRepository = options.resolveGitRepository ?? defaultResolveGitRepository;
    // Phase 1 — cheap filesystem walk that only collects candidate directories. Each
    // workspace root is itself a candidate (the user may have opened a repository or a
    // subdirectory of one) alongside every nested `.git` marker.
    const candidates: string[] = [...roots];
    for (const [index, workspaceRoot] of roots.entries()) {
        // Folder settings belong to the opened path, which can differ from its realpath.
        const maxDepth = resolveRepositoryScanMaxDepth(options, workspaceRoots[index]);
        // Sequential walk keeps recursive filesystem IO bounded.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await collectGitMarkerDirs(workspaceRoot, candidates, maxDepth, 0);
    }

    // Phase 2 — resolve candidates through Git concurrently. Git resolution (one
    // subprocess per candidate) dominated activation time with many repositories, so it
    // runs bounded-parallel instead of one-at-a-time. De-duplicating candidate paths
    // first, then keying `seen` by canonical root and sorting by label at the end, keeps
    // results deterministic regardless of the order resolutions complete in.
    await mapWithConcurrency([...new Set(candidates)], GIT_RESOLVE_CONCURRENCY, (candidate) =>
        addResolvedRoot(candidate, roots, seen, resolveGitRepository),
    );

    // Spread already isolates the map values before sorting; no shared array is mutated.
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
