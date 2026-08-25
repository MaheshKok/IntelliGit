/**
 * Spec-derived tests for `tests/fixtures/repo/scenarios.ts`: the registry contract, identity
 * hygiene, and the local-worktree scenarios (clean / dirty / conflicted / mid-rebase /
 * detached-head). One `scenarios.test.ts` became this trio so the Windows CI shards can spread its
 * git-heavy builds; the remote and shelf scenarios and the independence sweep live in the sibling
 * `scenarios.*.test.ts` files, and the shared read-back seam plus its reasoning live in
 * `scenariosTestHelpers.ts`.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
    allocateDestination,
    assertNoIdentityLeakage,
    git,
    gitFails,
    removeTrackedScratchDirectories,
    scenarioFor,
    trackScratchHome,
} from "./scenariosTestHelpers";
import {
    assertCleanPostcondition,
    assertConflictedPostcondition,
    assertDetachedHeadPostcondition,
    assertDirtyPostcondition,
    assertMidRebasePostcondition,
    DIRTY_FIXTURE,
    REPOSITORY_SCENARIO_IDS,
    REPOSITORY_SCENARIOS,
} from "../../fixtures/repo/scenarios";

afterAll(removeTrackedScratchDirectories);

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
            trackScratchHome(workspace.home);

            await assertNoIdentityLeakage(workspace);
        },
    );
});

describe("clean", () => {
    it("leaves git status --porcelain empty", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("clean").prepare(destination);
        trackScratchHome(workspace.home);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        expect(status).toBe("");
    });

    it("can fail: a dirty workspace violates the clean postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(assertCleanPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /clean scenario postcondition violated/,
        );
    });
});

describe("dirty", () => {
    it("names at least one modified and one untracked path in git status --porcelain", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);

        const status = await git(workspace.root, ["status", "--porcelain"], workspace.env);
        const lines = status.split("\n");
        expect(lines.some((line) => line.startsWith("??"))).toBe(true);
        expect(lines.some((line) => !line.startsWith("??") && /M/.test(line.slice(0, 2)))).toBe(
            true,
        );
    });

    it("exposes the exact status paths the dirty scenario creates, including rename source metadata", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("dirty").prepare(destination);
        trackScratchHome(workspace.home);

        const status = await git(
            workspace.root,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            workspace.env,
        );
        const records = status.split("\0").filter(Boolean);

        // Porcelain -z emits the rename destination and source as separate records; the panel only
        // renders the destination, so both records are checked to keep the fixture and oracle honest.
        expect(records).toEqual(
            expect.arrayContaining([
                `A  ${DIRTY_FIXTURE.binaryPath}`,
                `MM ${DIRTY_FIXTURE.mutablePath}`,
                `R  ${DIRTY_FIXTURE.renamePath}`,
                DIRTY_FIXTURE.renameFromPath,
                `?? ${DIRTY_FIXTURE.crlfPath}`,
                `?? ${DIRTY_FIXTURE.untrackedPath}`,
            ]),
        );
        expect(records).toHaveLength(DIRTY_FIXTURE.visiblePaths.length + 1);
        expect(records).not.toContain(`?? ${DIRTY_FIXTURE.ignoredPath}`);
    });

    it("can fail: a clean workspace violates the dirty postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("clean").prepare(destination);
        trackScratchHome(workspace.home);

        await expect(assertDirtyPostcondition(workspace.root, workspace.env)).rejects.toThrow(
            /dirty scenario postcondition violated/,
        );
    });
});

describe("conflicted", () => {
    it("leaves a real in-progress merge with an unmerged entry", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("conflicted").prepare(destination);
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

        const status = await git(workspace.root, ["status"], workspace.env);
        expect(status).toMatch(/rebas/i);
        expect(status).toContain("conflict.txt");
    });

    it("can fail: repairing the rebase (rebase --abort) violates the mid-rebase postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("mid-rebase").prepare(destination);
        trackScratchHome(workspace.home);

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
        trackScratchHome(workspace.home);

        expect(await gitFails(workspace.root, ["symbolic-ref", "-q", "HEAD"], workspace.env)).toBe(
            true,
        );
        const head = await git(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        expect(head).toBe(workspace.template?.commits.featureCommit3);
    });

    it("can fail: checking out a branch violates the detached-head postcondition", async () => {
        const destination = await allocateDestination();
        const workspace = await scenarioFor("detached-head").prepare(destination);
        trackScratchHome(workspace.home);
        const expectedSha = workspace.template!.commits.featureCommit3;

        await git(workspace.root, ["checkout", "--quiet", "main"], workspace.env);

        await expect(
            assertDetachedHeadPostcondition(workspace.root, workspace.env, expectedSha),
        ).rejects.toThrow(/detached-head scenario postcondition violated/);
    });
});
