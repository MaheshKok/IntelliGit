import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const mocks = vi.hoisted(() => {
    class FileUri {
        readonly scheme = "file";
        constructor(readonly fsPath: string) {}
    }
    return {
        FileUri,
        activeUri: undefined as FileUri | undefined,
        showErrorMessage: vi.fn(),
        showTimedInformationMessage: vi.fn(),
    };
});

vi.mock("vscode", () => ({
    Uri: mocks.FileUri,
    window: {
        get activeTextEditor() {
            return mocks.activeUri ? { document: { uri: mocks.activeUri } } : undefined;
        },
        showErrorMessage: mocks.showErrorMessage,
    },
    workspace: { textDocuments: [] },
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            Object.entries(args ?? {}).reduce(
                (rendered, [key, value]) => rendered.replace(`{${key}}`, value),
                message,
            ),
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: async (_title: string, task: () => Promise<void>) => task(),
    showTimedInformationMessage: mocks.showTimedInformationMessage,
}));

import { addFileToVcsFromContext } from "../../../src/commands/fileContextCommands";
import { trackUnversionedFilesFromPanel } from "../../../src/views/panelFileActions";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

/** Runs Git in an isolated test repository with deterministic author identity. */
async function git(repo: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
        cwd: repo,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
    return stdout;
}

/** Creates a disposable repository with a committed baseline file. */
async function repository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-file-add-to-vcs-"));
    directories.push(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repo, "baseline.txt"), "BASE\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    return repo;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = undefined;
});
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

describe("Add to VCS native file context", () => {
    it("intent-adds only the clicked untracked file without staging content or disturbing unrelated bytes", async () => {
        const repo = await repository();
        const selectedPath = "selected.txt";
        const unrelatedPath = "baseline.txt";
        await writeFile(path.join(repo, selectedPath), "SELECTED\n");
        await writeFile(path.join(repo, unrelatedPath), "STAGED\n");
        await git(repo, ["add", "--", unrelatedPath]);
        await writeFile(path.join(repo, unrelatedPath), "WORKTREE\n");
        const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
        const beforeUnrelatedIndex = await git(repo, ["show", `:${unrelatedPath}`]);
        const refreshData = vi.fn(async () => undefined);

        await addFileToVcsFromContext(
            new mocks.FileUri(path.join(repo, selectedPath)),
            new GitOps(new GitExecutor(repo)),
            async (scopedGitOps, _root, relativePath) =>
                trackUnversionedFilesFromPanel(
                    {
                        gitOps: scopedGitOps,
                        getWorkspaceRoot: () => new mocks.FileUri(repo) as never,
                        refreshData,
                        fireWorkingTreeChanged: () => undefined,
                    },
                    [relativePath],
                ),
        );

        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(await git(repo, ["status", "--porcelain"])).toContain(` A ${selectedPath}`);
        expect(await git(repo, ["diff", "--cached", "--", selectedPath])).toBe("");
        expect(await git(repo, ["show", `:${unrelatedPath}`])).toBe(beforeUnrelatedIndex);
        expect(await readFile(path.join(repo, unrelatedPath), "utf8")).toBe("WORKTREE\n");
        expect(refreshData).toHaveBeenCalledOnce();
        expect(mocks.showTimedInformationMessage).toHaveBeenCalledWith(
            `Added ${selectedPath} to VCS.`,
        );
    });

    it("re-adds an already staged new file without changing its index blob", async () => {
        const repo = await repository();
        const selectedPath = "staged-new.txt";
        await writeFile(path.join(repo, selectedPath), "STAGED\n");
        await git(repo, ["add", "--", selectedPath]);
        await writeFile(path.join(repo, selectedPath), "WORKTREE\n");
        const beforeIndex = await git(repo, ["ls-files", "--stage", "-z"]);

        await addFileToVcsFromContext(
            new mocks.FileUri(path.join(repo, selectedPath)),
            new GitOps(new GitExecutor(repo)),
            async (scopedGitOps, _root, relativePath) =>
                trackUnversionedFilesFromPanel(
                    {
                        gitOps: scopedGitOps,
                        getWorkspaceRoot: () => new mocks.FileUri(repo) as never,
                        refreshData: async () => undefined,
                        fireWorkingTreeChanged: () => undefined,
                    },
                    [relativePath],
                ),
        );

        expect(await git(repo, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
        expect(await readFile(path.join(repo, selectedPath), "utf8")).toBe("WORKTREE\n");
    });

    it("uses the shared status recheck to reject tracked and ignored paths", async () => {
        const repo = await repository();
        const gitOps = new GitOps(new GitExecutor(repo));
        const deps = {
            gitOps,
            getWorkspaceRoot: () => new mocks.FileUri(repo) as never,
            refreshData: async () => undefined,
            fireWorkingTreeChanged: () => undefined,
        };
        await writeFile(path.join(repo, "baseline.txt"), "MODIFIED\n");

        await expect(trackUnversionedFilesFromPanel(deps, ["baseline.txt"])).rejects.toThrow(
            "Only unversioned files can be moved into Changes: baseline.txt",
        );

        await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
        await writeFile(path.join(repo, "ignored.txt"), "IGNORED\n");
        await expect(trackUnversionedFilesFromPanel(deps, ["ignored.txt"])).rejects.toThrow(
            "Only unversioned files can be moved into Changes: ignored.txt",
        );
    });
});
