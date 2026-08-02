import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import type { InteractiveRebaseRunDependencies } from "../../../src/git/interactiveRebase/run";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const deterministicGitEnvironment = {
    GIT_AUTHOR_NAME: "Rebase integration test",
    GIT_AUTHOR_EMAIL: "rebase-integration@example.invalid",
    GIT_COMMITTER_NAME: "Rebase integration test",
    GIT_COMMITTER_EMAIL: "rebase-integration@example.invalid",
    // Rebase recreates commits. Fixed dates keep those recreated object IDs stable across machines.
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00 +0000",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00 +0000",
} as const;

/** Removes every temporary directory registered by the current integration test file. */
export async function cleanTemporaryRepositories(): Promise<void> {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
}

/** Runs Git against an isolated fixture with a deterministic identity and commit timestamps. */
export async function git(repositoryRoot: string, args: readonly string[]): Promise<Buffer> {
    const result = await execFileAsync("git", [...args], {
        cwd: repositoryRoot,
        encoding: "buffer",
        env: { ...process.env, ...deterministicGitEnvironment },
    });
    return Buffer.from(result.stdout);
}

/** One named commit from the fixture's oldest-to-newest main-branch history. */
export interface RebaseFixtureCommit {
    readonly hash: string;
    readonly subject: string;
}

/** Reads current `main` history in oldest-to-newest order so it matches the interactive todo order. */
export async function readHistory(repositoryRoot: string): Promise<readonly RebaseFixtureCommit[]> {
    return (await git(repositoryRoot, ["log", "--reverse", "--format=%H%x00%s"]))
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((record) => {
            const separator = record.indexOf("\0");
            return { hash: record.slice(0, separator), subject: record.slice(separator + 1) };
        });
}

/** Real collaborators and explicitly named commit graph for one interactive-rebase integration test. */
export interface RebaseFixture {
    readonly root: string;
    readonly gitDir: string;
    readonly commits: readonly RebaseFixtureCommit[];
    readonly dependencies: InteractiveRebaseRunDependencies;
}

/** Creates the named four-commit main history used by every interactive-rebase integration scenario. */
export async function createRebaseFixture(helperScriptPath: string): Promise<RebaseFixture> {
    return createFixture(helperScriptPath, [
        ["root", "root.txt", "root\n"],
        ["first", "first.txt", "first\n"],
        ["second", "second.txt", "second\n"],
        ["third", "third.txt", "third\n"],
    ]);
}

/** Creates a rebase fixture whose reordered second and third commits conflict on `shared.txt`. */
export async function createConflictingRebaseFixture(
    helperScriptPath: string,
): Promise<RebaseFixture> {
    return createFixture(helperScriptPath, [
        ["root", "root.txt", "root\n"],
        ["first", "shared.txt", "one\ntwo\nthree\nfour\nbase\nsix\nseven\neight\nnine\nten\n"],
        ["second", "shared.txt", "one\ntwo\nthree\nfour\nsecond\nsix\nseven\neight\nnine\nten\n"],
        [
            "third",
            "shared.txt",
            "one\ntwo\nthree\nfour\nthird\nsix\nseven\neight\nnine\nthird ten\n",
        ],
        ["fourth", "fourth.txt", "fourth\n"],
    ]);
}

/** Creates one isolated main history and the production dependencies used to rebase it. */
async function createFixture(
    helperScriptPath: string,
    commitsToCreate: readonly (readonly [subject: string, filename: string, content: string])[],
): Promise<RebaseFixture> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-integration-"));
    directories.push(root);
    // Production storage is the extension's global storage directory, never the repository. Keeping
    // the fixture faithful also keeps the working tree assertable: storage inside the repo would
    // need a .gitignore, and an ignored directory hides a runner that dirties the tree.
    const storageRoot = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-storage-"));
    directories.push(storageRoot);
    await git(root, ["init", "-b", "main"]);

    for (const [subject, filename, content] of commitsToCreate) {
        await writeFile(path.join(root, filename), content);
        await git(root, ["add", filename]);
        await git(root, ["commit", "-m", subject]);
    }

    const gitDir = await resolveGitPath(root, "--git-dir");
    const commonDir = await resolveGitPath(root, "--git-common-dir");
    const executor = withPinnedEnvironment(new GitExecutor(root));
    const mutationGate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    return {
        root,
        gitDir,
        commits: await readHistory(root),
        dependencies: {
            executor,
            mutationGate,
            // The fixture is a standalone Git process with no extension-managed whole-index operation.
            hasWholeIndexOperationInProgress: async () => false,
            storageRoot,
            gitDir,
            commonDir,
            helperScriptPath,
            createSessionId: () => "00000000-0000-4000-8000-000000000001",
            now: () => new Date("2000-01-01T00:00:00.000Z"),
        },
    };
}

/** Resolves Git's worktree-aware directory responses against the isolated fixture root. */
async function resolveGitPath(
    repositoryRoot: string,
    argument: "--git-dir" | "--git-common-dir",
): Promise<string> {
    return path.resolve(
        repositoryRoot,
        (await git(repositoryRoot, ["rev-parse", argument])).toString("utf8").trim(),
    );
}

/**
 * Pins the deterministic identity and dates on every Git process the runner spawns.
 *
 * The runner drives the executor itself, so the fixture cannot pass `env` per call. Assigning to
 * `process.env` would reach it, but `process.env` is shared by every test file that lands in the
 * same worker, and `GitExecutor` documents that it never mutates it (`executor.ts:76`). Routing
 * through the executor's own per-invocation `env` seam keeps that guarantee true and confines the
 * pinning to this fixture. Spawned editor helpers inherit it from their parent Git process.
 */
function withPinnedEnvironment(executor: GitExecutor): Pick<GitExecutor, "run" | "runBinary"> {
    return {
        run: (args, options = {}) =>
            executor.run(args, {
                ...options,
                env: { ...options.env, ...deterministicGitEnvironment },
            }),
        runBinary: (args, options = {}) =>
            executor.runBinary(args, {
                ...options,
                env: { ...options.env, ...deterministicGitEnvironment },
            }),
    };
}
