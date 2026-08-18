import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import type { RebaseReconciliationDependencies } from "../../../src/git/interactiveRebase/reconcile";
import type { InteractiveRebaseRunDependencies } from "../../../src/git/interactiveRebase/run";
import {
    createRebaseSessionDirectory,
    tryAcquireRebaseReservation,
    writeRebaseManifest,
} from "../../../src/git/interactiveRebase/storage";
import type {
    RebasePushTarget,
    RebaseSessionLifecycle,
    RebaseSessionManifest,
} from "../../../src/git/interactiveRebase/types";

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
    await removeScratchDirectories(...directories.splice(0));
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
    /** Read-only dependencies for gathering reconciliation evidence from this fixture. */
    readonly reconciliationDependencies: RebaseReconciliationDependencies;
}

/**
 * Which side of the real `git rebase -i` delegation a suspended runner is parked on.
 *
 * The choice decides which refusal a concurrent submission can reach, so it is the whole
 * point of the seam rather than a convenience: `tryAcquireRebaseReservation` checks for a
 * rebase directory *before* it writes its exclusive pointer, so a second submission parked
 * `after-git` is refused for `rebase-in-progress` and never reaches the pointer at all.
 * Only `before-git` — reservation written, no rebase directory yet — can exercise the
 * exclusion the pointer itself provides.
 */
export type RebaseSuspensionPoint = "before-git" | "after-git";

/** Coordinates a first real rebase parked at the executor seam so a second submission can overlap. */
export interface SuspendedRebase {
    /** Dependencies whose interactive-rebase delegation parks at the configured point. */
    readonly dependencies: InteractiveRebaseRunDependencies;
    /** Resolves once the runner has reached the suspension point and is parked there. */
    waitForSuspension(): Promise<void>;
    /** Allows the parked runner invocation to proceed to its real result. */
    release(): void;
}

/** Caller-selected persisted state for a real storage-backed reconciliation scenario. */
export interface PersistedRebaseSessionOptions {
    readonly sessionId: string;
    readonly lifecycle: RebaseSessionLifecycle;
    readonly branch: string;
    readonly baseHash: string;
    readonly expectedHead: string;
}

/**
 * A fixture that also has a bare `file://` origin wired as `origin` with `main` tracking it.
 *
 * Separate from `RebaseFixture` so the remote is opt-in: initializing a bare repository and pushing
 * to it costs ~0.3s per fixture (measured 16.88s against 15.15s for this suite once the six
 * scenarios that never push stopped paying for one), and that is charged per scenario forever.
 */
export interface PushableRebaseFixture extends RebaseFixture {
    readonly remote: RebaseFixtureRemote;
}

/** Bare `file://` origin details used to verify a force push against the remote's own ref. */
interface RebaseFixtureRemote {
    readonly root: string;
    readonly url: string;
    readonly remoteHeadRef: "refs/heads/main";
    readonly pushTarget: RebasePushTarget;
}

/** Reads a ref directly from the bare remote rather than a potentially stale local tracking ref. */
export async function readBareRemoteRef(
    bareRemoteRoot: string,
    remoteHeadRef: string,
): Promise<string> {
    return (await git(bareRemoteRoot, ["rev-parse", remoteHeadRef])).toString("utf8").trim();
}

/** Clones the fixture's bare origin into a cleanup-managed working tree for a collaborating push. */
export async function createRemoteCollaborator(fixture: PushableRebaseFixture): Promise<string> {
    const collaboratorRoot = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-collaborator-"));
    directories.push(collaboratorRoot);
    await git(fixture.root, ["clone", "--branch", "main", fixture.remote.url, collaboratorRoot]);
    return collaboratorRoot;
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

/** Creates the standard fixture with a bare `file://` origin already wired up and pushed to. */
export async function createPushableRebaseFixture(
    helperScriptPath: string,
): Promise<PushableRebaseFixture> {
    const fixture = await createRebaseFixture(helperScriptPath);
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-remote-"));
    directories.push(remoteRoot);
    const remoteHeadRef = "refs/heads/main" as const;
    const remoteName = "origin";
    const url = pathToFileURL(remoteRoot).href;

    await git(remoteRoot, ["init", "--bare"]);
    await git(remoteRoot, ["symbolic-ref", "HEAD", remoteHeadRef]);
    await git(fixture.root, ["remote", "add", remoteName, url]);
    await git(fixture.root, ["push", "--set-upstream", remoteName, "main"]);
    const upstreamOid = await readBareRemoteRef(remoteRoot, remoteHeadRef);

    return {
        ...fixture,
        remote: {
            root: remoteRoot,
            url,
            remoteHeadRef,
            pushTarget: { remoteName, remoteHeadRef, upstreamOid },
        },
    };
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

/**
 * Persists one session through the production storage writers in the fixture's cleanup-managed root.
 *
 * The caller supplies every field that reconciliation correlates with live Git state so scenarios
 * can model matching and mismatching restarts without hand-writing a storage-format JSON file.
 */
export async function plantPersistedRebaseSession(
    fixture: RebaseFixture,
    options: PersistedRebaseSessionOptions,
): Promise<RebaseSessionManifest> {
    const storageRoot = fixture.reconciliationDependencies.storageRoot;
    await createRebaseSessionDirectory(storageRoot, fixture.root, options.sessionId);
    const manifest: RebaseSessionManifest = {
        version: 1,
        sessionId: options.sessionId,
        repoRoot: fixture.root,
        branch: options.branch,
        hasPushedCommit: false,
        baseHash: options.baseHash,
        expectedHead: options.expectedHead,
        createdAt: "2000-01-01T00:00:00.000Z",
        lifecycle: options.lifecycle,
    };
    await writeRebaseManifest(storageRoot, manifest);
    return manifest;
}

/** Leaves a production-created reservation pointer without a manifest or live Git rebase for sweep tests. */
export async function plantOrphanedRebaseReservation(
    fixture: RebaseFixture,
    sessionId: string,
): Promise<void> {
    const acquired = await tryAcquireRebaseReservation({
        storageRoot: fixture.reconciliationDependencies.storageRoot,
        repoRoot: fixture.root,
        gitDir: fixture.gitDir,
        sessionId,
    });
    if (acquired.status !== "acquired") {
        throw new Error(`Expected an orphanable reservation, got "${acquired.reason}".`);
    }
}

/**
 * Parks the first real interactive-rebase invocation at the executor seam so a second submission
 * can overlap the still-running runner without a timing delay or a mocked Git process.
 *
 * Only the `git rebase -i` delegation is wrapped; every other command the runner issues — the
 * guard reads, the revision reads — runs untouched, so the parked runner is suspended in the
 * real critical section rather than in a stubbed one.
 */
export function suspendInteractiveRebase(
    dependencies: InteractiveRebaseRunDependencies,
    at: RebaseSuspensionPoint,
): SuspendedRebase {
    let markSuspended!: () => void;
    const suspended = new Promise<void>((resolve) => {
        markSuspended = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        dependencies: {
            ...dependencies,
            executor: {
                ...dependencies.executor,
                runBinary: async (args, options) => {
                    if (!(args[0] === "rebase" && args[1] === "-i")) {
                        return dependencies.executor.runBinary(args, options);
                    }
                    if (at === "before-git") {
                        markSuspended();
                        await released;
                        return dependencies.executor.runBinary(args, options);
                    }
                    const result = await dependencies.executor.runBinary(args, options);
                    markSuspended();
                    await released;
                    return result;
                },
            },
        },
        waitForSuspension: () => suspended,
        release,
    };
}

/**
 * Replaces one session's durable manifest without recreating its helper-artifact directory.
 *
 * `plantPersistedRebaseSession` cannot do this — `createRebaseSessionDirectory` refuses an
 * existing directory — so drifting a manifest the runner itself wrote needs its own seam.
 */
export async function rewritePersistedRebaseManifest(
    fixture: RebaseFixture,
    manifest: RebaseSessionManifest,
): Promise<void> {
    await writeRebaseManifest(fixture.reconciliationDependencies.storageRoot, manifest);
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
        reconciliationDependencies: { storageRoot, gitDir, executor },
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
