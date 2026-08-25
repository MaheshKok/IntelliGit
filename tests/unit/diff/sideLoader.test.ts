import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SideSpec } from "../../../src/services/diffService";

const mocks = vi.hoisted(() => {
    const fileUri = (fsPath: string) => ({
        scheme: "file",
        fsPath,
        toString: () => `file://${fsPath}`,
    });
    return {
        stat: vi.fn(),
        readFile: vi.fn(),
        textDocuments: [] as Array<{ uri: { toString(): string }; getText(): string }>,
        fileUri,
        joinUri: (root: { fsPath: string }, filePath: string) =>
            fileUri(`${root.fsPath}/${filePath}`),
    };
});

vi.mock("vscode", () => ({
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: mocks.fileUri, joinPath: mocks.joinUri },
    workspace: {
        fs: { stat: mocks.stat, readFile: mocks.readFile },
        textDocuments: mocks.textDocuments,
    },
}));

import { countLines, loadDiffSide } from "../../../src/diff/sideLoader";

/**
 * The fixture repository root, resolved the way the loader resolves it.
 *
 * `loadWorktree` builds its lookup URI from `path.resolve(repoRoot)`. `/repo` is not an absolute
 * path on Windows, so that call rewrites it against the current drive and the URI the loader
 * computes stops matching a hand-written `file:///repo/...` literal -- the open document is then
 * missed and the loader silently falls back to disk, which is exactly the behaviour these tests
 * exist to rule out. Resolving here keeps both sides in agreement on every platform.
 */
const REPO_ROOT = path.resolve("/repo");

/** The URI the loader computes for the fixture file, built through the same mock it uses. */
const fixtureFileUri = () => mocks.joinUri(mocks.fileUri(REPO_ROOT), "file.txt");

interface BinaryExecutor {
    runBinary: ReturnType<typeof vi.fn>;
}

function executor(
    options: {
        size?: number;
        mode?: number;
        bytes?: Uint8Array;
        error?: Error;
    } = {},
): BinaryExecutor {
    const runBinary = vi.fn(async (args: string[]) => {
        if (options.error) throw options.error;
        if (args[0] === "cat-file" && args[1] === "-s") {
            return {
                stdout: Buffer.from(`${options.size ?? options.bytes?.byteLength ?? 0}\n`),
                truncated: false,
            };
        }
        if (args[0] === "ls-tree") {
            const mode = (options.mode ?? 0o100644).toString(8);
            return { stdout: Buffer.from(`${mode} blob hash\tfile.txt\0`), truncated: false };
        }
        return { stdout: Buffer.from(options.bytes ?? Buffer.from("text\n")), truncated: false };
    });
    return { runBinary };
}

function refSide(ref = "HEAD"): SideSpec {
    return { kind: "ref", ref };
}

function options(side: SideSpec, binaryExecutor: BinaryExecutor, maxBytes = 32) {
    return {
        repoRoot: REPO_ROOT,
        filePath: "file.txt",
        side,
        maxBytes,
        executor: binaryExecutor as never,
    };
}

describe("loadDiffSide", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.textDocuments.length = 0;
        mocks.stat.mockResolvedValue({ type: 1, size: 5 });
        mocks.readFile.mockResolvedValue(Buffer.from("disk\n"));
    });

    it("loads a ref as raw bytes and text after eligibility checks", async () => {
        const binaryExecutor = executor({ bytes: Buffer.from("ref text\n") });

        const result = await loadDiffSide(options(refSide(), binaryExecutor));

        expect(result).toMatchObject({ status: "loaded", text: "ref text\n", mode: 0o100644 });
        if (result.status === "loaded") expect(result.bytes).toEqual(Buffer.from("ref text\n"));
        expect(binaryExecutor.runBinary).toHaveBeenNthCalledWith(
            1,
            ["cat-file", "-s", "HEAD:file.txt"],
            expect.objectContaining({ maxOutputBytes: expect.any(Number) }),
        );
    });

    it("delegates a ref whose size probe exceeds the cap before reading content", async () => {
        const binaryExecutor = executor({ size: 33, bytes: Buffer.from("too large") });

        await expect(loadDiffSide(options(refSide(), binaryExecutor, 32))).resolves.toEqual({
            status: "over-budget",
            size: 33,
        });
        expect(binaryExecutor.runBinary).toHaveBeenCalledOnce();
    });

    it("maps a confirmed missing ref to an empty side", async () => {
        const binaryExecutor = executor({
            error: new Error("fatal: path 'file.txt' does not exist in 'HEAD'"),
        });

        await expect(loadDiffSide(options(refSide(), binaryExecutor))).resolves.toEqual({
            status: "missing",
        });
    });

    it("loads an untracked worktree file from raw bytes", async () => {
        mocks.stat.mockResolvedValue({ type: 1, size: 5 });
        mocks.readFile.mockResolvedValue(Buffer.from("new\n"));

        const result = await loadDiffSide(options({ kind: "worktree" }, executor() as never));

        expect(result).toMatchObject({ status: "loaded", text: "new\n" });
        expect(mocks.stat).toHaveBeenCalledOnce();
        expect(mocks.readFile).toHaveBeenCalledOnce();
    });

    it("maps a confirmed missing worktree file to an empty side", async () => {
        mocks.stat.mockRejectedValue({ code: "FileNotFound" });

        await expect(
            loadDiffSide(options({ kind: "worktree" }, executor() as never)),
        ).resolves.toEqual({
            status: "missing",
        });
    });

    /**
     * Deleting a file on disk does not close its editor, and the buffer that stays open is what
     * the next save writes. The sibling case below already prefers that buffer over stale
     * metadata; this is the same preference on the branch where `stat` never returns one, which
     * would otherwise render the working-tree side as deleted while the editor still shows text.
     */
    it("uses an open dirty document for a file that no longer exists on disk", async () => {
        mocks.stat.mockRejectedValue({ code: "FileNotFound" });
        mocks.textDocuments.push({ uri: fixtureFileUri(), getText: () => "unsaved\n" });

        const result = await loadDiffSide(options({ kind: "worktree" }, executor() as never));

        expect(result).toMatchObject({ status: "loaded", text: "unsaved\n" });
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it("uses an open dirty document before stale filesystem metadata", async () => {
        mocks.textDocuments.push({ uri: fixtureFileUri(), getText: () => "dirty\n" });

        const result = await loadDiffSide(options({ kind: "worktree" }, executor() as never));

        expect(result).toMatchObject({ status: "loaded", text: "dirty\n" });
        expect(mocks.stat).toHaveBeenCalledOnce();
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it("keeps a dirty open symlink ineligible", async () => {
        mocks.textDocuments.push({ uri: fixtureFileUri(), getText: () => "dirty symlink\n" });
        mocks.stat.mockResolvedValue({ type: 64, size: 0 });

        await expect(loadDiffSide(options({ kind: "worktree" }, executor()))).resolves.toEqual({
            status: "ineligible",
            reason: "symlink",
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it.each([
        [64, "symlink"],
        [2, "submodule"],
    ] as const)(
        "routes a %s worktree entry to native eligibility handling",
        async (type, reason) => {
            mocks.stat.mockResolvedValue({ type, size: 0 });

            await expect(loadDiffSide(options({ kind: "worktree" }, executor()))).resolves.toEqual({
                status: "ineligible",
                reason,
            });
            expect(mocks.readFile).not.toHaveBeenCalled();
        },
    );

    it("routes NUL-containing bytes to native eligibility handling", async () => {
        const binaryExecutor = executor({ bytes: Buffer.from([0x61, 0x00, 0x62]) });

        await expect(loadDiffSide(options(refSide(), binaryExecutor))).resolves.toEqual({
            status: "ineligible",
            reason: "binary",
        });
    });

    it("routes invalid UTF-8 to native eligibility handling", async () => {
        const binaryExecutor = executor({ bytes: Buffer.from([0xc3, 0x28]) });

        await expect(loadDiffSide(options(refSide(), binaryExecutor))).resolves.toEqual({
            status: "ineligible",
            reason: "invalid-utf8",
        });
    });

    it.each([
        [0o120000, "symlink"],
        [0o160000, "submodule"],
    ] as const)("rejects Git mode %o as %s before content allocation", async (mode, reason) => {
        const binaryExecutor = executor({ mode, bytes: Buffer.from("not read") });

        await expect(loadDiffSide(options(refSide(), binaryExecutor))).resolves.toEqual({
            status: "ineligible",
            reason,
        });
        expect(binaryExecutor.runBinary).toHaveBeenCalledTimes(2);
    });

    it("honours a provider's known binary flag without decoding it", async () => {
        const binary: SideSpec = {
            kind: "provider",
            label: "Shelf",
            identity: "Shelf",
            load: vi.fn(async () => ({
                status: "loaded" as const,
                bytes: Buffer.from([0xff, 0x00]),
                mode: 0o100644,
                binary: true,
            })),
        };

        await expect(loadDiffSide(options(binary, executor()))).resolves.toEqual({
            status: "ineligible",
            reason: "binary",
        });
        expect(binary.load).toHaveBeenCalledWith(32);
    });

    it("maps a provider missing result to an empty side", async () => {
        const provider: SideSpec = {
            kind: "provider",
            label: "Shelf",
            identity: "Shelf",
            load: vi.fn(async () => ({ status: "missing" as const })),
        };

        await expect(loadDiffSide(options(provider, executor()))).resolves.toEqual({
            status: "missing",
        });
    });

    it("returns a provider over-budget result without allocating or decoding", async () => {
        const provider: SideSpec = {
            kind: "provider",
            label: "Shelf",
            identity: "Shelf",
            load: vi.fn(async () => ({ status: "over-budget" as const, size: 33 })),
        };

        await expect(loadDiffSide(options(provider, executor(), 32))).resolves.toEqual({
            status: "over-budget",
            size: 33,
        });
    });

    it("propagates permission failures instead of creating an empty worktree side", async () => {
        mocks.stat.mockRejectedValue(
            Object.assign(new Error("permission denied"), { code: "EACCES" }),
        );

        await expect(loadDiffSide(options({ kind: "worktree" }, executor()))).rejects.toThrow(
            "permission denied",
        );
    });

    it("propagates unknown Git failures instead of treating them as missing", async () => {
        const binaryExecutor = executor({ error: new Error("fatal: repository is corrupt") });

        await expect(loadDiffSide(options(refSide(), binaryExecutor))).rejects.toThrow(
            "repository is corrupt",
        );
    });
});
