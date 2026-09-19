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
    }
    return {
        FakeUri,
        activeUri: FakeUri.file("/repo-a/active.ts") as FakeUri | undefined,
        realpath: vi.fn(async (value: string) => value),
        executorRoots: [] as string[],
        executorRun: vi.fn(async () => "/repo-b\n"),
        compareEditorFileWithBranch: vi.fn(async () => undefined),
        compareEditorFileWithRevision: vi.fn(async () => undefined),
        showEditorFileDiff: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
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
    },
    l10n: { t: (message: string) => message },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.executorRun;

        constructor(repoRoot: string) {
            mocks.executorRoots.push(repoRoot);
        }
    },
}));
vi.mock("../../../src/services/diffService", () => ({
    compareEditorFileWithBranch: mocks.compareEditorFileWithBranch,
    compareEditorFileWithRevision: mocks.compareEditorFileWithRevision,
    showEditorFileDiff: mocks.showEditorFileDiff,
}));

import {
    compareFileWithBranchOrTag,
    compareFileWithRevision,
    showFileDiff,
} from "../../../src/commands/fileContextCommands";

const makeGitOps = (): GitOps =>
    ({ deriveFor: vi.fn(() => ({ scope: "selected" }) as unknown as GitOps) }) as unknown as GitOps;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = mocks.FakeUri.file("/repo-a/active.ts");
    mocks.executorRoots.length = 0;
    mocks.realpath.mockImplementation(async (value: string) => value);
    mocks.executorRun.mockResolvedValue("/repo-b\n");
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
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Show Diff failed: {message}");
    });
});
