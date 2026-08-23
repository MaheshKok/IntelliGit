/**
 * Pins the two properties `replaceRegularWorktreeFile`'s open flags exist to carry, after #223
 * forced the truncation out of an `O_TRUNC` flag and into an explicit `truncate(0)`.
 *
 * Windows rejects `O_WRONLY | O_TRUNC` with no `O_CREAT`: libuv turns that into the Win32
 * `TRUNCATE_EXISTING` disposition and `open` fails with `EINVAL`, which broke shelf raw-apply for
 * every Windows user.
 *
 * Drop `O_TRUNC` and forget the explicit truncate, and a shorter payload leaves the tail of the
 * previous contents behind -- silent file corruption that no length-agnostic assertion catches.
 * That is the first test below, and it is the one that mutation-proves the fix.
 *
 * The "refuses to create" test below asserts a real contract, but it does NOT pin the open flags,
 * and it is written down here so nobody later reads it as if it did: `assertRegularTarget` lstats
 * the target before the open, so swapping the flags to `O_CREAT | O_TRUNC` (the other disposition
 * Windows accepts) leaves every test in this file green -- measured. The reason not to use
 * `O_CREAT` is therefore defence in depth across the lstat-to-open window, not the behaviour any
 * test here observes.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { replaceRegularWorktreeFile } from "../../../src/shelf/safeWorktreeWrite";

describe("replaceRegularWorktreeFile", () => {
    let root: string | undefined;

    afterEach(async () => {
        if (root) await rm(root, { recursive: true, force: true });
        root = undefined;
    });

    async function createRoot(): Promise<string> {
        root = await mkdtemp(path.join(tmpdir(), "intelligit-safe-worktree-write-"));
        return root;
    }

    it("leaves no tail of the previous contents when the new payload is shorter", async () => {
        const repositoryRoot = await createRoot();
        const target = path.join(repositoryRoot, "tracked.txt");
        await writeFile(target, "a much longer previous body that must not survive\n");

        await replaceRegularWorktreeFile(repositoryRoot, "tracked.txt", Buffer.from("short\n"));

        // Byte-exact, not `toContain`: the defect this guards against is trailing bytes, which a
        // containment assertion reads straight past.
        expect(await readFile(target, "utf8")).toBe("short\n");
        expect((await stat(target)).size).toBe(Buffer.byteLength("short\n"));
    });

    it("still replaces a longer payload correctly", async () => {
        const repositoryRoot = await createRoot();
        const target = path.join(repositoryRoot, "tracked.txt");
        await writeFile(target, "tiny\n");

        const longer = "a considerably longer replacement body\n";
        await replaceRegularWorktreeFile(repositoryRoot, "tracked.txt", Buffer.from(longer));

        expect(await readFile(target, "utf8")).toBe(longer);
    });

    it("refuses to create a file that does not already exist", async () => {
        const repositoryRoot = await createRoot();

        // Enforced by `assertRegularTarget`'s lstat rather than by the open flags -- see this
        // file's module comment. Asserted anyway because "a shelf payload cannot conjure a worktree
        // file the repository does not have" is the contract, wherever it happens to be enforced.
        await expect(
            replaceRegularWorktreeFile(repositoryRoot, "absent.txt", Buffer.from("nope\n")),
        ).rejects.toThrow();
        await expect(stat(path.join(repositoryRoot, "absent.txt"))).rejects.toThrow();
    });
});
