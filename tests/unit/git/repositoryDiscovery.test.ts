import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    discoverGitRepositories,
    type ResolveGitRoot,
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

function resolverFor(roots: string[]): ResolveGitRoot {
    const normalized = new Set(roots.map((root) => path.resolve(root)));
    return vi.fn(async (candidateRoot: string) => {
        const resolved = path.resolve(candidateRoot);
        return normalized.has(resolved) ? resolved : null;
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
        const resolveGitRoot = resolverFor([workspace]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([{ root: path.resolve(workspace), label: path.basename(workspace) }]);
    });

    it("discovers nested git repositories when the workspace root is not a repository", async () => {
        const workspace = await makeTempWorkspace();
        const app = path.join(workspace, "app");
        const service = path.join(workspace, "packages", "service");
        await makeGitMarker(app);
        await makeGitMarker(service);
        const resolveGitRoot = resolverFor([app, service]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([
            { root: path.resolve(app), label: "app" },
            { root: path.resolve(service), label: path.join("packages", "service") },
        ]);
    });

    it("deduplicates nested markers that resolve to the same git root", async () => {
        const workspace = await makeTempWorkspace();
        const app = path.join(workspace, "app");
        const nested = path.join(app, "nested");
        await makeGitMarker(app);
        await makeGitMarker(nested);
        const resolveGitRoot = vi.fn(async (candidateRoot: string) => {
            if (candidateRoot === app || candidateRoot === nested) return app;
            return null;
        });

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([{ root: path.resolve(app), label: "app" }]);
    });

    it("discovers a git root that is a parent of the workspace (workspace opened as subdirectory)", async () => {
        // /tmp/root/ is the git root (.git lives there); user opens /tmp/root/project2
        const root = await makeTempWorkspace();
        const project2 = path.join(root, "project2");
        await fs.mkdir(project2, { recursive: true });
        await makeGitMarker(root);
        // Resolver simulates `git rev-parse --show-toplevel` returning the parent git root
        const resolveGitRoot = vi.fn(async (candidateRoot: string) => {
            if (candidateRoot === project2) return root;
            return null;
        });

        const repos = await discoverGitRepositories([project2], { resolveGitRoot });

        expect(repos).toEqual([{ root: path.resolve(root), label: path.basename(root) }]);
    });

    it("discovers the git root when workspace equals git root (no regression)", async () => {
        const workspace = await makeTempWorkspace();
        await makeGitMarker(workspace);
        const resolveGitRoot = resolverFor([workspace]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([{ root: path.resolve(workspace), label: path.basename(workspace) }]);
    });

    it("drops resolved git roots outside the workspace real path", async () => {
        const workspace = await makeTempWorkspace();
        const outside = await makeTempWorkspace();
        await makeGitMarker(workspace);
        await makeGitMarker(outside);
        const resolveGitRoot = vi.fn(async () => outside);

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([]);
        expect(resolveGitRoot).toHaveBeenCalledWith(workspace);
    });

    it("does not scan ignored directories", async () => {
        const workspace = await makeTempWorkspace();
        const ignoredRepo = path.join(workspace, "node_modules", "pkg");
        await makeGitMarker(ignoredRepo);
        const resolveGitRoot = resolverFor([ignoredRepo]);

        const repos = await discoverGitRepositories([workspace], { resolveGitRoot });

        expect(repos).toEqual([]);
        expect(resolveGitRoot).toHaveBeenCalledTimes(1);
        expect(resolveGitRoot).toHaveBeenCalledWith(workspace);
    });

    it("returns an empty list when no repositories are found", async () => {
        const workspace = await makeTempWorkspace();
        await fs.mkdir(path.join(workspace, "src"), { recursive: true });

        await expect(
            discoverGitRepositories([workspace], { resolveGitRoot: resolverFor([]) }),
        ).resolves.toEqual([]);
    });
});
