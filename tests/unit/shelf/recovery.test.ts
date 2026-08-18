import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import {
    EMPTY_TREE_OID,
    purgeRecoverySnapshots,
    RecoverySafetyError,
    resumePendingShelfRecoveries,
    ShelfRecoveryFullError,
    ShelfReverter,
    ShelfRollbackRetainedError,
    type RevertCheckpoint,
} from "../../../src/shelf/recovery";
import { ShelfStore, type ShelfJournalPathProgress } from "../../../src/shelf/store";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function git(directory: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

async function gitOutput(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout;
}

async function fileFingerprint(target: string): Promise<string> {
    const details = await lstat(target);
    return `${(details.mode & 0o7777).toString(8)}:${createHash("sha256")
        .update(await readFile(target))
        .digest("hex")}`;
}

async function createReverter(
    options: {
        readonly checkpoint?: (checkpoint: RevertCheckpoint) => Promise<void>;
        readonly sameFilesystem?: () => Promise<boolean>;
        readonly commit?: boolean;
        readonly capacityAvailable?: () => Promise<boolean>;
    } = {},
) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-recovery-"));
    directories.push(repositoryRoot);
    await git(repositoryRoot, ["init"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n");
    if (options.commit ?? true) {
        await git(repositoryRoot, ["add", "tracked.txt"]);
        await git(repositoryRoot, ["commit", "-m", "base"]);
    }
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "change\n");
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(repositoryRoot, "shelf-storage"),
    });
    const executor = new GitExecutor(repositoryRoot);
    const gitOps = new GitOps(executor);
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const store = new ShelfStore(paths);
    return {
        repositoryRoot,
        gitOps,
        gate,
        store,
        reverter: new ShelfReverter({
            repositoryRoot,
            gitOps,
            gate,
            store,
            checkpoint: options.checkpoint,
            sameFilesystem: options.sameFilesystem,
            capacityAvailable: options.capacityAvailable,
        }),
    };
}

const checkpoints: readonly RevertCheckpoint[] = [
    "journal-created",
    "source-moved",
    "base-written",
    "index-updated",
    "recovery-verified",
    "journal-committed",
];
const preCommitCheckpoints = checkpoints.filter((checkpoint) => checkpoint !== "journal-committed");

describe("ShelfReverter", () => {
    it.each(preCommitCheckpoints)("rolls back a crash injected at %s", async (checkpoint) => {
        const { repositoryRoot, reverter } = await createReverter({
            checkpoint: async (current) => {
                if (current === checkpoint) throw new Error("crash at " + checkpoint);
            },
        });

        await expect(
            reverter.revert({
                transactionId: "crash-" + checkpoint,
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toThrow("crash at " + checkpoint);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("change\n");
    });

    it("never rolls back after the shelved journal has committed", async () => {
        const { repositoryRoot, reverter, store } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "journal-committed") throw new Error("crash after commit");
            },
        });

        await expect(
            reverter.revert({
                transactionId: "after-commit",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toThrow("crash after commit");

        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("base\n");
        expect((await store.readJournals())[0]).toMatchObject({
            id: "after-commit",
            state: "shelved",
        });
    });

    it("aborts EXDEV before a journal or worktree mutation", async () => {
        const { repositoryRoot, reverter } = await createReverter({
            sameFilesystem: async () => false,
        });

        await expect(
            reverter.revert({
                transactionId: "exdev",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toThrow("EXDEV");
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("change\n");
    });

    it("checks containment before fingerprinting or moving through a symlinked parent", async () => {
        let moved = false;
        const { repositoryRoot, reverter } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "source-moved") moved = true;
            },
        });
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(outside);
        await symlink(outside, path.join(repositoryRoot, "escape"));

        await expect(
            reverter.revert({
                transactionId: "symlink-parent",
                files: [
                    { relativePath: "escape/new/nested.txt", baseBytes: Buffer.from("base\n") },
                ],
            }),
        ).rejects.toThrow("escaped");

        expect(moved).toBe(false);
        await expect(
            readFile(path.join(outside, "new", "nested.txt"), "utf8"),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("continues rollback after one per-path restoration failure and retains that path", async () => {
        let root = "";
        let gitDirectory = "";
        let verified = 0;
        const { repositoryRoot, gitOps, reverter } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint !== "recovery-verified") return;
                verified += 1;
                if (verified !== 2) return;
                await rm(
                    path.join(
                        gitDirectory,
                        "intelligit",
                        "recovery",
                        "rollback-failure",
                        "blocked",
                        "one.txt",
                    ),
                );
                throw new Error("crash after both writes");
            },
        });
        root = repositoryRoot;
        gitDirectory = (await gitOps.getGitDirectories()).gitDir;
        await mkdir(path.join(root, "blocked"), { recursive: true });
        await mkdir(path.join(root, "safe"), { recursive: true });
        await writeFile(path.join(root, "blocked", "one.txt"), "base one\n");
        await writeFile(path.join(root, "safe", "two.txt"), "base two\n");
        await git(root, ["add", "blocked/one.txt", "safe/two.txt"]);
        await git(root, ["commit", "-m", "more base files"]);
        await writeFile(path.join(root, "blocked", "one.txt"), "change one\n");
        await writeFile(path.join(root, "safe", "two.txt"), "change two\n");

        const error = await reverter
            .revert({
                transactionId: "rollback-failure",
                files: [
                    { relativePath: "blocked/one.txt", baseBytes: Buffer.from("base one\n") },
                    { relativePath: "safe/two.txt", baseBytes: Buffer.from("base two\n") },
                ],
            })
            .catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfRollbackRetainedError);
        expect((error as ShelfRollbackRetainedError).retainedPaths).toEqual(["blocked/one.txt"]);
        expect(await readFile(path.join(root, "safe", "two.txt"), "utf8")).toBe("change two\n");
    });

    it("retains both states when a path reappears after its recovery move", async () => {
        let root = "";
        const { repositoryRoot, reverter } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "source-moved") {
                    await writeFile(path.join(root, "tracked.txt"), "third-party\n");
                }
            },
        });
        root = repositoryRoot;

        const error = await reverter
            .revert({
                transactionId: "reappeared",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            })
            .catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfRollbackRetainedError);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe(
            "third-party\n",
        );
        expect((error as ShelfRollbackRetainedError).retainedPaths).toEqual(["tracked.txt"]);
    });

    it("retains both states when third-party content changes a transaction-written path", async () => {
        let root = "";
        const { repositoryRoot, reverter } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "base-written") {
                    await writeFile(path.join(root, "tracked.txt"), "third-party\n");
                }
            },
        });
        root = repositoryRoot;

        const error = await reverter
            .revert({
                transactionId: "interference",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            })
            .catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfRollbackRetainedError);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe(
            "third-party\n",
        );
    });

    it("retains both states when third-party mode changes keep the same bytes", async () => {
        let root = "";
        const { repositoryRoot, reverter } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "base-written") {
                    await chmod(path.join(root, "tracked.txt"), 0o755);
                }
            },
        });
        root = repositoryRoot;

        const error = await reverter
            .revert({
                transactionId: "mode-interference",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            })
            .catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfRollbackRetainedError);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("base\n");
    });

    it("pins a normal base OID and uses the empty tree for an unborn repository", async () => {
        const normal = await createReverter();
        const baseOid = (await gitOutput(normal.repositoryRoot, ["rev-parse", "HEAD"])).trim();
        const normalResult = await normal.reverter.revert({
            transactionId: "normal",
            baseOid,
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });
        expect(normalResult.baseOid).toBe(baseOid);

        const unborn = await createReverter({ commit: false });
        const unbornResult = await unborn.reverter.revert({
            transactionId: "unborn",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });
        expect(unbornResult.baseOid).toBe(EMPTY_TREE_OID);
    });

    it("retains recovery when a raw index flag changes without changing its tree", async () => {
        let root = "";
        const { repositoryRoot, gitOps, gate, reverter, store } = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint !== "base-written") return;
                await git(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
            },
        });
        root = repositoryRoot;

        await expect(
            reverter.revert({
                transactionId: "default-index-guard",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toBeInstanceOf(ShelfRollbackRetainedError);
        expect(await gitOutput(repositoryRoot, ["ls-files", "-v", "--", "tracked.txt"])).toMatch(
            /^h /,
        );
        expect(
            await resumePendingShelfRecoveries({
                repositoryRoot,
                gitOps,
                gate,
                store,
            }),
        ).toEqual({ rolledBackIds: [], retainedIds: ["default-index-guard"] });
        expect((await store.readJournals())[0]).toMatchObject({
            id: "default-index-guard",
            state: "ghost",
        });
    });

    it("restores staged-only content to the base worktree and index through Git plumbing", async () => {
        const { repositoryRoot, reverter } = await createReverter();
        await git(repositoryRoot, ["add", "tracked.txt"]);

        await reverter.revert({
            transactionId: "staged-only",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });

        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await gitOutput(repositoryRoot, ["show", ":tracked.txt"])).toBe("base\n");
        expect(await gitOutput(repositoryRoot, ["diff", "--cached", "--", "tracked.txt"])).toBe("");
    });

    it("restores mixed staged and worktree content to the base index and keeps the worktree original", async () => {
        const { repositoryRoot, reverter } = await createReverter();
        await git(repositoryRoot, ["add", "tracked.txt"]);
        await writeFile(path.join(repositoryRoot, "tracked.txt"), "worktree only\n");

        const result = await reverter.revert({
            transactionId: "mixed-state",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });

        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await gitOutput(repositoryRoot, ["show", ":tracked.txt"])).toBe("base\n");
        expect(await readFile(path.join(result.recoveryDirectory, "tracked.txt"), "utf8")).toBe(
            "worktree only\n",
        );
    });

    it("reads a literal bracketed path from the pinned base tree", async () => {
        const { repositoryRoot, reverter } = await createReverter();
        const relativePath = "literal[bracket].txt";
        await writeFile(path.join(repositoryRoot, relativePath), "literal base\n");
        await git(repositoryRoot, ["add", "--", relativePath]);
        await git(repositoryRoot, ["commit", "-m", "literal path"]);
        await writeFile(path.join(repositoryRoot, relativePath), "literal change\n");

        await reverter.revert({ transactionId: "literal-path", files: [{ relativePath }] });

        expect(await readFile(path.join(repositoryRoot, relativePath), "utf8")).toBe(
            "literal base\n",
        );
        expect(await gitOutput(repositoryRoot, ["show", `:${relativePath}`])).toBe(
            "literal base\n",
        );
    });

    it("removes an added path from the index with Git index-info when the base lacks it", async () => {
        const { repositoryRoot, reverter } = await createReverter();
        const relativePath = "added.txt";
        await writeFile(path.join(repositoryRoot, relativePath), "added\n");
        await git(repositoryRoot, ["add", "--", relativePath]);

        const result = await reverter.revert({
            transactionId: "base-absent",
            files: [{ relativePath }],
        });

        await expect(
            readFile(path.join(repositoryRoot, relativePath), "utf8"),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await gitOutput(repositoryRoot, ["diff", "--cached", "--name-only"])).toBe("");
        expect(await readFile(path.join(result.recoveryDirectory, relativePath), "utf8")).toBe(
            "added\n",
        );
    });

    it("stages originals under the rev-parse Git directory and records copied recovery objects", async () => {
        const { gitOps, reverter, store } = await createReverter();
        const result = await reverter.revert({
            transactionId: "staging",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });
        const directories = await gitOps.getGitDirectories();

        expect(result.recoveryDirectory).toBe(
            path.join(directories.gitDir, "intelligit", "recovery", "staging"),
        );
        expect((await store.readJournals())[0]?.recoveryObjectHashes).toHaveLength(1);
    });

    it("recovers a real linked worktree under its rev-parse Git directory", async () => {
        const primary = await createReverter();
        const linkedWorktree = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-linked-"));
        directories.push(linkedWorktree);
        await rm(linkedWorktree, { recursive: true, force: true });
        await git(primary.repositoryRoot, [
            "worktree",
            "add",
            "-b",
            "shelf-recovery-linked",
            linkedWorktree,
            "HEAD",
        ]);
        await writeFile(path.join(linkedWorktree, "tracked.txt"), "linked change\n");
        const paths = await resolveShelfPaths({
            repositoryRoot: linkedWorktree,
            globalStoragePath: path.join(primary.repositoryRoot, "linked-shelf-storage"),
        });
        const executor = new GitExecutor(linkedWorktree);
        const gitOps = new GitOps(executor);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const store = new ShelfStore(paths);
        const reverter = new ShelfReverter({ repositoryRoot: linkedWorktree, gitOps, gate, store });

        const result = await reverter.revert({
            transactionId: "linked-worktree",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });
        const gitDirectories = await gitOps.getGitDirectories();

        expect((await lstat(path.join(linkedWorktree, ".git"))).isFile()).toBe(true);
        expect(result.recoveryDirectory).toBe(
            path.join(gitDirectories.gitDir, "intelligit", "recovery", "linked-worktree"),
        );
        expect(await readFile(path.join(linkedWorktree, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await readFile(path.join(result.recoveryDirectory, "tracked.txt"), "utf8")).toBe(
            "linked change\n",
        );
        expect(await gitOutput(linkedWorktree, ["show", ":tracked.txt"])).toBe("base\n");
    });

    it("refuses a new destructive revert when recovery capacity is full", async () => {
        const { repositoryRoot, reverter, store } = await createReverter({
            capacityAvailable: async () => false,
        });

        await expect(
            reverter.revert({
                transactionId: "full",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toBeInstanceOf(ShelfRecoveryFullError);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("change\n");
        expect(await store.readJournals()).toEqual([]);
    });

    it.each(preCommitCheckpoints)(
        "resumes a real pending journal created at %s",
        async (checkpoint) => {
            const subject = await createReverter();
            const transactionId = "restart-" + checkpoint;
            const target = path.join(subject.repositoryRoot, "tracked.txt");
            const gitDirectories = await subject.gitOps.getGitDirectories();
            const recoveryPath = path.join(
                gitDirectories.gitDir,
                "intelligit",
                "recovery",
                transactionId,
                "tracked.txt",
            );
            const baseEntry = {
                mode: "100644",
                oid: (
                    await gitOutput(subject.repositoryRoot, ["rev-parse", "HEAD:tracked.txt"])
                ).trim(),
            };
            await git(subject.repositoryRoot, ["add", "tracked.txt"]);
            const originalIndexEntry = {
                mode: "100644",
                oid: (
                    await gitOutput(subject.repositoryRoot, ["rev-parse", ":tracked.txt"])
                ).trim(),
            };
            let expectedIndexFingerprint = createHash("sha256")
                .update(
                    await gitOutput(subject.repositoryRoot, ["ls-files", "--stage", "-v", "-z"]),
                )
                .digest("hex");
            const pathProgress: Record<string, ShelfJournalPathProgress> = {};

            if (checkpoint !== "journal-created") {
                await mkdir(path.dirname(recoveryPath), { recursive: true });
                await rename(target, recoveryPath);
                const moved = {
                    phase: "moved" as const,
                    target,
                    recoveryPath,
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                    originalIndexEntry,
                    writtenIndexEntry: originalIndexEntry,
                };
                pathProgress["tracked.txt"] = moved;

                if (checkpoint !== "source-moved") {
                    await writeFile(target, "base\n");
                    const written = {
                        ...moved,
                        phase: "written" as const,
                        writtenFingerprint: await fileFingerprint(target),
                    };
                    pathProgress["tracked.txt"] = written;

                    if (checkpoint === "index-updated" || checkpoint === "recovery-verified") {
                        await git(subject.repositoryRoot, ["reset", "HEAD", "--", "tracked.txt"]);
                        pathProgress["tracked.txt"] = {
                            ...written,
                            writtenIndexEntry: baseEntry,
                        };
                        expectedIndexFingerprint = createHash("sha256")
                            .update(
                                await gitOutput(subject.repositoryRoot, [
                                    "ls-files",
                                    "--stage",
                                    "-v",
                                    "-z",
                                ]),
                            )
                            .digest("hex");
                    }
                }
            }
            await subject.store.writeJournal({
                id: transactionId,
                state: "shelvePendingRevert",
                pathProgress,
                expectedIndexFingerprint,
            });

            const first = await resumePendingShelfRecoveries({
                repositoryRoot: subject.repositoryRoot,
                gitOps: subject.gitOps,
                gate: subject.gate,
                store: subject.store,
            });
            const retry = await resumePendingShelfRecoveries({
                repositoryRoot: subject.repositoryRoot,
                gitOps: subject.gitOps,
                gate: subject.gate,
                store: subject.store,
            });

            expect(first).toEqual({ rolledBackIds: [transactionId], retainedIds: [] });
            expect(retry).toEqual({ rolledBackIds: [], retainedIds: [] });
            expect(await subject.store.readJournals()).toEqual([]);
            expect(await readFile(target, "utf8")).toBe("change\n");
            expect(await gitOutput(subject.repositoryRoot, ["show", ":tracked.txt"])).toBe(
                "change\n",
            );
        },
    );

    it("leaves committed shelved journals untouched during restart recovery", async () => {
        const subject = await createReverter();
        await subject.reverter.revert({
            transactionId: "restart-committed",
            files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
        });

        const result = await resumePendingShelfRecoveries({
            repositoryRoot: subject.repositoryRoot,
            gitOps: subject.gitOps,
            gate: subject.gate,
            store: subject.store,
        });

        expect(result).toEqual({ rolledBackIds: [], retainedIds: [] });
        expect((await subject.store.readJournals())[0]).toMatchObject({
            id: "restart-committed",
            state: "shelved",
        });
        expect(await readFile(path.join(subject.repositoryRoot, "tracked.txt"), "utf8")).toBe(
            "base\n",
        );
    });

    it("retains third-party content and recovery data during restart recovery", async () => {
        let root = "";
        const subject = await createReverter({
            checkpoint: async (checkpoint) => {
                if (checkpoint === "base-written") {
                    await writeFile(path.join(root, "tracked.txt"), "third-party\n");
                }
            },
        });
        root = subject.repositoryRoot;

        await expect(
            subject.reverter.revert({
                transactionId: "restart-retained",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toBeInstanceOf(ShelfRollbackRetainedError);

        const result = await resumePendingShelfRecoveries({
            repositoryRoot: subject.repositoryRoot,
            gitOps: subject.gitOps,
            gate: subject.gate,
            store: subject.store,
        });
        const directories = await subject.gitOps.getGitDirectories();

        expect(result).toEqual({ rolledBackIds: [], retainedIds: ["restart-retained"] });
        expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("third-party\n");
        expect(
            await readFile(
                path.join(
                    directories.gitDir,
                    "intelligit",
                    "recovery",
                    "restart-retained",
                    "tracked.txt",
                ),
                "utf8",
            ),
        ).toBe("change\n");
        expect((await subject.store.readJournals())[0]).toMatchObject({
            id: "restart-retained",
            state: "ghost",
        });
    });

    it("marks a pending journal ghost when its moved original is missing", async () => {
        const subject = await createReverter();
        const transactionId = "missing-recovery";
        const target = path.join(subject.repositoryRoot, "tracked.txt");
        const gitDirectories = await subject.gitOps.getGitDirectories();
        const originalIndexEntry = {
            mode: "100644",
            oid: (await gitOutput(subject.repositoryRoot, ["rev-parse", ":tracked.txt"])).trim(),
        };
        const expectedIndexFingerprint = createHash("sha256")
            .update(await gitOutput(subject.repositoryRoot, ["ls-files", "--stage", "-v", "-z"]))
            .digest("hex");
        await subject.store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint,
            pathProgress: {
                "tracked.txt": {
                    phase: "moved",
                    target,
                    recoveryPath: path.join(
                        gitDirectories.gitDir,
                        "intelligit",
                        "recovery",
                        transactionId,
                        "tracked.txt",
                    ),
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                    originalIndexEntry,
                    writtenIndexEntry: originalIndexEntry,
                },
            },
        });

        const result = await resumePendingShelfRecoveries({
            repositoryRoot: subject.repositoryRoot,
            gitOps: subject.gitOps,
            gate: subject.gate,
            store: subject.store,
        });

        expect(result).toEqual({ rolledBackIds: [], retainedIds: [transactionId] });
        expect(await readFile(target, "utf8")).toBe("change\n");
        expect((await subject.store.readJournals())[0]).toMatchObject({
            id: transactionId,
            state: "ghost",
        });
    });

    it("purges recovery only through its explicit retention-aware command", async () => {
        const { gitOps } = await createReverter();
        const directories = await gitOps.getGitDirectories();
        const recovery = path.join(directories.gitDir, "intelligit", "recovery", "expired");
        await mkdir(recovery, { recursive: true });
        await writeFile(path.join(recovery, "original"), "bytes");

        expect(
            await purgeRecoverySnapshots({
                gitDir: directories.gitDir,
                minimumRetentionMs: 0,
            }),
        ).toEqual(["expired"]);
    });

    it("refuses a symlinked recovery root during purge", async () => {
        const { gitOps } = await createReverter();
        const gitDirectories = await gitOps.getGitDirectories();
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-purge-outside-"));
        directories.push(outside);
        const recoveryRoot = path.join(gitDirectories.gitDir, "intelligit", "recovery");
        await mkdir(path.dirname(recoveryRoot), { recursive: true });
        await symlink(outside, recoveryRoot);

        await expect(
            purgeRecoverySnapshots({ gitDir: gitDirectories.gitDir, minimumRetentionMs: 0 }),
        ).rejects.toBeInstanceOf(RecoverySafetyError);
        expect(await readdir(outside)).toEqual([]);
    });
});
