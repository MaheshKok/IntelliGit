/**
 * Pins what `replaceRegularWorktreeFile` guarantees about replacing a worktree file.
 *
 * The payload is written to an exclusively created sibling and renamed over the target, rather
 * than written into the target directly. That is a security property, not a style choice: the
 * lstat that proves the target is a regular file and the write that trusts it are separate
 * syscalls, and a symlink swapped in between them used to be *followed*, with the post-write lstat
 * reporting an escape that had already happened. `O_NOFOLLOW` closed that on POSIX and Windows
 * ignores the flag entirely, which is precisely where the pre/post pair stopped being a guard.
 *
 * Three properties, each with its own test below:
 *
 * - The target is replaced by a rename, so a path swapped in mid-flight is overwritten rather than
 *   written through. Asserted by inode identity, which is the only locally observable difference
 *   between the two mechanisms -- byte content is identical either way, so a content assertion
 *   cannot see this change at all.
 * - The file's permission bits survive. `wx` creates at 0o600, so a mechanism that forgets to
 *   carry the mode silently makes an executable script non-executable and owner-only.
 * - No temporary survives a successful write.
 *
 * Payload-length correctness (#223, where `O_WRONLY | O_TRUNC` with no `O_CREAT` broke shelf
 * raw-apply for every Windows user) is still asserted byte-exactly below. It is now structural --
 * the payload goes to a fresh file -- but the assertion is kept because "shorter payload leaves a
 * tail behind" is the defect that matters, whatever mechanism is underneath.
 */

import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { POSIX_PERMISSIONS_ENFORCED } from "../../helpers/platformCapabilities";
import { replaceRegularWorktreeFile } from "../../../src/shelf/safeWorktreeWrite";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

describe("replaceRegularWorktreeFile", () => {
    let root: string | undefined;

    afterEach(async () => {
        if (root) await removeScratchDirectories(root);
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

    it("replaces the target by rename rather than writing into it", async () => {
        const repositoryRoot = await createRoot();
        const target = path.join(repositoryRoot, "tracked.txt");
        await writeFile(target, "before\n");
        const before = await stat(target);

        // A platform that does not report inodes would make the assertion below vacuously true, so
        // fail loudly here instead of silently proving nothing.
        expect(before.ino, "this platform must report inode numbers").toBeGreaterThan(0);

        await replaceRegularWorktreeFile(repositoryRoot, "tracked.txt", Buffer.from("after\n"));

        const after = await stat(target);
        expect(await readFile(target, "utf8")).toBe("after\n");
        // The temporary's inode is allocated while the original is still linked, so the two cannot
        // collide. Writing into the target in place would keep the original inode -- which is what
        // this file asserted for as long as the write followed a symlink it had already checked.
        expect(
            after.ino,
            "target must be a different file, i.e. renamed into place, not written through",
        ).not.toBe(before.ino);
    });

    it.skipIf(!POSIX_PERMISSIONS_ENFORCED)(
        "carries the replaced file's permission bits across the rename",
        async () => {
            const repositoryRoot = await createRoot();
            const target = path.join(repositoryRoot, "run.sh");
            await writeFile(target, "#!/bin/sh\necho before\n");
            await chmod(target, 0o755);

            await replaceRegularWorktreeFile(
                repositoryRoot,
                "run.sh",
                Buffer.from("#!/bin/sh\necho after\n"),
            );

            // 0o600 is what `wx` creates, and is what this reads if the mode is not carried over:
            // an executable script silently returned non-executable and unreadable by anyone else.
            expect((await stat(target)).mode & 0o777).toBe(0o755);
        },
    );

    it("leaves no temporary behind after a successful write", async () => {
        const repositoryRoot = await createRoot();
        await writeFile(path.join(repositoryRoot, "tracked.txt"), "before\n");

        await replaceRegularWorktreeFile(repositoryRoot, "tracked.txt", Buffer.from("after\n"));

        expect(await readdir(repositoryRoot)).toEqual(["tracked.txt"]);
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
