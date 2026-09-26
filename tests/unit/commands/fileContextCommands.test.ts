import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => {
    class FakeUri {
        readonly scheme: string;

        constructor(
            readonly fsPath: string,
            scheme = "file",
        ) {
            this.scheme = scheme;
        }

        static file(fsPath: string): FakeUri {
            return new FakeUri(fsPath);
        }

        toString(): string {
            return `${this.scheme}:${this.fsPath}`;
        }
    }
    return {
        FakeUri,
        activeUri: FakeUri.file("/repo-a/active.ts") as FakeUri | undefined,
        textDocuments: [] as Array<{
            uri: FakeUri;
            isDirty: boolean;
            getText: () => string;
        }>,
        realpath: vi.fn(async (value: string) => value),
        lstat: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => false })),
        getActiveOperation: vi.fn(async () => "none"),
        hasWholeIndexOperationInProgress: vi.fn(async () => false),
        getStatus: vi.fn(async (): Promise<Array<{ path: string; status: string }>> => []),
        showInputBox: vi.fn(async (_options: unknown): Promise<string | undefined> => "message"),
        executorRoots: [] as string[],
        executorRun: vi.fn(async () => "/repo-b\n"),
        executorRunBinary: vi.fn(async () => ({
            stdout: Buffer.from("annotated source\n"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: false,
        })),
        compareEditorFileWithBranch: vi.fn(async () => undefined),
        compareEditorFileWithRevision: vi.fn(async () => undefined),
        createReadonlyDiffUri: vi.fn(() => ({ scheme: "intelligit-diff", path: "/selected.ts" })),
        fetch: vi.fn(async () => undefined),
        getFileContentAtRef: vi.fn(async () => "committed HEAD content"),
        hasFileAtHead: vi.fn(async () => true),
        rollbackFiles: vi.fn(async () => undefined),
        showEditorFileDiff: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
        showInformationMessage: vi.fn(async () => undefined),
        showTextDocument: vi.fn(async () => undefined),
        showWarningMessage: vi.fn(
            async (_message?: string, _options?: unknown, ...items: string[]) => items[0],
        ),
        withProgress: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath, lstat: mocks.lstat }));
vi.mock("vscode", () => ({
    Uri: mocks.FakeUri,
    window: {
        get activeTextEditor() {
            return mocks.activeUri ? { document: { uri: mocks.activeUri } } : undefined;
        },
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
        showTextDocument: mocks.showTextDocument,
        showWarningMessage: mocks.showWarningMessage,
        showInputBox: mocks.showInputBox,
        withProgress: mocks.withProgress,
    },
    ProgressLocation: { Notification: 15 },
    workspace: {
        get textDocuments() {
            return mocks.textDocuments;
        },
    },
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            Object.entries(args ?? {}).reduce(
                (rendered, [key, value]) => rendered.replace(`{${key}}`, value),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.executorRun;
        runBinary = mocks.executorRunBinary;

        constructor(repoRoot: string) {
            mocks.executorRoots.push(repoRoot);
        }
    },
}));
vi.mock("../../../src/services/diffService", () => ({
    compareEditorFileWithBranch: mocks.compareEditorFileWithBranch,
    compareEditorFileWithRevision: mocks.compareEditorFileWithRevision,
    createReadonlyDiffUri: mocks.createReadonlyDiffUri,
    showEditorFileDiff: mocks.showEditorFileDiff,
}));

import {
    annotateWithGitBlame,
    commitFileFromContext,
    compareFileWithBranchOrTag,
    compareFileWithRevision,
    fetchFile,
    pullFileRepositoryFromContext,
    pushFileRepositoryFromContext,
    rollbackFile,
    showCurrentRevision,
    showFileDiff,
} from "../../../src/commands/fileContextCommands";

const makeGitOps = (): GitOps =>
    ({
        deriveFor: vi.fn(
            () =>
                ({
                    scope: "selected",
                    fetch: mocks.fetch,
                    getFileContentAtRef: mocks.getFileContentAtRef,
                    hasFileAtHead: mocks.hasFileAtHead,
                    rollbackFiles: mocks.rollbackFiles,
                    getActiveOperation: mocks.getActiveOperation,
                    hasWholeIndexOperationInProgress: mocks.hasWholeIndexOperationInProgress,
                    getStatus: mocks.getStatus,
                }) as unknown as GitOps,
        ),
    }) as unknown as GitOps;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = mocks.FakeUri.file("/repo-a/active.ts");
    mocks.textDocuments.length = 0;
    mocks.executorRoots.length = 0;
    mocks.realpath.mockImplementation(async (value: string) => value);
    mocks.lstat.mockReset().mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
    mocks.getActiveOperation.mockReset().mockResolvedValue("none");
    mocks.hasWholeIndexOperationInProgress.mockReset().mockResolvedValue(false);
    mocks.getStatus.mockReset().mockResolvedValue([]);
    mocks.showInputBox.mockReset().mockResolvedValue("message");
    mocks.executorRun.mockResolvedValue("/repo-b\n");
    mocks.executorRunBinary.mockResolvedValue({
        stdout: Buffer.from("annotated source\n"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        truncated: false,
    });
});

describe("commitFileFromContext", () => {
    it("prompts for the clicked repository file and preserves a nonempty message", async () => {
        const gitOps = makeGitOps();
        const runCommit = vi.fn(async () => undefined);
        mocks.showInputBox.mockResolvedValueOnce("  Keep my message  ");

        await commitFileFromContext(
            mocks.FakeUri.file("/repo-b/nested/file.ts"),
            gitOps,
            runCommit,
        );

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Commit File: nested/file.ts",
                prompt: "Press Enter to commit only nested/file.ts. Escape to cancel.",
                placeHolder: "Enter a commit message.",
            }),
        );
        const options = mocks.showInputBox.mock.calls[0][0] as {
            validateInput: (value: string) => string | undefined;
        };
        expect(options.validateInput(" \n ")).toBe("Enter a commit message.");
        expect(options.validateInput("a message")).toBeUndefined();
        expect(runCommit).toHaveBeenCalledWith(
            expect.objectContaining({ scope: "selected" }),
            "/repo-b",
            "nested/file.ts",
            "  Keep my message  ",
        );
    });

    it("uses the captured active editor only for absent context", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.activeUri = mocks.FakeUri.file("/repo-b/active.ts");
        mocks.showInputBox.mockImplementationOnce(async () => {
            mocks.activeUri = mocks.FakeUri.file("/repo-a/other.ts");
            return "message";
        });

        await commitFileFromContext(undefined, makeGitOps(), runCommit);

        expect(runCommit).toHaveBeenCalledWith(
            expect.anything(),
            "/repo-b",
            "active.ts",
            "message",
        );
    });

    it.each([null, {}, new mocks.FakeUri("/repo-b/file.ts", "untitled")])(
        "rejects explicit invalid context %j instead of using the active editor",
        async (ctx) => {
            const gitOps = makeGitOps();
            const runCommit = vi.fn(async () => undefined);
            await commitFileFromContext(ctx, gitOps, runCommit);
            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.showInputBox).not.toHaveBeenCalled();
            expect(runCommit).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "Commit is only available for local files.",
            );
        },
    );

    it("rejects a directory rather than committing a recursive tree", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.lstat.mockResolvedValueOnce({ isFile: () => false, isSymbolicLink: () => false });
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/nested"), makeGitOps(), runCommit);
        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Commit is only available for local files.",
        );
    });

    it("accepts a deleted file only when current status names that exact path", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.lstat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
        mocks.getStatus.mockResolvedValue([{ path: "deleted.ts", status: "D" }]);
        await commitFileFromContext(
            mocks.FakeUri.file("/repo-b/deleted.ts"),
            makeGitOps(),
            runCommit,
        );
        expect(runCommit).toHaveBeenCalledWith(
            expect.anything(),
            "/repo-b",
            "deleted.ts",
            "message",
        );
    });

    it("rejects a missing directory even when it contains tracked deleted files", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.lstat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
        mocks.getStatus.mockResolvedValue([{ path: "deleted/file.ts", status: "D" }]);
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/deleted"), makeGitOps(), runCommit);
        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Commit is only available for local files.",
        );
    });

    it("rejects a file replaced by a directory while the input is open", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.lstat
            .mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => false })
            .mockResolvedValueOnce({ isFile: () => false, isSymbolicLink: () => false });
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/file.ts"), makeGitOps(), runCommit);
        expect(mocks.showInputBox).toHaveBeenCalledTimes(1);
        expect(runCommit).not.toHaveBeenCalled();
    });

    it.each([undefined, "", " \n "])(
        "does nothing after cancelled or blank input %j",
        async (message) => {
            const runCommit = vi.fn(async () => undefined);
            mocks.showInputBox.mockResolvedValueOnce(message);
            await commitFileFromContext(
                mocks.FakeUri.file("/repo-b/file.ts"),
                makeGitOps(),
                runCommit,
            );
            expect(runCommit).not.toHaveBeenCalled();
            expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        },
    );

    it.each(["before", "during"])("rejects selected buffer dirtied %s the prompt", async (when) => {
        const clicked = mocks.FakeUri.file("/repo-b/file.ts");
        const runCommit = vi.fn(async () => undefined);
        const makeDirty = () =>
            mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "unsaved" });
        if (when === "before") makeDirty();
        else
            mocks.showInputBox.mockImplementationOnce(async () => {
                makeDirty();
                return "message";
            });
        await commitFileFromContext(clicked, makeGitOps(), runCommit);
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Save file.ts before committing.");
        expect(mocks.showInputBox).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    });

    it("rejects a dirty symlink-parent alias of the selected file", async () => {
        mocks.textDocuments.push({
            uri: mocks.FakeUri.file("/alias/file.ts"),
            isDirty: true,
            getText: () => "unsaved",
        });
        mocks.realpath.mockImplementation(async (value) =>
            value === "/alias" ? "/repo-b" : value,
        );
        const runCommit = vi.fn(async () => undefined);
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/file.ts"), makeGitOps(), runCommit);
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showInputBox).not.toHaveBeenCalled();
    });

    it.each(["before", "during"])("rejects a Git operation started %s the prompt", async (when) => {
        const runCommit = vi.fn(async () => undefined);
        if (when === "before") mocks.getActiveOperation.mockResolvedValueOnce("merge");
        else mocks.getActiveOperation.mockResolvedValueOnce("none").mockResolvedValueOnce("merge");
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/file.ts"), makeGitOps(), runCommit);
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "A merge is in progress — resolve or abort it first.",
        );
        expect(mocks.showInputBox).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    });

    it("reports commit failures without claiming success", async () => {
        const runCommit = vi.fn(async () => {
            throw new Error("hook refused");
        });
        await commitFileFromContext(mocks.FakeUri.file("/repo-b/file.ts"), makeGitOps(), runCommit);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Commit failed: hook refused");
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("fails closed when the complete operation-marker check cannot be read", async () => {
        const runCommit = vi.fn(async () => undefined);
        mocks.hasWholeIndexOperationInProgress.mockRejectedValueOnce(
            new Error("marker unreadable"),
        );

        await commitFileFromContext(mocks.FakeUri.file("/repo-b/file.ts"), makeGitOps(), runCommit);

        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(runCommit).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Commit failed: marker unreadable");
    });
});

describe("fetchFile", () => {
    it("retains missing-parent rejection for commands that do not opt into deleted-file resolution", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockRejectedValueOnce(
            Object.assign(new Error("missing parent"), { code: "ENOENT" }),
        );

        await fetchFile(mocks.FakeUri.file("/repo-b/missing/file.ts"), gitOps);

        expect(mocks.realpath).toHaveBeenCalledExactlyOnceWith("/repo-b/missing");
        expect(mocks.executorRun).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Fetch failed: missing parent");
    });

    it("fetches through GitOps derived for the clicked file repository and returns that root", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file.ts");

        const fetchedRoot = await fetchFile(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.withProgress).toHaveBeenCalledWith(
            { location: 15, title: "IntelliGit: Fetching...", cancellable: false },
            expect.any(Function),
        );
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Fetched successfully.");
        expect(fetchedRoot).toBe("/repo-b");
    });

    it("rejects an explicit non-file context without fetching or borrowing the active editor", async () => {
        const gitOps = makeGitOps();

        const fetchedRoot = await fetchFile(
            new mocks.FakeUri("untitled:file.ts", "untitled"),
            gitOps,
        );

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Fetch is only available for local files.",
        );
        expect(fetchedRoot).toBeUndefined();
    });

    it("reports fetch failures without success or a refreshable repository root", async () => {
        const gitOps = makeGitOps();
        mocks.fetch.mockRejectedValueOnce(new Error("network unavailable"));

        const fetchedRoot = await fetchFile(mocks.FakeUri.file("/repo-b/file.ts"), gitOps);

        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Fetch failed: network unavailable");
        expect(fetchedRoot).toBeUndefined();
    });
});

describe("pullFileRepositoryFromContext", () => {
    it("runs Pull with GitOps derived for the selected file repository and its canonical root", async () => {
        const gitOps = makeGitOps();
        const runPull = vi.fn(async () => undefined);
        const clicked = mocks.FakeUri.file("/repo-b/nested/file.ts");

        await pullFileRepositoryFromContext(clicked, gitOps, runPull);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(runPull).toHaveBeenCalledWith(
            expect.objectContaining({ scope: "selected" }),
            "/repo-b",
        );
    });

    it("rejects a non-file context without deriving GitOps or running Pull", async () => {
        const gitOps = makeGitOps();
        const runPull = vi.fn(async () => undefined);

        await pullFileRepositoryFromContext(
            new mocks.FakeUri("untitled:file.ts", "untitled"),
            gitOps,
            runPull,
        );

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(runPull).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Pull is only available for local files.",
        );
    });

    it("reports callback failures without leaking them to the command host", async () => {
        const gitOps = makeGitOps();
        const runPull = vi.fn(async () => {
            throw new Error("network unavailable");
        });

        await expect(
            pullFileRepositoryFromContext(mocks.FakeUri.file("/repo-b/file.ts"), gitOps, runPull),
        ).resolves.toBeUndefined();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Pull failed: network unavailable");
    });
});

describe("pushFileRepositoryFromContext", () => {
    it("runs Push with GitOps derived for the selected file repository and its canonical root", async () => {
        const gitOps = makeGitOps();
        const runPush = vi.fn(async () => undefined);
        const clicked = mocks.FakeUri.file("/repo-b/nested/file.ts");

        await pushFileRepositoryFromContext(clicked, gitOps, runPush);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(runPush).toHaveBeenCalledWith(
            expect.objectContaining({ scope: "selected" }),
            "/repo-b",
        );
    });

    it("rejects a non-file context without deriving GitOps or running Push", async () => {
        const gitOps = makeGitOps();
        const runPush = vi.fn(async () => undefined);

        await pushFileRepositoryFromContext(
            new mocks.FakeUri("untitled:file.ts", "untitled"),
            gitOps,
            runPush,
        );

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(runPush).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Push is only available for local files.",
        );
    });

    it("reports callback failures without leaking them to the command host", async () => {
        const gitOps = makeGitOps();
        const runPush = vi.fn(async () => {
            throw new Error("network unavailable");
        });

        await expect(
            pushFileRepositoryFromContext(mocks.FakeUri.file("/repo-b/file.ts"), gitOps, runPush),
        ).resolves.toBeUndefined();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Push failed: network unavailable");
    });
});

describe("rollbackFile", () => {
    it("confirms the exact clicked tracked path and rolls back only that path", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file with spaces.ts");

        await rollbackFile(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.hasFileAtHead).toHaveBeenCalledWith("nested/file with spaces.ts");
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "Rollback nested/file with spaces.ts?",
            { modal: true },
            "Rollback",
        );
        expect(mocks.rollbackFiles).toHaveBeenCalledWith(["nested/file with spaces.ts"]);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "Rolled back nested/file with spaces.ts.",
        );
    });

    it("uses the active editor when the context is undefined", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await rollbackFile(undefined, gitOps);

        expect(mocks.hasFileAtHead).toHaveBeenCalledWith("src/active.ts");
        expect(mocks.rollbackFiles).toHaveBeenCalledWith(["src/active.ts"]);
    });

    it("does not roll back or report success when confirmation is cancelled", async () => {
        const gitOps = makeGitOps();
        mocks.showWarningMessage.mockResolvedValueOnce(undefined);

        await rollbackFile(mocks.FakeUri.file("/repo-b/src/cancelled.ts"), gitOps);

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "Rollback src/cancelled.ts?",
            { modal: true },
            "Rollback",
        );
        expect(mocks.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("rejects a dirty open buffer before checking HEAD or showing confirmation", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/dirty.ts");
        mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "unsaved" });

        await rollbackFile(clicked, gitOps);

        expect(mocks.hasFileAtHead).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(mocks.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Save or discard unsaved changes to src/dirty.ts before rolling it back.",
        );
    });

    it("rejects a dirty buffer opened through a symlink alias of the selected file", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/dirty.ts");
        const alias = mocks.FakeUri.file("/linked/repo-b/src/dirty.ts");
        mocks.textDocuments.push({ uri: alias, isDirty: true, getText: () => "unsaved" });
        mocks.realpath.mockImplementation(async (value: string) =>
            value === "/linked/repo-b/src" ? "/repo-b/src" : value,
        );

        await rollbackFile(clicked, gitOps);

        expect(mocks.hasFileAtHead).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(mocks.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Save or discard unsaved changes to src/dirty.ts before rolling it back.",
        );
    });

    it("rejects an untracked or staged-new path before confirmation", async () => {
        const gitOps = makeGitOps();
        mocks.hasFileAtHead.mockResolvedValueOnce(false);

        await rollbackFile(mocks.FakeUri.file("/repo-b/new.ts"), gitOps);

        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(mocks.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Cannot roll back new.ts because it does not exist in HEAD.",
        );
    });

    it("reports rollback failures for the selected path", async () => {
        const gitOps = makeGitOps();
        mocks.rollbackFiles.mockRejectedValueOnce(new Error("checkout failed"));

        await rollbackFile(mocks.FakeUri.file("/repo-b/src/a.ts"), gitOps);

        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Rollback failed for src/a.ts: checkout failed",
        );
    });
});

describe("compareFileWithRevision", () => {
    it("uses an inactive clicked tab's repository instead of the active editor and graph", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file with spaces.ts");

        await compareFileWithRevision(clicked, gitOps);

        expect(mocks.executorRoots).toEqual(["/repo-b/nested"]);
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.compareEditorFileWithRevision).toHaveBeenCalledWith(
            clicked,
            "/repo-b",
            expect.objectContaining({ scope: "selected" }),
            "nested/file with spaces.ts",
        );
    });

    it("uses the active editor only when the command context is undefined", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await compareFileWithRevision(undefined, gitOps);

        expect(mocks.compareEditorFileWithRevision).toHaveBeenCalledWith(
            mocks.activeUri,
            "/repo-b",
            expect.anything(),
            "src/active.ts",
        );
    });

    it.each([
        { fsPath: "/repo-b/not-a-uri.ts" },
        new mocks.FakeUri("untitled:file.ts", "untitled"),
    ])("rejects explicit invalid context %o instead of falling back", async (context) => {
        const gitOps = makeGitOps();

        await compareFileWithRevision(context, gitOps);

        expect(mocks.realpath).not.toHaveBeenCalled();
        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.compareEditorFileWithRevision).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("reports repository discovery errors without invoking the comparison", async () => {
        const gitOps = makeGitOps();
        mocks.executorRun.mockRejectedValueOnce(new Error("not a repository"));

        await compareFileWithRevision(mocks.FakeUri.file("/outside/file.ts"), gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.compareEditorFileWithRevision).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Compare with revision failed: not a repository",
        );
    });

    it("uses the canonical parent for linked repositories while retaining the clicked URI", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/src");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        const clicked = mocks.FakeUri.file("/linked/repo/src/file.ts");

        await compareFileWithRevision(clicked, gitOps);

        expect(mocks.executorRoots).toEqual(["/private/repo/src"]);
        expect(mocks.compareEditorFileWithRevision).toHaveBeenCalledWith(
            clicked,
            "/private/repo",
            expect.anything(),
            "src/file.ts",
        );
    });

    it("retains the clicked URI when the active editor changes during discovery", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/file.ts");
        mocks.realpath.mockImplementationOnce(async (value: string) => {
            mocks.activeUri = mocks.FakeUri.file("/repo-c/switched.ts");
            return value;
        });

        await compareFileWithRevision(clicked, gitOps);

        expect(mocks.compareEditorFileWithRevision).toHaveBeenCalledWith(
            clicked,
            "/repo-b",
            expect.anything(),
            "file.ts",
        );
    });
});

describe("compareFileWithBranchOrTag", () => {
    it("uses the clicked file's repository instead of the active graph repository", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file with spaces.ts");

        await compareFileWithBranchOrTag(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.compareEditorFileWithBranch).toHaveBeenCalledWith(
            clicked,
            "/repo-b",
            expect.objectContaining({ scope: "selected" }),
            "nested/file with spaces.ts",
        );
    });
});

describe("showFileDiff", () => {
    it("compares the clicked file's HEAD with its original working document in the owning repository", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/nested");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        const clicked = mocks.FakeUri.file("/linked/repo/nested/file with spaces.ts");

        await showFileDiff(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/private/repo");
        expect(mocks.showEditorFileDiff).toHaveBeenCalledWith(
            clicked,
            "/private/repo",
            expect.objectContaining({ scope: "selected" }),
            "nested/file with spaces.ts",
        );
    });

    it("rejects an explicit malformed context instead of diffing the active editor", async () => {
        const gitOps = makeGitOps();

        await showFileDiff({ fsPath: "/repo-b/not-a-uri.ts" }, gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.showEditorFileDiff).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show Diff is only available for local files.",
        );
    });

    it("uses the active editor only when no command context is supplied", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await showFileDiff(undefined, gitOps);

        expect(mocks.showEditorFileDiff).toHaveBeenCalledWith(
            mocks.activeUri,
            "/repo-b",
            expect.anything(),
            "src/active.ts",
        );
    });

    it("reports repository discovery failures without opening a diff", async () => {
        const gitOps = makeGitOps();
        mocks.executorRun.mockRejectedValueOnce(new Error("not a repository"));

        await showFileDiff(mocks.FakeUri.file("/outside/file.ts"), gitOps);

        expect(mocks.showEditorFileDiff).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Show Diff failed: not a repository");
    });
});

describe("showCurrentRevision", () => {
    it("opens the clicked file's immutable HEAD content from its owning repository", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/nested");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        const clicked = mocks.FakeUri.file("/linked/repo/nested/selected.ts");
        const readonlyUri = { scheme: "intelligit-diff", path: "/nested/selected.ts" };
        mocks.createReadonlyDiffUri.mockReturnValueOnce(readonlyUri);

        await showCurrentRevision(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/private/repo");
        expect(mocks.getFileContentAtRef).toHaveBeenCalledWith("nested/selected.ts", "HEAD");
        expect(mocks.createReadonlyDiffUri).toHaveBeenCalledWith(
            "nested/selected.ts",
            "committed HEAD content",
            "HEAD",
        );
        expect(mocks.showTextDocument).toHaveBeenCalledWith(readonlyUri);
    });

    it("uses the active editor only when no command context is supplied", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await showCurrentRevision(undefined, gitOps);

        expect(mocks.getFileContentAtRef).toHaveBeenCalledWith("src/active.ts", "HEAD");
        expect(mocks.createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/active.ts",
            "committed HEAD content",
            "HEAD",
        );
    });

    it("rejects an explicit malformed context instead of opening the active file", async () => {
        const gitOps = makeGitOps();

        await showCurrentRevision({ fsPath: "/repo-b/not-a-uri.ts" }, gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.getFileContentAtRef).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show Current Revision is only available for local files.",
        );
    });

    it("reports HEAD read failures without opening a document", async () => {
        const gitOps = makeGitOps();
        mocks.getFileContentAtRef.mockRejectedValueOnce(new Error("missing from HEAD"));

        await showCurrentRevision(mocks.FakeUri.file("/repo-b/selected.ts"), gitOps);

        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show Current Revision failed: missing from HEAD",
        );
    });
});

describe("annotateWithGitBlame", () => {
    const maxOutputBytes = 4 * 1024 * 1024;

    it("opens a readonly blame snapshot for the clicked file from its owning repository", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/nested");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        mocks.executorRunBinary.mockResolvedValueOnce({
            stdout: Buffer.from("abc123 (Ada 2026-09-19 1) source line\n"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: false,
        });
        const clicked = mocks.FakeUri.file("/linked/repo/nested/file with spaces.ts");

        await annotateWithGitBlame(clicked, gitOps);

        expect(mocks.executorRoots).toEqual(["/private/repo/nested", "/private/repo"]);
        expect(gitOps.deriveFor).toHaveBeenCalledWith("/private/repo");
        expect(mocks.executorRunBinary).toHaveBeenCalledWith(
            ["blame", "--date=short", "--", "nested/file with spaces.ts"],
            { maxOutputBytes },
        );
        expect(mocks.createReadonlyDiffUri).toHaveBeenCalledWith(
            "nested/file with spaces.ts.blame",
            "abc123 (Ada 2026-09-19 1) source line\n",
            "Git Blame",
        );
        expect(mocks.showTextDocument).toHaveBeenCalledWith({
            scheme: "intelligit-diff",
            path: "/selected.ts",
        });
    });

    it("passes the exact dirty document through blame stdin, including empty text", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/active.ts");
        mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "" });

        await annotateWithGitBlame(clicked, gitOps);

        expect(mocks.executorRunBinary).toHaveBeenCalledWith(
            ["blame", "--date=short", "--contents", "-", "--", "src/active.ts"],
            { input: Buffer.alloc(0), maxOutputBytes },
        );
    });

    it("rejects truncated blame output without opening a partial document", async () => {
        const gitOps = makeGitOps();
        mocks.executorRunBinary.mockResolvedValueOnce({
            stdout: Buffer.alloc(maxOutputBytes, 0x61),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: true,
        });

        await annotateWithGitBlame(mocks.FakeUri.file("/repo-b/large.ts"), gitOps);

        expect(mocks.createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Git Blame output is too large to open (maximum 4 MiB).",
        );
    });

    it.each([
        { fsPath: "/repo-b/not-a-uri.ts" },
        new mocks.FakeUri("untitled:file.ts", "untitled"),
    ])(
        "rejects explicit invalid context %o instead of annotating another file",
        async (context) => {
            const gitOps = makeGitOps();

            await annotateWithGitBlame(context, gitOps);

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.executorRunBinary).not.toHaveBeenCalled();
            expect(mocks.createReadonlyDiffUri).not.toHaveBeenCalled();
            expect(mocks.showTextDocument).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "Annotate with Git Blame is only available for local files.",
            );
        },
    );

    it("reports Git blame failures without opening a document", async () => {
        const gitOps = makeGitOps();
        mocks.executorRunBinary.mockRejectedValueOnce(new Error("fatal: no such path"));

        await annotateWithGitBlame(mocks.FakeUri.file("/repo-b/untracked.ts"), gitOps);

        expect(mocks.createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Annotate with Git Blame failed: fatal: no such path",
        );
    });
});
