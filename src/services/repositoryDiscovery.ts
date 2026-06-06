import * as fs from "fs/promises";
import * as path from "path";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";

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
    if (!(await gitOps.isRepository())) return null;
    return gitOps.getRepositoryRoot();
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
    if (!workspaceRoots.some((workspaceRoot) => isWithin(workspaceRoot, root))) return;
    if (seen.has(root)) return;
    seen.set(root, { root, label: labelForRoot(root, workspaceRoots) });
}

/**
 * Recursively scans a workspace folder for `.git` markers while skipping heavy dependency dirs.
 *
 * Inaccessible directories are ignored so discovery remains best-effort during
 * activation and no-repository onboarding flows.
 */
async function scanForGitMarkers(
    directory: string,
    workspaceRoots: string[],
    seen: Map<string, DiscoveredRepository>,
    resolveGitRoot: ResolveGitRoot,
): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) {
            if (entry.name === ".git") {
                await addResolvedRoot(directory, workspaceRoots, seen, resolveGitRoot);
            }
            continue;
        }
        if (!entry.isDirectory()) continue;
        await scanForGitMarkers(
            path.join(directory, entry.name),
            workspaceRoots,
            seen,
            resolveGitRoot,
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
    const resolveGitRoot = options.resolveGitRoot ?? defaultResolveGitRoot;

    for (const workspaceRoot of roots) {
        await addResolvedRoot(workspaceRoot, roots, seen, resolveGitRoot);
        await scanForGitMarkers(workspaceRoot, roots, seen, resolveGitRoot);
    }

    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
