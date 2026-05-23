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

export interface DiscoveredRepository {
    root: string;
    label: string;
}

export type ResolveGitRoot = (candidateRoot: string) => Promise<string | null>;

export interface DiscoverGitRepositoriesOptions {
    resolveGitRoot?: ResolveGitRoot;
}

async function defaultResolveGitRoot(candidateRoot: string): Promise<string | null> {
    const gitOps = new GitOps(new GitExecutor(candidateRoot));
    if (!(await gitOps.isRepository())) return null;
    return gitOps.getRepositoryRoot();
}

function normalizeRoot(root: string): string {
    return path.resolve(root);
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

async function addResolvedRoot(
    candidateRoot: string,
    workspaceRoots: string[],
    seen: Map<string, DiscoveredRepository>,
    resolveGitRoot: ResolveGitRoot,
): Promise<void> {
    const resolved = await resolveGitRoot(candidateRoot).catch(() => null);
    if (!resolved) return;
    const root = normalizeRoot(resolved);
    if (seen.has(root)) return;
    seen.set(root, { root, label: labelForRoot(root, workspaceRoots) });
}

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

export async function discoverGitRepositories(
    workspaceRoots: string[],
    options: DiscoverGitRepositoriesOptions = {},
): Promise<DiscoveredRepository[]> {
    const roots = workspaceRoots.map(normalizeRoot);
    const seen = new Map<string, DiscoveredRepository>();
    const resolveGitRoot = options.resolveGitRoot ?? defaultResolveGitRoot;

    for (const workspaceRoot of roots) {
        await addResolvedRoot(workspaceRoot, roots, seen, resolveGitRoot);
        await scanForGitMarkers(workspaceRoot, roots, seen, resolveGitRoot);
    }

    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
