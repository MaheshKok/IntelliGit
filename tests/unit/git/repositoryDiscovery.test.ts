import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_REPOSITORY_SCAN_MAX_DEPTH,
    discoverGitRepositories,
    readRepositoryScanMaxDepth,
    resolveRepositoryScanMaxDepth,
    type ResolveGitRepository,
} from "../../../src/services/repositoryDiscovery";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

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
    await Promise.all(tempRoots.splice(0).map((root) => removeScratchDirectories(root)));
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

    it("respects default maximum discovery depth", async () => {
        const workspace = await makeTempWorkspace();
        const repoAtDefaultDepth = path.join(workspace, "d1", "d2");
        const repoBeyondDefaultDepth = path.join(workspace, "d1", "d2", "d3");
        await makeGitMarker(repoAtDefaultDepth);
        await makeGitMarker(repoBeyondDefaultDepth);

        const resolveGitRepository = resolverFor([repoAtDefaultDepth, repoBeyondDefaultDepth]);
        const repos = await discoverGitRepositories([workspace], { resolveGitRepository });

        expect(repos.map((r) => r.root)).toContain(path.resolve(repoAtDefaultDepth));
        expect(repos.map((r) => r.root)).not.toContain(path.resolve(repoBeyondDefaultDepth));
    });

    it("respects custom maxDepth option to constrain or widen discovery", async () => {
        const workspace = await makeTempWorkspace();
        const repoAtDepth1 = path.join(workspace, "level1");
        const repoAtDepth2 = path.join(workspace, "level1", "level2");
        await makeGitMarker(repoAtDepth1);
        await makeGitMarker(repoAtDepth2);

        const resolveGitRepository = resolverFor([repoAtDepth1, repoAtDepth2]);

        const reposDepth1 = await discoverGitRepositories([workspace], {
            resolveGitRepository,
            maxDepth: 1,
        });
        expect(reposDepth1.map((r) => r.root)).toEqual([path.resolve(repoAtDepth1)]);

        const reposDepth0 = await discoverGitRepositories([workspace], {
            resolveGitRepository,
            maxDepth: 0,
        });
        expect(reposDepth0).toEqual([]);
    });

    it("reads maxDepth from configuration when option is omitted", async () => {
        const workspace = await makeTempWorkspace();
        const repoAtDepth1 = path.join(workspace, "sub1");
        const repoAtDepth2 = path.join(workspace, "sub1", "sub2");
        await makeGitMarker(repoAtDepth1);
        await makeGitMarker(repoAtDepth2);

        const resolveGitRepository = resolverFor([repoAtDepth1, repoAtDepth2]);

        const configuration = {
            get: vi.fn(<T>(section: string, defaultValue?: T): T | undefined => {
                if (section === "repositoryScanMaxDepth") return 1 as T;
                return defaultValue;
            }),
        };

        const repos = await discoverGitRepositories([workspace], {
            resolveGitRepository,
            configuration,
        });
        expect(repos.map((r) => r.root)).toEqual([path.resolve(repoAtDepth1)]);
    });

    it("supports unlimited depth when maxDepth is -1", async () => {
        const workspace = await makeTempWorkspace();
        const deepRepo = path.join(workspace, "a", "b", "c", "d", "e");
        await makeGitMarker(deepRepo);

        const resolveGitRepository = resolverFor([deepRepo]);

        const repos = await discoverGitRepositories([workspace], {
            resolveGitRepository,
            maxDepth: -1,
        });
        expect(repos.map((r) => r.root)).toEqual([path.resolve(deepRepo)]);
    });

    it("resolves repository scan depth correctly through helper functions", () => {
        expect(DEFAULT_REPOSITORY_SCAN_MAX_DEPTH).toBe(2);
        expect(resolveRepositoryScanMaxDepth()).toBe(DEFAULT_REPOSITORY_SCAN_MAX_DEPTH);
        expect(resolveRepositoryScanMaxDepth({ maxDepth: 1 })).toBe(1);
        expect(resolveRepositoryScanMaxDepth({ maxDepth: 0 })).toBe(0);
        expect(resolveRepositoryScanMaxDepth({ maxDepth: -1 })).toBe(Infinity);
        expect(resolveRepositoryScanMaxDepth({ maxDepth: -5 })).toBe(
            DEFAULT_REPOSITORY_SCAN_MAX_DEPTH,
        );

        const config = {
            get: vi.fn(<T>(section: string): T | undefined => {
                if (section === "repositoryScanMaxDepth") return 4 as T;
                return undefined;
            }),
        };
        expect(readRepositoryScanMaxDepth(config)).toBe(4);

        const scopedConfig = vi.fn((resource?: string) => ({
            get: vi.fn(<T>(section: string): T | undefined => {
                if (section === "repositoryScanMaxDepth") {
                    return (resource === "/special" ? 5 : 1) as T;
                }
                return undefined;
            }),
        }));
        expect(readRepositoryScanMaxDepth(scopedConfig, "/special")).toBe(5);
        expect(readRepositoryScanMaxDepth(scopedConfig, "/other")).toBe(1);
    });

    it("resolves resource-scoped maxDepth per workspace root", async () => {
        const workspaceA = await makeTempWorkspace();
        const workspaceB = await makeTempWorkspace();

        const repoInA = path.join(workspaceA, "d1");
        const deepRepoInA = path.join(workspaceA, "d1", "d2");
        const repoInB = path.join(workspaceB, "d1");
        const deepRepoInB = path.join(workspaceB, "d1", "d2");

        await makeGitMarker(repoInA);
        await makeGitMarker(deepRepoInA);
        await makeGitMarker(repoInB);
        await makeGitMarker(deepRepoInB);

        const resolveGitRepository = resolverFor([repoInA, deepRepoInA, repoInB, deepRepoInB]);

        const configuration = (resource?: string) => ({
            get: vi.fn(<T>(section: string, defaultValue?: T): T | undefined => {
                if (section === "repositoryScanMaxDepth") {
                    if (resource?.includes(path.basename(workspaceA))) return 1 as T;
                    if (resource?.includes(path.basename(workspaceB))) return 2 as T;
                }
                return defaultValue;
            }),
        });

        const repos = await discoverGitRepositories([workspaceA, workspaceB], {
            resolveGitRepository,
            configuration,
        });

        const repoRoots = repos.map((r) => r.root);
        expect(repoRoots).toContain(path.resolve(repoInA));
        expect(repoRoots).not.toContain(path.resolve(deepRepoInA));
        expect(repoRoots).toContain(path.resolve(repoInB));
        expect(repoRoots).toContain(path.resolve(deepRepoInB));
    });
});
