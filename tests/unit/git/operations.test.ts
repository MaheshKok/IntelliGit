import { execFile } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import {
    GitOps,
    type ActiveOperationKind,
    type DiffForPathsResult,
} from "../../../src/git/operations";
import type { WorkingFile } from "../../../src/types";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function git(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
        cwd: directory,
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

/** Captures Git's expected no-index add patch, whose exit code is one when a diff exists. */
async function gitNoIndexAddDiff(directory: string, relativePath: string): Promise<string> {
    try {
        await execFileAsync(
            "git",
            ["diff", "--no-index", "--full-index", "--no-color", "--", "/dev/null", relativePath],
            { cwd: directory },
        );
    } catch (error) {
        const stdout = (error as { stdout?: string | Buffer }).stdout;
        if (stdout !== undefined) return stdout.toString();
        throw error;
    }
    throw new Error("Expected Git no-index add diff to report a difference.");
}

async function createGitRepository(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-operation-state-"));
    directories.push(root);
    await git(root, ["init"]);
    return root;
}

/** Writes and commits an initial tracked file so tests can exercise HEAD-relative diffs. */
async function commitFile(root: string, relativePath: string, content: string): Promise<void> {
    await writeFile(path.join(root, relativePath), content);
    await git(root, ["add", "--", relativePath]);
    await git(root, ["commit", "-m", "base"]);
}

/** Builds a GitOps facade rooted in the temporary repository. */
function gitOpsFor(root: string): GitOps {
    return new GitOps(new GitExecutor(root));
}

/** Asserts every requested path is either present in patch text or explicitly summarized. */
function expectPathsRepresented(result: DiffForPathsResult, paths: string[]): void {
    expect(
        paths.every(
            (filePath) =>
                result.summarizedPaths.includes(filePath) || result.diff.includes(filePath),
        ),
    ).toBe(true);
}

/** Resolves the absolute path of a repository's live index file the same way production code does. */
async function getIndexPath(root: string): Promise<string> {
    const reported = (await git(root, ["rev-parse", "--git-path", "index"])).trim();
    return path.isAbsolute(reported) ? reported : path.resolve(root, reported);
}

/** Lists `withIndexSnapshot`'s temp-directory names currently present under the OS temp root. */
async function listIndexSnapshotDirs(): Promise<Set<string>> {
    const entries = await readdir(tmpdir());
    return new Set(entries.filter((name) => name.startsWith("intelligit-index-")));
}

describe("GitOps.getGitDirectories", () => {
    it("resolves Git-managed directories and the normalized repository root", async () => {
        const directories = await new GitOps(new GitExecutor(process.cwd())).getGitDirectories();

        expect(directories.gitDir).toMatch(/\.git/);
        expect(directories.commonDir).toMatch(/\.git/);
        expect(directories.root).toBe(path.resolve(process.cwd()));
    });

    it("resolves linked-worktree directories when .git is a file", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-worktree-"));
        directories.push(root);
        const linked = path.join(root, "linked");
        await git(root, ["init"]);
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["worktree", "add", "--detach", linked]);

        const gitDirectories = await new GitOps(new GitExecutor(linked)).getGitDirectories();

        expect(gitDirectories.gitDir).toContain(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        expect(gitDirectories.commonDir).toBe(path.join(await realpath(root), ".git"));
        expect(gitDirectories.root).toBe(await realpath(linked));
    });
});

describe("GitOps.hasWholeIndexOperationInProgress", () => {
    it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
        "detects the %s marker",
        async (marker) => {
            const root = await createGitRepository();
            await writeFile(path.join(root, ".git", marker), "state\n");

            await expect(
                new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
            ).resolves.toBe(true);
        },
    );

    it.each(["rebase-merge", "rebase-apply"])("detects the %s directory", async (directory) => {
        const root = await createGitRepository();
        await mkdir(path.join(root, ".git", directory));

        await expect(
            new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(true);
    });

    it("resolves a linked worktree gitdir file before checking markers", async () => {
        const root = await createGitRepository();
        const linked = path.join(root, "linked");
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["worktree", "add", "--detach", linked]);
        const reportedGitDir = (await git(linked, ["rev-parse", "--git-dir"])).trim();
        const gitDir = path.isAbsolute(reportedGitDir)
            ? reportedGitDir
            : path.resolve(linked, reportedGitDir);
        await writeFile(path.join(gitDir, "CHERRY_PICK_HEAD"), "state\n");

        await expect(
            new GitOps(new GitExecutor(linked)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(true);
    });

    it("returns false for a clean repository", async () => {
        const root = await createGitRepository();

        await expect(
            new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(false);
    });
});

describe("GitOps.getActiveOperation", () => {
    it.each([
        ["MERGE_HEAD", "merge"],
        ["CHERRY_PICK_HEAD", "cherry-pick"],
        ["REVERT_HEAD", "revert"],
        ["rebase-merge", "rebase"],
        ["rebase-apply", "rebase"],
    ] as const satisfies readonly [string, ActiveOperationKind][])(
        "derives %s as %s",
        async (marker, expected) => {
            const root = await createGitRepository();
            const target = path.join(root, ".git", marker);
            if (marker.startsWith("rebase-")) await mkdir(target);
            else await writeFile(target, "state\n");

            await expect(gitOpsFor(root).getActiveOperation()).resolves.toBe(expected);
        },
    );

    it.each([
        [["rebase-merge", "MERGE_HEAD"], "rebase"],
        [["rebase-apply", "CHERRY_PICK_HEAD"], "rebase"],
        [["MERGE_HEAD", "REVERT_HEAD"], "merge"],
        [["MERGE_HEAD", "CHERRY_PICK_HEAD"], "merge"],
        [["CHERRY_PICK_HEAD", "REVERT_HEAD"], "cherry-pick"],
        [
            ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"],
            "rebase",
        ],
    ] as const satisfies readonly [readonly string[], ActiveOperationKind][])(
        "uses documented precedence for %j",
        async (markers, expected) => {
            const root = await createGitRepository();
            await Promise.all(
                markers.map(async (marker) => {
                    const target = path.join(root, ".git", marker);
                    if (marker.startsWith("rebase-")) await mkdir(target);
                    else await writeFile(target, "state\n");
                }),
            );

            await expect(gitOpsFor(root).getActiveOperation()).resolves.toBe(expected);
        },
    );

    it("resolves a linked worktree gitdir file before deriving the operation", async () => {
        const root = await createGitRepository();
        const linked = path.join(root, "linked");
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["worktree", "add", "--detach", linked]);
        const reportedGitDir = (await git(linked, ["rev-parse", "--git-dir"])).trim();
        const gitDir = path.isAbsolute(reportedGitDir)
            ? reportedGitDir
            : path.resolve(linked, reportedGitDir);
        await writeFile(path.join(gitDir, "REVERT_HEAD"), "state\n");

        await expect(gitOpsFor(linked).getActiveOperation()).resolves.toBe("revert");
    });

    it("returns none for a clean repository", async () => {
        const root = await createGitRepository();

        await expect(gitOpsFor(root).getActiveOperation()).resolves.toBe("none");
    });
});

describe("GitOps.withIndexSnapshot", () => {
    it("restores the pre-operation index bytes and cleans up the temp dir on success", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        const tempDirsBefore = await listIndexSnapshotDirs();

        const result = await gitOps.withIndexSnapshot(async () => {
            await writeFile(path.join(root, "b.txt"), "b\n");
            await git(root, ["add", "b.txt"]);
            return "operation-result";
        });

        expect(result).toBe("operation-result");
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
        // Other test workers create snapshot dirs concurrently in the shared
        // tmpdir; retry so only a dir this test leaks permanently fails.
        let leakedDirs: string[] = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const tempDirsAfter = await listIndexSnapshotDirs();
            leakedDirs = [...tempDirsAfter].filter((dir) => !tempDirsBefore.has(dir));
            if (leakedDirs.length === 0) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(leakedDirs).toEqual([]);
    });

    it("restores the index and rethrows the same error when the operation fails", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        const operationError = new Error("operation boom");

        await expect(
            gitOps.withIndexSnapshot(async () => {
                await writeFile(path.join(root, "b.txt"), "b\n");
                await git(root, ["add", "b.txt"]);
                throw operationError;
            }),
        ).rejects.toBe(operationError);

        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
    });

    it("preserves the operation error as the cause when restore also fails after the operation fails", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const operationError = new Error("operation boom");

        const caught: unknown = await gitOps
            .withIndexSnapshot(async () => {
                await rm(path.join(root, ".git"), { recursive: true, force: true });
                throw operationError;
            })
            .catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(Error);
        const error = caught as Error;
        expect(error.message).toContain("operation boom");
        expect(error.message.toLowerCase()).toContain("restor");
        expect(error.cause).toBe(operationError);
    });

    it("reports that the commit succeeded but the index restore failed", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);

        const caught: unknown = await gitOps
            .withIndexSnapshot(async () => {
                await rm(path.join(root, ".git"), { recursive: true, force: true });
                return "operation-result";
            })
            .catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(Error);
        const error = caught as Error;
        expect(error.message.toLowerCase()).toContain("commit succeeded");
        expect(error.message.toLowerCase()).toContain("restor");
    });

    it("falls back to a direct copy when a concurrent Git process holds the index .lock file", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        await writeFile(`${indexPath}.lock`, "held-by-another-git-process");

        const result = await gitOps.withIndexSnapshot(async () => {
            // A real `git` write here would also block on the planted `.lock` file, so mutate
            // the index bytes directly to isolate this test to the restore fallback itself.
            await writeFile(indexPath, "mutated-index-bytes-outside-git");
            return "operation-result";
        });

        expect(result).toBe("operation-result");
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
    });
});

describe("GitOps.getDiffForPaths", () => {
    it("assembles tracked, deleted, and untracked checked paths", async () => {
        const root = await createGitRepository();
        await commitFile(root, "tracked.txt", "before\n");
        await commitFile(root, "deleted.txt", "remove me\n");
        await writeFile(path.join(root, "tracked.txt"), "after\n");
        await rm(path.join(root, "deleted.txt"));
        await writeFile(path.join(root, "untracked.txt"), "new file\n");

        const result = await gitOpsFor(root).getDiffForPaths([
            "tracked.txt",
            "deleted.txt",
            "untracked.txt",
        ]);

        expect(result.diff).toContain("tracked.txt");
        expect(result.diff).toContain("deleted.txt");
        expect(result.diff).toContain("untracked.txt");
        expect(result.diff).toContain("+after");
        expect(result.diff).toContain("+new file");
        expect(result.summarizedPaths).toEqual([]);
        expect(result.truncated).toBe(false);
    });

    it("expands a selected rename destination to its porcelain source path", async () => {
        const root = await createGitRepository();
        await commitFile(root, "source.txt", "before rename\n");
        await git(root, ["mv", "source.txt", "destination.txt"]);

        const result = await gitOpsFor(root).getDiffForPaths(["destination.txt"]);

        expect(result.diff).toContain("source.txt");
        expect(result.diff).toContain("destination.txt");
    });

    it("does not expand a selected copy destination to an independently modified source", async () => {
        const root = await createGitRepository();
        const original = "shared copy content\n".repeat(100);
        await commitFile(root, "source.txt", original);
        await git(root, ["config", "status.renames", "copies"]);
        await writeFile(path.join(root, "source.txt"), `${original}SOURCE_SENTINEL\n`);
        await writeFile(path.join(root, "destination.txt"), `${original}DESTINATION_CHANGE\n`);
        await git(root, ["add", "source.txt", "destination.txt"]);
        const gitOps = gitOpsFor(root);

        await expect(gitOps.getStatus({ withStats: false })).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: "destination.txt",
                    status: "C",
                    sourcePath: "source.txt",
                }),
            ]),
        );

        const result = await gitOps.getDiffForPaths(["destination.txt"]);

        expect(result.diff).toContain("DESTINATION_CHANGE");
        expect(result.diff).not.toContain("SOURCE_SENTINEL");
    });

    it("uses a supplied validated status snapshot instead of a later live status", async () => {
        const root = await createGitRepository();
        await commitFile(root, "source.txt", "before rename\n");
        await git(root, ["mv", "source.txt", "destination.txt"]);
        const gitOps = gitOpsFor(root);
        const validatedStatusSnapshot: readonly WorkingFile[] = [
            {
                path: "destination.txt",
                sourcePath: "source.txt",
                status: "R",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ];
        const getStatus = vi.spyOn(gitOps, "getStatus").mockResolvedValue([]);

        const result = await gitOps.getDiffForPaths(["destination.txt"], {
            validatedStatusSnapshot,
        });

        expect(getStatus).not.toHaveBeenCalled();
        expect(result.diff).toContain("source.txt");
        expect(result.diff).toContain("destination.txt");
    });

    it("keeps supplied untracked classification authoritative over a later live status", async () => {
        const root = await createGitRepository();
        const filePath = "snapshot-untracked.txt";
        await writeFile(path.join(root, filePath), "snapshot untracked content\n");
        const gitOps = gitOpsFor(root);
        const validatedStatusSnapshot: readonly WorkingFile[] = [
            {
                path: filePath,
                status: "?",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ];
        const getStatus = vi.spyOn(gitOps, "getStatus").mockResolvedValue([
            {
                path: filePath,
                status: "M",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ]);

        const result = await gitOps.getDiffForPaths([filePath], { validatedStatusSnapshot });

        expect(getStatus).not.toHaveBeenCalled();
        expect(result.diff).toContain(`diff --git a/${filePath} b/${filePath}`);
        expect(result.diff).toContain("new file mode 100644");
        expect(result.diff).toContain("--- /dev/null");
        expect(result.diff).toContain(`+++ b/${filePath}`);
        expect(result.diff).toContain("+snapshot untracked content");
    });

    it("treats wildcard-magic filenames as literal pathspecs", async () => {
        const root = await createGitRepository();
        await commitFile(root, "literal[ab].txt", "before literal\n");
        await commitFile(root, "literala.txt", "before expanded\n");
        await writeFile(path.join(root, "literal[ab].txt"), "after literal\n");
        await writeFile(path.join(root, "literala.txt"), "after expanded\n");

        const result = await gitOpsFor(root).getDiffForPaths(["literal[ab].txt"]);

        expect(result.diff).toContain("after literal");
        expect(result.diff).not.toContain("after expanded");
    });

    it("uses a runtime empty tree for an unborn SHA-1 repository", async () => {
        const root = await createGitRepository();
        await writeFile(path.join(root, "first.txt"), "first commit\n");
        await git(root, ["add", "first.txt"]);

        const result = await gitOpsFor(root).getDiffForPaths(["first.txt"]);

        expect(result.diff).toContain("first.txt");
        expect(result.diff).toContain("+first commit");
    });

    it("raises a typed error for an unborn zero-path amend request", async () => {
        const root = await createGitRepository();

        await expect(
            gitOpsFor(root).getDiffForPaths([], { includeHead: true }),
        ).rejects.toMatchObject({
            name: "UnbornHeadDiffError",
        });
    });

    it("uses a runtime empty tree for an unborn SHA-256 repository when supported", async (context) => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-sha256-"));
        directories.push(root);
        try {
            await git(root, ["init", "--object-format=sha256"]);
        } catch {
            console.warn(
                "Skipping SHA-256 diff test: this Git build lacks --object-format=sha256.",
            );
            context.skip();
            return;
        }
        await writeFile(path.join(root, "first.txt"), "sha256 first commit\n");
        await git(root, ["add", "first.txt"]);

        const result = await gitOpsFor(root).getDiffForPaths(["first.txt"]);

        expect(result.diff).toContain("+sha256 first commit");
    });

    it("includes the current HEAD patch for amend requests, including zero checked paths", async () => {
        const root = await createGitRepository();
        await commitFile(root, "committed.txt", "commit contents\n");

        const withPath = await gitOpsFor(root).getDiffForPaths(["committed.txt"], {
            includeHead: true,
        });
        const headOnly = await gitOpsFor(root).getDiffForPaths([], { includeHead: true });

        expect(withPath.diff).toContain("commit contents");
        expect(headOnly.diff).toContain("commit contents");
        expect(headOnly.diff).toContain("committed.txt");
    });

    it("summarizes per-file and bounded-untracked content instead of buffering it", async () => {
        const root = await createGitRepository();
        await commitFile(root, "large-tracked.txt", "before\n");
        await writeFile(path.join(root, "large-tracked.txt"), `${"x".repeat(70_000)}\n`);
        await writeFile(path.join(root, "large-untracked.txt"), `${"y".repeat(70_000)}\n`);

        const result = await gitOpsFor(root).getDiffForPaths([
            "large-tracked.txt",
            "large-untracked.txt",
        ]);

        expect(result.summarizedPaths).toEqual(
            expect.arrayContaining(["large-tracked.txt", "large-untracked.txt"]),
        );
        expect(result.truncated).toBe(true);
        expect(result.diff).not.toContain("x".repeat(70_000));
        expect(result.diff).not.toContain("y".repeat(70_000));
        expect(result.diff).toContain(
            "[Diff omitted for large-tracked.txt: +1/-1 lines, per-file byte budget reached.]",
        );
    });

    it("diffs an untracked symlink itself without opening its target", async () => {
        const root = await createGitRepository();
        await symlink("missing-target", path.join(root, "broken-link"));

        const result = await gitOpsFor(root).getDiffForPaths(["broken-link"]);

        expect(result.diff).toBe(await gitNoIndexAddDiff(root, "broken-link"));
    });

    it("represents an untracked symlink to a directory", async () => {
        const root = await createGitRepository();
        const paths = ["directory-link"];
        await mkdir(path.join(root, "target-directory"));
        await symlink("target-directory", path.join(root, paths[0]));

        const result = await gitOpsFor(root).getDiffForPaths(paths);

        expect(result.diff).toContain("new file mode 120000");
        expect(result.diff).toContain("+target-directory");
        expectPathsRepresented(result, paths);
    });

    it("represents an untracked symlink to a FIFO without opening it", async () => {
        const root = await createGitRepository();
        const paths = ["fifo-link"];
        await execFileAsync("mkfifo", [path.join(root, "target-fifo")]);
        await symlink("target-fifo", path.join(root, paths[0]));

        const startedAt = performance.now();
        const result = await gitOpsFor(root).getDiffForPaths(paths);

        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(result.diff).toContain("new file mode 120000");
        expect(result.diff).toContain("+target-fifo");
        expectPathsRepresented(result, paths);
    }, 10_000);

    it("represents regular files and every untracked symlink target type", async () => {
        const root = await createGitRepository();
        const paths = ["regular.txt", "broken-link", "file-link", "directory-link"];
        await writeFile(path.join(root, "regular.txt"), "regular contents\\n");
        await symlink("missing-target", path.join(root, "broken-link"));
        await writeFile(path.join(root, "regular-target.txt"), "target contents\\n");
        await symlink("regular-target.txt", path.join(root, "file-link"));
        await mkdir(path.join(root, "directory-target"));
        await symlink("directory-target", path.join(root, "directory-link"));

        const startedAt = performance.now();
        const result = await gitOpsFor(root).getDiffForPaths(paths);

        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expectPathsRepresented(result, paths);
    }, 10_000);

    it("summarizes an untracked path removed after the status snapshot and continues", async () => {
        const root = await createGitRepository();
        await commitFile(root, "tracked.txt", "before\\n");
        await writeFile(path.join(root, "tracked.txt"), "after\\n");
        await writeFile(path.join(root, "vanished.txt"), "gone\\n");
        const gitOps = gitOpsFor(root);
        const getStatus = gitOps.getStatus.bind(gitOps);
        gitOps.getStatus = async (options) => {
            const status = await getStatus(options);
            await rm(path.join(root, "vanished.txt"));
            return status;
        };

        const result = await gitOps.getDiffForPaths(["tracked.txt", "vanished.txt"]);

        expect(result.diff).toContain("+after");
        expect(result.diff).toContain("[vanished.txt was removed while assembling the diff.]");
        expect(result.summarizedPaths).toContain("vanished.txt");
    });

    it("stops acquiring patches after the cumulative byte budget", async () => {
        const root = await createGitRepository();
        const paths = Array.from({ length: 5 }, (_, index) => `large-${index}.txt`);
        for (const filePath of paths) {
            await commitFile(root, filePath, "before\n");
            await writeFile(path.join(root, filePath), `${filePath}-${"z".repeat(60_000)}\n`);
        }

        const result = await gitOpsFor(root).getDiffForPaths(paths);

        expect(result.truncated).toBe(true);
        expect(result.summarizedPaths.length).toBeGreaterThan(0);
        expect(result.diff).not.toContain(`large-4.txt-${"z".repeat(60_000)}`);
    });

    it("does not charge discarded truncated bytes against later patch budget", async () => {
        const root = await createGitRepository();
        const paths = [
            "truncated.txt",
            "middle-one.txt",
            "middle-two.txt",
            "middle-three.txt",
            "later.txt",
        ];
        for (const filePath of paths) {
            await commitFile(root, filePath, "before\\n");
            await writeFile(path.join(root, filePath), "after\\n");
        }
        const gitOps = gitOpsFor(root);
        const executor = (gitOps as unknown as { executor: GitExecutor }).executor;
        const runBinary = executor.runBinary.bind(executor);
        const laterPatch = Buffer.from(
            `diff --git a/later.txt b/later.txt\\n${"x".repeat(60_000)}`,
        );
        executor.runBinary = async (args, options) => {
            if (
                args[0] === "--literal-pathspecs" &&
                args[1] === "diff" &&
                args[2] === "--full-index"
            ) {
                if (args.at(-1) === "truncated.txt") {
                    return {
                        stdout: Buffer.alloc(options.maxOutputBytes ?? 0),
                        stderr: Buffer.alloc(0),
                        exitCode: 0,
                        truncated: true,
                    };
                }
                if (args.at(-1) === "later.txt") {
                    const maxOutputBytes = options.maxOutputBytes ?? 0;
                    return {
                        stdout:
                            maxOutputBytes >= laterPatch.length
                                ? laterPatch
                                : laterPatch.subarray(0, maxOutputBytes),
                        stderr: Buffer.alloc(0),
                        exitCode: 0,
                        truncated: maxOutputBytes < laterPatch.length,
                    };
                }
                return {
                    stdout: Buffer.alloc(60_000),
                    stderr: Buffer.alloc(0),
                    exitCode: 0,
                    truncated: false,
                };
            }
            return runBinary(args, options);
        };

        const result = await gitOps.getDiffForPaths(paths);

        expect(result.summarizedPaths).toContain("truncated.txt");
        expect(result.diff).toContain("diff --git a/later.txt b/later.txt");
    });

    it("labels an applied cumulative cap at the per-file boundary", async () => {
        const root = await createGitRepository();
        const paths = ["first.txt", "second.txt", "third.txt", "boundary.txt"];
        for (const filePath of paths) {
            await commitFile(root, filePath, "before\\n");
            await writeFile(path.join(root, filePath), "after\\n");
        }
        const gitOps = gitOpsFor(root);
        const executor = (gitOps as unknown as { executor: GitExecutor }).executor;
        const runBinary = executor.runBinary.bind(executor);
        executor.runBinary = async (args, options) => {
            if (
                args[0] === "--literal-pathspecs" &&
                args[1] === "diff" &&
                args[2] === "--numstat"
            ) {
                return {
                    stdout: Buffer.alloc(0),
                    stderr: Buffer.alloc(0),
                    exitCode: 0,
                    truncated: false,
                };
            }
            if (
                args[0] === "--literal-pathspecs" &&
                args[1] === "diff" &&
                args[2] === "--full-index"
            ) {
                if (args.at(-1) === "boundary.txt") {
                    return {
                        stdout: Buffer.alloc(options.maxOutputBytes ?? 0),
                        stderr: Buffer.alloc(0),
                        exitCode: 0,
                        truncated: true,
                    };
                }
                return {
                    stdout: Buffer.alloc(64 * 1024),
                    stderr: Buffer.alloc(0),
                    exitCode: 0,
                    truncated: false,
                };
            }
            return runBinary(args, options);
        };

        const result = await gitOps.getDiffForPaths(paths);

        expect(result.diff).toContain(
            "[Diff omitted for boundary.txt: cumulative byte budget reached.]",
        );
    });

    it("does not starve an untracked symlink after discarded truncated patches", async () => {
        const root = await createGitRepository();
        const trackedPaths = Array.from({ length: 6 }, (_, index) => `large-${index}.txt`);
        for (const filePath of trackedPaths) {
            await commitFile(root, filePath, "before\n");
            await writeFile(path.join(root, filePath), `${"z".repeat(400_000)}\n`);
        }
        await symlink("late-target", path.join(root, "late-link"));
        const gitOps = gitOpsFor(root);
        const executor = (gitOps as unknown as { executor: GitExecutor }).executor;
        const runBinary = executor.runBinary.bind(executor);
        let hashObjectSpawns = 0;
        executor.runBinary = async (args, options) => {
            if (args[0] === "hash-object" && args[1] === "--stdin") {
                hashObjectSpawns += 1;
            }
            return runBinary(args, options);
        };

        const result = await gitOps.getDiffForPaths([...trackedPaths, "late-link"]);

        expect(result.summarizedPaths).not.toContain("late-link");
        expect(result.diff).toContain("diff --git a/late-link b/late-link");
        expect(hashObjectSpawns).toBe(1);
    });

    it("represents an untracked symlink whose target text contains embedded newlines", async () => {
        const root = await createGitRepository();
        await symlink("tgt\nwith\nnewlines", path.join(root, "nl-link"));

        const result = await gitOpsFor(root).getDiffForPaths(["nl-link"]);

        // Ground truth captured from real Git *after* the untracked synthesis above, so this
        // never depends on a hardcoded object ID.
        await git(root, ["add", "--", "nl-link"]);
        const expected = await git(root, ["diff", "--cached", "--full-index", "--no-color"]);
        expect(result.diff).toBe(expected);
    });

    it("C-quotes a synthesized header for a non-ASCII symlink path", async () => {
        const root = await createGitRepository();
        await symlink("target-value", path.join(root, "naïve-link"));

        const result = await gitOpsFor(root).getDiffForPaths(["naïve-link"]);

        await git(root, ["add", "--", "naïve-link"]);
        const expected = await git(root, ["diff", "--cached", "--full-index", "--no-color"]);
        expect(result.diff).toBe(expected);
    });

    it("C-quotes a synthesized header for a symlink path containing a double quote", async () => {
        const root = await createGitRepository();
        await symlink("target-value", path.join(root, 'quote"link'));

        const result = await gitOpsFor(root).getDiffForPaths(['quote"link']);

        await git(root, ["add", "--", 'quote"link']);
        const expected = await git(root, ["diff", "--cached", "--full-index", "--no-color"]);
        expect(result.diff).toBe(expected);
    });

    it("appends a trailing tab to the synthesized +++ line for an unquoted symlink path containing a space", async () => {
        const root = await createGitRepository();
        await symlink("target-value", path.join(root, "space name-link"));

        const result = await gitOpsFor(root).getDiffForPaths(["space name-link"]);

        await git(root, ["add", "--", "space name-link"]);
        const expected = await git(root, ["diff", "--cached", "--full-index", "--no-color"]);
        expect(result.diff).toBe(expected);
    });
});
