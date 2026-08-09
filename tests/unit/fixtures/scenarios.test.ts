/**
 * Spec-derived tests for `tests/fixtures/repo/scenarios.ts` (PLAN.md:101, Phase 2c-iii). Every
 * scenario's defining postcondition is checked with a real `git` command (or, for
 * `shelf-populated`, a fresh `ShelfStore` read) run against the built workspace -- never by
 * trusting `prepare()`'s own return value alone -- for the same reason `seed.test.ts` does this:
 * a bug in a scenario builder would otherwise produce a silent false-green fixture for a screen no
 * real user would see (`scenarios.ts`'s own "Governing principle" doc comment).
 *
 * The `git()` helper below is deliberately re-declared rather than imported from
 * `tests/fixtures/repo/gitRun.ts`, mirroring `tests/unit/fixtures/gitTestHelpers.ts`'s own
 * documented reasoning: driving the fixture and reading it back through the SAME internal
 * git-runner the module under test also uses would let a bug in that shared seam hide from every
 * test built on top of it.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";

import {
    assertAheadBehindPostcondition,
    assertCleanPostcondition,
    assertConflictedPostcondition,
    assertDetachedHeadPostcondition,
    assertDirtyPostcondition,
    assertEmptyRepoPostcondition,
    assertMidRebasePostcondition,
    assertShelfConflictedPostcondition,
    assertShelfPopulatedPostcondition,
    REPOSITORY_SCENARIO_IDS,
    REPOSITORY_SCENARIOS,
    type RepositoryScenarioId,
    type ScenarioWorkspace,
} from "../../fixtures/repo/scenarios";

const execFileAsync = promisify(execFile);

/** Runs one git process and returns trimmed UTF-8 stdout -- the test suite's own independent seam,
 * not `scenarios.ts`'s. */
async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

/** Like `git`, but resolves `false` on a non-zero exit instead of rejecting -- used only for
 * assertions that check whether a git subcommand fails (e.g. `symbolic-ref` on a detached HEAD). */
async function gitFails(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    try {
        await git(cwd, args, env);
        return false;
    } catch {
        return true;
    }
}

const scratchRoots: string[] = [];
const scratchHomes: string[] = [];

/** Allocates a fresh, empty destination under this test file's own scratch root, registered for
 * `afterAll` cleanup. */
async function allocateDestination(): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "intelligit-scenarios-test-"));
    scratchRoots.push(parent);
    return join(parent, "destination");
}

function scenarioFor(id: RepositoryScenarioId) {
    const scenario = REPOSITORY_SCENARIOS.find((candidate) => candidate.id === id);
    if (!scenario)
        throw new Error(
            `no REPOSITORY_SCENARIOS entry for "${id}" -- fix the test, not the fixture`,
        );
    return scenario;
}

/** Every scenario's `env`/`home` shape, asserted against the frozen `ScenarioWorkspace` contract
 * rather than inline per test -- typed explicitly so a future scenario that forgets to route
 * through `createSanitizedGitEnv` fails here instead of only in whichever test happens to run
 * first. */
function assertNoIdentityLeakage(workspace: ScenarioWorkspace): void {
    expect(workspace.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(workspace.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(workspace.env.HOME).toBe(workspace.home);
    expect(workspace.home).not.toBe(process.env.HOME);
}

afterAll(async () => {
    await Promise.all([
        ...scratchRoots.map((root) => rm(root, { recursive: true, force: true })),
        ...scratchHomes.map((home) => rm(home, { recursive: true, force: true })),
    ]);
});

describe("REPOSITORY_SCENARIOS", () => {
    it("has exactly one entry per REPOSITORY_SCENARIO_IDS id, in the same order, with no duplicates", () => {
        expect(REPOSITORY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
            ...REPOSITORY_SCENARIO_IDS,
        ]);
        // Set equality, not just a length/order check: catches a duplicate id masking a missing one.
        expect(new Set(REPOSITORY_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
            REPOSITORY_SCENARIO_IDS.length,
        );
    });
});

describe("no identity leakage", () => {
    it.each(REPOSITORY_SCENARIO_IDS)(
        "%s routes HOME/config through the sanitized env",
        async (id) => {
            const destination = await allocateDestination();
            const workspace = await scenarioFor(id).prepare(destination);
            scratchHomes.push(workspace.home);

            assertNoIdentityLeakage(workspace);
        },
    );
});

describe("clean", () => {
    it("leaves git status --porcelain empty", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("clean").prepare(destination);
        scratchHomes.push(workspace.home);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        expect(status).toBe("");
    });

    it("can fail: a dirty workspace violates the clean postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        scratchHomes.push(workspace.home);

        await expect(assertCleanPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /clean scenario postcondition violated/,
        );
    });
});

describe("dirty", () => {
    it("names at least one modified and one untracked path in git status --porcelain", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        scratchHomes.push(workspace.home);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        const lines = status.split("\n");
        expect(lines.some((line) => line.startsWith("??"))).toBe(true);
        expect(lines.some((line) => !line.startsWith("??") && /M/.test(line.slice(0, 2)))).toBe(
            true,
        );
    });

    it("can fail: a clean workspace violates the dirty postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("clean").prepare(destination);
        scratchHomes.push(workspace.home);

        await expect(assertDirtyPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /dirty scenario postcondition violated/,
        );
    });
});

describe("conflicted", () => {
    it("leaves a real in-progress merge with an unmerged entry", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("conflicted").prepare(destination);
        scratchHomes.push(workspace.home);

        const mergeHead = await git(
            workspace.root,
            ["rev-parse", "--verify", "MERGE_HEAD"],
            workspace.env,
        );
        expect(mergeHead).toHaveLength(40);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        expect(status.split("\n")).toContain("UU conflict.txt");
    });

    it("can fail: repairing the conflict (merge --abort) violates the conflicted postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("conflicted").prepare(destination);
        scratchHomes.push(workspace.home);

        // Sanity check first: the postcondition genuinely holds on the freshly built scenario.
        await expect(
            assertConflictedPostcondition(workspace.root, workspace.env),
        ).resolves.toBeUndefined();

        await git(workspace.root, ["merge", "--abort"], workspace.env);

        await expect(assertConflictedPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /conflicted scenario postcondition violated/,
        );
    });
});

describe("mid-rebase", () => {
    it("leaves a real in-progress rebase reporting a rebase in progress", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("mid-rebase").prepare(destination);
        scratchHomes.push(workspace.home);

        const status = await git(workspace.root, ["status"], workspace.env);
        expect(status).toMatch(/rebas/i);
        expect(status).toContain("conflict.txt");
    });

    it("can fail: repairing the rebase (rebase --abort) violates the mid-rebase postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("mid-rebase").prepare(destination);
        scratchHomes.push(workspace.home);

        await expect(
            assertMidRebasePostcondition(workspace.root, workspace.env),
        ).resolves.toBeUndefined();

        await git(workspace.root, ["rebase", "--abort"], workspace.env);

        await expect(assertMidRebasePostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /mid-rebase scenario postcondition violated/,
        );
    });
});

describe("detached-head", () => {
    it("fails symbolic-ref and points HEAD at the intended commit", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("detached-head").prepare(destination);
        scratchHomes.push(workspace.home);

        expect(await gitFails(workspace.root, ["symbolic-ref", "-q", "HEAD"], workspace.env)).toBe(
            true,
        );
        const head = await git(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        expect(head).toBe(workspace.template?.commits.featureCommit3);
    });

    it("can fail: checking out a branch violates the detached-head postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("detached-head").prepare(destination);
        scratchHomes.push(workspace.home);
        const expectedSha = workspace.template!.commits.featureCommit3;

        await git(workspace.root, ["checkout", "--quiet", "main"], workspace.env);

        await expect(
            assertDetachedHeadPostcondition(workspace.root, workspace.env, expectedSha),
        ).rejects.toThrow(/detached-head scenario postcondition violated/);
    });
});

describe("ahead-behind", () => {
    it("puts local main both ahead of and behind its upstream", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("ahead-behind").prepare(destination);
        scratchHomes.push(workspace.home);

        const counts = await git(
            workspace.root,
            ["rev-list", "--left-right", "--count", "main...@{upstream}"],
            workspace.env,
        );
        const [ahead, behind] = counts.split(/\s+/).map(Number);
        expect(ahead).toBeGreaterThan(0);
        expect(behind).toBeGreaterThan(0);
    });

    it("can fail: a freshly seeded (unadvanced) template violates the ahead-behind postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        scratchHomes.push(workspace.home);

        await expect(assertAheadBehindPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /ahead-behind scenario postcondition violated/,
        );
    });
});

describe("empty-repo", () => {
    it("has no commits, no origin, and an empty status", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("empty-repo").prepare(destination);
        scratchHomes.push(workspace.home);

        expect(workspace.template).toBeUndefined();
        expect(
            await gitFails(workspace.root, ["rev-parse", "--verify", "HEAD"], workspace.env),
        ).toBe(true);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        expect(status).toBe("");

        const remotes = await git(workspace.root, ["remote"], workspace.env);
        expect(remotes).toBe("");
    });

    it("can fail: a repository with history violates the empty-repo postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        scratchHomes.push(workspace.home);

        await expect(assertEmptyRepoPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /empty-repo scenario postcondition violated/,
        );
    });
});

describe("shelf-populated", () => {
    it("reports at least one shelf entry through a freshly opened ShelfStore", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("shelf-populated").prepare(destination);
        scratchHomes.push(workspace.home);

        // Deliberately does NOT reuse any ShelfStore scenarios.ts constructed internally --
        // opens an independent one against the same on-disk paths, exactly like this suite's
        // git-based assertions read plumbing state rather than trusting prepare()'s return value.
        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: workspace.root,
            globalStoragePath: join(destination, "shelf-storage"),
        });
        const independentStore = new ShelfStore(shelfPaths);
        const { shelfIds } = await independentStore.listShelves();
        expect(shelfIds.length).toBeGreaterThanOrEqual(1);
    });

    it("can fail: an empty shelf store violates the shelf-populated postcondition", async () => {
        const destination = await allocateDestination();
        await mkdir(destination, { recursive: true });
        const repoRoot = join(destination, "empty-repo-for-shelf");
        await mkdir(repoRoot, { recursive: true });
        await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });

        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: repoRoot,
            globalStoragePath: join(destination, "shelf-storage"),
        });
        const emptyStore = new ShelfStore(shelfPaths);

        await expect(assertShelfPopulatedPostcondition(emptyStore)).rejects.toThrow(
            /shelf-populated scenario postcondition violated/,
        );
    });
});

describe("shelf-conflicted", () => {
    it("opens a real text conflict session and preserves the shelf storage root", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("shelf-conflicted").prepare(destination);
        scratchHomes.push(workspace.home);

        expect(workspace.shelfStorageRoot).toBe(join(destination, "shelf-storage"));
        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: workspace.root,
            globalStoragePath: workspace.shelfStorageRoot!,
        });
        const store = new ShelfStore(shelfPaths);
        const executor = new GitExecutor(workspace.root, undefined, workspace.env);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const service = new ShelfService({
            repositoryRoot: workspace.root,
            executor,
            store,
            gate,
        });

        await expect(assertShelfConflictedPostcondition(store, service)).resolves.toBeUndefined();
        expect(await git(workspace.root, ["status", "--porcelain"], workspace.env)).toContain(
            " M mutable.txt",
        );
    });

    it("can fail: a populated shelf with only an ineligible path violates the real conflict-session postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("shelf-populated").prepare(destination);
        scratchHomes.push(workspace.home);

        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: workspace.root,
            globalStoragePath: join(destination, "shelf-storage"),
        });
        const store = new ShelfStore(shelfPaths);
        const executor = new GitExecutor(workspace.root, undefined, workspace.env);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const service = new ShelfService({
            repositoryRoot: workspace.root,
            executor,
            store,
            gate,
        });

        await expect(assertShelfConflictedPostcondition(store, service)).rejects.toThrow(
            /shelf-conflicted scenario postcondition violated/,
        );
    });

    /**
     * The SIDES branch specifically, which the ineligible-path case above never reaches -- it fails
     * earlier, on the missing mutable.txt entry.
     *
     * That gap was found by mutation, not by reading: deleting the pairwise-distinct check left the
     * whole suite green, because with a correctly built scenario there is nothing for the check to
     * catch. Yet that check is precisely what makes a no-op shelve or a missing post-shelve rewrite
     * fail (both proven red by mutation), so leaving its own throw unproven would mean the guard
     * that catches a degenerate scenario could itself be deleted silently.
     *
     * The base side is read back from the live session rather than hardcoding seed.ts's
     * "mutable original\n": writing the worktree file back to whatever base actually is collapses
     * current onto base by construction, so this stays honest if the seed's content ever changes.
     */
    it("can fail: a local rewrite that collapses onto the base side violates the postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("shelf-conflicted").prepare(destination);
        scratchHomes.push(workspace.home);

        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: workspace.root,
            globalStoragePath: workspace.shelfStorageRoot!,
        });
        const store = new ShelfStore(shelfPaths);
        const executor = new GitExecutor(workspace.root, undefined, workspace.env);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const service = new ShelfService({
            repositoryRoot: workspace.root,
            executor,
            store,
            gate,
        });

        const { shelfIds } = await store.listShelves();
        const manifest = await store.readCurrentShelfManifest(shelfIds[0]);
        const entry = manifest.files.find((file) => file.worktreeBlock?.path === "mutable.txt");
        const payload = await service.openShelfConflictSession(shelfIds[0], entry!.changeId);
        await writeFile(join(workspace.root, "mutable.txt"), payload.base, "utf8");

        await expect(assertShelfConflictedPostcondition(store, service)).rejects.toThrow(
            /pairwise distinct base\/current\/patchedBase sides/,
        );
    });
});

describe("independence", () => {
    it.each(REPOSITORY_SCENARIO_IDS)(
        "%s: two prepare() calls produce workspaces that share no path and are mutually unaffected",
        async (id) => {
            const destinationA = await allocateDestination();
            const destinationB = await allocateDestination();
            const workspaceA = await scenarioFor(id).prepare(destinationA);
            const workspaceB = await scenarioFor(id).prepare(destinationB);
            scratchHomes.push(workspaceA.home, workspaceB.home);

            expect(workspaceA.root).not.toBe(workspaceB.root);
            expect(workspaceA.home).not.toBe(workspaceB.home);

            // Mutate A, then prove B did not see it. `git status --ignored` in B is the decisive
            // oracle and the only one used: it reports the marker if -- and only if -- B's working
            // tree is the same directory as A's, so it genuinely fails when independence fails.
            // (A `cat-file -e HEAD:independence-marker.txt` check would NOT: the marker is never
            // committed, so that path fails to resolve in every repository including A's own, and
            // the assertion would pass even if A and B were literally the same directory.)
            await writeFile(
                join(workspaceA.root, "independence-marker.txt"),
                "only in A\n",
                "utf8",
            );
            const workingTreeStatusB = await git(
                workspaceB.root,
                ["status", "--porcelain=v1", "--ignored"],
                workspaceB.env,
            );
            expect(workingTreeStatusB).not.toContain("independence-marker.txt");
        },
    );
});
