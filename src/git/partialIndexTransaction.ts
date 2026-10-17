import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { GitExecutor } from "./executor";
import { changeFingerprint } from "../changes/parseDiff";
import { assertContainedParent } from "../shelf/recoveryPaths";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { replaceMergeWorktreeFile } from "../shelf/safeWorktreeWrite";
import {
    assertPartialOperationIdle,
    readPartialIndex,
    readPartialRef,
    readPartialWorktree,
    readPartialAttributes,
    MAX_PARTIAL_TEXT_BYTES,
    type PartialFileSnapshot,
} from "./partialSnapshot";

interface IndexJournal {
    schemaVersion: 1 | 2;
    root: string;
    gitDir: string;
    indexPath: string;
    oldHead: string;
    ref: string;
    indexHash: string;
    preparedHash: string;
    newHead?: string;
    pid: number;
    lock?: { ino: string; dev: string };
    refusal?: string;
    worktree?: {
        path: string;
        beforeHash: string;
        afterHash: string;
        attributesHash: string;
    };
}

/** Refused transactions retain evidence, while live owners are never discarded. */
export interface PartialRecoveryIssue {
    id: string;
    kind: "active" | "blocked" | "quarantined" | "unreadable";
    location?: "pending" | "quarantined";
    reason: string;
    commit?: string;
}

class RecoveryRefusal extends Error {}
class UnreadableJournal extends Error {}

/** Callers must retain metadata fences whenever ref publication happened or is uncertain. */
export class PartialIndexPublicationError extends Error {}

/** Test seams fire at durable boundaries, never through the webview protocol. */
export interface PartialTransactionFaults {
    afterLock?: () => Promise<void>;
    afterPublish?: () => Promise<void>;
    beforeRecoveryPublish?: () => Promise<void>;
    afterWorktreePublish?: () => Promise<void>;
}

interface PreparedWorktreeTransition {
    path: string;
    before: Buffer;
    after: Buffer;
    recheckAfter: () => Promise<void>;
}

/** Publishes a prepared index atomically, with a recoverable CAS ref update for commits. */
export async function publishPartialIndex(
    executor: GitExecutor,
    snapshot: PartialFileSnapshot,
    preparedIndex: string,
    newHead: string | undefined,
    recheck: () => Promise<void>,
    faults: PartialTransactionFaults = {},
    worktree?: PreparedWorktreeTransition,
): Promise<void> {
    assertWorktreeTransition(snapshot, newHead, worktree);
    const directory = await createTransactionDirectory(snapshot.gitDir);
    const bytes = await readFile(preparedIndex);
    await durableFile(path.join(directory, "index"), bytes);
    const journal: IndexJournal = {
        schemaVersion: worktree ? 2 : 1,
        root: snapshot.root,
        gitDir: snapshot.gitDir,
        indexPath: snapshot.indexPath,
        oldHead: snapshot.head,
        ref: snapshot.ref,
        indexHash: snapshot.indexHash,
        preparedHash: changeFingerprint(bytes),
        newHead,
        pid: process.pid,
        ...(worktree
            ? {
                  worktree: {
                      path: worktree.path,
                      beforeHash: changeFingerprint(worktree.before),
                      afterHash: changeFingerprint(worktree.after),
                      attributesHash: changeFingerprint(snapshot.attributes),
                  },
              }
            : {}),
    };
    if (worktree) {
        await durableFile(path.join(directory, "worktree-before"), worktree.before);
        await durableFile(path.join(directory, "worktree-after"), worktree.after);
    }
    await writeJournal(directory, journal);
    const lockPath = `${snapshot.indexPath}.lock`;
    let lock: FileHandle | undefined;
    let lockAcquired = false;
    let published = false;
    let refUpdateStarted = false;
    let worktreeWriteStarted = false;
    let completed = false;
    let durable = false;
    try {
        lock = await open(lockPath, "wx", 0o600);
        lockAcquired = true;
        const stats = await lock.stat({ bigint: true });
        journal.lock = { ino: String(stats.ino), dev: String(stats.dev) };
        await writeJournal(directory, journal);
        await recheck();
        await faults.afterLock?.();
        await lock.writeFile(bytes);
        await lock.sync();
        await lock.close();
        lock = undefined;
        await recheck();
        await assertPreparedLock(lockPath, journal);
        if (newHead) {
            refUpdateStarted = true;
            await executor.runBinary([
                "update-ref",
                "-m",
                "commit: IntelliGit selected changes",
                snapshot.ref,
                newHead,
                snapshot.head,
            ]);
            published = true;
            await faults.afterPublish?.();
            if (
                (await executor.run(["rev-parse", "--verify", "HEAD"])).trim() !== newHead ||
                (await readPartialRef(executor)) !== snapshot.ref
            ) {
                throw new Error("The branch changed after publishing the selected commit.");
            }
        }
        if (worktree) {
            await replaceMergeWorktreeFile(
                snapshot.root,
                worktree.path,
                worktree.after,
                async () => {
                    await recheck();
                    await assertPreparedLock(lockPath, journal);
                    worktreeWriteStarted = true;
                },
            );
            await syncDirectory(path.dirname(path.join(snapshot.root, worktree.path)));
            await faults.afterWorktreePublish?.();
            await worktree.recheckAfter();
        }
        await assertPreparedLock(lockPath, journal);
        await rename(lockPath, snapshot.indexPath);
        completed = true;
        await syncDirectory(snapshot.gitDir);
        durable = true;
    } catch (error) {
        if (newHead) {
            published = published || (await refPointsToCommit(executor, snapshot.ref, newHead));
        }
        throw classifyPublicationFailure(error, {
            published,
            completed,
            refUpdateStarted,
            worktreeWriteStarted,
            commit: Boolean(newHead),
            worktree: Boolean(worktree),
        });
    } finally {
        await lock?.close();
        if (durable || (!refUpdateStarted && !worktreeWriteStarted && !published && !completed)) {
            await cleanupPartialRecord(directory, lockPath, journal, {
                durable,
                completed,
                lockAcquired,
            });
        }
    }
}

/** A file transition cannot share ref publication or smuggle another snapshot's preimage. */
function assertWorktreeTransition(
    snapshot: PartialFileSnapshot,
    newHead: string | undefined,
    worktree: PreparedWorktreeTransition | undefined,
): void {
    if (
        worktree &&
        (newHead ||
            worktree.path !== snapshot.view.path ||
            worktree.before.length > MAX_PARTIAL_TEXT_BYTES ||
            worktree.after.length > MAX_PARTIAL_TEXT_BYTES ||
            changeFingerprint(worktree.before) !== snapshot.worktreeHash)
    )
        throw new Error("Invalid selected-worktree transaction.");
}

/** Uncertain writes stay non-retryable even if a later read happens to look like the old state. */
function classifyPublicationFailure(
    error: unknown,
    state: {
        published: boolean;
        completed: boolean;
        refUpdateStarted: boolean;
        worktreeWriteStarted: boolean;
        commit: boolean;
        worktree: boolean;
    },
): unknown {
    let message: string;
    if (state.published && !state.completed)
        message =
            "The commit succeeded, but its index reconciliation needs recovery. Do not retry the commit.";
    else if (state.completed)
        message = state.worktree
            ? "The selected rollback succeeded, but its durability needs recovery. Do not repeat the rollback."
            : state.commit
              ? "The commit succeeded, but its index durability needs recovery. Do not retry the commit."
              : "The selected changes were staged, but index durability needs recovery.";
    else if (state.worktreeWriteStarted)
        message =
            "The selected worktree transition needs recovery. Do not repeat the rollback before reviewing recovery.";
    else if (state.refUpdateStarted)
        message =
            "The selected commit publication could not be confirmed. Review Git history and recovery records before retrying.";
    else return error;
    return new PartialIndexPublicationError(message, { cause: error });
}

async function cleanupPartialRecord(
    directory: string,
    lock: string,
    journal: IndexJournal,
    progress: { durable: boolean; completed: boolean; lockAcquired: boolean },
): Promise<void> {
    try {
        if (progress.durable) await removePreparedIndexLock(lock, journal);
        else if (progress.lockAcquired && journal.lock) await releaseUnpublishedLock(lock, journal);
        else if (progress.lockAcquired) return;
        await rm(directory, { recursive: true, force: true });
    } catch (error) {
        if (!progress.completed) throw error;
        console.error("[IntelliGit] Partial-index cleanup retained its recovery journal:", error);
    }
}

async function refPointsToCommit(
    executor: GitExecutor,
    ref: string,
    commit: string,
): Promise<boolean> {
    try {
        const current = await executor.runBinary(["rev-parse", "--verify", ref], {
            expectedExitCodes: [0, 1],
        });
        return current.stdout.toString("utf8").trim() === commit;
    } catch {
        return false;
    }
}

/** Isolated refs preserve branch-aware hooks without publishing anything to the real worktree. */
export async function preparePartialCommit(
    executor: GitExecutor,
    snapshot: PartialFileSnapshot,
    selectedIndex: string,
    directory: string,
    message: string,
    expectedTree: string,
    commitOptions: { amend?: boolean } = {},
): Promise<string> {
    const original = commitOptions.amend
        ? await executor.runBinary(["cat-file", "-p", snapshot.head], {
              maxOutputBytes: 1024 * 1024,
          })
        : undefined;
    if (original?.truncated)
        throw new Error("The amended commit exceeds the supported header budget.");
    // Historical author metadata need not be UTF-8; verification must preserve its exact bytes.
    const originalHeaders = original?.stdout.toString("latin1").split("\n\n")[0].split("\n") ?? [];
    const expectedParents = commitOptions.amend
        ? originalHeaders.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7))
        : [snapshot.head];
    const expectedAuthor = originalHeaders.find((line) => line.startsWith("author "));
    const isolatedGitDir = path.join(directory, "git");
    await mkdir(path.join(isolatedGitDir, "objects", "info"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(isolatedGitDir, "refs"), { mode: 0o700 });
    if (/[\r\n]/.test(snapshot.commonDir))
        throw new Error("This Git directory requires the whole-file commit workflow.");
    await writeFile(
        path.join(isolatedGitDir, "objects", "info", "alternates"),
        `${path.join(snapshot.commonDir, "objects")}\n`,
        { mode: 0o600 },
    );
    await writeFile(
        path.join(isolatedGitDir, "HEAD"),
        snapshot.ref === "HEAD" ? `${snapshot.head}\n` : `ref: ${snapshot.ref}\n`,
        { mode: 0o600 },
    );
    const references = await executor.runBinary(
        ["for-each-ref", "--format=%(objectname) %(refname)"],
        {
            maxOutputBytes: 8 * 1024 * 1024,
        },
    );
    if (references.truncated)
        throw new Error("Too many references for an isolated selected commit.");
    await writeFile(path.join(isolatedGitDir, "packed-refs"), references.stdout, { mode: 0o600 });
    const config = path.join(isolatedGitDir, "config");
    await executor.runBinary([
        "config",
        "--file",
        config,
        "include.path",
        path.join(snapshot.commonDir, "config"),
    ]);
    const worktreeConfig = path.join(snapshot.gitDir, "config.worktree");
    try {
        if ((await lstat(worktreeConfig)).isFile()) {
            await executor.runBinary([
                "config",
                "--file",
                config,
                "--add",
                "include.path",
                worktreeConfig,
            ]);
        }
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
    const options = await isolatedCommitOptions(executor, snapshot);
    const env = {
        GIT_DIR: isolatedGitDir,
        GIT_COMMON_DIR: isolatedGitDir,
        GIT_WORK_TREE: snapshot.root,
        GIT_INDEX_FILE: selectedIndex,
    };
    await executor.runBinary(
        [...options, "commit", ...(commitOptions.amend ? ["--amend"] : []), "-m", message],
        {
            env,
            maxOutputBytes: 1024 * 1024,
        },
    );
    const result = await executor.runBinary([...options, "rev-parse", "--verify", "HEAD"], { env });
    const commit = result.stdout.toString("utf8").trim();
    const identity = await executor.runBinary([...options, "cat-file", "-p", commit], {
        env,
        maxOutputBytes: 1024 * 1024,
    });
    const headers = identity.stdout.toString("latin1").split("\n\n")[0].split("\n");
    const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
    const parents = headers
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7));
    if (
        identity.truncated ||
        tree !== expectedTree ||
        parents.length !== expectedParents.length ||
        parents.some((parent, index) => parent !== expectedParents[index]) ||
        (commitOptions.amend &&
            headers.find((line) => line.startsWith("author ")) !== expectedAuthor)
    ) {
        throw new Error(
            "A Git hook changed the selected commit. No commit was published; review its changes.",
        );
    }
    const imported = await executor.runBinary(["hash-object", "-t", "commit", "-w", "--stdin"], {
        input: identity.stdout,
    });
    if (imported.stdout.toString("utf8").trim() !== commit)
        throw new Error("Selected commit identity changed during import.");
    return commit;
}

async function isolatedCommitOptions(
    executor: GitExecutor,
    snapshot: PartialFileSnapshot,
): Promise<string[]> {
    const captured = await executor.runBinary(
        [
            "config",
            "--null",
            "--get-regexp",
            "^(user\\.(name|email|signingkey)|commit\\.(gpgsign|cleanup)|gpg\\..*|i18n\\.commitencoding)$",
        ],
        { expectedExitCodes: [0, 1], maxOutputBytes: 64 * 1024 },
    );
    if (captured.truncated) throw new Error("Commit configuration exceeds its supported size.");
    const options = ["-c", "maintenance.auto=false"];
    for (const entry of captured.stdout.toString("utf8").split("\0").filter(Boolean)) {
        const separator = entry.indexOf("\n");
        if (separator < 0) throw new Error("Invalid commit configuration.");
        if (
            entry.slice(0, separator).toLowerCase() === "i18n.commitencoding" &&
            !/^utf-?8$/i.test(entry.slice(separator + 1))
        )
            throw new Error(
                "Non-UTF-8 commit-message encoding requires the native commit workflow.",
            );
        options.push("-c", `${entry.slice(0, separator)}=${entry.slice(separator + 1)}`);
    }
    const hooks = await executor.runBinary(["config", "--path", "--get", "core.hooksPath"], {
        expectedExitCodes: [0, 1],
    });
    const hooksPath =
        hooks.exitCode === 0
            ? path.resolve(snapshot.root, hooks.stdout.toString("utf8").trim())
            : path.join(snapshot.commonDir, "hooks");
    options.push("-c", `core.hooksPath=${hooksPath}`);
    const refStorage = await executor.runBinary(["config", "--get", "extensions.refStorage"], {
        expectedExitCodes: [0, 1],
    });
    if (refStorage.exitCode === 0) options.push("-c", "extensions.refStorage=files");
    return options;
}

/** Reconciles only an unchanged index and a known completed ref transition. */
export async function recoverPartialIndexes(
    executor: GitExecutor,
    root: string,
    gitDir: string,
    faults: PartialTransactionFaults = {},
): Promise<{ changed: boolean; issues: PartialRecoveryIssue[] }> {
    const parent = path.join(gitDir, "intelligit", "partial-index");
    const names = await recoveryNames(parent);
    const issues: PartialRecoveryIssue[] = [];
    let changed = false;
    for (const name of names) {
        const directory = path.join(parent, name);
        await assertContainedParent(gitDir, path.join(directory, "journal.json"));
        let record: IndexJournal;
        try {
            record = await readJournal(directory, root, gitDir);
        } catch (error) {
            if (!(error instanceof UnreadableJournal)) throw error;
            issues.push({
                id: name,
                kind: "unreadable",
                location: "pending",
                reason: "The partial-index journal is unreadable. No index lock was removed.",
            });
            continue;
        }
        if (record.pid !== process.pid && isAlive(record.pid)) {
            issues.push({
                id: name,
                kind: "active",
                location: "pending",
                reason: `Another process may own this partial-index recovery (PID ${record.pid}).`,
                commit: record.newHead,
            });
            continue;
        }
        try {
            changed = (await recoverOne(executor, directory, record, faults)) || changed;
        } catch (error) {
            if (!(error instanceof RecoveryRefusal)) throw error;
            if (!(await quarantineRecovery(directory, record, error.message))) {
                issues.push({
                    id: name,
                    kind: "blocked",
                    location: "pending",
                    reason: "Review quarantined partial-index records before recovering more.",
                    commit: record.newHead,
                });
            }
        }
    }
    const quarantine = path.join(gitDir, "intelligit", "partial-index-quarantine");
    for (const id of await recoveryNames(quarantine)) {
        const directory = path.join(quarantine, id);
        await assertContainedParent(gitDir, path.join(directory, "journal.json"));
        let record: IndexJournal;
        try {
            record = await readJournal(directory, root, gitDir);
        } catch (error) {
            if (!(error instanceof UnreadableJournal)) throw error;
            issues.push({
                id,
                kind: "unreadable",
                location: "quarantined",
                reason: "The quarantined partial-index journal is unreadable.",
            });
            continue;
        }
        issues.push({
            id,
            kind: "quarantined",
            reason: record.refusal ?? "Partial-index recovery needs review.",
            commit: record.newHead,
        });
    }
    return { changed, issues };
}

/** Explicit dismissal removes only quarantined extension metadata, never Git state or locks. */
export async function discardPartialRecovery(
    root: string,
    gitDir: string,
    id: string,
    location: "pending" | "quarantined" = "quarantined",
): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid recovery record.");
    const parent = path.join(
        gitDir,
        "intelligit",
        location === "pending" ? "partial-index" : "partial-index-quarantine",
    );
    if (!(await recoveryNames(parent)).includes(id))
        throw new Error("The recovery record changed.");
    const directory = path.join(parent, id);
    await assertContainedParent(gitDir, path.join(directory, "journal.json"));
    await assertRegularRecord(directory);
    if (location === "pending") {
        try {
            await readJournal(directory, root, gitDir);
            throw new Error("The recovery record is now readable and cannot be discarded here.");
        } catch (error) {
            if (!(error instanceof UnreadableJournal)) throw error;
        }
    }
    await rm(directory, { recursive: true });
    await syncDirectory(parent);
}

async function recoverOne(
    executor: GitExecutor,
    directory: string,
    journal: IndexJournal,
    faults: PartialTransactionFaults,
): Promise<boolean> {
    await assertPartialOperationIdle(journal.gitDir);
    const head = (await executor.run(["rev-parse", "--verify", "HEAD"])).trim();
    const ref = await readPartialRef(executor);
    const currentHash = changeFingerprint(await readPartialIndex(journal));
    if (ref !== journal.ref)
        throw new RecoveryRefusal("The branch changed; partial-index recovery requires review.");
    if (journal.worktree)
        return recoverWorktreeIndex(executor, directory, journal, faults, head, ref, currentHash);
    if (head === (journal.newHead ?? journal.oldHead) && currentHash === journal.preparedHash) {
        await removePreparedIndexLock(`${journal.indexPath}.lock`, journal);
        await syncDirectory(journal.gitDir);
        await rm(directory, { recursive: true, force: true });
        return false;
    }
    if (head === journal.oldHead && currentHash === journal.indexHash) {
        await releaseUnpublishedLock(`${journal.indexPath}.lock`, journal);
        await rm(directory, { recursive: true, force: true });
        return false;
    }
    if (!journal.newHead || head !== journal.newHead || currentHash !== journal.indexHash) {
        throw new RecoveryRefusal(
            "The index or HEAD changed; partial-index recovery will not overwrite it.",
        );
    }
    return reconcileRecoveryIndex(executor, directory, journal, faults, head, ref, currentHash);
}

/** Worktree recovery never writes a file: only a proven completed file transition may finish its index. */
async function recoverWorktreeIndex(
    executor: GitExecutor,
    directory: string,
    journal: IndexJournal,
    faults: PartialTransactionFaults,
    head: string,
    ref: string,
    currentHash: string,
): Promise<boolean> {
    const worktree = journal.worktree!;
    if (head !== journal.oldHead)
        throw new RecoveryRefusal(
            "The branch changed after selected rollback; its recovery needs review.",
        );
    const verify = async (): Promise<string> => {
        try {
            if (
                changeFingerprint(await readPartialAttributes(executor, worktree.path)) !==
                worktree.attributesHash
            )
                throw new Error("Attributes changed.");
            return changeFingerprint(await readPartialWorktree(journal.root, worktree.path));
        } catch (error) {
            throw new RecoveryRefusal(
                "The selected worktree or its conversion changed; recovery will not overwrite it.",
                { cause: error },
            );
        }
    };
    for (const [name, expected] of [
        ["worktree-before", worktree.beforeHash],
        ["worktree-after", worktree.afterHash],
    ]) {
        const file = path.join(directory, name);
        try {
            const stats = await lstat(file);
            if (
                !stats.isFile() ||
                stats.isSymbolicLink() ||
                stats.size > MAX_PARTIAL_TEXT_BYTES ||
                changeFingerprint(await readFile(file)) !== expected
            )
                throw new Error("Invalid backup.");
        } catch (error) {
            throw new RecoveryRefusal("The selected-worktree recovery backup is corrupt.", {
                cause: error,
            });
        }
    }
    const hash = await verify();
    if (hash === worktree.beforeHash && currentHash === journal.indexHash) {
        await releaseUnpublishedLock(`${journal.indexPath}.lock`, journal);
        await rm(directory, { recursive: true, force: true });
        return false;
    }
    if (hash !== worktree.afterHash)
        throw new RecoveryRefusal(
            "The selected worktree changed; its original backup is retained for review.",
        );
    if (currentHash === journal.preparedHash) {
        await removePreparedIndexLock(`${journal.indexPath}.lock`, journal);
        await syncDirectory(journal.gitDir);
        await rm(directory, { recursive: true, force: true });
        return true;
    }
    if (currentHash !== journal.indexHash)
        throw new RecoveryRefusal(
            "The index changed after selected rollback; recovery requires review.",
        );
    return reconcileRecoveryIndex(
        executor,
        directory,
        journal,
        faults,
        head,
        ref,
        currentHash,
        async () => {
            if ((await verify()) !== worktree.afterHash)
                throw new RecoveryRefusal(
                    "The selected worktree changed during recovery; its backup is retained.",
                );
        },
    );
}

async function reconcileRecoveryIndex(
    executor: GitExecutor,
    directory: string,
    journal: IndexJournal,
    faults: PartialTransactionFaults,
    head: string,
    ref: string,
    currentHash: string,
    verifyWorktree?: () => Promise<void>,
): Promise<boolean> {
    const bytes = await readPartialIndex({
        gitDir: directory,
        indexPath: path.join(directory, "index"),
    });
    if (changeFingerprint(bytes) !== journal.preparedHash)
        throw new RecoveryRefusal("The recovery index is corrupt.");
    const lockPath = `${journal.indexPath}.lock`;
    let lock: FileHandle | undefined;
    try {
        try {
            lock = await open(lockPath, "wx", 0o600);
            const stats = await lock.stat({ bigint: true });
            journal.lock = { ino: String(stats.ino), dev: String(stats.dev) };
            await writeJournal(directory, journal);
            await lock.writeFile(bytes);
            await lock.sync();
        } catch (error) {
            if (!isExists(error)) throw error;
            await assertRecoveryLock(lockPath, journal);
        }
        await lock?.close();
        lock = undefined;
        await faults.beforeRecoveryPublish?.();
        await verifyWorktree?.();
        if (
            (await executor.run(["rev-parse", "--verify", "HEAD"])).trim() !== head ||
            (await readPartialRef(executor)) !== ref ||
            changeFingerprint(await readPartialIndex(journal)) !== currentHash
        ) {
            throw new RecoveryRefusal("The repository changed during partial-index recovery.");
        }
        await assertRecoveryLock(lockPath, journal);
        await rename(lockPath, journal.indexPath);
        await syncDirectory(journal.gitDir);
        await rm(directory, { recursive: true, force: true });
        return true;
    } finally {
        await lock?.close();
    }
}

async function releaseUnpublishedLock(lock: string, journal: IndexJournal): Promise<void> {
    try {
        const stats = await lstat(lock);
        if (!(await ownsIndexLock(lock, journal)) || stats.size > 64 * 1024 * 1024)
            throw new RecoveryRefusal(
                "The unpublished transaction lock ownership changed. The foreign lock is retained.",
            );
        const bytes = await readFile(lock);
        if (
            (bytes.length !== 0 && changeFingerprint(bytes) !== journal.preparedHash) ||
            !(await ownsIndexLock(lock, journal))
        )
            throw new RecoveryRefusal(
                "The unpublished transaction lock ownership changed. The foreign lock is retained.",
            );
        await rm(lock);
        await syncDirectory(journal.gitDir);
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
}

async function recoveryNames(parent: string): Promise<string[]> {
    try {
        const namespace = await lstat(path.dirname(parent));
        if (!namespace.isDirectory() || namespace.isSymbolicLink())
            throw new Error("Partial-index recovery requires a regular namespace.");
        const stats = await lstat(parent);
        if (!stats.isDirectory() || stats.isSymbolicLink())
            throw new Error("Partial-index recovery requires a regular directory.");
        const names = await readdir(parent);
        if (names.length > 32) throw new Error("Too many partial-index recovery records.");
        if (names.some((name) => !/^[a-f0-9-]{36}$/.test(name)))
            throw new Error("Unexpected partial-index recovery entry.");
        return names.sort();
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
}

async function quarantineRecovery(
    directory: string,
    journal: IndexJournal,
    reason: string,
): Promise<boolean> {
    const parent = await createRecoveryParent(journal.gitDir, "partial-index-quarantine");
    journal.refusal = reason;
    await writeJournal(directory, journal);
    await removePreparedIndexLock(`${journal.indexPath}.lock`, journal);
    if ((await recoveryNames(parent)).length >= 32) return false;
    await rename(directory, path.join(parent, randomUUID()));
    await syncDirectory(path.dirname(directory));
    await syncDirectory(parent);
    return true;
}

async function removePreparedIndexLock(lock: string, journal: IndexJournal): Promise<void> {
    if (!(await ownsIndexLock(lock, journal))) return;
    const stats = await lstat(lock);
    if (stats.size > 64 * 1024 * 1024) return;
    const bytes = await readFile(lock);
    if (changeFingerprint(bytes) === journal.preparedHash && (await ownsIndexLock(lock, journal))) {
        await rm(lock);
        await syncDirectory(journal.gitDir);
    }
}

async function assertRecoveryLock(lock: string, journal: IndexJournal): Promise<void> {
    try {
        await assertPreparedLock(lock, journal);
    } catch (error) {
        throw new RecoveryRefusal(
            "Index-lock ownership or content changed during recovery. The foreign lock is retained.",
            { cause: error },
        );
    }
}

async function createRecoveryParent(gitDir: string, kind: string): Promise<string> {
    let parent = gitDir;
    for (const name of ["intelligit", kind]) {
        const next = path.join(parent, name);
        await assertContainedParent(gitDir, next);
        try {
            await mkdir(next, { mode: 0o700 });
        } catch (error) {
            if (!isExists(error)) throw error;
        }
        const stats = await lstat(next);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error("Partial-index recovery requires owned regular directories.");
        }
        parent = next;
        await syncDirectory(path.dirname(next));
    }
    return parent;
}

async function createTransactionDirectory(gitDir: string): Promise<string> {
    if (
        (await recoveryNames(path.join(gitDir, "intelligit", "partial-index-quarantine"))).length >=
        32
    ) {
        throw new Error("Review quarantined partial-index records before committing more.");
    }
    const parent = await createRecoveryParent(gitDir, "partial-index");
    if ((await recoveryNames(parent)).length >= 32)
        throw new Error("Review partial-index recovery records before committing more.");
    const directory = path.join(parent, randomUUID());
    await assertContainedParent(gitDir, directory);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(parent);
    return directory;
}

async function writeJournal(directory: string, journal: IndexJournal): Promise<void> {
    const temporary = path.join(directory, `${randomUUID()}.json`);
    await durableFile(temporary, Buffer.from(JSON.stringify(journal)));
    await rename(temporary, path.join(directory, "journal.json"));
    await syncDirectory(directory);
}

async function durableFile(file: string, bytes: Buffer): Promise<void> {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function assertRegularRecord(directory: string): Promise<void> {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw new Error("Invalid partial-index journal directory.");
}

async function readJournal(directory: string, root: string, gitDir: string): Promise<IndexJournal> {
    await assertRegularRecord(directory);
    try {
        return await parseJournal(directory, root, gitDir);
    } catch (error) {
        throw new UnreadableJournal("The partial-index journal is missing or invalid.", {
            cause: error,
        });
    }
}

async function parseJournal(
    directory: string,
    root: string,
    gitDir: string,
): Promise<IndexJournal> {
    const file = path.join(directory, "journal.json");
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16_384) {
        throw new Error("Invalid partial-index journal.");
    }
    const journal = JSON.parse(await readFile(file, "utf8")) as IndexJournal;
    if (
        (journal.schemaVersion !== 1 && journal.schemaVersion !== 2) ||
        journal.root !== root ||
        journal.gitDir !== gitDir ||
        journal.indexPath !== path.join(gitDir, "index") ||
        !/^[a-f0-9]{40,64}$/.test(journal.oldHead) ||
        !/^(?:HEAD|refs\/heads\/[^\u0000-\u0020]+)$/.test(journal.ref) ||
        !/^[a-f0-9]{64}$/.test(journal.indexHash) ||
        !/^[a-f0-9]{64}$/.test(journal.preparedHash) ||
        !Number.isSafeInteger(journal.pid) ||
        journal.pid <= 0 ||
        (journal.newHead !== undefined && !/^[a-f0-9]{40,64}$/.test(journal.newHead)) ||
        (journal.refusal !== undefined &&
            (typeof journal.refusal !== "string" || journal.refusal.length > 1024))
    ) {
        throw new Error("Invalid partial-index recovery identity.");
    }
    assertWorktreeJournal(journal);
    return journal;
}

/** Schema two fences file transitions from older clients that only understand index journals. */
function assertWorktreeJournal(journal: IndexJournal): void {
    if (journal.schemaVersion === 2) {
        const worktree = journal.worktree;
        if (
            journal.newHead !== undefined ||
            !worktree ||
            typeof worktree.path !== "string" ||
            assertRepoRelativePath(worktree.path) !== worktree.path ||
            ![worktree.beforeHash, worktree.afterHash, worktree.attributesHash].every((hash) =>
                /^[a-f0-9]{64}$/.test(hash),
            )
        )
            throw new Error("Invalid selected-worktree recovery identity.");
    } else if (journal.worktree !== undefined)
        throw new Error("Unexpected worktree recovery metadata.");
}

async function ownsIndexLock(file: string, journal: IndexJournal): Promise<boolean> {
    if (!journal.lock) return false;
    try {
        const stats = await lstat(file, { bigint: true });
        return (
            stats.isFile() &&
            !stats.isSymbolicLink() &&
            String(stats.ino) === journal.lock.ino &&
            String(stats.dev) === journal.lock.dev
        );
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

async function assertPreparedLock(file: string, journal: IndexJournal): Promise<void> {
    if (
        !(await ownsIndexLock(file, journal)) ||
        (await lstat(file)).size > 64 * 1024 * 1024 ||
        changeFingerprint(await readFile(file)) !== journal.preparedHash
    ) {
        throw new Error("Index-lock ownership changed. The foreign lock will not be overwritten.");
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

function isExists(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (
            typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
        );
    }
}

async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
