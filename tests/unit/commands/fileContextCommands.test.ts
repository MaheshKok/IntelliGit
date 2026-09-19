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
        showErrorMessage: vi.fn(async () => undefined),
        showTextDocument: vi.fn(async () => undefined),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.FakeUri,
    window: {
        get activeTextEditor() {
            return mocks.activeUri ? { document: { uri: mocks.activeUri } } : undefined;
        },
        showErrorMessage: mocks.showErrorMessage,
        showTextDocument: mocks.showTextDocument,
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

import {
    annotateWithGitBlame,
    compareFileWithBranchOrTag,
    compareFileWithRevision,
    showCurrentRevision,
    showFileDiff,
} from "../../../src/commands/fileContextCommands";

const selectedGitOps = {
    scope: "selected",
    getFileContentAtRef: vi.fn(async () => "committed HEAD\n"),
} as unknown as GitOps;
const makeGitOps = (): GitOps => ({ deriveFor: vi.fn(() => selectedGitOps) }) as unknown as GitOps;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = mocks.FakeUri.file("/repo-a/active.ts");
    mocks.textDocuments.length = 0;
    mocks.executorRoots.length = 0;
    mocks.realpath.mockImplementation(async (value: string) => value);
    mocks.executorRun.mockResolvedValue("/repo-b\n");
    mocks.executorRunBinary.mockResolvedValue({
        stdout: Buffer.from("annotated source\n"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        truncated: false,
    });
    vi.mocked(selectedGitOps.getFileContentAtRef).mockResolvedValue("committed HEAD\n");
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
