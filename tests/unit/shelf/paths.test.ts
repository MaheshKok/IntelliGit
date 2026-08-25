import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    ensureShelfRoot,
    resolveShelfInternalPath,
    resolveShelfPaths,
    ShelfPathError,
    writePrivateShelfFile,
} from "../../../src/shelf/paths";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-paths-"));
    directories.push(directory);
    return directory;
}

describe("shelf paths", () => {
    it("uses the first 16 SHA-256 hex characters of the normalized real repository root", async () => {
        const temporary = await temporaryDirectory();
        const repositoryRoot = path.join(temporary, "repository");
        const globalStoragePath = path.join(temporary, "storage");
        await mkdir(repositoryRoot);
        const expected = createHash("sha256")
            .update(path.normalize(await realpath(repositoryRoot)))
            .digest("hex")
            .slice(0, 16);

        const direct = await resolveShelfPaths({ repositoryRoot, globalStoragePath });
        const normalized = await resolveShelfPaths({
            repositoryRoot: path.join(repositoryRoot, "..", "repository"),
            globalStoragePath,
        });

        expect(direct.repoId).toBe(expected);
        expect(normalized.repoId).toBe(expected);
        expect(direct.root).toBe(path.join(globalStoragePath, "shelves", expected));
    });

    it("appends the repository ID to a machine-scoped override and creates private artifacts", async () => {
        const temporary = await temporaryDirectory();
        const repositoryRoot = path.join(temporary, "repository");
        const overridePath = path.join(temporary, "override");
        await mkdir(repositoryRoot);
        const paths = await resolveShelfPaths({
            repositoryRoot,
            globalStoragePath: path.join(temporary, "storage"),
            overridePath,
        });

        await ensureShelfRoot(paths);
        const artifact = await writePrivateShelfFile(paths, "objects/content", "payload");

        expect(paths.root).toBe(path.join(overridePath, paths.repoId));
        // Windows does not implement POSIX permission bits: `stat().mode` there reports 0o666 for
        // any writable file whatever mode `mkdir`/`open` was given, so on that platform this
        // asserted the OS rather than the code (#223 -- it read `expected 438 to be 448`, i.e.
        // 0o666 vs 0o700). Privacy there is an ACL property this assertion could never observe.
        // Narrowed rather than deleted: the POSIX legs still enforce it, and they are the ones
        // where a regression to a world-readable shelf would be a real disclosure.
        if (process.platform !== "win32") {
            expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
            expect((await stat(artifact)).mode & 0o777).toBe(0o600);
        }
    });

    it("rejects symlinked storage roots and shelf-internal escapes", async () => {
        const temporary = await temporaryDirectory();
        const repositoryRoot = path.join(temporary, "repository");
        const storageTarget = path.join(temporary, "storage-target");
        const storageLink = path.join(temporary, "storage-link");
        await Promise.all([mkdir(repositoryRoot), mkdir(storageTarget)]);
        await symlink(storageTarget, storageLink);
        const paths = await resolveShelfPaths({ repositoryRoot, globalStoragePath: storageLink });

        await expect(ensureShelfRoot(paths)).rejects.toBeInstanceOf(ShelfPathError);
        expect(() => resolveShelfInternalPath(paths, "../escape")).toThrow(ShelfPathError);
        expect(() => resolveShelfInternalPath(paths, "objects/content")).not.toThrow();
        expect((await lstat(storageLink)).isSymbolicLink()).toBe(true);
    });

    it("rejects a symlinked ancestor before creating the configured storage path", async () => {
        const temporary = await temporaryDirectory();
        const repositoryRoot = path.join(temporary, "repository");
        const outside = path.join(temporary, "outside");
        const ancestor = path.join(temporary, "ancestor");
        await Promise.all([mkdir(repositoryRoot), mkdir(outside)]);
        await symlink(outside, ancestor);
        const paths = await resolveShelfPaths({
            repositoryRoot,
            globalStoragePath: path.join(ancestor, "configured-storage"),
        });

        await expect(ensureShelfRoot(paths)).rejects.toBeInstanceOf(ShelfPathError);
        await expect(lstat(path.join(outside, "configured-storage"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});
