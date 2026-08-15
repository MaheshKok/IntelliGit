/**
 * Spec-derived tests for `tests/fixtures/repo/harness.ts` (PLAN.md Phase 1 step 8, the per-test
 * workspace factory slice). `createFixtureWorkspace()` is the surface a Playwright test actually
 * calls; these tests drive it exactly like that caller would -- through the manifest, never through
 * `copyTemplate`/`rehydrateCopy` directly -- and verify every functional claim with real `git`
 * commands read back through `gitTestHelpers.ts`'s own `git()` helper (Gate 4: independent of the
 * module's own internal `runGit` seam), mirroring `rehydrate.test.ts`'s own discipline.
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
    DEFAULT_WORKSPACES_ROOT,
    createFixtureWorkspace,
    deriveWorkspacesRoot,
    type FixtureWorkspace,
} from "../../fixtures/repo/harness";
import { MANIFEST_SCHEMA_VERSION, writeFixtureManifest } from "../../fixtures/repo/manifest";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { git } from "./gitTestHelpers";

const FIXTURE_TIMEOUT_MS = 30_000;

describe("createFixtureWorkspace", () => {
    let cleanupDirs: string[] = [];
    let workspacesToDispose: FixtureWorkspace[] = [];

    afterEach(async () => {
        await Promise.all(workspacesToDispose.map((workspace) => workspace.dispose()));
        workspacesToDispose = [];
        await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        cleanupDirs = [];
    }, FIXTURE_TIMEOUT_MS);

    /** Seeds a real template and publishes a manifest pointing at it, under one throwaway work
     * directory. Does NOT call `createFixtureWorkspace` itself -- callers do that, so a test can
     * create as many or as few workspaces from the same manifest as its scenario needs. */
    async function seedTemplateAndManifest(prefix: string): Promise<{
        readonly workDir: string;
        readonly template: FixtureTemplate;
        readonly manifestPath: string;
        readonly workspacesRoot: string;
    }> {
        const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-harness-${prefix}-`));
        cleanupDirs.push(workDir);
        const templateDir = path.join(workDir, "template");
        const manifestPath = path.join(workDir, "manifest.json");
        const workspacesRoot = path.join(workDir, "workspaces");

        const template = await seedFixtureTemplate(templateDir);
        cleanupDirs.push(template.home);
        await writeFixtureManifest(manifestPath, {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            templateRoot: templateDir,
        });

        return { workDir, template, manifestPath, workspacesRoot };
    }

    async function exists(candidate: string): Promise<boolean> {
        try {
            await stat(candidate);
            return true;
        } catch {
            return false;
        }
    }

    it("DEFAULT_WORKSPACES_ROOT is an absolute path under the OS temp directory", () => {
        expect(path.isAbsolute(DEFAULT_WORKSPACES_ROOT)).toBe(true);
        expect(DEFAULT_WORKSPACES_ROOT.startsWith(tmpdir())).toBe(true);
    });

    it("shortens a macOS-shaped parent when the profile plus VS Code socket would exceed the platform budget", () => {
        const candidate =
            "/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/intelligit-e2e-workspaces";
        const root = deriveWorkspacesRoot(candidate, 104);
        const socketPath = path.join(root, "ig-XXXXXX", "profile", "1.13-main.sock");

        expect(root).not.toBe(candidate);
        expect(root).toBe(path.join(path.dirname(candidate), "i"));
        expect(socketPath.length).toBeLessThanOrEqual(104);
    });

    it("rejects an impossible socket budget instead of returning an uncreatable root path", () => {
        const candidate = "/var/folders/example/intelligit-e2e-workspaces";
        const socketPathLimit = 1;

        expect(() => deriveWorkspacesRoot(candidate, socketPathLimit)).toThrowError(
            new RangeError(
                `Cannot derive a creatable workspaces root for candidateParent "${candidate}" ` +
                    `with socketPathLimit ${socketPathLimit}; shortest path attempted was "/i".`,
            ),
        );
    });

    describe("construction", () => {
        it(
            "builds selected dirty and clean scenarios without relying on the manifest",
            async () => {
                const workspacesRoot = await mkdtemp(
                    path.join(tmpdir(), "intelligit-harness-scenarios-"),
                );
                cleanupDirs.push(workspacesRoot);
                const workspacesRootPrefix = `${workspacesRoot}${path.sep}`;

                const [dirtyWorkspace, cleanWorkspace] = await Promise.all([
                    createFixtureWorkspace({ scenario: "dirty", workspacesRoot }),
                    createFixtureWorkspace({ scenario: "clean", workspacesRoot }),
                ]);
                workspacesToDispose.push(dirtyWorkspace, cleanWorkspace);

                const [dirtyStatus, cleanStatus] = await Promise.all([
                    git(dirtyWorkspace.root, ["status", "--porcelain"], dirtyWorkspace.env),
                    git(cleanWorkspace.root, ["status", "--porcelain"], cleanWorkspace.env),
                ]);
                expect(dirtyStatus).not.toBe("");
                expect(cleanStatus).toBe("");

                for (const workspace of [dirtyWorkspace, cleanWorkspace]) {
                    expect(workspace.env.HOME).toBeDefined();
                    expect(workspace.env.HOME?.startsWith(workspacesRootPrefix)).toBe(true);
                    expect(workspace.env.TMPDIR?.startsWith(workspacesRootPrefix)).toBe(true);
                    expect(workspace.env.TMP).toBe(workspace.env.TMPDIR);
                    expect(workspace.env.TEMP).toBe(workspace.env.TMPDIR);
                    expect(workspace.profileDir.startsWith(workspacesRootPrefix)).toBe(true);
                }
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "forwards shelf storage only for the shelf-populated scenario",
            async () => {
                const workspacesRoot = await mkdtemp(
                    path.join(tmpdir(), "intelligit-harness-shelf-storage-"),
                );
                cleanupDirs.push(workspacesRoot);

                const [shelfWorkspace, dirtyWorkspace, cleanWorkspace] = await Promise.all([
                    createFixtureWorkspace({ scenario: "shelf-populated", workspacesRoot }),
                    createFixtureWorkspace({ scenario: "dirty", workspacesRoot }),
                    createFixtureWorkspace({ scenario: "clean", workspacesRoot }),
                ]);
                workspacesToDispose.push(shelfWorkspace, dirtyWorkspace, cleanWorkspace);

                expect(shelfWorkspace.shelfStorageRoot).toBe(
                    path.join(path.dirname(shelfWorkspace.root), "shelf-storage"),
                );
                expect(dirtyWorkspace.shelfStorageRoot).toBeUndefined();
                expect(cleanWorkspace.shelfStorageRoot).toBeUndefined();
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "returns an independently functional workspace whose origin points at its OWN origin.git, not the template's",
            async () => {
                const { template, manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("construct");
                const workspace = await createFixtureWorkspace({ manifestPath, workspacesRoot });
                workspacesToDispose.push(workspace);

                expect(await exists(workspace.root)).toBe(true);
                expect(await exists(workspace.originRoot)).toBe(true);
                expect(await exists(workspace.profileDir)).toBe(true);

                const readmeContent = await readFile(
                    path.join(workspace.root, "README.md"),
                    "utf8",
                );
                expect(readmeContent).toBe("# IntelliGit Fixture Repo\n");

                const remoteUrl = await git(
                    workspace.root,
                    ["config", "--get", "remote.origin.url"],
                    workspace.env,
                );
                expect(remoteUrl).toBe(pathToFileURL(workspace.originRoot).href);
                expect(remoteUrl).not.toBe(pathToFileURL(template.originRoot).href);

                // Real functional proof, not just a config-string comparison.
                await expect(
                    git(workspace.root, ["fetch", "--quiet", "origin"], workspace.env),
                ).resolves.not.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "propagates a missing-manifest hard failure rather than rebuilding the template itself",
            async () => {
                const { workDir, workspacesRoot } =
                    await seedTemplateAndManifest("missing-manifest");
                const neverWritten = path.join(workDir, "no-such-manifest.json");

                await expect(
                    createFixtureWorkspace({ manifestPath: neverWritten, workspacesRoot }),
                ).rejects.toThrow(/no manifest file/);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("fixture-owned scratch directories", () => {
        it(
            "each workspace's HOME/TMPDIR/TMP/TEMP resolve beneath its own root, and are distinct between two workspaces",
            async () => {
                const { manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("scratch-dirs");
                const [workspaceA, workspaceB] = await Promise.all([
                    createFixtureWorkspace({ manifestPath, workspacesRoot }),
                    createFixtureWorkspace({ manifestPath, workspacesRoot }),
                ]);
                workspacesToDispose.push(workspaceA, workspaceB);

                for (const workspace of [workspaceA, workspaceB]) {
                    expect(workspace.env.HOME).toBeDefined();
                    expect(workspace.env.HOME).toContain(workspacesRoot);
                    expect(workspace.env.TMPDIR).toBe(workspace.env.TMP);
                    expect(workspace.env.TMP).toBe(workspace.env.TEMP);
                    expect(workspace.env.TMPDIR).toContain(workspacesRoot);
                }

                expect(workspaceA.env.HOME).not.toBe(workspaceB.env.HOME);
                expect(workspaceA.env.TMPDIR).not.toBe(workspaceB.env.TMPDIR);
                expect(workspaceA.profileDir).not.toBe(workspaceB.profileDir);
                expect(workspaceA.root).not.toBe(workspaceB.root);
                expect(workspaceA.originRoot).not.toBe(workspaceB.originRoot);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("independence between workspaces", () => {
        it(
            "mutating one workspace never affects the other workspace or the template",
            async () => {
                const { template, manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("independence");
                const [workspaceA, workspaceB] = await Promise.all([
                    createFixtureWorkspace({ manifestPath, workspacesRoot }),
                    createFixtureWorkspace({ manifestPath, workspacesRoot }),
                ]);
                workspacesToDispose.push(workspaceA, workspaceB);

                await writeFile(
                    path.join(workspaceA.root, "README.md"),
                    "mutated in workspace A only\n",
                    "utf8",
                );
                await writeFile(
                    path.join(workspaceA.root, "only-in-a.txt"),
                    "brand new file\n",
                    "utf8",
                );

                const readmeInB = await readFile(path.join(workspaceB.root, "README.md"), "utf8");
                expect(readmeInB).toBe("# IntelliGit Fixture Repo\n");
                expect(await exists(path.join(workspaceB.root, "only-in-a.txt"))).toBe(false);

                const readmeInTemplate = await readFile(
                    path.join(template.root, "README.md"),
                    "utf8",
                );
                expect(readmeInTemplate).toBe("# IntelliGit Fixture Repo\n");
                expect(await exists(path.join(template.root, "only-in-a.txt"))).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("dispose()", () => {
        it(
            "removes the workspace's fixture-owned root and is idempotent",
            async () => {
                const { manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("dispose-basic");
                const workspace = await createFixtureWorkspace({ manifestPath, workspacesRoot });
                // `root` is `<ownRoot>/copy/workspace`; walk back up to the fixture-owned root itself.
                const ownRoot = path.dirname(path.dirname(workspace.root));

                expect(await exists(ownRoot)).toBe(true);

                await workspace.dispose();
                expect(await exists(ownRoot)).toBe(false);

                // Idempotent: a second call must not throw, even though the root is already gone.
                await expect(workspace.dispose()).resolves.not.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "THE TEETH TEST: removes a linked worktree living OUTSIDE the fixture-owned root",
            async () => {
                const { workDir, manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("dispose-linked-worktree");
                const workspace = await createFixtureWorkspace({ manifestPath, workspacesRoot });
                const ownRoot = path.dirname(path.dirname(workspace.root));

                // Deliberately a sibling of `workspacesRoot`, never nested under `ownRoot` -- this is
                // what "outside the repo root" means, and what makes this test exercise the real
                // enumeration-and-remove path rather than the vacuous empty-list case.
                const linkedWorktreePath = path.join(workDir, "linked-worktree-outside-root");
                expect(linkedWorktreePath.startsWith(ownRoot)).toBe(false);

                await git(
                    workspace.root,
                    ["worktree", "add", linkedWorktreePath, "-b", "harness-test-linked-worktree"],
                    workspace.env,
                );

                // Real evidence the linked worktree actually exists and git itself knows about it --
                // not just that the directory was created by the shell.
                expect(await exists(linkedWorktreePath)).toBe(true);
                const worktreeList = await git(
                    workspace.root,
                    ["worktree", "list", "--porcelain"],
                    workspace.env,
                );
                expect(worktreeList).toContain(linkedWorktreePath);

                await workspace.dispose();

                expect(await exists(linkedWorktreePath)).toBe(false);
                expect(await exists(ownRoot)).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "dispose() on a workspace with no linked worktrees still removes the root cleanly (the base case)",
            async () => {
                const { manifestPath, workspacesRoot } =
                    await seedTemplateAndManifest("dispose-empty-case");
                const workspace = await createFixtureWorkspace({ manifestPath, workspacesRoot });
                const ownRoot = path.dirname(path.dirname(workspace.root));

                const worktreeList = await git(
                    workspace.root,
                    ["worktree", "list", "--porcelain"],
                    workspace.env,
                );
                // Exactly one block (the primary worktree) -- confirms this scenario really is the
                // empty-linked-worktree case, not accidentally the same as the teeth test above.
                expect(worktreeList.trim().split("\n\n").length).toBe(1);

                await workspace.dispose();
                expect(await exists(ownRoot)).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("construction failure", () => {
        /**
         * `dispose()` is the only thing that ever removes a workspace's own root, and it only
         * exists on a handle this function returns. A throw between `mkdtemp` and the return
         * therefore leaves the root with no owner: `runFixtureTeardown` removes the template
         * directory and the manifest, never a workspace root, and `DEFAULT_WORKSPACES_ROOT` is a
         * fixed path, so the orphans accumulate run over run.
         *
         * The assertion counts the roots under `workspacesRoot` rather than checking one known
         * path, because the leaked directory's name comes from `mkdtemp` and is never returned
         * to the caller -- which is exactly why nothing can clean it up afterwards.
         */
        it(
            "removes its own root when construction fails, leaving nothing behind under the workspaces root",
            async () => {
                const { workDir, manifestPath, workspacesRoot } = await seedTemplateAndManifest("failed-construction");

                // A manifest whose templateRoot does not exist: `readFixtureManifest` accepts it
                // (the path is a well-formed absolute string), `mkdtemp` succeeds, and
                // `copyTemplate` then throws -- a real failure after the root is already on disk.
                await writeFile(
                    manifestPath,
                    JSON.stringify({
                        schemaVersion: MANIFEST_SCHEMA_VERSION,
                        templateRoot: path.join(workDir, "template-that-was-never-seeded"),
                    }),
                    "utf8",
                );

                await expect(createFixtureWorkspace({ manifestPath, workspacesRoot })).rejects.toThrow();

                const leaked = await readdir(workspacesRoot).catch(() => [] as string[]);
                expect(
                    leaked,
                    "construction failed after mkdtemp, so no handle and no dispose() exists for this " +
                        "root; whatever is listed here can never be reclaimed by anything",
                ).toEqual([]);
            },
            FIXTURE_TIMEOUT_MS,
        );

        /**
         * The other half of the ratchet. Removing the root on failure must not turn into
         * removing it always, and must not swallow the diagnosis: the caller still needs the
         * original error, unmodified, to know WHY construction failed.
         */
        it(
            "propagates the original construction error rather than a cleanup error",
            async () => {
                const { workDir, manifestPath, workspacesRoot } = await seedTemplateAndManifest("failed-construction-error");
                const missingTemplate = path.join(workDir, "template-that-was-never-seeded");

                await writeFile(
                    manifestPath,
                    JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION, templateRoot: missingTemplate }),
                    "utf8",
                );

                // A string argument to `toThrow` is a substring check, which is what the escaped
                // RegExp this replaced was reconstructing by hand.
                await expect(createFixtureWorkspace({ manifestPath, workspacesRoot })).rejects.toThrow(
                    missingTemplate,
                );
            },
            FIXTURE_TIMEOUT_MS,
        );
    });
});
