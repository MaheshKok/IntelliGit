import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => {
    class FileSystemError extends Error {
        constructor(
            message: string,
            readonly code: string,
        ) {
            super(message);
        }
    }

    return {
        commands: { executeCommand: vi.fn(async () => undefined) },
        FileSystemError,
        Uri: {
            joinPath: vi.fn((root: { scheme?: string; path?: string }, path: string) => ({
                root,
                path,
                toString: () => `${root.scheme ?? "file"}://${root.path ?? ""}/${path}`,
            })),
        },
        l10n: {
            t: vi.fn((message: string, values?: Record<string, string>) =>
                message.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] ?? match),
            ),
        },
        workspace: {
            fs: { stat: vi.fn(async () => undefined) },
            openTextDocument: vi.fn(async () => ({ getText: () => "local file contents" })),
            textDocuments: [],
        },
    };
});
const createReadonlyDiffUri = vi.hoisted(() =>
    vi.fn((filePath: string, content: string, ref: string) => ({ filePath, content, ref })),
);
// panelFileActions.ts imports openUnifiedDiff cross-module from diffService.ts, so (unlike
// diffService.ts's own tests) it can be mocked directly here. The default beforeEach below makes
// it immediately invoke the native delegate it was given -- simulating the viewer declining --
// so every existing assertion on the exact prior git.openChange/vscode.diff fallback behavior
// stays valid unchanged, while dedicated tests assert on openUnifiedDiffMock's own call
// arguments to prove the funnel is actually being routed to with the correct SideSpec.
const openUnifiedDiffMock = vi.hoisted(() => vi.fn());
const openEditableDiffMock = vi.hoisted(() => vi.fn());
const beginEditableDiffSessionMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => vscodeMock);
vi.mock("../../../src/services/diffService", () => ({
    beginEditableDiffSession: beginEditableDiffSessionMock,
    createReadonlyDiffUri,
    openUnifiedDiff: openUnifiedDiffMock,
}));
vi.mock("../../../src/diff/editableDiffOpener", () => ({
    openEditableDiff: openEditableDiffMock,
}));

import {
    selectStashFromPanel,
    showDiffFromPanel,
    showStashDiffFromPanel,
} from "../../../src/views/panelFileActions";
import type { GitOps } from "../../../src/git/operations";
import type { WorkingFile } from "../../../src/types";

function makeGitOps(): GitOps {
    return {
        getStashFileContents: vi.fn(async () => ({ before: "base", after: "stash" })),
        getStashFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
            { path: "new.txt", status: "?", staged: false, additions: 1, deletions: 0 },
        ]),
        // The single-file path resolves the stash by its stable commit hash (never
        // stash@{index}), so it reads through getFileContentAtRef instead of the index-based
        // getStashFileContents used by the still-native whole-stash overview.
        listStashes: vi.fn(async () => [{ index: 2, hash: "stash2hash" }]),
        getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) =>
            ref === "stash2hash" ? "stash" : undefined,
        ),
    } as unknown as GitOps;
}

/** A fresh, always-resolved cancellation token matching the funnel's native-delegate contract. */
function fakeCancellationToken() {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
    };
}

function fileActionDeps(gitOps: GitOps) {
    return { gitOps, getWorkspaceRoot: () => ({ scheme: "file", path: "/repo" }) };
}

function stashSelectionDeps(
    postUpdate: (message: { selectedStashIndex: number }) => void | Promise<void>,
) {
    return {
        gitOps: {
            getStashFiles: vi.fn(async (index: number) => [
                {
                    path: `stash-${index}.ts`,
                    status: "M",
                    staged: false,
                    additions: 1,
                    deletions: 0,
                },
            ]),
        },
        iconTheme: {
            decorateWorkingFiles: vi.fn(async (files: WorkingFile[]) => files),
            getFolderIconsByPaths: vi.fn(async () => ({})),
            getThemeData: vi.fn(() => ({ folderIcons: {}, iconFonts: [] })),
        },
        getFiles: () => [],
        getStashes: () => [],
        getShelfFilePaths: () => [],
        currentBranchHasUpstream: vi.fn(async () => false),
        setStashState: vi.fn(),
        postUpdate,
    } as Parameters<typeof selectStashFromPanel>[0];
}

beforeEach(() => {
    // Runs before every nested describe's own beforeEach (and its vi.clearAllMocks(), which
    // clears call history but not this implementation) so the decline default is always active.
    openUnifiedDiffMock.mockImplementation(async (_request: unknown, nativeDelegate: never) =>
        (nativeDelegate as (token: ReturnType<typeof fakeCancellationToken>) => Promise<void>)(
            fakeCancellationToken(),
        ),
    );
    openEditableDiffMock.mockImplementation(async (_request: unknown, nativeDelegate: never) =>
        (nativeDelegate as (token: ReturnType<typeof fakeCancellationToken>) => Promise<void>)(
            fakeCancellationToken(),
        ),
    );
});

describe("showStashDiffFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vscodeMock.workspace.textDocuments = [];
        vi.mocked(vscodeMock.workspace.fs.stat).mockResolvedValue(undefined);
        vi.mocked(vscodeMock.workspace.openTextDocument).mockResolvedValue({
            getText: () => "local file contents",
        });
    });

    it("opens one stash file with Local File on the left and Stash 2 on the right", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts", false);

        expect(gitOps.listStashes).toHaveBeenCalled();
        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "stash2hash");
        expect(gitOps.getStashFileContents).not.toHaveBeenCalled();
        expect(createReadonlyDiffUri).toHaveBeenCalledWith("src/a.ts", "stash", "Stash {2}");
        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "local file contents",
            "Local File",
        );
        expect(createReadonlyDiffUri).not.toHaveBeenCalledWith(
            "src/a.ts",
            "base",
            expect.any(String),
        );
        expect(vscodeMock.workspace.fs.stat).toHaveBeenCalledWith(
            expect.objectContaining({ path: "src/a.ts" }),
        );
        expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ path: "src/a.ts" }),
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
            { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
            "src/a.ts (Local File <-> Stash {2})",
            { preview: false },
        );
    });

    it("routes single-file stash diffs through the unified diff funnel with worktree-left, stash-hash-right sides", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts", false);

        expect(openUnifiedDiffMock).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "src/a.ts",
                left: { kind: "worktree" },
                right: expect.objectContaining({
                    kind: "provider",
                    identity: "stash2hash",
                    label: "Stash {2}",
                }),
            }),
            expect.any(Function),
        );
    });

    it("throws when the requested stash index is no longer present at that position", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.listStashes).mockResolvedValueOnce([]);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts")).rejects.toThrow(
            "Stash entry changed at index 2; refresh and try again.",
        );
        expect(gitOps.getFileContentAtRef).not.toHaveBeenCalled();
        expect(openUnifiedDiffMock).not.toHaveBeenCalled();
    });

    it("uses an explicitly labeled empty virtual document when the stashed side is absent", async () => {
        const gitOps = makeGitOps();
        const missingPathError = new Error("fatal: path 'src/a.ts' does not exist in 'stash2hash'");
        vi.mocked(gitOps.getFileContentAtRef).mockRejectedValue(missingPathError);

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "stash2hash");
        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "stash2hash^3");
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
            {
                filePath: "src/a.ts",
                content: "",
                ref: "Empty stashed file (missing: Stash {2})",
            },
            "src/a.ts (Local File <-> Stash {2})",
            { preview: true },
        );
    });

    it("shows a missing local file as an empty original before the stashed addition", async () => {
        const gitOps = makeGitOps();
        const missingFileError = new Error(
            "Unable to resolve nonexistent file 'file:///repo/src/a.ts'",
        );
        vi.mocked(vscodeMock.workspace.fs.stat).mockRejectedValueOnce(missingFileError);

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "", ref: "Empty local file (missing)" },
            { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
            "src/a.ts (Local File <-> Stash {2})",
            { preview: true },
        );
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it("treats the observed generic open error as a missing local file", async () => {
        const gitOps = makeGitOps();
        const missingFileError = new Error(
            "Unable to read file 'file:///repo/src/a.ts' (Error: Unable to resolve nonexistent file 'file:///repo/src/a.ts')",
        );
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce(missingFileError);

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(vscodeMock.workspace.fs.stat).toHaveBeenCalledWith(
            expect.objectContaining({ path: "src/a.ts" }),
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "", ref: "Empty local file (missing)" },
            { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
            "src/a.ts (Local File <-> Stash {2})",
            { preview: true },
        );
    });

    it("propagates unrelated local stat errors", async () => {
        const gitOps = makeGitOps();
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );
        vi.mocked(vscodeMock.workspace.fs.stat).mockRejectedValueOnce(permissionError);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts")).rejects.toBe(
            permissionError,
        );
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("propagates unrelated local open errors", async () => {
        const gitOps = makeGitOps();
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce(permissionError);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts")).rejects.toBe(
            permissionError,
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("opens every stash file from its snapshot to the current local document and keeps only a new tab", async () => {
        const gitOps = makeGitOps();
        const started: string[] = [];
        const resolvers = new Map<
            string,
            (contents: { before: string | undefined; after: string | undefined }) => void
        >();
        vi.mocked(gitOps.getStashFileContents).mockImplementation(
            async (_index, filePath) =>
                new Promise((resolve) => {
                    started.push(filePath);
                    resolvers.set(filePath, resolve);
                }),
        );

        const showDiff = showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined, false);

        await vi.waitFor(() => expect(started).toEqual(["src/a.ts", "new.txt"]));
        resolvers.get("new.txt")?.({ before: undefined, after: "new" });
        resolvers.get("src/a.ts")?.({ before: "base", after: "stash" });
        await showDiff;

        expect(gitOps.getStashFiles).toHaveBeenCalledWith(2);
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash {2}",
            [
                [
                    { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
                    { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
                    { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
                ],
                [
                    { filePath: "new.txt", content: "new", ref: "Stash {2}" },
                    { filePath: "new.txt", content: "local file contents", ref: "Local File" },
                    { filePath: "new.txt", content: "new", ref: "Stash {2}" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });

    it("uses labeled empty documents for missing stash and local sides in stash-wide diffs", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "gone.txt", status: "D", staged: false, additions: 0, deletions: 1 },
        ]);
        vi.mocked(gitOps.getStashFileContents).mockResolvedValueOnce({
            before: "must not be used",
            after: undefined,
        });
        vi.mocked(vscodeMock.workspace.fs.stat).mockRejectedValueOnce({
            code: "FileNotFound",
        });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash {2}",
            [
                [
                    {
                        filePath: "gone.txt",
                        content: "",
                        ref: "Empty stashed file (missing: Stash {2})",
                    },
                    {
                        filePath: "gone.txt",
                        content: "",
                        ref: "Empty local file (missing)",
                    },
                    {
                        filePath: "gone.txt",
                        content: "",
                        ref: "Empty stashed file (missing: Stash {2})",
                    },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });

    it("uses matching dirty local document text before stat or open for stash-wide diffs", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
        ]);
        vscodeMock.workspace.textDocuments = [
            {
                isDirty: true,
                getText: () => "unsaved local content",
                uri: { toString: () => "file:///repo/src/a.ts" },
            },
        ];

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash {2}",
            [
                [
                    { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
                    { filePath: "src/a.ts", content: "unsaved local content", ref: "Local File" },
                    { filePath: "src/a.ts", content: "stash", ref: "Stash {2}" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
        expect(vscodeMock.workspace.fs.stat).not.toHaveBeenCalled();
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it("propagates unrelated local-file errors without opening stash-wide changes", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
        ]);
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce(permissionError);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined)).rejects.toBe(
            permissionError,
        );
        expect(createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("does not register wide diff URIs when a later local read fails", async () => {
        const gitOps = makeGitOps();
        let finishFirstRead!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            finishFirstRead = resolve;
        });
        let rejectSecondRead!: (error: unknown) => void;
        const secondRead = new Promise<never>((_resolve, reject) => {
            rejectSecondRead = reject;
        });
        vi.mocked(vscodeMock.workspace.openTextDocument)
            .mockResolvedValueOnce({
                getText: () => {
                    finishFirstRead();
                    return "first local content";
                },
            })
            .mockReturnValueOnce(secondRead);
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );

        const showDiff = showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);
        await firstRead;
        rejectSecondRead(permissionError);

        await expect(showDiff).rejects.toBe(permissionError);
        expect(createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("never routes the whole-stash overview through the unified diff funnel", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);

        expect(openUnifiedDiffMock).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            expect.any(String),
            expect.any(Array),
        );
    });
});

describe("showDiffFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function deps() {
        return { getWorkspaceRoot: () => ({ scheme: "file", path: "/repo" }) };
    }

    it("opens an editable diff comparing HEAD to the working tree, never git.openChange's index-aware pair", async () => {
        await showDiffFromPanel(deps(), "src/a.ts");

        expect(openEditableDiffMock).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "src/a.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                fileUri: expect.objectContaining({ path: "src/a.ts" }),
            }),
            expect.any(Function),
            expect.any(Function),
        );
    });

    it("falls back to the exact prior git.openChange behavior when the viewer declines", async () => {
        await showDiffFromPanel(deps(), "src/a.ts");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "git.openChange",
            expect.objectContaining({ path: "src/a.ts" }),
        );
    });
});

describe("selectStashFromPanel", () => {
    it("does not resolve until its asynchronous panel update has been posted", async () => {
        const posted = Promise.withResolvers<void>();
        const postUpdate = vi.fn(() => posted.promise);
        const selection = selectStashFromPanel(stashSelectionDeps(postUpdate), 3);

        await vi.waitFor(() => expect(postUpdate).toHaveBeenCalledOnce());
        let resolved = false;
        void selection.then(() => {
            resolved = true;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        posted.resolve();
        await selection;
        expect(resolved).toBe(true);
    });

    it("keeps two sequential awaited stash selections in post order", async () => {
        const firstPost = Promise.withResolvers<void>();
        const secondPost = Promise.withResolvers<void>();
        const order: number[] = [];
        const postUpdate = vi.fn((message: { selectedStashIndex: number }) => {
            order.push(message.selectedStashIndex);
            return message.selectedStashIndex === 1 ? firstPost.promise : secondPost.promise;
        });
        const deps = stashSelectionDeps(postUpdate);
        const selections = (async () => {
            await selectStashFromPanel(deps, 1);
            await selectStashFromPanel(deps, 2);
        })();

        await vi.waitFor(() => expect(order).toEqual([1]));
        firstPost.resolve();
        await vi.waitFor(() => expect(order).toEqual([1, 2]));
        secondPost.resolve();
        await selections;
        expect(order).toEqual([1, 2]);
    });

    it("propagates a rejected post update without a later stale post", async () => {
        const rejection = new Error("whole-index predicate failed");
        const postUpdate = vi.fn(() => Promise.reject(rejection));

        await expect(selectStashFromPanel(stashSelectionDeps(postUpdate), 5)).rejects.toBe(
            rejection,
        );
        expect(postUpdate).toHaveBeenCalledOnce();
    });
});
