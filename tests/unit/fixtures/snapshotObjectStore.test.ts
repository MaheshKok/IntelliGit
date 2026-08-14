/**
 * Spec-derived tests for `tests/fixtures/repo/snapshotObjectStore.ts` (PLAN.md Phase 1 step 9:
 * "an object inventory, plus an assertion that `objects/info/alternates` is either absent or
 * points only inside the copy -- an alternates file still pointing at the template would make
 * copies silently share objects").
 *
 * Every assertion here is checked against a real repository built through plain `git` commands
 * with `createSanitizedGitEnv`'s sanitized environment (never through `snapshotObjectStore.ts`'s
 * own internal `gitRun.ts` seam), per this suite's Gate-4 discipline: a bug in the shared seam
 * must not be able to hide from every test built on top of it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertAlternatesContained, snapshotObjectStore } from "../../fixtures/repo/snapshotObjectStore";
import type { ScratchRepo } from "./gitTestHelpers";
import { commitAll, createScratchRepo, writeRepoFile } from "./gitTestHelpers";

describe("snapshotObjectStore", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    describe("object inventory", () => {
        it("captures every object git knows about, typed and sized", async () => {
            repo = await createScratchRepo("objectstore-basic");
            await writeRepoFile(repo.root, "a.txt", "hello\n");
            const commitSha = await commitAll(repo.root, repo.env, "add a.txt");

            const commonDir = path.join(repo.root, ".git");
            const section = await snapshotObjectStore(repo.root, commonDir, repo.env);

            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;

            const objectTypes = section.data.objects.map((entry) => entry.objectType).sort();
            // One commit, one tree, one blob -- exactly what a single-file initial commit creates.
            expect(objectTypes).toEqual(["blob", "commit", "tree"]);

            const commitEntry = section.data.objects.find((entry) => entry.objectId === commitSha);
            expect(commitEntry).toBeDefined();
            expect(commitEntry?.objectType).toBe("commit");
            expect(commitEntry?.size).toBeGreaterThan(0);
        });

        it("grows the inventory as new objects are added, and shrinks it back down for a fresh repo", async () => {
            // RED-proof: the same assertion ("exactly N objects") must diverge between a repo with
            // more history and one with less, or it is not really testing anything.
            const small = await createScratchRepo("objectstore-small");
            await writeRepoFile(small.root, "a.txt", "hello\n");
            await commitAll(small.root, small.env, "one commit");
            const smallSection = await snapshotObjectStore(small.root, path.join(small.root, ".git"), small.env);
            expect(smallSection.status).toBe("captured");
            const smallCount = smallSection.status === "captured" ? smallSection.data.objects.length : -1;

            const large = await createScratchRepo("objectstore-large");
            await writeRepoFile(large.root, "a.txt", "hello\n");
            await commitAll(large.root, large.env, "one commit");
            await writeRepoFile(large.root, "b.txt", "world\n");
            await commitAll(large.root, large.env, "two commits");
            const largeSection = await snapshotObjectStore(large.root, path.join(large.root, ".git"), large.env);
            expect(largeSection.status).toBe("captured");
            const largeCount = largeSection.status === "captured" ? largeSection.data.objects.length : -1;

            expect(largeCount).toBeGreaterThan(smallCount);

            await Promise.all([small.dispose(), large.dispose()]);
        });
    });

    describe("alternates", () => {
        it("reports absent when no alternates file exists", async () => {
            repo = await createScratchRepo("objectstore-no-alternates");
            await writeRepoFile(repo.root, "a.txt", "hello\n");
            await commitAll(repo.root, repo.env, "c1");

            const section = await snapshotObjectStore(repo.root, path.join(repo.root, ".git"), repo.env);
            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;
            expect(section.data.alternates).toEqual({ present: false, rawLines: [], resolvedAbsolutePaths: [] });
        });

        it("reports present with resolved absolute paths when an alternates file exists", async () => {
            repo = await createScratchRepo("objectstore-alternates-present");
            await writeRepoFile(repo.root, "a.txt", "hello\n");
            await commitAll(repo.root, repo.env, "c1");

            const infoDir = path.join(repo.root, ".git", "objects", "info");
            await mkdir(infoDir, { recursive: true });
            const insideObjectsDir = path.join(repo.root, ".git", "objects");
            await writeFile(path.join(infoDir, "alternates"), `${insideObjectsDir}\n`);

            const section = await snapshotObjectStore(repo.root, path.join(repo.root, ".git"), repo.env);
            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;
            expect(section.data.alternates.present).toBe(true);
            expect(section.data.alternates.rawLines).toEqual([insideObjectsDir]);
            expect(section.data.alternates.resolvedAbsolutePaths).toEqual([insideObjectsDir]);
        });
    });

    describe("assertAlternatesContained -- the RED-proof this bullet exists for", () => {
        it("does not throw when alternates is absent", () => {
            expect(() =>
                assertAlternatesContained({ present: false, rawLines: [], resolvedAbsolutePaths: [] }, ["/allowed"]),
            ).not.toThrow();
        });

        it("does not throw when every alternates path resolves inside an allowed root", () => {
            expect(() =>
                assertAlternatesContained(
                    { present: true, rawLines: ["x"], resolvedAbsolutePaths: ["/allowed/root/objects"] },
                    ["/allowed/root"],
                ),
            ).not.toThrow();
        });

        it("THROWS when an alternates path resolves outside every allowed root -- the deliberate break", async () => {
            // This is the literal RED-proof PLAN.md's work order asks for: plant an alternates
            // file pointing outside the copy, and confirm the assertion (here, the function call
            // itself) fails -- by throwing, which is exactly what a real test guarding a real copy
            // would rely on to catch a template-sharing regression.
            repo = await createScratchRepo("objectstore-alternates-outside");
            await writeRepoFile(repo.root, "a.txt", "hello\n");
            await commitAll(repo.root, repo.env, "c1");

            const outside = await createScratchRepo("objectstore-alternates-outside-target");
            const infoDir = path.join(repo.root, ".git", "objects", "info");
            await mkdir(infoDir, { recursive: true });
            await writeFile(path.join(infoDir, "alternates"), `${outside.root}\n`);

            const section = await snapshotObjectStore(repo.root, path.join(repo.root, ".git"), repo.env);
            expect(section.status).toBe("captured");
            if (section.status !== "captured") return;

            expect(() => assertAlternatesContained(section.data.alternates, [repo!.root])).toThrow(
                /points outside every allowed root/,
            );

            // Sanity: the exact same data does NOT throw once the outside root is declared allowed
            // too -- proving the assertion's failure above was caused by the path, not by a typo
            // in the test.
            expect(() =>
                assertAlternatesContained(section.data.alternates, [repo!.root, outside.root]),
            ).not.toThrow();

            await outside.dispose();
        });
    });
});
