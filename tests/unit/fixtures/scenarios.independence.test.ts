/**
 * Spec-derived tests for `tests/fixtures/repo/scenarios.ts`: the independence sweep, which builds
 * every scenario TWICE and is therefore the most git-heavy slice of the suite -- its own file so
 * the Windows CI shards can schedule it alone. The per-scenario postcondition tests live in the
 * sibling `scenarios.*.test.ts` files, and the shared read-back seam plus its reasoning live in
 * `scenariosTestHelpers.ts`.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
    allocateDestination,
    git,
    removeTrackedScratchDirectories,
    scenarioFor,
    trackScratchHome,
} from "./scenariosTestHelpers";
import { REPOSITORY_SCENARIO_IDS } from "../../fixtures/repo/scenarios";

afterAll(removeTrackedScratchDirectories);

describe("independence", () => {
    it.each(REPOSITORY_SCENARIO_IDS)(
        "%s: two prepare() calls produce workspaces that share no path and are mutually unaffected",
        async (id) => {
            const destinationA = await allocateDestination();
            const destinationB = await allocateDestination();
            const workspaceA = await scenarioFor(id).prepare(destinationA);
            const workspaceB = await scenarioFor(id).prepare(destinationB);
            trackScratchHome(workspaceA.home, workspaceB.home);

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
