import type { FSWatcher } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGitDir } from "../../../src/git/gitDirectory";
import { watchWholeIndexOperation } from "../../../src/git/wholeIndexOperationWatcher";

const { readFileSyncMock, watchMock } = vi.hoisted(() => ({
    readFileSyncMock: vi.fn(),
    watchMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    readFileSyncMock.mockImplementation(actual.readFileSync);
    return { ...actual, readFileSync: readFileSyncMock, watch: watchMock };
});

type FsWatchCallback = (eventType: string, filename: string | Buffer | null) => void;
type FsWatchErrorCallback = (error: Error) => void;

const directories: string[] = [];

afterEach(async () => {
    readFileSyncMock.mockClear();
    watchMock.mockReset();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

/** Creates an isolated repository-shaped directory for synchronous Git-dir resolver tests. */
async function createRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-git-directory-"));
    directories.push(root);
    return root;
}

describe("resolveGitDir", () => {
    it("keeps the standard .git directory and falls back for missing or malformed pointers", async () => {
        const standardRoot = await createRoot();
        const missingRoot = await createRoot();
        const malformedRoot = await createRoot();
        const standardGitDir = path.join(standardRoot, ".git");
        await mkdir(standardGitDir);
        await writeFile(path.join(malformedRoot, ".git"), "not a gitdir pointer\n");

        expect(resolveGitDir(standardRoot)).toBe(standardGitDir);
        expect(resolveGitDir(missingRoot)).toBe(path.join(missingRoot, ".git"));
        expect(resolveGitDir(malformedRoot)).toBe(path.join(malformedRoot, ".git"));
    });

    it("resolves whitespace-padded relative and absolute gitdir pointers", async () => {
        const relativeRoot = await createRoot();
        const absoluteRoot = await createRoot();
        const absoluteGitDir = path.join(absoluteRoot, "metadata", "worktree");
        await writeFile(
            path.join(relativeRoot, ".git"),
            "gitdir:   ../shared-metadata/worktree   \n",
        );
        await writeFile(path.join(absoluteRoot, ".git"), `gitdir: ${absoluteGitDir}\n`);

        expect(resolveGitDir(relativeRoot)).toBe(
            path.resolve(relativeRoot, "../shared-metadata/worktree"),
        );
        expect(resolveGitDir(absoluteRoot)).toBe(absoluteGitDir);
    });

    it("falls back to the conventional .git path when a pointer file is unreadable", async () => {
        const root = await createRoot();
        const dotGit = path.join(root, ".git");
        await writeFile(dotGit, "gitdir: metadata/worktree\n");
        const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
        readFileSyncMock.mockImplementationOnce(() => {
            throw readError;
        });

        expect(resolveGitDir(root)).toBe(dotGit);
        expect(readFileSyncMock).toHaveBeenCalledWith(dotGit, "utf8");
    });
});

describe("watchWholeIndexOperation", () => {
    it("watches the linked-worktree Git directory, forwards markers and unknown filenames, and disposes once", async () => {
        const root = await createRoot();
        const gitDir = path.join(root, "metadata", "worktree");
        await writeFile(path.join(root, ".git"), "gitdir: metadata/worktree\n");
        const callbacks: FsWatchCallback[] = [];
        const close = vi.fn();
        watchMock.mockImplementation((...args: unknown[]) => {
            const callback = args.at(-1);
            if (typeof callback !== "function") throw new Error("Expected fs.watch callback");
            callbacks.push(callback as FsWatchCallback);
            return { close, on: vi.fn() } as unknown as FSWatcher;
        });
        const onDidChange = vi.fn();

        const disposable = watchWholeIndexOperation(root, onDidChange);

        expect(watchMock).toHaveBeenCalledWith(gitDir, expect.any(Function));
        const callback = callbacks[0];
        if (!callback) throw new Error("Expected fs.watch callback");
        for (const marker of [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
        ]) {
            callback("rename", marker);
        }
        callback("change", null);
        callback("change", "HEAD");

        expect(onDidChange).toHaveBeenCalledTimes(7);
        disposable.dispose();
        disposable.dispose();
        callback("rename", "MERGE_HEAD");
        expect(close).toHaveBeenCalledOnce();
        expect(onDidChange).toHaveBeenCalledTimes(7);
    });

    it("surfaces synchronous fs.watch setup failure", async () => {
        const root = await createRoot();
        const setupError = new Error("watch setup failed");
        watchMock.mockImplementation((() => {
            throw setupError;
        }) as never);

        expect(() => watchWholeIndexOperation(root, vi.fn())).toThrow(setupError);
    });

    it("disposes and routes an asynchronous fs.watch error once", async () => {
        const root = await createRoot();
        const close = vi.fn();
        let onError: FsWatchErrorCallback | undefined;
        const watcher = {
            close,
            on: vi.fn((event: string, listener: unknown) => {
                if (event === "error" && typeof listener === "function") {
                    onError = listener as FsWatchErrorCallback;
                }
                return watcher;
            }),
        };
        watchMock.mockReturnValue(watcher as unknown as FSWatcher);
        const onDidError = vi.fn();
        const disposable = watchWholeIndexOperation(root, vi.fn(), onDidError);
        if (!onError) throw new Error("Expected fs.watch error listener");
        const watcherError = new Error("watch failed asynchronously");

        onError(watcherError);
        disposable.dispose();
        onError(watcherError);

        expect(close).toHaveBeenCalledOnce();
        expect(onDidError).toHaveBeenCalledOnce();
        expect(onDidError).toHaveBeenCalledWith(watcherError);
    });

    it("decodes Buffer marker names without treating unrelated Buffers as unknown", async () => {
        const root = await createRoot();
        let callback: FsWatchCallback | undefined;
        const close = vi.fn();
        watchMock.mockImplementation((...args: unknown[]) => {
            const listener = args.at(-1);
            if (typeof listener !== "function") throw new Error("Expected fs.watch callback");
            callback = listener as FsWatchCallback;
            return { close, on: vi.fn() } as unknown as FSWatcher;
        });
        const onDidChange = vi.fn();
        const disposable = watchWholeIndexOperation(root, onDidChange);
        if (!callback) throw new Error("Expected fs.watch callback");

        callback("rename", Buffer.from("MERGE_HEAD"));
        callback("rename", Buffer.from("HEAD"));

        expect(onDidChange).toHaveBeenCalledOnce();
        disposable.dispose();
        expect(close).toHaveBeenCalledOnce();
    });
});
