import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILENAMES_MAY_CONTAIN_RESERVED_CHARACTERS } from "../../helpers/platformCapabilities";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";

const vscodeMock = vi.hoisted(() => ({
    l10n: { t: (message: string) => message },
    window: {
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);
const notificationsMock = vi.hoisted(() => ({
    runWithNotificationProgress: async (_title: string, task: () => Promise<void>): Promise<void> =>
        task(),
    showTimedWarningMessage: vi.fn(),
    showTimedInformationMessage: vi.fn(),
}));

vi.mock("../../../src/utils/notifications", () => notificationsMock);

import { commitSelectedFromPanel } from "../../../src/views/commitPanelActions";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

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

async function write(repo: string, file: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content, "utf8");
}

async function createRepository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-commit-accuracy-"));
    directories.push(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await write(repo, "tracked.txt", "base\n");
    await write(repo, "nested/untouched.txt", "base\n");
    await write(repo, "deleted.txt", "base\n");
    await write(repo, "renamed/from.txt", "r".repeat(200));
    await write(repo, "conflict.txt", "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    return repo;
}

function actionDeps(gitOps: GitOps) {
    return {
        gitOps,
        refreshData: async () => undefined,
        refreshGraphData: async () => undefined,
        fireWorkingTreeChanged: () => undefined,
        postCommitted: async () => undefined,
        maybeOfferPublishBranch: async () => undefined,
        publishBranch: async () => undefined,
    };
}

async function commitSelected(
    repo: string,
    options: { message: string; amend?: boolean; paths: string[] },
): Promise<void> {
    await commitSelectedFromPanel(actionDeps(new GitOps(new GitExecutor(repo))), {
        message: options.message,
        amend: options.amend ?? false,
        push: false,
        paths: options.paths,
    });
}

async function changedPaths(repo: string): Promise<string> {
    return git(repo, [
        "diff-tree",
        "--root",
        "-r",
        "--no-commit-id",
        "--no-renames",
        "--name-status",
        "HEAD",
    ]);
}

describe("commitSelectedFromPanel commit accuracy", () => {
    it("reports file creation for a first commit", async () => {
        const repo = await mkdtemp(path.join(tmpdir(), "intelligit-commit-accuracy-"));
        directories.push(repo);
        await git(repo, ["init"]);
        await git(repo, ["config", "user.email", "test@example.invalid"]);
        await git(repo, ["config", "user.name", "Test"]);
        await write(repo, "first.txt", "first\n");

        await commitSelected(repo, { message: "first", paths: ["first.txt"] });

        expect(await changedPaths(repo)).toBe("A\tfirst.txt\n");
    });

    it("excludes a previously staged but unchecked file", async () => {
        const repo = await createRepository();
        await write(repo, "selected.txt", "selected\n");
        await write(repo, "unchecked.txt", "unchecked\n");
        await git(repo, ["add", "unchecked.txt"]);

        await commitSelected(repo, { message: "selected", paths: ["selected.txt"] });

        expect(await changedPaths(repo)).toBe("A\tselected.txt\n");
    });

    it("commits a checked deleted path", async () => {
        const repo = await createRepository();
        await rm(path.join(repo, "deleted.txt"));

        await commitSelected(repo, { message: "delete", paths: ["deleted.txt"] });

        expect(await changedPaths(repo)).toBe("D\tdeleted.txt\n");
    });

    it("commits both rename paths and keeps the rest of the recursive tree", async () => {
        const repo = await createRepository();
        await rename(path.join(repo, "renamed/from.txt"), path.join(repo, "renamed/to.txt"));
        await git(repo, ["add", "-A"]);

        await commitSelected(repo, { message: "rename", paths: ["renamed/to.txt"] });

        expect(await changedPaths(repo)).toBe("D\trenamed/from.txt\nA\trenamed/to.txt\n");
        const tree = await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
        expect(tree).toContain("nested/untouched.txt\n");
        expect(tree).toContain("renamed/to.txt\n");
        expect(tree).not.toContain("renamed/from.txt\n");
    });

    it("commits a checked case-only rename without sweeping staged files", async (context) => {
        const repo = await createRepository();
        await write(repo, "File.txt", "base\n");
        await git(repo, ["add", "File.txt"]);
        await git(repo, ["commit", "-m", "case base"]);
        await git(repo, ["mv", "File.txt", "file.txt"]);

        const caseInsensitive = await access(path.join(repo, "File.txt"))
            .then(() => true)
            .catch(() => false);
        if (!caseInsensitive) {
            console.warn("Skipping case-only rename regression on a case-sensitive filesystem.");
            context.skip();
            return;
        }

        await commitSelected(repo, { message: "case-only rename", paths: ["file.txt"] });

        expect(await changedPaths(repo)).toBe("D\tFile.txt\nA\tfile.txt\n");
    });

    it("restores divergent staged content, deletions, and intent-to-add after a case-only commit", async (context) => {
        const repo = await createRepository();
        await write(repo, "File.txt", "base\n");
        await git(repo, ["add", "File.txt"]);
        await git(repo, ["commit", "-m", "case base"]);
        await git(repo, ["mv", "File.txt", "file.txt"]);

        const caseInsensitive = await access(path.join(repo, "File.txt"))
            .then(() => true)
            .catch(() => false);
        if (!caseInsensitive) {
            context.skip();
            return;
        }

        await write(repo, "tracked.txt", "STAGED\n");
        await git(repo, ["add", "tracked.txt"]);
        await write(repo, "tracked.txt", "WORKTREE\n");
        await rm(path.join(repo, "deleted.txt"));
        await git(repo, ["add", "-u", "deleted.txt"]);
        await write(repo, "intent.txt", "intent\n");
        await git(repo, ["add", "-N", "intent.txt"]);

        await commitSelected(repo, { message: "case-only rename", paths: ["file.txt"] });

        expect(await changedPaths(repo)).toBe("D\tFile.txt\nA\tfile.txt\n");
        expect(await git(repo, ["show", ":tracked.txt"])).toBe("STAGED\n");
        expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("WORKTREE\n");
        expect(await git(repo, ["status", "--porcelain"])).toContain("D  deleted.txt\n");
        expect(await git(repo, ["status", "--porcelain"])).toContain(" A intent.txt\n");
    });

    it("excludes and preserves both paths of an unchecked staged rename", async (context) => {
        const repo = await createRepository();
        await write(repo, "File.txt", "base\n");
        await git(repo, ["add", "File.txt"]);
        await git(repo, ["commit", "-m", "case base"]);
        await git(repo, ["mv", "File.txt", "file.txt"]);

        const caseInsensitive = await access(path.join(repo, "File.txt"))
            .then(() => true)
            .catch(() => false);
        if (!caseInsensitive) {
            context.skip();
            return;
        }

        await git(repo, ["mv", "renamed/from.txt", "renamed/unchecked.txt"]);

        await commitSelected(repo, { message: "case-only rename", paths: ["file.txt"] });

        expect(await changedPaths(repo)).toBe("D\tFile.txt\nA\tfile.txt\n");
        expect(await git(repo, ["diff", "--cached", "--name-status"])).toContain(
            "R100\trenamed/from.txt\trenamed/unchecked.txt\n",
        );
    });

    it("restores the complete index when the case-only commit hook rejects", async (context) => {
        const repo = await createRepository();
        await write(repo, "File.txt", "base\n");
        await git(repo, ["add", "File.txt"]);
        await git(repo, ["commit", "-m", "case base"]);
        await git(repo, ["mv", "File.txt", "file.txt"]);

        const caseInsensitive = await access(path.join(repo, "File.txt"))
            .then(() => true)
            .catch(() => false);
        if (!caseInsensitive) {
            context.skip();
            return;
        }

        await write(repo, "tracked.txt", "STAGED\n");
        await git(repo, ["add", "tracked.txt"]);
        await write(repo, "tracked.txt", "WORKTREE\n");
        const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
        const beforeIndex = await git(repo, ["ls-files", "-s"]);
        const beforeCachedDiff = await git(repo, ["diff", "--cached"]);
        const gitOps = new GitOps(new GitExecutor(repo));
        vi.spyOn(gitOps, "commit").mockRejectedValueOnce(new Error("commit rejected"));

        await expect(
            commitSelectedFromPanel(actionDeps(gitOps), {
                message: "case-only rename",
                amend: false,
                push: false,
                paths: ["file.txt"],
            }),
        ).rejects.toThrow();

        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(await git(repo, ["ls-files", "-s"])).toBe(beforeIndex);
        expect(await git(repo, ["diff", "--cached"])).toBe(beforeCachedDiff);
    });

    it("does not report success or move HEAD when a normal checked commit hook fails silently", async () => {
        const repo = await createRepository();
        await write(repo, "selected.txt", "selected\n");
        await write(repo, "unchecked.txt", "unchecked\n");
        await git(repo, ["add", "selected.txt", "unchecked.txt"]);
        const preCommitHook = path.join(repo, ".git", "hooks", "pre-commit");
        await writeFile(preCommitHook, ["#!/bin/sh", "exit 1", ""].join("\n"), "utf8");
        await chmod(preCommitHook, 0o755);
        const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
        const beforeIndex = await git(repo, ["ls-files", "-s"]);
        const beforeCachedDiff = await git(repo, ["diff", "--cached"]);
        await expect(git(repo, ["commit", "-m", "verify hook"])).rejects.toThrow();
        notificationsMock.showTimedInformationMessage.mockClear();

        await expect(
            commitSelected(repo, { message: "silent hook", paths: ["selected.txt"] }),
        ).rejects.toThrow();

        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(await git(repo, ["ls-files", "-s"])).toBe(beforeIndex);
        expect(await git(repo, ["diff", "--cached"])).toBe(beforeCachedDiff);
        expect(notificationsMock.showTimedInformationMessage).not.toHaveBeenCalledWith(
            "Committed successfully.",
        );
    });

    it("does not stage a copy source when only its destination is checked", async () => {
        const repo = await createRepository();
        await write(repo, "src.txt", "r".repeat(200));
        await git(repo, ["add", "src.txt"]);
        await git(repo, ["commit", "-m", "copy source"]);
        await git(repo, ["config", "status.renames", "copies"]);
        await write(repo, "src.txt", "s".repeat(200));
        await git(repo, ["add", "src.txt"]);
        await write(repo, "copy.txt", "s".repeat(200));
        await git(repo, ["add", "copy.txt"]);
        await write(repo, "src.txt", "u".repeat(200));

        await commitSelected(repo, { message: "copy", paths: ["copy.txt"] });

        expect(await changedPaths(repo)).toBe("A\tcopy.txt\n");
        expect(await git(repo, ["diff", "--name-only"])).toBe("src.txt\n");
    });

    it.skipIf(!FILENAMES_MAY_CONTAIN_RESERVED_CHARACTERS)(
        "treats wildcard and magic characters in checked filenames literally",
        async () => {
            const repo = await createRepository();
            const literalPath = "literal[abc]*?.txt";
            await write(repo, literalPath, "literal\n");

            await commitSelected(repo, { message: "literal", paths: [literalPath] });

            expect(await changedPaths(repo)).toBe(`A\t${literalPath}\n`);
        },
    );

    it("amends only checked paths", async () => {
        const repo = await createRepository();
        await git(repo, ["commit", "--allow-empty", "-m", "target"]);
        await write(repo, "tracked.txt", "amended\n");
        await write(repo, "staged-unchecked.txt", "unchecked\n");
        await git(repo, ["add", "staged-unchecked.txt"]);

        await commitSelected(repo, { message: "amended", amend: true, paths: ["tracked.txt"] });

        expect(await changedPaths(repo)).toBe("M\ttracked.txt\n");
    });

    it("amends a message with zero paths without sweeping staged content", async () => {
        const repo = await createRepository();
        await write(repo, "message-target.txt", "target\n");
        await git(repo, ["add", "message-target.txt"]);
        await git(repo, ["commit", "-m", "target"]);
        await write(repo, "staged-but-unchecked.txt", "unchecked\n");
        await git(repo, ["add", "staged-but-unchecked.txt"]);

        await commitSelected(repo, { message: "amended", amend: true, paths: [] });

        expect(await changedPaths(repo)).toBe("A\tmessage-target.txt\n");
        expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe(
            "staged-but-unchecked.txt\n",
        );
    });

    it("keeps a merge-in-progress commit as a bare whole-index commit", async () => {
        const repo = await createRepository();
        const mainBranch = (await git(repo, ["branch", "--show-current"])).trim();
        await git(repo, ["checkout", "-b", "feature"]);
        await write(repo, "feature.txt", "feature\n");
        await git(repo, ["add", "feature.txt"]);
        await git(repo, ["commit", "-m", "feature"]);
        await git(repo, ["checkout", mainBranch]);
        await write(repo, "main.txt", "main\n");
        await git(repo, ["add", "main.txt"]);
        await git(repo, ["commit", "-m", "main"]);
        await git(repo, ["merge", "--no-commit", "feature"]);

        await commitSelected(repo, { message: "merge", paths: ["feature.txt"] });

        expect(await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(
            "feature.txt\n",
        );
    });

    it("keeps a revert-conflict commit as a bare whole-index commit", async () => {
        const repo = await createRepository();
        await write(repo, "conflict.txt", "change\n");
        await git(repo, ["add", "conflict.txt"]);
        await git(repo, ["commit", "-m", "change"]);
        const change = (await git(repo, ["rev-parse", "HEAD"])).trim();
        await write(repo, "conflict.txt", "later\n");
        await git(repo, ["add", "conflict.txt"]);
        await git(repo, ["commit", "-m", "later"]);
        await expect(git(repo, ["revert", "--no-edit", change])).rejects.toThrow();
        await write(repo, "conflict.txt", "resolved\n");
        await git(repo, ["add", "conflict.txt"]);

        await commitSelected(repo, { message: "resolve revert", paths: ["conflict.txt"] });

        expect(await changedPaths(repo)).toBe("M\tconflict.txt\n");
        await expect(git(repo, ["rev-parse", "--verify", "REVERT_HEAD"])).rejects.toThrow();
    });
});
