import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
        toString(): string {
            return `file:${this.fsPath}`;
        }
    }
    return {
        FileUri,
        activeUri: undefined as FileUri | undefined,
        textDocuments: [] as Array<{ uri: FileUri; isDirty: boolean; getText: () => string }>,
        showInputBox: vi.fn(async () => "Commit the selected file"),
        showErrorMessage: vi.fn(),
        showTimedInformationMessage: vi.fn(),
    };
});

vi.mock("vscode", () => ({
    Uri: mocks.FileUri,
    workspace: { textDocuments: mocks.textDocuments },
    window: {
        get activeTextEditor() {
            return mocks.activeUri ? { document: { uri: mocks.activeUri } } : undefined;
        },
        showInputBox: mocks.showInputBox,
        showErrorMessage: mocks.showErrorMessage,
    },
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
    showTimedWarningMessage: vi.fn(),
}));

import { commitFileFromContext } from "../../../src/commands/fileContextCommands";
import { commitSelectedFromPanel } from "../../../src/views/commitPanelActions";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

/** Runs real Git against an isolated repository with deterministic author identity. */
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

/** Creates a disposable repository containing two independently tracked files. */
async function repository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-file-context-commit-"));
    directories.push(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repo, "selected.txt"), "BASE\n");
    await writeFile(path.join(repo, "unrelated.txt"), "BASE\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    return repo;
}

/** Executes the same selected-file action used by command registration, with observable refresh. */
async function runCommit(ctx: unknown, gitOps: GitOps): Promise<ReturnType<typeof vi.fn>> {
    const refreshData = vi.fn(async () => undefined);
    await commitFileFromContext(ctx, gitOps, async (scopedGitOps, _root, filePath, message) => {
        await commitSelectedFromPanel(
            {
                gitOps: scopedGitOps,
                refreshData,
                fireWorkingTreeChanged: () => undefined,
                postCommitted: () => undefined,
                maybeOfferPublishBranch: async () => undefined,
            },
            { message, amend: false, push: false, paths: [filePath], rejectActiveOperation: true },
        );
    });
    return refreshData;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = undefined;
    mocks.textDocuments.length = 0;
    mocks.showInputBox.mockReset().mockResolvedValue("Commit the selected file");
});
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

describe("Commit File real repository isolation", () => {
    it.each([
        { when: "before", selectedAlias: false },
        { when: "before", selectedAlias: true },
        { when: "during", selectedAlias: false },
        { when: "during", selectedAlias: true },
    ])(
        "rejects a dirty missing-parent alias $when the prompt (selected alias: $selectedAlias)",
        async ({ when, selectedAlias }) => {
            const repo = await repository();
            const filePath = "nested/selected.txt";
            await mkdir(path.join(repo, "nested"));
            await writeFile(path.join(repo, filePath), "NESTED\n");
            await git(repo, ["add", filePath]);
            await git(repo, ["commit", "-m", "nested base"]);
            const aliases = await mkdtemp(path.join(tmpdir(), "intelligit-dirty-file-alias-"));
            directories.push(aliases);
            const alias = path.join(aliases, "alias");
            await symlink(repo, alias, "junction");
            await removeScratchDirectories(path.join(repo, "nested"));
            await writeFile(path.join(repo, "unrelated.txt"), "STAGED\n");
            await git(repo, ["add", "unrelated.txt"]);
            await writeFile(path.join(repo, "unrelated.txt"), "WORKTREE\n");
            const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
            const beforeIndex = await git(repo, ["ls-files", "--stage", "-z"]);
            const dirtyDocument = {
                uri: new mocks.FileUri(path.join(selectedAlias ? repo : alias, filePath)),
                isDirty: true,
                getText: () => "UNSAVED\n",
            };
            if (when === "before") {
                mocks.textDocuments.push(dirtyDocument);
            } else {
                mocks.showInputBox.mockImplementationOnce(async () => {
                    mocks.textDocuments.push(dirtyDocument);
                    return "Commit selected file";
                });
            }

            const refresh = await runCommit(
                new mocks.FileUri(path.join(selectedAlias ? alias : repo, filePath)),
                new GitOps(new GitExecutor(repo)),
            );

            expect(
                await git(repo, ["rev-parse", "HEAD"]),
                "dirty alias must not commit the tracked deletion",
            ).toBe(beforeHead);
            expect(await git(repo, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
            expect(refresh).not.toHaveBeenCalled();
            expect(mocks.showInputBox).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "Save nested/selected.txt before committing.",
            );
            expect(await readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("WORKTREE\n");
        },
    );

    it.each(["before", "during"])(
        "rejects sequencer-only state created %s the prompt without staging selected changes",
        async (when) => {
            const repo = await repository();
            await writeFile(path.join(repo, "selected.txt"), "SAVED SELECTED\n");
            await writeFile(path.join(repo, "unrelated.txt"), "STAGED\n");
            await git(repo, ["add", "unrelated.txt"]);
            await writeFile(path.join(repo, "unrelated.txt"), "WORKTREE\n");
            const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
            const beforeIndex = await git(repo, ["ls-files", "--stage", "-z"]);
            if (when === "before") {
                await mkdir(path.join(repo, ".git/sequencer"));
            } else {
                mocks.showInputBox.mockImplementationOnce(async () => {
                    await mkdir(path.join(repo, ".git/sequencer"));
                    return "Commit selected file";
                });
            }
            const runSelected = vi.fn(
                async (gitOps: GitOps, _root: string, filePath: string, message: string) => {
                    await commitSelectedFromPanel(
                        {
                            gitOps,
                            refreshData: async () => undefined,
                            fireWorkingTreeChanged: () => undefined,
                            postCommitted: () => undefined,
                            maybeOfferPublishBranch: async () => undefined,
                        },
                        {
                            message,
                            amend: false,
                            push: false,
                            paths: [filePath],
                            rejectActiveOperation: true,
                        },
                    );
                },
            );

            await commitFileFromContext(
                new mocks.FileUri(path.join(repo, "selected.txt")),
                new GitOps(new GitExecutor(repo)),
                runSelected,
            );

            expect(
                await git(repo, ["ls-files", "--stage", "-z"]),
                "sequencer fence preserves the index before staging",
            ).toBe(beforeIndex);
            expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
            expect(runSelected).not.toHaveBeenCalled();
            expect(mocks.showInputBox).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
            expect(mocks.showErrorMessage).toHaveBeenCalledWith(
                "A Git operation is in progress — continue or abort it first.",
            );
            expect(await readFile(path.join(repo, "selected.txt"), "utf8")).toBe(
                "SAVED SELECTED\n",
            );
            expect(await readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("WORKTREE\n");
        },
    );

    it("commits the explicit owning repository while the editor and shared GitOps point elsewhere", async () => {
        const active = await repository();
        const selected = await repository();
        await writeFile(path.join(active, "selected.txt"), "ACTIVE REPOSITORY\n");
        await git(active, ["add", "selected.txt"]);
        mocks.activeUri = new mocks.FileUri(path.join(active, "selected.txt"));
        const activeHead = await git(active, ["rev-parse", "HEAD"]);
        const activeIndex = await git(active, ["ls-files", "--stage", "-z"]);
        await writeFile(path.join(selected, "selected.txt"), "SAVED SELECTED\n");
        await writeFile(path.join(selected, "unrelated.txt"), "STAGED\n");
        await git(selected, ["add", "unrelated.txt"]);
        await writeFile(path.join(selected, "unrelated.txt"), "WORKTREE\n");

        const refresh = await runCommit(
            new mocks.FileUri(path.join(selected, "selected.txt")),
            new GitOps(new GitExecutor(active)),
        );

        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(mocks.showTimedInformationMessage).toHaveBeenCalledWith("Committed successfully.");
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(await git(active, ["rev-parse", "HEAD"])).toBe(activeHead);
        expect(await git(active, ["ls-files", "--stage", "-z"])).toBe(activeIndex);
        expect(
            await git(selected, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
        ).toBe("selected.txt\n");
        expect(await git(selected, ["show", "HEAD:selected.txt"])).toBe("SAVED SELECTED\n");
        expect(await git(selected, ["show", ":unrelated.txt"])).toBe("STAGED\n");
        expect(await readFile(path.join(selected, "unrelated.txt"), "utf8")).toBe("WORKTREE\n");
    });

    it("commits an exact tracked deletion without selecting other deleted files", async () => {
        const repo = await repository();
        await rm(path.join(repo, "selected.txt"));
        await rm(path.join(repo, "unrelated.txt"));

        await runCommit(
            new mocks.FileUri(path.join(repo, "selected.txt")),
            new GitOps(new GitExecutor(repo)),
        );

        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(
            await git(repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"]),
        ).toBe("D\tselected.txt\n");
        expect(await git(repo, ["show", "HEAD:unrelated.txt"])).toBe("BASE\n");
        expect(await git(repo, ["status", "--porcelain"])).toBe(" D unrelated.txt\n");
    });

    it.each([false, true])(
        "commits a deleted file beneath a missing parent and preserves unrelated staged bytes (symlink ancestor: %s)",
        async (useSymlink) => {
            const repo = await repository();
            await mkdir(path.join(repo, "nested/deeper"), { recursive: true });
            await writeFile(path.join(repo, "nested/deeper/selected.txt"), "NESTED\n");
            await git(repo, ["add", "nested/deeper/selected.txt"]);
            await git(repo, ["commit", "-m", "nested base"]);
            await removeScratchDirectories(path.join(repo, "nested"));
            await writeFile(path.join(repo, "unrelated.txt"), "STAGED\n");
            await git(repo, ["add", "unrelated.txt"]);
            await writeFile(path.join(repo, "unrelated.txt"), "WORKTREE\n");
            let selectedRoot = repo;
            if (useSymlink) {
                const aliases = await mkdtemp(path.join(tmpdir(), "intelligit-file-commit-alias-"));
                directories.push(aliases);
                selectedRoot = path.join(aliases, "alias");
                await symlink(repo, selectedRoot, "junction");
            }

            await runCommit(
                new mocks.FileUri(path.join(selectedRoot, "nested/deeper/selected.txt")),
                new GitOps(new GitExecutor(repo)),
            );

            expect(mocks.showInputBox).toHaveBeenCalledOnce();
            expect(mocks.showErrorMessage).not.toHaveBeenCalled();
            expect(
                await git(repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"]),
            ).toBe("D\tnested/deeper/selected.txt\n");
            expect(await git(repo, ["show", "HEAD:unrelated.txt"])).toBe("BASE\n");
            expect(await git(repo, ["show", ":unrelated.txt"])).toBe("STAGED\n");
            expect(await readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("WORKTREE\n");
        },
    );

    it("rejects a missing parent directory instead of committing its deleted descendants", async () => {
        const repo = await repository();
        await mkdir(path.join(repo, "nested/deeper"), { recursive: true });
        await writeFile(path.join(repo, "nested/deeper/selected.txt"), "NESTED\n");
        await git(repo, ["add", "nested"]);
        await git(repo, ["commit", "-m", "nested base"]);
        const head = await git(repo, ["rev-parse", "HEAD"]);
        await removeScratchDirectories(path.join(repo, "nested"));

        await runCommit(
            new mocks.FileUri(path.join(repo, "nested/deeper")),
            new GitOps(new GitExecutor(repo)),
        );

        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Commit is only available for local files.",
        );
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
    });
});
