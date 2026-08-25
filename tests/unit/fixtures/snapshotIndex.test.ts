/**
 * Spec-derived tests for `tests/fixtures/repo/snapshotIndex.ts` (PLAN.md Phase 1 step 9: "Index,
 * including flags and unmerged stages -- not merely `git ls-files`").
 */

import { afterEach, describe, expect, it } from "vitest";

import { snapshotIndex } from "../../fixtures/repo/snapshotIndex";
import { git, type ScratchRepo } from "./gitTestHelpers";
import { commitAll, createScratchRepo, writeRepoFile } from "./gitTestHelpers";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

describe("snapshotIndex", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    it("captures a plain committed file at stage 0 with an uppercase flag", async () => {
        repo = await createScratchRepo("index-basic");
        await writeRepoFile(repo.root, "a.txt", "hello\n");
        await commitAll(repo.root, repo.env, "c1");

        const section = await snapshotIndex(repo.root, repo.env);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        expect(section.data).toHaveLength(1);
        expect(section.data[0]).toMatchObject({ path: "a.txt", stage: 0 });
        expect(section.data[0]?.objectId).toHaveLength(40);
        // Uppercase: a plain state, not assume-unchanged. See `git help ls-files`.
        expect(section.data[0]?.flag).toBe("H");
    });

    it("lowercases the flag for an assume-unchanged path", async () => {
        repo = await createScratchRepo("index-assume-unchanged");
        await writeRepoFile(repo.root, "a.txt", "hello\n");
        await commitAll(repo.root, repo.env, "c1");
        await git(repo.root, ["update-index", "--assume-unchanged", "a.txt"], repo.env);

        const section = await snapshotIndex(repo.root, repo.env);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        expect(section.data[0]?.flag).toBe("h");
    });

    it("captures a genuinely empty index for a fresh repository, never not-captured", async () => {
        repo = await createScratchRepo("index-empty");
        const section = await snapshotIndex(repo.root, repo.env);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;
        expect(section.data).toEqual([]);
    });

    describe("unmerged stages", () => {
        async function buildRealConflict(): Promise<ScratchRepo> {
            const conflictRepo = await createScratchRepo("index-conflict");
            await writeRepoFile(conflictRepo.root, "shared.txt", "one\ntwo\nthree\n");
            await commitAll(conflictRepo.root, conflictRepo.env, "base");

            await git(conflictRepo.root, ["checkout", "-q", "-b", "other"], conflictRepo.env);
            await writeRepoFile(conflictRepo.root, "shared.txt", "one\nOTHER\nthree\n");
            await commitAll(conflictRepo.root, conflictRepo.env, "other edit");

            await git(conflictRepo.root, ["checkout", "-q", "main"], conflictRepo.env);
            await writeRepoFile(conflictRepo.root, "shared.txt", "one\nMAIN\nthree\n");
            await commitAll(conflictRepo.root, conflictRepo.env, "main edit");

            await git(conflictRepo.root, ["merge", "other"], conflictRepo.env).catch(
                () => undefined,
            );
            return conflictRepo;
        }

        it("surfaces an unmerged path as three entries at stages 1/2/3, sharing one path", async () => {
            repo = await buildRealConflict();

            const section = await snapshotIndex(repo.root, repo.env);
            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;

            const conflictEntries = section.data.filter((entry) => entry.path === "shared.txt");
            expect(conflictEntries).toHaveLength(3);
            expect(conflictEntries.map((entry) => entry.stage).sort()).toEqual([1, 2, 3]);
            // Every distinct stage should carry its own object id (base/ours/theirs really differ).
            expect(new Set(conflictEntries.map((entry) => entry.objectId)).size).toBe(3);
        });

        it("RED-proof: the same 'stage-0-only' assertion fails once a real conflict is introduced", async () => {
            // Healthy state: exactly one stage-0 entry for the shared path.
            const clean = await createScratchRepo("index-red-proof-clean");
            await writeRepoFile(clean.root, "shared.txt", "one\ntwo\nthree\n");
            await commitAll(clean.root, clean.env, "base");
            const cleanSection = await snapshotIndex(clean.root, clean.env);
            expect(cleanSection.status).toBe("captured");
            const cleanStages =
                cleanSection.status === "captured"
                    ? cleanSection.data
                          .filter((entry) => entry.path === "shared.txt")
                          .map((entry) => entry.stage)
                    : [];
            expect(cleanStages).toEqual([0]);
            await clean.dispose();

            // Deliberately broken input: a real unmerged conflict on the same path.
            const broken = await buildRealConflict();
            const brokenSection = await snapshotIndex(broken.root, broken.env);
            expect(brokenSection.status).toBe("captured");
            const brokenStages =
                brokenSection.status === "captured"
                    ? brokenSection.data
                          .filter((entry) => entry.path === "shared.txt")
                          .map((entry) => entry.stage)
                          .sort()
                    : [];
            // The exact assertion that passed for the clean repo (`toEqual([0])`) now fails for
            // the broken one -- confirmed by asserting the actual, different shape directly.
            expect(brokenStages).not.toEqual([0]);
            expect(brokenStages).toEqual([1, 2, 3]);
            await broken.dispose();
        });

        it("runs against a bare repository without throwing, reporting a genuinely empty index", async () => {
            repo = await createScratchRepo("index-bare-source");
            await writeRepoFile(repo.root, "a.txt", "hello\n");
            await commitAll(repo.root, repo.env, "c1");

            const { mkdtemp } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const path = await import("node:path");
            const bareRoot = await mkdtemp(path.join(tmpdir(), "intelligit-index-bare-"));
            await git(bareRoot, ["init", "--quiet", "--bare"], repo.env);
            await git(repo.root, ["push", "--quiet", bareRoot, "main"], repo.env);

            const section = await snapshotIndex(bareRoot, repo.env);
            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;
            expect(section.data).toEqual([]);

            const { rm } = await import("node:fs/promises");
            await removeScratchDirectories(bareRoot);
        });
    });
});
