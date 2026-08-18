import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    discoverGitRepositories,
    type ResolveGitRepository,
} from "../../../src/services/repositoryDiscovery";

const tempRoots: string[] = [];

async function makeTempWorkspace(): Promise<string> {
    const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-discovery-")),
    );
    tempRoots.push(root);
    return root;
}

async function makeGitMarker(repoRoot: string): Promise<void> {
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
}

function resolverFor(roots: string[]): ResolveGitRepository {
    const normalized = new Set(roots.map((root) => path.resolve(root)));
    return vi.fn(async (candidateRoot: string) => {
        const resolved = path.resolve(candidateRoot);
        return normalized.has(resolved)
            ? {
                  root: resolved,
                  gitDir: path.join(resolved, ".git"),
                  commonDir: path.join(resolved, ".git"),
              }
            : null;
    });
}

afterEach(async () => {
    await Promise.all(
        tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
});

describe("discoverGitRepositories", () => {
    it("returns the workspace root when the workspace is a git repository", async () => {
        const workspace = await makeTempWorkspace();
        await makeGitMarker(workspace);
        const resolveGitRepository = resolverFor([workspace]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([
            { root: path.resolve(workspace), label: path.basename(workspace), kind: "repository" },
        ]);
    });

    it("discovers nested git repositories when the workspace root is not a repository", async () => {
        const workspace = await makeTempWorkspace();
        const app = path.join(workspace, "app");
        const service = path.join(workspace, "packages", "service");
        await makeGitMarker(app);
        await makeGitMarker(service);
        const resolveGitRepository = resolverFor([app, service]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([
            { root: path.resolve(app), label: "app", kind: "repository" },
            {
                root: path.resolve(service),
                label: path.join("packages", "service"),
                kind: "repository",
            },
        ]);
    });

    it("classifies linked worktrees from Git directories while nested repositories stay regular", async () => {
        const workspace = await makeTempWorkspace();
        const submodule = path.join(workspace, "packages", "submodule");
        const linkedWorktree = path.join(workspace, "worktrees", "feature");
        await makeGitMarker(submodule);
        await makeGitMarker(linkedWorktree);
        const commonDir = path.join(workspace, ".git");
        const resolveGitRepository = vi.fn(async (candidateRoot: string) => {
            const root = path.resolve(candidateRoot);
            if (root === submodule) {
                return {
                    root,
                    gitDir: path.join(root, ".git"),
                    commonDir: path.join(root, ".git"),
                };
            }
            if (root === linkedWorktree) {
                return {
                    root,
                    gitDir: path.join(commonDir, "worktrees", "feature"),
                    commonDir,
                };
            }
            return null;
        });

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([
            {
                root: path.resolve(submodule),
                label: path.join("packages", "submodule"),
                kind: "repository",
            },
            {
                root: path.resolve(linkedWorktree),
                label: path.join("worktrees", "feature"),
                kind: "worktree",
            },
        ]);
    });

    it("deduplicates nested markers that resolve to the same git root", async () => {
        const workspace = await makeTempWorkspace();
        const app = path.join(workspace, "app");
        const nested = path.join(app, "nested");
        await makeGitMarker(app);
        await makeGitMarker(nested);
        const resolveGitRepository = vi.fn(async (candidateRoot: string) => {
            if (candidateRoot === app || candidateRoot === nested) {
                return {
                    root: app,
                    gitDir: path.join(app, ".git"),
                    commonDir: path.join(app, ".git"),
                };
            }
            return null;
        });

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([{ root: path.resolve(app), label: "app", kind: "repository" }]);
    });

    it("discovers a git root that is a parent of the workspace (workspace opened as subdirectory)", async () => {
        // /tmp/root/ is the git root (.git lives there); user opens /tmp/root/project2
        const root = await makeTempWorkspace();
        const project2 = path.join(root, "project2");
        await fs.mkdir(project2, { recursive: true });
        await makeGitMarker(root);
        // Resolver simulates `git rev-parse --show-toplevel` returning the parent git root
        const resolveGitRepository = vi.fn(async (candidateRoot: string) => {
            if (candidateRoot === project2) {
                return {
                    root,
                    gitDir: path.join(root, ".git"),
                    commonDir: path.join(root, ".git"),
                };
            }
            return null;
        });

        const repos = await discoverGitRepositories([project2], { resolveGitRepository });

        expect(repos).toEqual([
            { root: path.resolve(root), label: path.basename(root), kind: "repository" },
        ]);
    });

    it("discovers the git root when workspace equals git root (no regression)", async () => {
        const workspace = await makeTempWorkspace();
        await makeGitMarker(workspace);
        const resolveGitRepository = resolverFor([workspace]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([
            { root: path.resolve(workspace), label: path.basename(workspace), kind: "repository" },
        ]);
    });

    it("drops resolved git roots outside the workspace real path", async () => {
        const workspace = await makeTempWorkspace();
        const outside = await makeTempWorkspace();
        await makeGitMarker(workspace);
        await makeGitMarker(outside);
        const resolveGitRepository = vi.fn(async () => ({
            root: outside,
            gitDir: path.join(outside, ".git"),
            commonDir: path.join(outside, ".git"),
        }));

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([]);
        expect(resolveGitRepository).toHaveBeenCalledWith(workspace);
    });

    it("does not scan ignored directories", async () => {
        const workspace = await makeTempWorkspace();
        const ignoredRepo = path.join(workspace, "node_modules", "pkg");
        await makeGitMarker(ignoredRepo);
        const resolveGitRepository = resolverFor([ignoredRepo]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos).toEqual([]);
        expect(resolveGitRepository).toHaveBeenCalledTimes(1);
        expect(resolveGitRepository).toHaveBeenCalledWith(workspace);
    });

    it("returns an empty list when no repositories are found", async () => {
        const workspace = await makeTempWorkspace();
        await fs.mkdir(path.join(workspace, "src"), { recursive: true });

        await expect(
            discoverGitRepositories([workspace], { resolveGitRepository: resolverFor([]) }),
        ).resolves.toEqual([]);
    });
});
