import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import {
    PATCH_GENERATION_FLAGS,
    generateLayerPatches,
    generateUntrackedPatch,
    materializeLayerPatches,
} from "../../../src/shelf/patchIO";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function git(directory: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

async function gitBuffer(directory: string, args: string[]): Promise<Buffer> {
    const result = await execFileAsync("git", args, { cwd: directory, encoding: "buffer" });
    return result.stdout as Buffer;
}

async function createRepository(files: Readonly<Record<string, Uint8Array | string>>): Promise<{
    readonly source: string;
    readonly verify: string;
    readonly indexPatch: string;
    readonly worktreePatch: string;
}> {
    const source = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-patch-"));
    directories.push(source);
    for (const [file, contents] of Object.entries(files)) {
        const target = path.join(source, file);
        await writeFile(target, contents);
    }
    await git(source, ["init"]);
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base"]);
    const verify = path.join(source, "verify");
    await git(source, ["worktree", "add", "--detach", verify]);
    return {
        source,
        verify,
        indexPatch: path.join(source, "index.patch"),
        worktreePatch: path.join(source, "worktree.patch"),
    };
}

async function assertRoundTrip(
    repository: Awaited<ReturnType<typeof createRepository>>,
): Promise<void> {
    await generateLayerPatches(new GitExecutor(repository.source), {
        indexPatchPath: repository.indexPatch,
        worktreePatchPath: repository.worktreePatch,
    });
    await materializeLayerPatches(new GitExecutor(repository.verify), {
        indexPatchPath: repository.indexPatch,
        worktreePatchPath: repository.worktreePatch,
    });

    await expect(
        gitBuffer(repository.verify, ["diff", "--cached", ...PATCH_GENERATION_FLAGS]),
    ).resolves.toEqual(
        await gitBuffer(repository.source, ["diff", "--cached", ...PATCH_GENERATION_FLAGS]),
    );
    await expect(
        gitBuffer(repository.verify, ["diff", ...PATCH_GENERATION_FLAGS]),
    ).resolves.toEqual(await gitBuffer(repository.source, ["diff", ...PATCH_GENERATION_FLAGS]));
}

describe("layer patch materialization", () => {
    it.each(["staged-only", "unstaged-only", "mixed", "base-index-worktree divergence"])(
        "round-trips %s content without collapsing the two layers",
        async (kind) => {
            const repository = await createRepository({ "tracked.txt": "base\n" });
            if (kind === "staged-only") {
                await writeFile(path.join(repository.source, "tracked.txt"), "index\n");
                await git(repository.source, ["add", "tracked.txt"]);
            } else if (kind === "unstaged-only") {
                await writeFile(path.join(repository.source, "tracked.txt"), "worktree\n");
            } else if (kind === "mixed") {
                await writeFile(path.join(repository.source, "tracked.txt"), "index\n");
                await git(repository.source, ["add", "tracked.txt"]);
                await writeFile(path.join(repository.source, "tracked.txt"), "worktree\n");
            } else {
                await writeFile(path.join(repository.source, "tracked.txt"), "index\n");
                await git(repository.source, ["add", "tracked.txt"]);
                await writeFile(path.join(repository.source, "tracked.txt"), "base\n");
            }

            await assertRoundTrip(repository);
        },
    );

    it("removes a staged-only deletion from the materialized worktree", async () => {
        const repository = await createRepository({ "gone.txt": "base\n" });
        await unlink(path.join(repository.source, "gone.txt"));
        await git(repository.source, ["add", "-u"]);

        await assertRoundTrip(repository);

        await expect(readFile(path.join(repository.verify, "gone.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("round-trips a staged rename followed by a worktree rename", async () => {
        const repository = await createRepository({ "a.txt": "base\n" });
        await git(repository.source, ["mv", "a.txt", "b.txt"]);
        await rename(path.join(repository.source, "b.txt"), path.join(repository.source, "c.txt"));

        await assertRoundTrip(repository);
    });

    it.each(["add-delete", "delete-recreate"])("round-trips %s cancellation", async (kind) => {
        const repository = await createRepository(
            kind === "add-delete" ? { ".gitkeep": "" } : { "tracked.txt": "base\n" },
        );
        if (kind === "add-delete") {
            await writeFile(path.join(repository.source, "new.txt"), "index\n");
            await git(repository.source, ["add", "new.txt"]);
            await unlink(path.join(repository.source, "new.txt"));
        } else {
            await unlink(path.join(repository.source, "tracked.txt"));
            await git(repository.source, ["add", "tracked.txt"]);
            await writeFile(path.join(repository.source, "tracked.txt"), "recreated\n");
        }

        await assertRoundTrip(repository);
    });

    it("round-trips binary and empty-file layers byte-for-byte", async () => {
        const repository = await createRepository({
            "binary.bin": Buffer.from([0, 1, 2, 255]),
            "empty.txt": "",
        });
        await writeFile(path.join(repository.source, "binary.bin"), Buffer.from([0, 255, 3, 4]));
        await writeFile(path.join(repository.source, "empty.txt"), "index\n");
        await git(repository.source, ["add", "binary.bin", "empty.txt"]);
        await writeFile(path.join(repository.source, "binary.bin"), Buffer.from([4, 3, 255, 0]));
        await writeFile(path.join(repository.source, "empty.txt"), "");

        await assertRoundTrip(repository);
        expect(await readFile(path.join(repository.verify, "binary.bin"))).toEqual(
            await readFile(path.join(repository.source, "binary.bin")),
        );
    });

    it("captures and applies an untracked binary file through a no-index patch", async () => {
        const repository = await createRepository({ ".gitkeep": "" });
        const contents = Buffer.from([0, 255, 1, 2]);
        const patchPath = path.join(repository.source, "untracked.patch");
        await writeFile(path.join(repository.source, "untracked.bin"), contents);

        await generateUntrackedPatch(new GitExecutor(repository.source), {
            patchPath,
            relativePath: "untracked.bin",
        });
        await new GitExecutor(repository.verify).run(["apply", patchPath]);

        expect(await readFile(path.join(repository.verify, "untracked.bin"))).toEqual(contents);
    });
});
