/**
 * Spec-derived tests for `scratchWorkspaces.ts`.
 *
 * The behavior under test is a CLEANUP path on a FAILED seed, which no green run ever reaches --
 * so each test here drives the failure directly and then does what vitest does the instant
 * `beforeAll` rejects: run `afterAll`. The assertion is always on the filesystem, never on the
 * helper's internal path list, because the contract is "the directory is gone", not "the string was
 * recorded".
 *
 * The first test is the one that fails if `seedPair` is ever rewritten back to `Promise.all`: with
 * `all`, the rejection propagates immediately and `removeAll` reads an empty list while the slow
 * sibling is still seeding, leaving its `home` on disk forever.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createScratchWorkspaces } from "./scratchWorkspaces";

async function exists(target: string): Promise<boolean> {
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createScratchWorkspaces", () => {
    const allocated: string[] = [];

    async function scratchDir(): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "intelligit-scratch-workspaces-test-"));
        allocated.push(dir);
        return dir;
    }

    afterEach(async () => {
        await Promise.all(
            allocated.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    it("removes a slow sibling's home when the other seed fails first", async () => {
        const scratch = createScratchWorkspaces();
        const home = await scratchDir();

        await expect(
            scratch.seedPair(
                async () => {
                    // Still seeding when the sibling below has already thrown. Under `Promise.all`
                    // this registration lands AFTER `removeAll` has read the list.
                    await delay(50);
                    return { home };
                },
                async () => {
                    throw new Error("seed-b exploded");
                },
            ),
        ).rejects.toThrow("seed-b exploded");

        await scratch.removeAll();

        expect(await exists(home)).toBe(false);
    });

    it("removes a registered path even when both seeds fail", async () => {
        const scratch = createScratchWorkspaces();
        const parentDir = await scratchDir();
        scratch.register(parentDir);

        await expect(
            scratch.seedPair(
                async () => {
                    throw new Error("seed-a exploded");
                },
                async () => {
                    throw new Error("seed-b exploded");
                },
            ),
            // The FIRST seed's reason, deterministically -- not whichever lost the race.
        ).rejects.toThrow("seed-a exploded");

        await scratch.removeAll();

        expect(await exists(parentDir)).toBe(false);
    });

    it("returns both workspaces in argument order and removes both homes", async () => {
        const scratch = createScratchWorkspaces();
        const homeA = await scratchDir();
        const homeB = await scratchDir();

        const [a, b] = await scratch.seedPair(
            async () => ({ home: homeA, tag: "a" }),
            async () => {
                await delay(10);
                return { home: homeB, tag: "b" };
            },
        );

        expect([a.tag, b.tag]).toEqual(["a", "b"]);

        await scratch.removeAll();

        expect(await exists(homeA)).toBe(false);
        expect(await exists(homeB)).toBe(false);
    });
});
