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
        lstat: vi.fn(async () => ({ isDirectory: () => false })),
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
        createReadonlyDiffUri: vi.fn(() => ({ scheme: "intelligit-diff", path: "/file.ts" })),
        openDiffAgainstGitRef: vi.fn(async () => undefined),
        runGitOperationFromPanel: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
        showInformationMessage: vi.fn(async () => undefined),
        showTextDocument: vi.fn(async () => undefined),
        showWarningMessage: vi.fn(async () => "Rollback" as string | undefined),
    };
});

vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, realpath: mocks.realpath }));
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
    },
    workspace: {
        get textDocuments() {
            return mocks.textDocuments;
        },
    },
    l10n: { t: (message: string) => message },
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
    openDiffAgainstGitRef: mocks.openDiffAgainstGitRef,
}));
vi.mock("../../../src/views/commitPanelActions", () => ({
    runGitOperationFromPanel: mocks.runGitOperationFromPanel,
}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: (message: string) => mocks.showInformationMessage(message),
}));

import {
    annotateWithGitBlame,
    compareFileWithBranchOrTag,
    compareFileWithRevision,
    fetchFileRepositoryFromContext,
    rollbackFileFromContext,
    showCurrentRevision,
    showFileDiff,
} from "../../../src/commands/fileContextCommands";

const selectedGitOps = {
    scope: "selected",
    getFileContentAtRef: vi.fn(async () => "committed HEAD\n"),
    rollbackFiles: vi.fn(async () => undefined),
} as unknown as GitOps;
const makeGitOps = (): GitOps => ({ deriveFor: vi.fn(() => selectedGitOps) }) as unknown as GitOps;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = mocks.FakeUri.file("/repo-a/active.ts");
    mocks.textDocuments.length = 0;
    mocks.executorRoots.length = 0;
    mocks.realpath.mockImplementation(async (value: string) => value);
    mocks.lstat.mockReset().mockResolvedValue({ isDirectory: () => false });
    mocks.executorRun.mockResolvedValue("/repo-b\n");
    mocks.executorRunBinary.mockResolvedValue({
        stdout: Buffer.from("annotated source\n"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        truncated: false,
    });
    vi.mocked(selectedGitOps.getFileContentAtRef).mockResolvedValue("committed HEAD\n");
    vi.mocked(selectedGitOps.rollbackFiles).mockResolvedValue(undefined);
    mocks.showWarningMessage.mockResolvedValue("Rollback");
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
            "Compare with revision failed: {message}",
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
    it("uses the selected file's repository instead of the active graph repository", async () => {
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

    it("retains a linked file URI while passing its canonical repository path", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/src");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        const clicked = mocks.FakeUri.file("/linked/repo/src/file.ts");

        await compareFileWithBranchOrTag(clicked, gitOps);

        expect(mocks.compareEditorFileWithBranch).toHaveBeenCalledWith(
            clicked,
            "/private/repo",
            expect.anything(),
            "src/file.ts",
        );
    });

    it("rejects malformed explicit context instead of borrowing the active editor", async () => {
        const gitOps = makeGitOps();

        await compareFileWithBranchOrTag({ fsPath: "/repo-b/not-a-uri.ts" }, gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.compareEditorFileWithBranch).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
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
        expect(mocks.openDiffAgainstGitRef).toHaveBeenCalledWith(
            clicked,
            "/private/repo",
            "nested/file with spaces.ts",
            "HEAD",
            "revision",
            expect.objectContaining({ scope: "selected" }),
        );
    });

    it("rejects an explicit malformed context instead of diffing the active editor", async () => {
        const gitOps = makeGitOps();

        await showFileDiff({ fsPath: "/repo-b/not-a-uri.ts" }, gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(mocks.openDiffAgainstGitRef).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show Diff is only available for local files.",
        );
    });

    it("uses the active editor only when no command context is supplied", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await showFileDiff(undefined, gitOps);

        expect(mocks.openDiffAgainstGitRef).toHaveBeenCalledWith(
            mocks.activeUri,
            "/repo-b",
            "src/active.ts",
            "HEAD",
            "revision",
            expect.anything(),
        );
    });

    it("reports repository discovery failures without opening a diff", async () => {
        const gitOps = makeGitOps();
        mocks.executorRun.mockRejectedValueOnce(new Error("not a repository"));

        await showFileDiff(mocks.FakeUri.file("/outside/file.ts"), gitOps);

        expect(mocks.openDiffAgainstGitRef).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Show Diff failed: {message}");
    });
});

describe("showCurrentRevision", () => {
    it("opens immutable HEAD content for the clicked file from its owning repository", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/nested");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        const clicked = mocks.FakeUri.file("/linked/repo/nested/file with spaces.ts");

        await showCurrentRevision(clicked, gitOps);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/private/repo");
        expect(selectedGitOps.getFileContentAtRef).toHaveBeenCalledWith(
            "nested/file with spaces.ts",
            "HEAD",
        );
        expect(mocks.createReadonlyDiffUri).toHaveBeenCalledWith(
            "nested/file with spaces.ts",
            "committed HEAD\n",
            "HEAD",
        );
        expect(mocks.showTextDocument).toHaveBeenCalledWith({
            scheme: "intelligit-diff",
            path: "/file.ts",
        });
    });

    it("uses the active editor only when no command context is supplied", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await showCurrentRevision(undefined, gitOps);

        expect(selectedGitOps.getFileContentAtRef).toHaveBeenCalledWith("src/active.ts", "HEAD");
    });

    it.each([
        { fsPath: "/repo-b/not-a-uri.ts" },
        new mocks.FakeUri("untitled:file.ts", "untitled"),
    ])("rejects explicit invalid context %o instead of opening another file", async (context) => {
        const gitOps = makeGitOps();

        await showCurrentRevision(context, gitOps);

        expect(gitOps.deriveFor).not.toHaveBeenCalled();
        expect(selectedGitOps.getFileContentAtRef).not.toHaveBeenCalled();
        expect(mocks.createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show Current Revision is only available for local files.",
        );
    });

    it("reports missing HEAD or untracked-file read errors without opening a document", async () => {
        const gitOps = makeGitOps();
        vi.mocked(selectedGitOps.getFileContentAtRef).mockRejectedValueOnce(
            new Error("path does not exist in HEAD"),
        );

        await showCurrentRevision(mocks.FakeUri.file("/repo-b/untracked.ts"), gitOps);

        expect(mocks.createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Show current revision failed: {message}",
        );
    });
});

describe("annotateWithGitBlame", () => {
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
        expect(mocks.executorRunBinary).toHaveBeenCalledWith([
            "blame",
            "--date=short",
            "--",
            "nested/file with spaces.ts",
        ]);
        expect(mocks.createReadonlyDiffUri).toHaveBeenCalledWith(
            "nested/file with spaces.ts.blame",
            "abc123 (Ada 2026-09-19 1) source line\n",
            "Git Blame",
        );
        expect(mocks.showTextDocument).toHaveBeenCalledWith({
            scheme: "intelligit-diff",
            path: "/file.ts",
        });
    });

    it("passes the dirty active document through blame stdin without adding HEAD", async () => {
        const gitOps = makeGitOps();
        const activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");
        mocks.activeUri = activeUri;
        mocks.textDocuments.push({
            uri: activeUri,
            isDirty: true,
            getText: () => "changed source\n",
        });

        await annotateWithGitBlame(undefined, gitOps);

        expect(mocks.executorRunBinary).toHaveBeenCalledWith(
            ["blame", "--date=short", "--contents", "-", "--", "src/active.ts"],
            { input: Buffer.from("changed source\n") },
        );
        expect(mocks.executorRunBinary.mock.calls[0]?.[0]).not.toContain("HEAD");
    });

    it("passes an empty dirty document as an explicit empty stdin buffer", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/empty.ts");
        mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "" });

        await annotateWithGitBlame(clicked, gitOps);

        expect(mocks.executorRunBinary).toHaveBeenCalledWith(
            ["blame", "--date=short", "--contents", "-", "--", "empty.ts"],
            { input: Buffer.alloc(0) },
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
            "Annotate with Git Blame failed: {message}",
        );
    });
});

describe("rollbackFileFromContext", () => {
    const refreshPanels = vi.fn(async () => undefined);

    beforeEach(() => {
        refreshPanels.mockClear();
    });

    it("rolls back only the clicked path through its owning repository", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file with spaces.ts");

        await rollbackFileFromContext(clicked, gitOps, refreshPanels);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(selectedGitOps.rollbackFiles).toHaveBeenCalledWith(["nested/file with spaces.ts"]);
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "Rollback {path}?",
            { modal: true },
            "Rollback",
        );
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Changes rolled back.");
        expect(refreshPanels).toHaveBeenCalledTimes(1);
    });

    it("uses the active editor only when no command context is supplied", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await rollbackFileFromContext(undefined, gitOps, refreshPanels);

        expect(selectedGitOps.rollbackFiles).toHaveBeenCalledWith(["src/active.ts"]);
    });

    it("does not mutate when confirmation is cancelled", async () => {
        const gitOps = makeGitOps();
        mocks.showWarningMessage.mockResolvedValueOnce(undefined);

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/cancelled.ts"),
            gitOps,
            refreshPanels,
        );

        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
        expect(refreshPanels).not.toHaveBeenCalled();
    });

    it("rejects a dirty selected document before confirmation", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/dirty.ts");
        mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "dirty\n" });

        await rollbackFileFromContext(clicked, gitOps, refreshPanels);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Save or discard changes to {path} before rolling back.",
        );
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
    });

    it("rejects the selected document when it becomes dirty during confirmation", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/raced.ts");
        mocks.showWarningMessage.mockImplementationOnce(async () => {
            mocks.textDocuments.push({ uri: clicked, isDirty: true, getText: () => "dirty\n" });
            return "Rollback";
        });

        await rollbackFileFromContext(clicked, gitOps, refreshPanels);

        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
        expect(refreshPanels).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Save or discard changes to {path} before rolling back.",
        );
    });

    it("matches a dirty selected document through a canonical parent alias", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/linked/repo/src/dirty.ts");
        const openAlias = mocks.FakeUri.file("/other-link/repo/src/dirty.ts");
        mocks.realpath.mockImplementation(async (value: string) => {
            if (value === "/linked/repo/src" || value === "/other-link/repo/src") {
                return "/private/repo/src";
            }
            return value;
        });
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");
        mocks.textDocuments.push({ uri: openAlias, isDirty: true, getText: () => "dirty\n" });

        await rollbackFileFromContext(clicked, gitOps, refreshPanels);

        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it("allows unrelated dirty documents", async () => {
        const gitOps = makeGitOps();
        mocks.textDocuments.push({
            uri: mocks.FakeUri.file("/repo-b/src/unrelated.ts"),
            isDirty: true,
            getText: () => "dirty\n",
        });

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/selected.ts"),
            gitOps,
            refreshPanels,
        );

        expect(selectedGitOps.rollbackFiles).toHaveBeenCalledWith(["src/selected.ts"]);
    });

    it("checks the captured canonical file path through a symlinked parent", async () => {
        const gitOps = makeGitOps();
        mocks.realpath.mockResolvedValueOnce("/private/repo/src");
        mocks.executorRun.mockResolvedValueOnce("/private/repo\n");

        await rollbackFileFromContext(
            mocks.FakeUri.file("/linked/repo/src/file.ts"),
            gitOps,
            refreshPanels,
        );

        expect(mocks.lstat).toHaveBeenNthCalledWith(1, "/private/repo/src/file.ts");
        expect(mocks.lstat).toHaveBeenNthCalledWith(2, "/private/repo/src/file.ts");
    });

    it("rejects an explicitly selected directory before confirmation", async () => {
        const gitOps = makeGitOps();
        mocks.lstat.mockResolvedValueOnce({ isDirectory: () => true });

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/folder"),
            gitOps,
            refreshPanels,
        );

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Rollback is only available for files.",
        );
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
    });

    it("rejects the selected path when it becomes a directory during confirmation", async () => {
        const gitOps = makeGitOps();
        mocks.lstat
            .mockResolvedValueOnce({ isDirectory: () => false })
            .mockResolvedValueOnce({ isDirectory: () => true });

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/changed-type"),
            gitOps,
            refreshPanels,
        );

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Rollback is only available for files.",
        );
        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
        expect(refreshPanels).not.toHaveBeenCalled();
    });

    it("allows a deleted tracked file to reach rollback", async () => {
        const gitOps = makeGitOps();
        mocks.lstat.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/deleted.ts"),
            gitOps,
            refreshPanels,
        );

        expect(selectedGitOps.rollbackFiles).toHaveBeenCalledWith(["src/deleted.ts"]);
    });

    it.each([
        { fsPath: "/repo-b/not-a-uri.ts" },
        new mocks.FakeUri("untitled:file.ts", "untitled"),
    ])(
        "rejects explicit invalid context %o instead of using the active editor",
        async (context) => {
            const gitOps = makeGitOps();

            await rollbackFileFromContext(context, gitOps, refreshPanels);

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "Rollback is only available for local files.",
            );
        },
    );

    it("surfaces filesystem and rollback failures without mutating another repository", async () => {
        const gitOps = makeGitOps();
        mocks.lstat.mockRejectedValueOnce(new Error("permission denied"));

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/blocked.ts"),
            gitOps,
            refreshPanels,
        );

        expect(selectedGitOps.rollbackFiles).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Rollback failed: {message}");

        mocks.showErrorMessage.mockClear();
        mocks.lstat.mockResolvedValueOnce({ isDirectory: () => false });
        vi.mocked(selectedGitOps.rollbackFiles).mockRejectedValueOnce(new Error("rollback failed"));

        await rollbackFileFromContext(
            mocks.FakeUri.file("/repo-b/src/fails.ts"),
            gitOps,
            refreshPanels,
        );

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Rollback failed: {message}");
        expect(refreshPanels).toHaveBeenCalledTimes(1);
    });
});

describe("fetchFileRepositoryFromContext", () => {
    const refreshPanels = vi.fn(async () => undefined);
    const refreshGraph = vi.fn(async () => undefined);

    beforeEach(() => {
        refreshPanels.mockClear();
        refreshGraph.mockClear();
        mocks.runGitOperationFromPanel.mockReset().mockResolvedValue(undefined);
    });

    it("fetches the clicked file's repository and forwards both refresh callbacks", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/nested/file with spaces.ts");
        mocks.runGitOperationFromPanel.mockImplementationOnce(async (deps, operation) => {
            expect(operation).toBe("fetch");
            expect(deps.gitOps).toBe(selectedGitOps);
            await deps.refreshData();
            await deps.refreshGraphData?.();
            deps.fireWorkingTreeChanged();
        });

        await fetchFileRepositoryFromContext(clicked, gitOps, refreshPanels, refreshGraph);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledTimes(1);
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: selectedGitOps }),
            "fetch",
        );
        expect(refreshPanels).toHaveBeenCalledTimes(1);
        expect(refreshGraph).toHaveBeenCalledTimes(1);
    });

    it("uses the active editor only when command context is undefined", async () => {
        const gitOps = makeGitOps();
        mocks.activeUri = mocks.FakeUri.file("/repo-b/src/active.ts");

        await fetchFileRepositoryFromContext(undefined, gitOps, refreshPanels, refreshGraph);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: selectedGitOps }),
            "fetch",
        );
    });

    it.each([
        { fsPath: "/repo-b/not-a-uri.ts" },
        new mocks.FakeUri("untitled:file.ts", "untitled"),
    ])(
        "rejects explicit invalid context %o instead of fetching the active editor",
        async (context) => {
            const gitOps = makeGitOps();

            await fetchFileRepositoryFromContext(context, gitOps, refreshPanels, refreshGraph);

            expect(gitOps.deriveFor).not.toHaveBeenCalled();
            expect(mocks.runGitOperationFromPanel).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "Fetch is only available for local files.",
            );
        },
    );

    it("keeps the captured file repository when the active editor changes during resolution", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/selected.ts");
        mocks.realpath.mockImplementationOnce(async (value: string) => {
            mocks.activeUri = mocks.FakeUri.file("/repo-c/switched.ts");
            return value;
        });

        await fetchFileRepositoryFromContext(clicked, gitOps, refreshPanels, refreshGraph);

        expect(gitOps.deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.runGitOperationFromPanel).toHaveBeenCalledWith(
            expect.objectContaining({ gitOps: selectedGitOps }),
            "fetch",
        );
    });

    it("shows repository resolution and fetch failures", async () => {
        const gitOps = makeGitOps();
        const clicked = mocks.FakeUri.file("/repo-b/src/selected.ts");
        mocks.executorRun.mockRejectedValueOnce(new Error("not a repository"));

        await fetchFileRepositoryFromContext(clicked, gitOps, refreshPanels, refreshGraph);

        expect(mocks.runGitOperationFromPanel).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Fetch failed: {message}");

        mocks.showErrorMessage.mockClear();
        mocks.runGitOperationFromPanel.mockRejectedValueOnce(new Error("network unavailable"));

        await fetchFileRepositoryFromContext(clicked, gitOps, refreshPanels, refreshGraph);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Fetch failed: {message}");
    });
});
