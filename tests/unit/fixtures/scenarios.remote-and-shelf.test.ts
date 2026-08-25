/**
 * Spec-derived tests for `tests/fixtures/repo/scenarios.ts`: the remote-relationship scenarios
 * (ahead-behind / ahead-only / pushed-tip / rewritten-history / stale-lease), empty-repo, and the
 * shelf scenarios. One `scenarios.test.ts` became this trio so the Windows CI shards can spread
 * its git-heavy builds; the local-worktree scenarios and the independence sweep live in the
 * sibling `scenarios.*.test.ts` files, and the shared read-back seam plus its reasoning live in
 * `scenariosTestHelpers.ts`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";

import { createSanitizedGitEnv } from "../../fixtures/repo/seed";
import {
    allocateDestination,
    git,
    gitFails,
    removeTrackedScratchDirectories,
    scenarioFor,
    trackScratchHome,
} from "./scenariosTestHelpers";
import {
    assertAheadBehindPostcondition,
    assertAheadOnlyPostcondition,
    assertEmptyRepoPostcondition,
    assertPushedTipPostcondition,
    assertRewrittenHistoryPostcondition,
    assertShelfConflictedPostcondition,
    assertShelfPopulatedPostcondition,
    assertStaleLeasePostcondition,
    PUSHED_TIP_FIXTURE,
} from "../../fixtures/repo/scenarios";

afterAll(removeTrackedScratchDirectories);

describe("ahead-behind", () => {
    it("puts local main both ahead of and behind its upstream", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("ahead-behind").prepare(destination);
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

        await expect(assertAheadBehindPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /ahead-behind scenario postcondition violated/,
        );
    });
});

describe("ahead-only", () => {
    it("puts local main exactly one commit ahead of its upstream without moving origin/main", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("ahead-only").prepare(destination);
        trackScratchHome(workspace.home);

        const counts = await git(
            workspace.root,
            ["rev-list", "--left-right", "--count", "main...@{upstream}"],
            workspace.env,
        );
        expect(counts.split(/\s+/).map(Number)).toEqual([1, 0]);
        expect(await git(workspace.root, ["status", "--porcelain"], workspace.env)).toBe("");

        const localRemoteTracking = await git(
            workspace.root,
            ["rev-parse", "refs/remotes/origin/main"],
            workspace.env,
        );
        const originHead = await git(
            workspace.template!.originRoot,
            ["rev-parse", "refs/heads/main"],
            workspace.env,
        );
        expect(originHead).toBe(localRemoteTracking);
    });

    it("can fail: a clean zero-ahead state violates the ahead-only postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("clean").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(
            assertAheadOnlyPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/ahead-only scenario postcondition violated/);
    });
});

describe("pushed-tip", () => {
    it("puts a clean non-merge main tip on origin/main with no ahead/behind delta", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("pushed-tip").prepare(destination);
        trackScratchHome(workspace.home);

        const [counts, status, subject, parents, localRemoteTracking, originHead] =
            await Promise.all([
                git(
                    workspace.root,
                    ["rev-list", "--left-right", "--count", "main...@{upstream}"],
                    workspace.env,
                ),
                git(workspace.root, ["status", "--porcelain"], workspace.env),
                git(workspace.root, ["show", "-s", "--format=%s", "HEAD"], workspace.env),
                git(workspace.root, ["show", "-s", "--format=%P", "HEAD"], workspace.env),
                git(workspace.root, ["rev-parse", "refs/remotes/origin/main"], workspace.env),
                git(
                    workspace.template!.originRoot,
                    ["rev-parse", "refs/heads/main"],
                    workspace.env,
                ),
            ]);

        expect(counts.split(/\s+/).map(Number)).toEqual([0, 0]);
        expect(status).toBe("");
        expect(subject).toBe(PUSHED_TIP_FIXTURE.subject);
        expect(parents.split(/\s+/)).toHaveLength(1);
        expect(localRemoteTracking).toBe(originHead);
        await expect(
            assertPushedTipPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).resolves.toBeUndefined();
    });

    it("can fail: the unpushed ahead-only state violates the pushed-tip postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("ahead-only").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(
            assertPushedTipPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/pushed-tip scenario postcondition violated/);
    });
});

describe("rewritten-history", () => {
    it("rewrites origin/main to a real non-descendant commit without fetching locally", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("rewritten-history").prepare(destination);
        trackScratchHome(workspace.home);

        const localHead = await git(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const localRemoteTracking = await git(
            workspace.root,
            ["rev-parse", "refs/remotes/origin/main"],
            workspace.env,
        );
        const rewrittenOriginHead = await git(
            workspace.template!.originRoot,
            ["rev-parse", "refs/heads/main"],
            workspace.env,
        );

        expect(localRemoteTracking).toBe(localHead);
        expect(rewrittenOriginHead).not.toBe(localHead);
        expect(
            await gitFails(
                workspace.template!.originRoot,
                ["merge-base", "--is-ancestor", localHead, rewrittenOriginHead],
                workspace.env,
            ),
        ).toBe(true);
        await expect(
            assertRewrittenHistoryPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).resolves.toBeUndefined();
    });

    it("can fail: an unrevised origin violates the rewritten-history postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(
            assertRewrittenHistoryPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/rewritten-history scenario postcondition violated/);
    });

    it("can fail: a normal descendant origin commit violates the non-fast-forward postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);
        await git(workspace.root, ["reset", "--hard", "HEAD"], workspace.env);
        await git(workspace.root, ["clean", "-fdx", "--quiet"], workspace.env);

        const collaboratorClone = join(destination, "rewritten-history-descendant");
        await git(
            destination,
            [
                "clone",
                "--quiet",
                "--branch",
                "main",
                workspace.template!.originRoot,
                collaboratorClone,
            ],
            workspace.env,
        );
        await writeFile(join(collaboratorClone, "normal-origin-advance.txt"), "advance\n", "utf8");
        await git(collaboratorClone, ["add", "normal-origin-advance.txt"], workspace.env);
        await git(
            collaboratorClone,
            ["commit", "--quiet", "-m", "Normal origin advance"],
            workspace.env,
        );
        await git(collaboratorClone, ["push", "--quiet", "origin", "main"], workspace.env);
        await removeScratchDirectories(collaboratorClone);

        await expect(
            assertRewrittenHistoryPostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/rewritten-history scenario postcondition violated/);
    });
});

describe("stale-lease", () => {
    it("leaves a local rewrite and a collaborator commit beyond the last fetched lease", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("stale-lease").prepare(destination);
        trackScratchHome(workspace.home);

        const localHead = await git(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const lastFetched = await git(
            workspace.root,
            ["rev-parse", "refs/remotes/origin/main"],
            workspace.env,
        );
        const collaboratorHead = await git(
            workspace.template!.originRoot,
            ["rev-parse", "refs/heads/main"],
            workspace.env,
        );

        expect(localHead).not.toBe(lastFetched);
        expect(collaboratorHead).not.toBe(lastFetched);
        expect(
            await gitFails(
                workspace.template!.originRoot,
                ["merge-base", "--is-ancestor", lastFetched, collaboratorHead],
                workspace.env,
            ),
        ).toBe(false);
        await expect(
            assertStaleLeasePostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).resolves.toBeUndefined();
    });

    it("can fail: a rewritten origin without a collaborator descendant violates the stale lease postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("rewritten-history").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(
            assertStaleLeasePostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/stale-lease scenario postcondition violated/);
    });

    it("can fail: a rewritten origin without an ancestor lease violates the stale lease postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);
        await git(workspace.root, ["reset", "--hard", "HEAD"], workspace.env);
        await git(workspace.root, ["clean", "-fdx", "--quiet"], workspace.env);

        await writeFile(join(workspace.root, "local-lease-rewrite.txt"), "local rewrite\n", "utf8");
        await git(workspace.root, ["add", "local-lease-rewrite.txt"], workspace.env);
        await git(workspace.root, ["commit", "--quiet", "--amend", "--no-edit"], workspace.env);

        const collaboratorClone = join(destination, "stale-lease-rewrite");
        await git(
            destination,
            [
                "clone",
                "--quiet",
                "--branch",
                "main",
                workspace.template!.originRoot,
                collaboratorClone,
            ],
            workspace.env,
        );
        await writeFile(join(collaboratorClone, "rewritten-origin.txt"), "rewritten\n", "utf8");
        await git(collaboratorClone, ["add", "rewritten-origin.txt"], workspace.env);
        await git(collaboratorClone, ["commit", "--quiet", "--amend", "--no-edit"], workspace.env);
        await git(
            collaboratorClone,
            ["push", "--quiet", "--force", "origin", "main"],
            workspace.env,
        );
        await removeScratchDirectories(collaboratorClone);

        await expect(
            assertStaleLeasePostcondition(
                workspace.root,
                workspace.template!.originRoot,
                workspace.env,
            ),
        ).rejects.toThrow(/stale-lease scenario postcondition violated/);
    });
});

describe("empty-repo", () => {
    it("has no commits, no origin, and an empty status", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("empty-repo").prepare(destination);
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

        await expect(assertEmptyRepoPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /empty-repo scenario postcondition violated/,
        );
    });
});

describe("shelf-populated", () => {
    it("reports at least one shelf entry through a freshly opened ShelfStore", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("shelf-populated").prepare(destination);
        trackScratchHome(workspace.home);

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
        // Sanitized env, not the ambient one: a bare `git init` inherits the developer's real HOME
        // and global/system config, which is exactly the leakage `assertNoIdentityLeakage` exists to
        // forbid. `init.defaultBranch`, `init.templateDir`, or a global hook in that config can
        // change what this repo is created as, so this negative case would be running against a
        // different repository on a different machine.
        const { home, env } = await createSanitizedGitEnv();
        trackScratchHome(home);
        await git(repoRoot, ["init", "--quiet"], env);

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
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

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
