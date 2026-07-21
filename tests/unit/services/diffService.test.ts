import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";

const mocks = vi.hoisted(() => {
    class HoistedFakeUri {
        readonly path: string;
        readonly scheme: string;
        readonly query: string;

        constructor(
            public readonly fsPath: string,
            scheme = "file",
            path = fsPath,
            query = "",
        ) {
            this.scheme = scheme;
            this.path = path;
            this.query = query;
        }

        toString(): string {
            const encodedPath = this.path.split("/").map(encodeURIComponent).join("/");
            return `${this.scheme}:${encodedPath}${this.query ? `?${this.query}` : ""}`;
        }

        static file(fsPath: string): HoistedFakeUri {
            return new HoistedFakeUri(fsPath, "file");
        }

        static parse(value: string): HoistedFakeUri {
            const separator = value.indexOf(":");
            if (separator === -1) return new HoistedFakeUri(value, "file");
            const scheme = value.slice(0, separator);
            const rest = value.slice(separator + 1);
            const queryStart = rest.indexOf("?");
            const path = queryStart === -1 ? rest : rest.slice(0, queryStart);
            const query = queryStart === -1 ? "" : rest.slice(queryStart + 1);
            return new HoistedFakeUri(path, scheme, path, query);
        }

        static from(components: { scheme: string; path: string; query?: string }): HoistedFakeUri {
            return new HoistedFakeUri(
                components.path,
                components.scheme,
                components.path,
                components.query ?? "",
            );
        }
    }

    return {
        FakeUri: HoistedFakeUri,
        executeCommand: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
        showWarningMessage: vi.fn(),
        registerTextDocumentContentProvider: vi.fn(),
        onDidCloseTextDocument: vi.fn(),
        getCommitParentHashes: vi.fn(),
        pickMainlineParent: vi.fn(),
        buildCommitFilePatch: vi.fn(),
        runWithNotificationProgress: vi.fn(),
    };
});

vi.mock("vscode", () => ({
    Uri: mocks.FakeUri,
    env: { language: "en" },
    l10n: { t: interpolateL10n },
    commands: {
        executeCommand: mocks.executeCommand,
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
        showWarningMessage: mocks.showWarningMessage,
    },
    workspace: {
        registerTextDocumentContentProvider: mocks.registerTextDocumentContentProvider,
        onDidCloseTextDocument: mocks.onDidCloseTextDocument,
    },
}));

vi.mock("../../../src/services/gitHelpers", async () => {
    const actual = await vi.importActual<typeof import("../../../src/services/gitHelpers")>(
        "../../../src/services/gitHelpers",
    );
    return {
        ...actual,
        isValidGitHash: (value: string) => /^[0-9a-f]{7,40}$/i.test(value),
        getCommitParentHashes: mocks.getCommitParentHashes,
        pickMainlineParent: mocks.pickMainlineParent,
        buildCommitFilePatch: mocks.buildCommitFilePatch,
    };
});

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: mocks.runWithNotificationProgress,
    showTimedInformationMessage: mocks.showInformationMessage,
    showTimedWarningMessage: mocks.showWarningMessage,
}));

import {
    applySelectedCommitFileChange,
    compareCommitInfoFileWithLocal,
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
    createReadonlyDiffUri,
    openCommitFileDiff,
    registerReadonlyDiffContentProvider,
} from "../../../src/services/diffService";
import type { GitExecutor } from "../../../src/git/executor";
import type { GitOps } from "../../../src/git/operations";
import { EMPTY_TREE_HASH } from "../../../src/utils/constants";

function makeGitOps(): GitOps {
    return {
        getFileContentAtRef: vi.fn(async (filePath: string, ref: string) => `${ref}:${filePath}`),
        getBranches: vi.fn(async () => [
            { name: "main", hash: "aaa1111", isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
            { name: "feature", hash: "bbb2222", isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
        ]),
        getFileHistoryEntries: vi.fn(async () => []),
    } as unknown as GitOps;
}

function makeExecutor(): GitExecutor {
    return {
        run: vi.fn(async () => ""),
    } as unknown as GitExecutor;
}

describe("diffService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.executeCommand.mockResolvedValue(undefined);
        mocks.showErrorMessage.mockResolvedValue(undefined);
        mocks.showInformationMessage.mockResolvedValue(undefined);
        mocks.showQuickPick.mockResolvedValue(undefined);
        mocks.showInputBox.mockResolvedValue(undefined);
        mocks.showWarningMessage.mockResolvedValue(undefined);
        mocks.registerTextDocumentContentProvider.mockReturnValue({ dispose: vi.fn() });
        mocks.onDidCloseTextDocument.mockReturnValue({ dispose: vi.fn() });
        mocks.getCommitParentHashes.mockResolvedValue([]);
        mocks.pickMainlineParent.mockResolvedValue({ kind: "notMerge" });
        mocks.buildCommitFilePatch.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n");
        mocks.runWithNotificationProgress.mockImplementation(
            async (_message: string, task: () => Promise<void>) => task(),
        );
    });

    it("registers and disposes the readonly diff content provider", () => {
        const context = { subscriptions: [] as Array<{ dispose(): void }> };
        const registration = { dispose: vi.fn() };
        const closeListener = { dispose: vi.fn() };
        mocks.registerTextDocumentContentProvider.mockReturnValueOnce(registration);
        mocks.onDidCloseTextDocument.mockReturnValueOnce(closeListener);

        const disposable = registerReadonlyDiffContentProvider(context as never);
        disposable.dispose();

        expect(mocks.registerTextDocumentContentProvider).toHaveBeenCalledWith(
            "intelligit-diff",
            expect.objectContaining({ provideTextDocumentContent: expect.any(Function) }),
        );
        expect(registration.dispose).toHaveBeenCalled();
        expect(closeListener.dispose).toHaveBeenCalled();
        expect(context.subscriptions).toContain(disposable);
    });

    it("creates unique encoded virtual documents with JSON label queries and retained content", () => {
        const context = { subscriptions: [] as Array<{ dispose(): void }> };
        registerReadonlyDiffContentProvider(context as never);
        const provider = mocks.registerTextDocumentContentProvider.mock.calls[0][1] as {
            provideTextDocumentContent: (uri: { toString(): string }) => string;
        };

        const stashed = createReadonlyDiffUri(
            "src/nested dir/a#b?.ts",
            "stashed contents",
            "Stashed: stash@{2}",
        );
        const local = createReadonlyDiffUri(
            "src/nested dir/a#b?.ts",
            "local contents",
            "Local File",
        );

        expect(stashed.scheme).toBe("intelligit-diff");
        expect(stashed.path).toBe("/src/nested dir/a#b?.ts");
        expect(stashed.toString()).toContain("/src/nested%20dir/a%23b%3F.ts");
        expect(stashed.toString()).not.toContain("%2520");
        expect(JSON.parse(stashed.query)).toEqual({
            id: expect.any(String),
            ref: "Stashed: stash@{2}",
        });
        expect(JSON.parse(local.query)).toEqual({ id: expect.any(String), ref: "Local File" });
        expect(stashed.toString()).not.toBe(local.toString());
        expect(provider.provideTextDocumentContent(stashed)).toBe("stashed contents");
        expect(provider.provideTextDocumentContent(local)).toBe("local contents");
    });

    it("opens a root-commit file diff against the empty tree", async () => {
        const gitOps = makeGitOps();
        const executor = makeExecutor();
        const commitHash = "abcdef1234567890";

        await openCommitFileDiff(commitHash, "src/a.ts", "/repo", gitOps, executor);

        expect(mocks.getCommitParentHashes).toHaveBeenCalledWith(commitHash, executor);
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(1, "src/a.ts", EMPTY_TREE_HASH);
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(2, "src/a.ts", commitHash);
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(mocks.FakeUri),
            expect.any(mocks.FakeUri),
            expect.stringContaining("src/a.ts"),
        );
        const [leftUri, rightUri] = mocks.executeCommand.mock.calls[0].slice(1, 3) as [
            { query: string },
            { query: string },
        ];
        expect(JSON.parse(leftUri.query).ref).toBe(EMPTY_TREE_HASH.slice(0, 8));
        expect(JSON.parse(rightUri.query).ref).toBe(commitHash.slice(0, 8));
    });

    it("uses the selected mainline parent for merge commit file diffs", async () => {
        const gitOps = makeGitOps();
        const executor = makeExecutor();
        const commitHash = "abcdef1234567890";
        mocks.getCommitParentHashes.mockResolvedValueOnce(["11111111", "22222222"]);
        mocks.pickMainlineParent.mockResolvedValueOnce({ kind: "selected", parentNumber: 2 });

        await openCommitFileDiff(commitHash, "src/a.ts", "/repo", gitOps, executor);

        expect(mocks.pickMainlineParent).toHaveBeenCalledWith(
            commitHash,
            "Open Commit File Diff",
            executor,
            ["11111111", "22222222"],
        );
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(1, "src/a.ts", `${commitHash}^2`);
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(2, "src/a.ts", commitHash);
    });

    it("compares an editor file with a selected branch", async () => {
        const gitOps = makeGitOps();
        mocks.showQuickPick.mockImplementationOnce(async (items: Array<{ refName: string }>) =>
            items.find((item) => item.refName === "feature"),
        );

        await compareEditorFileWithBranch(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);

        expect(gitOps.getBranches).toHaveBeenCalled();
        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "feature");
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(mocks.FakeUri),
            expect.any(mocks.FakeUri),
            "src/a.ts (branch: feature) <-> Working Tree",
        );
        const [leftUri] = mocks.executeCommand.mock.calls[0].slice(1, 2) as [{ query: string }];
        expect(JSON.parse(leftUri.query).ref).toBe("feature");
    });

    it("compares an editor file with a manually entered revision", async () => {
        const gitOps = makeGitOps();
        mocks.showQuickPick.mockImplementationOnce(async (items: Array<{ refName: string }>) =>
            items[items.length - 1],
        );
        mocks.showInputBox.mockResolvedValueOnce("HEAD~1");

        await compareEditorFileWithRevision(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);

        expect(gitOps.getFileHistoryEntries).toHaveBeenCalledWith("src/a.ts", 20);
        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "HEAD~1");
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(mocks.FakeUri),
            expect.any(mocks.FakeUri),
            "src/a.ts (revision: HEAD~1) <-> Working Tree",
        );
    });

    it("compares a commit-info file against the local working tree", async () => {
        const gitOps = makeGitOps();

        await compareCommitInfoFileWithLocal(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890" },
            "/repo",
            gitOps,
        );

        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "abcdef1234567890");
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(mocks.FakeUri),
            expect.any(mocks.FakeUri),
            "src/a.ts (revision: abcdef1234567890) <-> Working Tree",
        );
    });

    it("applies and reverts selected commit-file patches through git apply", async () => {
        const executor = makeExecutor();
        const refreshConflictUi = vi.fn(async () => undefined);
        mocks.showWarningMessage
            .mockResolvedValueOnce("Apply Change")
            .mockResolvedValueOnce("Revert Change");

        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890", commitShortHash: "abcdef12" },
            "cherry-pick",
            executor,
            refreshConflictUi,
        );
        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890", commitShortHash: "abcdef12" },
            "revert",
            executor,
            refreshConflictUi,
        );

        expect(mocks.buildCommitFilePatch).toHaveBeenCalledWith(
            "abcdef1234567890",
            "src/a.ts",
            "Cherry-pick Selected Change",
            executor,
        );
        expect(executor.run).toHaveBeenNthCalledWith(
            1,
            expect.arrayContaining(["apply", "--index", "--3way", "--whitespace=nowarn"]),
        );
        expect(executor.run).toHaveBeenNthCalledWith(
            2,
            expect.arrayContaining(["apply", "--index", "--3way", "--whitespace=nowarn", "-R"]),
        );
        expect(refreshConflictUi).toHaveBeenCalledTimes(2);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "Applied selected change from abcdef12 for src/a.ts.",
        );
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "Reverted selected change from abcdef12 for src/a.ts.",
        );
    });

    it("surfaces invalid file diff and patch errors", async () => {
        const gitOps = makeGitOps();
        await expect(
            openCommitFileDiff("not-a-hash", "src/a.ts", "/repo", gitOps, makeExecutor()),
        ).rejects.toThrow("Invalid commit hash received for file diff action.");

        const executor = makeExecutor();
        const refreshConflictUi = vi.fn(async () => undefined);
        mocks.showWarningMessage.mockResolvedValueOnce("Apply Change");
        mocks.buildCommitFilePatch.mockRejectedValueOnce(new Error("patch failed"));

        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890", commitShortHash: "abcdef12" },
            "cherry-pick",
            executor,
            refreshConflictUi,
        );

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Cherry-pick selected change failed: patch failed",
        );
        expect(refreshConflictUi).toHaveBeenCalled();
    });

    it("cleans readonly diff documents when matching virtual documents close", () => {
        const context = { subscriptions: [] as Array<{ dispose(): void }> };
        let closeListener: ((document: { uri: { scheme: string; toString(): string } }) => void) | undefined;
        mocks.onDidCloseTextDocument.mockImplementationOnce((listener) => {
            closeListener = listener as typeof closeListener;
            return { dispose: vi.fn() };
        });

        registerReadonlyDiffContentProvider(context as never);
        const provider = mocks.registerTextDocumentContentProvider.mock.calls[0][1] as {
            provideTextDocumentContent: (uri: { toString(): string }) => string;
        };
        const gitOps = makeGitOps();

        return compareCommitInfoFileWithLocal(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890" },
            "/repo",
            gitOps,
        ).then(() => {
            const leftUri = mocks.executeCommand.mock.calls[0][1] as { scheme: string; toString(): string };
            expect(provider.provideTextDocumentContent(leftUri)).toBe("abcdef1234567890:src/a.ts");

            closeListener?.({ uri: { scheme: "file", toString: () => leftUri.toString() } });
            expect(provider.provideTextDocumentContent(leftUri)).toBe("abcdef1234567890:src/a.ts");

            closeListener?.({ uri: leftUri });
            expect(provider.provideTextDocumentContent(leftUri)).toBe("");
        });
    });

    it("skips merge commit diffs when mainline selection is cancelled or unavailable", async () => {
        const gitOps = makeGitOps();
        const executor = makeExecutor();
        const commitHash = "abcdef1234567890";
        mocks.getCommitParentHashes.mockResolvedValue(["11111111", "22222222"]);
        mocks.pickMainlineParent.mockResolvedValueOnce({ kind: "cancelled" });

        await openCommitFileDiff(commitHash, "src/a.ts", "/repo", gitOps, executor);
        expect(mocks.executeCommand).not.toHaveBeenCalled();

        mocks.pickMainlineParent.mockResolvedValueOnce({ kind: "notMerge" });
        await openCommitFileDiff(commitHash, "src/a.ts", "/repo", gitOps, executor);
        expect(mocks.executeCommand).not.toHaveBeenCalled();
    });

    it("opens commit diffs with empty content when parent or commit file content is unavailable", async () => {
        const gitOps = makeGitOps();
        const executor = makeExecutor();
        const commitHash = "abcdef1234567890";
        (gitOps.getFileContentAtRef as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error("parent missing"))
            .mockRejectedValueOnce(new Error("commit missing"));
        mocks.getCommitParentHashes.mockResolvedValueOnce(["11111111"]);

        await openCommitFileDiff(commitHash, "src/a.ts", "/repo", gitOps, executor);

        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(mocks.FakeUri),
            expect.any(mocks.FakeUri),
            "src/a.ts (11111111 ↔ abcdef12)",
        );
    });

    it("handles compare-with-branch unavailable, outside-workspace, cancellation, and command errors", async () => {
        const gitOps = makeGitOps();

        await compareEditorFileWithBranch(undefined, "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Compare with Branch is only available for local files.",
        );

        await compareEditorFileWithBranch(mocks.FakeUri.file("/elsewhere/src/a.ts"), "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Selected file is outside the current IntelliGit repository workspace.",
        );

        mocks.showQuickPick.mockResolvedValueOnce(undefined);
        await compareEditorFileWithBranch(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);
        expect(gitOps.getFileContentAtRef).not.toHaveBeenCalled();

        (gitOps.getBranches as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("branches failed"));
        await compareEditorFileWithBranch(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Compare with branch failed: branches failed",
        );
    });

    it("handles compare-with-revision picks, blank manual input, unavailable files, and errors", async () => {
        const gitOps = makeGitOps();

        await compareEditorFileWithRevision(undefined, "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Compare with Revision is only available for local files.",
        );

        await compareEditorFileWithRevision(mocks.FakeUri.file("/elsewhere/src/a.ts"), "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Selected file is outside the current IntelliGit repository workspace.",
        );

        (gitOps.getFileHistoryEntries as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            {
                hash: "abcdef1234567890",
                shortHash: "abcdef12",
                subject: "",
                author: "Mahesh",
                date: "2026-06-04",
            },
        ]);
        mocks.showQuickPick.mockImplementationOnce(async (items: Array<{ refName: string }>) => items[0]);
        await compareEditorFileWithRevision(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);
        expect(gitOps.getFileContentAtRef).toHaveBeenCalledWith("src/a.ts", "abcdef1234567890");

        mocks.showQuickPick.mockImplementationOnce(async (items: Array<{ refName: string }>) =>
            items[items.length - 1],
        );
        mocks.showInputBox.mockResolvedValueOnce("   ");
        await compareEditorFileWithRevision(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);

        (gitOps.getFileHistoryEntries as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("history failed"),
        );
        await compareEditorFileWithRevision(mocks.FakeUri.file("/repo/src/a.ts"), "/repo", gitOps);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Compare with revision failed: history failed",
        );
    });

    it("handles commit-info and selected-change malformed or cancelled payloads", async () => {
        const gitOps = makeGitOps();
        const executor = makeExecutor();
        const refreshConflictUi = vi.fn(async () => {
            throw new Error("refresh failed");
        });

        await compareCommitInfoFileWithLocal(undefined, "/repo", gitOps);
        expect(mocks.executeCommand).not.toHaveBeenCalled();

        await compareCommitInfoFileWithLocal(
            { filePath: "../secret.txt", commitHash: "abcdef1234567890" },
            "/repo",
            gitOps,
        );
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Compare with local failed:"),
        );

        await applySelectedCommitFileChange(undefined, "cherry-pick", executor, refreshConflictUi);
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();

        mocks.showWarningMessage.mockResolvedValueOnce("Cancel");
        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890" },
            "cherry-pick",
            executor,
            refreshConflictUi,
        );
        expect(mocks.buildCommitFilePatch).not.toHaveBeenCalled();

        mocks.showWarningMessage.mockResolvedValueOnce("Apply Change");
        mocks.buildCommitFilePatch.mockResolvedValueOnce(null);
        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890" },
            "cherry-pick",
            executor,
            refreshConflictUi,
        );
        expect(refreshConflictUi).toHaveBeenCalled();

        mocks.showWarningMessage.mockResolvedValueOnce("Apply Change");
        mocks.buildCommitFilePatch.mockResolvedValueOnce("   ");
        await applySelectedCommitFileChange(
            { filePath: "src/a.ts", commitHash: "abcdef1234567890" },
            "cherry-pick",
            executor,
            refreshConflictUi,
        );
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "No file-level patch found for src/a.ts in abcdef12.",
        );
    });
});
