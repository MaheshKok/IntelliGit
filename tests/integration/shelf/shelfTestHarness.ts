import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfReverter } from "../../../src/shelf/recovery";
import { type ShelfStoreOptions, ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

/** Removes every temporary repository registered by the current integration test file. */
export async function cleanTemporaryRepositories(): Promise<void> {
    await removeScratchDirectories(...directories.splice(0));
}

/** Runs Git against an isolated fixture with a deterministic test identity. */
export async function git(repositoryRoot: string, args: readonly string[]): Promise<Buffer> {
    const result = await execFileAsync("git", [...args], {
        cwd: repositoryRoot,
        encoding: "buffer",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Shelf integration test",
            GIT_AUTHOR_EMAIL: "shelf-integration@example.invalid",
            GIT_COMMITTER_NAME: "Shelf integration test",
            GIT_COMMITTER_EMAIL: "shelf-integration@example.invalid",
        },
    });
    return Buffer.from(result.stdout);
}

/** Captures Git's complete NUL-delimited index metadata for byte-identity assertions. */
export async function indexSnapshot(repositoryRoot: string): Promise<Buffer> {
    return git(repositoryRoot, ["ls-files", "--stage", "-v", "-z"]);
}

/** Captures the cached diff used to assert exact staged-layer reconstruction. */
export async function cachedDiff(repositoryRoot: string): Promise<Buffer> {
    return git(repositoryRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]);
}

/** Reads a repository file as bytes without normalizing line endings. */
export async function fileBytes(repositoryRoot: string, relativePath: string): Promise<Buffer> {
    return readFile(path.join(repositoryRoot, relativePath));
}

/** Resolves the actual Git directory, including the per-worktree directory behind a .git file. */
export async function gitDirectory(repositoryRoot: string): Promise<string> {
    const result = (await git(repositoryRoot, ["rev-parse", "--git-dir"])).toString("utf8").trim();
    return path.resolve(repositoryRoot, result);
}

/** Creates a real ShelfService with real Git, filesystem, store, and repository-lock collaborators. */
export async function createShelfFixture(
    options: {
        readonly initialFiles?: Readonly<Record<string, string | Buffer>>;
        readonly commit?: boolean;
        readonly recordBaseRevisions?: boolean;
        readonly storeOptions?: ShelfStoreOptions;
        readonly reverter?: ShelfReverter;
        readonly storageRoot?: string;
    } = {},
): Promise<{
    readonly root: string;
    readonly storageRoot: string;
    readonly executor: GitExecutor;
    readonly store: ShelfStore;
    readonly service: ShelfService;
}> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-integration-"));
    directories.push(root);
    await git(root, ["init"]);
    for (const [relativePath, contents] of Object.entries(
        options.initialFiles ?? { "tracked.txt": "base\n" },
    )) {
        const target = path.join(root, relativePath);
        await writeFile(target, contents);
    }
    if (options.commit !== false) {
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "fixture base"]);
    }
    const storageRoot = options.storageRoot ?? path.join(root, "shelf-storage");
    const store = new ShelfStore(
        await resolveShelfPaths({ repositoryRoot: root, globalStoragePath: storageRoot }),
        options.storeOptions,
    );
    const executor = new GitExecutor(root);
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    return {
        root,
        storageRoot,
        executor,
        store,
        service: new ShelfService({
            repositoryRoot: root,
            executor,
            store,
            gate,
            recordBaseRevisions: options.recordBaseRevisions,
            reverter: options.reverter,
        }),
    };
}

/** Creates a linked worktree rooted under the fixture so cleanup cannot touch a developer checkout. */
export async function createLinkedWorktree(repositoryRoot: string): Promise<string> {
    const linkedRoot = path.join(
        path.dirname(repositoryRoot),
        `${path.basename(repositoryRoot)}-linked`,
    );
    directories.push(linkedRoot);
    await git(repositoryRoot, ["worktree", "add", "-b", "shelf-linked", linkedRoot]);
    return linkedRoot;
}

/** Creates another independent real service that shares the supplied fixture's on-disk shelf root. */
export async function createSecondService(
    repositoryRoot: string,
    storageRoot: string,
): Promise<{ readonly store: ShelfStore; readonly service: ShelfService }> {
    const store = new ShelfStore(
        await resolveShelfPaths({ repositoryRoot, globalStoragePath: storageRoot }),
    );
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    return {
        store,
        service: new ShelfService({
            repositoryRoot,
            executor: new GitExecutor(repositoryRoot),
            store,
            gate,
        }),
    };
}
