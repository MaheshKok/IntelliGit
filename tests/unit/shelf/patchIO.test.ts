import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyPatchHeader } from "../../../src/shelf/patchClassification";
import {
    PATCH_GENERATION_FLAGS,
    generateLayerPatches,
    generateUntrackedPatch,
    indexPatchBlocks,
    materializeLayerPatches,
    selectPatchBlocks,
} from "../../../src/shelf/patchIO";

const execFileAsync = promisify(execFile);

interface BinaryCall {
    readonly args: readonly string[];
    readonly expectedExitCodes?: readonly number[];
    readonly outputFile?: string;
}

class RecordingExecutor {
    readonly binaryCalls: BinaryCall[] = [];
    readonly runCalls: string[][] = [];

    async runBinary(
        args: string[],
        options: { outputFile?: string; expectedExitCodes?: readonly number[] } = {},
    ): Promise<{
        stdout: Buffer;
        stderr: Buffer;
        exitCode: number;
    }> {
        this.binaryCalls.push({
            args,
            expectedExitCodes: options.expectedExitCodes,
            outputFile: options.outputFile,
        });
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    }

    async run(args: string[]): Promise<string> {
        this.runCalls.push(args);
        return "";
    }
}

class RealGitExecutor {
    constructor(private readonly cwd: string) {}

    async runBinary(
        args: string[],
        options: { outputFile?: string; expectedExitCodes?: readonly number[] },
    ): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number }> {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd: this.cwd,
            encoding: "buffer",
        });
        if (options.outputFile) await writeFile(options.outputFile, stdout);
        return { stdout, stderr, exitCode: 0 };
    }

    async run(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
        return stdout.toString();
    }
}

describe("shelf patch primitives", () => {
    it("uses the frozen byte-safe diff flags for each layer", async () => {
        const executor = new RecordingExecutor();

        await generateLayerPatches(executor, {
            indexPatchPath: "/tmp/index.patch",
            worktreePatchPath: "/tmp/worktree.patch",
            paths: ["renamed file.txt"],
        });

        expect(PATCH_GENERATION_FLAGS).toEqual([
            "--binary",
            "--full-index",
            "-M",
            "--no-textconv",
            "--no-ext-diff",
            "--no-color",
        ]);
        expect(executor.binaryCalls).toEqual([
            {
                args: ["diff", "--cached", ...PATCH_GENERATION_FLAGS, "--", "renamed file.txt"],
                outputFile: "/tmp/index.patch",
            },
            {
                args: ["diff", ...PATCH_GENERATION_FLAGS, "--", "renamed file.txt"],
                outputFile: "/tmp/worktree.patch",
            },
        ]);
    });

    it("captures an untracked file through byte-safe no-index output", async () => {
        const executor = new RecordingExecutor();

        await generateUntrackedPatch(executor, {
            patchPath: "/tmp/untracked.patch",
            relativePath: "untracked.bin",
        });

        expect(executor.binaryCalls).toEqual([
            {
                args: [
                    "diff",
                    "--no-index",
                    ...PATCH_GENERATION_FLAGS,
                    "--",
                    "/dev/null",
                    "untracked.bin",
                ],
                expectedExitCodes: [0, 1],
                outputFile: "/tmp/untracked.patch",
            },
        ]);
    });

    it("never invokes git apply with --3way while materializing layers", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "intelligit-patch-io-"));
        const indexPatchPath = path.join(directory, "index.patch");
        const worktreePatchPath = path.join(directory, "worktree.patch");
        const executor = new RecordingExecutor();
        try {
            await Promise.all([
                writeFile(indexPatchPath, "index"),
                writeFile(worktreePatchPath, "worktree"),
            ]);
            await materializeLayerPatches(executor, { indexPatchPath, worktreePatchPath });

            expect(executor.runCalls).toEqual([
                ["apply", "--check", "--cached", indexPatchPath],
                ["apply", "--cached", indexPatchPath],
                ["apply", "--check", indexPatchPath],
                ["apply", indexPatchPath],
                ["checkout-index", "--all", "--force"],
                ["apply", "--check", worktreePatchPath],
                ["apply", worktreePatchPath],
            ]);
            expect(executor.runCalls.flat()).not.toContain("--3way");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("materializes a staged rename without leaving its source path", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "intelligit-patch-io-"));
        const indexPatchPath = path.join(directory, "index.patch");
        const worktreePatchPath = path.join(directory, "worktree.patch");
        const sourcePath = path.join(directory, "old.txt");
        const destinationPath = path.join(directory, "new.txt");
        const git = new RealGitExecutor(directory);
        try {
            await git.run(["init"]);
            await git.run(["config", "user.email", "shelf@example.test"]);
            await git.run(["config", "user.name", "Shelf Test"]);
            await writeFile(sourcePath, "before\n");
            await git.run(["add", "--", "old.txt"]);
            await git.run(["commit", "-m", "base"]);
            await git.run(["mv", "old.txt", "new.txt"]);
            await generateLayerPatches(git, { indexPatchPath, worktreePatchPath });
            await git.run(["reset", "--hard", "HEAD"]);

            await materializeLayerPatches(git, { indexPatchPath, worktreePatchPath });

            await expect(access(sourcePath)).rejects.toThrow();
            await expect(readFile(destinationPath, "utf8")).resolves.toBe("before\n");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("indexes rename blocks by byte range and only selects whole logical blocks", () => {
        const patch = Buffer.from(
            [
                "diff --git a/old.txt b/new.txt",
                "similarity index 100%",
                "rename from old.txt",
                "rename to new.txt",
                "diff --git a/other.txt b/other.txt",
                "index 1111111..2222222 100644",
                "--- a/other.txt",
                "+++ b/other.txt",
                "@@ -1 +1 @@",
                "-before",
                "+after",
                "",
            ].join("\n"),
            "utf8",
        );

        const blocks = indexPatchBlocks(patch);

        expect(blocks).toEqual([
            {
                changeId: "patch-0",
                start: 0,
                end: patch.indexOf(Buffer.from("diff --git a/other.txt")),
                path: "new.txt",
                renamedFrom: "old.txt",
            },
            {
                changeId: "patch-1",
                start: patch.indexOf(Buffer.from("diff --git a/other.txt")),
                end: patch.length,
                path: "other.txt",
                renamedFrom: undefined,
            },
        ]);
        expect(selectPatchBlocks(patch, blocks, ["patch-0"])).toEqual(
            patch.subarray(0, patch.indexOf(Buffer.from("diff --git a/other.txt"))),
        );
    });

    it("does not derive rename metadata from bytes after the first hunk", () => {
        const patch = Buffer.from(
            [
                "diff --git a/file.txt b/file.txt",
                "index 1111111..2222222 100644",
                "--- a/file.txt",
                "+++ b/file.txt",
                "@@ -1 +1 @@",
                "-before",
                "+after",
                "rename from payload-only.txt",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)[0]?.renamedFrom).toBeUndefined();
    });

    it("preserves header status precedence and stops at a binary header", () => {
        const patch = Buffer.from(
            [
                "diff --git a/old.txt b/new.txt",
                "similarity index 100%",
                "rename from old.txt",
                "rename to new.txt",
                "old mode 100644",
                "new mode 100755",
                "GIT binary patch",
                "literal 0",
                "rename from payload-only.txt",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(classifyPatchHeader(patch)).toEqual({
            status: "R",
            renamedFrom: "old.txt",
            binary: true,
        });
    });

    it("uses the unified destination line when a path itself contains b-slash", () => {
        const patch = Buffer.from(
            [
                "diff --git a/dir b/name.txt b/dir b/name.txt",
                "index 1111111..2222222 100644",
                "--- a/dir b/name.txt",
                "+++ b/dir b/name.txt",
                "@@ -1 +1 @@",
                "-before",
                "+after",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)[0]?.path).toBe("dir b/name.txt");
    });

    it("indexes an unquoted mode-only path containing b-slash", () => {
        const patch = Buffer.from(
            [
                "diff --git a/dir b/name.txt b/dir b/name.txt",
                "old mode 100644",
                "new mode 100755",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)[0]?.path).toBe("dir b/name.txt");
    });

    it("does not split a block on diff-header text inside a hunk", () => {
        const patch = Buffer.from(
            [
                "diff --git a/file.txt b/file.txt",
                "index 1111111..2222222 100644",
                "--- a/file.txt",
                "+++ b/file.txt",
                "@@ -1 +1 @@",
                "-before",
                "+diff --git a/not-a-header b/not-a-header",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)).toHaveLength(1);
        expect(indexPatchBlocks(patch)[0]?.path).toBe("file.txt");
    });

    it("indexes a non-rename binary block from its diff header", () => {
        const patch = Buffer.from(
            [
                "diff --git a/image.bin b/image.bin",
                "new file mode 100644",
                "index 0000000..1111111",
                "GIT binary patch",
                "literal 0",
                "HcmV?d00001",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)[0]?.path).toBe("image.bin");
    });

    it("decodes Git C-style quoted binary paths from the diff header", () => {
        const patch = Buffer.from(
            [
                'diff --git "a/tab\\011name.bin" "b/tab\\011name.bin"',
                "new file mode 100644",
                "index 0000000..1111111",
                "GIT binary patch",
                "literal 0",
                "HcmV?d00001",
                "",
            ].join("\n"),
            "utf8",
        );

        expect(indexPatchBlocks(patch)[0]?.path).toBe("tab\tname.bin");
    });

    it("indexes each plain unified file section without splitting hunk payload", () => {
        const patch = Buffer.from(
            [
                "--- a/one.txt",
                "+++ b/one.txt",
                "@@ -1,2 +1,2 @@",
                "--- a/hunk-payload.txt",
                "+++ b/hunk-payload.txt",
                " context",
                "--- a/two.txt",
                "+++ b/two.txt",
                "@@ -1 +1 @@",
                "-before",
                "+after",
                "",
            ].join("\n"),
            "utf8",
        );
        const secondStart = patch.indexOf(Buffer.from("--- a/two.txt"));

        const blocks = indexPatchBlocks(patch);

        expect(blocks).toEqual([
            {
                changeId: "patch-0",
                start: 0,
                end: secondStart,
                path: "one.txt",
                renamedFrom: undefined,
            },
            {
                changeId: "patch-1",
                start: secondStart,
                end: patch.length,
                path: "two.txt",
                renamedFrom: undefined,
            },
        ]);
        expect(selectPatchBlocks(patch, blocks, ["patch-1"])).toEqual(patch.subarray(secondStart));
    });

    it("uses the source path for a plain unified deletion", () => {
        const patch = Buffer.from(
            ["--- a/deleted b/ignored.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-before", ""].join(
                "\n",
            ),
            "utf8",
        );

        const blocks = indexPatchBlocks(patch);

        expect(blocks).toEqual([
            {
                changeId: "patch-0",
                start: 0,
                end: patch.length,
                path: "deleted b/ignored.txt",
                renamedFrom: undefined,
            },
        ]);
        expect(selectPatchBlocks(patch, blocks, ["patch-0"])).toEqual(patch);
    });

    it("indexes a plain unified diff as one byte-preserving block", () => {
        const patch = Buffer.from(
            ["--- a/plain.txt", "+++ b/plain.txt", "@@ -1 +1 @@", "-before", "+after", ""].join(
                "\n",
            ),
            "utf8",
        );

        const blocks = indexPatchBlocks(patch);

        expect(blocks).toEqual([
            {
                changeId: "patch-0",
                start: 0,
                end: patch.length,
                path: "plain.txt",
                renamedFrom: undefined,
            },
        ]);
        expect(selectPatchBlocks(patch, blocks, ["patch-0"])).toEqual(patch);
    });
});
