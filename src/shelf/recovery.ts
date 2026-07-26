import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { GitExecutor } from "../git/executor";
import type { RepositoryMutationGate } from "../git/repositoryMutationGate";
import type {
    ShelfJournal,
    ShelfJournalIndexEntry,
    ShelfJournalPathProgress,
    ShelfJournalShelfLink,
    ShelfStore,
} from "./store";
import { GitExecutorRecoveryGit, RecoverySafetyError } from "./recoveryGit";
import type { ShelfRecoveryGit } from "./recoveryGit";
import {
    assertContainedParent,
    assertContainedParentIfPresent,
    assertRepositoryRelativePath,
    ensureContainedParent,
    resolveRecoveryPath,
    resolveRepositoryPath,
} from "./recoveryPaths";

export { EMPTY_TREE_OID, RecoverySafetyError } from "./recoveryGit";
export type { ShelfRecoveryGit } from "./recoveryGit";

/** Fault-injection boundaries around each durable destructive transition. */
export type RevertCheckpoint =
    | "journal-created"
    | "source-moved"
    | "base-written"
    | "index-updated"
    | "recovery-verified"
    | "journal-committed";
/** One repository-relative file to restore to the pinned base state. */
export interface RevertFile {
    readonly relativePath: string;
    readonly baseBytes?: Uint8Array;
}
/** Dependencies and test seams for one repository-scoped shelf reverter. */
export interface ShelfReverterOptions {
    readonly repositoryRoot: string;
    readonly gitOps: { getGitDirectories(): Promise<{ gitDir: string; commonDir: string }> };
    readonly gate: RepositoryMutationGate;
    readonly store: ShelfStore;
    readonly git?: ShelfRecoveryGit;
    readonly checkpoint?: (checkpoint: RevertCheckpoint) => Promise<void>;
    readonly sameFilesystem?: (repositoryRoot: string, gitDir: string) => Promise<boolean>;
    readonly capacityAvailable?: () => Promise<boolean>;
    readonly getHead?: () => Promise<string | undefined>;
    readonly getIndexFingerprint?: () => Promise<string | undefined>;
}

/** Deterministic outcome of retrying all restart-time pending journals. */
export interface PendingShelfRecoveryResult {
    readonly rolledBackIds: readonly string[];
    readonly retainedIds: readonly string[];
}

/** Raised before mutation when recovery staging is not on the worktree device. */
class RecoveryExdevError extends Error {
    /** Creates the fixed cross-device recovery refusal. */
    constructor() {
        super("EXDEV: recovery staging is not on the worktree filesystem.");
        this.name = "RecoveryExdevError";
    }
}

/** Raised before mutation when required recovery retention capacity is unavailable. */
export class ShelfRecoveryFullError extends Error {
    /** Creates the fixed recovery-capacity refusal. */
    constructor() {
        super("Recovery full: refusing a new destructive shelf operation.");
        this.name = "ShelfRecoveryFullError";
    }
}

/** Raised when rollback preserves one or more paths instead of overwriting changed state. */
export class ShelfRollbackRetainedError extends Error {
    /** Records the repository-relative paths that remain available in recovery. */
    constructor(readonly retainedPaths: readonly string[]) {
        super("Rollback retained recovery because another process changed a transaction path.");
        this.name = "ShelfRollbackRetainedError";
    }
}

interface MovedPath {
    readonly relativePath: string;
    readonly target: string;
    readonly recoveryPath: string;
    readonly hadOriginal: boolean;
    readonly originalIndexEntry: ShelfJournalIndexEntry | undefined;
    readonly originalIndexFingerprint?: string;
    writtenFingerprint: string;
    writtenIndexEntry: ShelfJournalIndexEntry | undefined;
    writtenIndexFingerprint?: string;
}

interface RevertState {
    readonly transactionId: string;
    readonly baseOid: string;
    readonly originalHead: string | undefined;
    readonly journal: ShelfJournal;
    readonly moved: MovedPath[];
    readonly recoveryObjectHashes: string[];
    readonly pathProgress: Record<string, ShelfJournalPathProgress>;
    readonly seenPaths: Set<string>;
    expectedIndex: string | undefined;
}

/** Performs one journaled revert transaction or restart-time recovery under the repository gate. */
export class ShelfReverter {
    private readonly git: ShelfRecoveryGit;

    /** Binds a reverter to one repository and its serialized storage/Git surfaces. */
    constructor(private readonly options: ShelfReverterOptions) {
        this.git =
            options.git ?? new GitExecutorRecoveryGit(new GitExecutor(options.repositoryRoot));
    }

    /** Moves originals to recovery and restores each requested path to its pinned base state. */
    async revert(input: {
        readonly transactionId: string;
        readonly baseOid?: string;
        readonly files: readonly RevertFile[];
        readonly shelf?: ShelfJournalShelfLink;
    }): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        const directories = await this.options.gitOps.getGitDirectories();
        return this.options.gate.run(this.options.repositoryRoot, directories.commonDir, async () =>
            this.options.store.withLock(async () => {
                return this.revertWithHeldLocks(input);
            }),
        );
    }

    /**
     * Reverts while the activation-owned repository gate and store lock are already held.
     *
     * ShelfService uses this path after it has durably written the shelf generation, so
     * the journal can link the destructive recovery transaction to that generation without
     * re-entering either serialization primitive.
     */
    async revertWithHeldLocks(input: {
        readonly transactionId: string;
        readonly baseOid?: string;
        readonly files: readonly RevertFile[];
        readonly shelf?: ShelfJournalShelfLink;
    }): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        const directories = await this.options.gitOps.getGitDirectories();
        if (
            !(await (this.options.sameFilesystem ?? isSameFilesystem)(
                this.options.repositoryRoot,
                directories.gitDir,
            ))
        ) {
            throw new RecoveryExdevError();
        }
        if (this.options.capacityAvailable && !(await this.options.capacityAvailable())) {
            throw new ShelfRecoveryFullError();
        }
        const recoveryDirectory = recoveryDirectoryFor(directories.gitDir, input.transactionId);
        return this.revertUnderGate(input, recoveryDirectory, directories.gitDir);
    }

    /** Safely rolls back only incomplete shelf-revert journals after a process restart. */
    async resumePending(): Promise<PendingShelfRecoveryResult> {
        const directories = await this.options.gitOps.getGitDirectories();
        return this.options.gate.run(this.options.repositoryRoot, directories.commonDir, async () =>
            this.options.store.withLock(async () => {
                const rolledBackIds: string[] = [];
                const retainedIds: string[] = [];
                for (const journal of await this.options.store.readJournals()) {
                    if (journal.state !== "shelvePendingRevert") continue;
                    try {
                        if (!isIndexFingerprint(journal.expectedIndexFingerprint)) {
                            throw new RecoverySafetyError(
                                "Pending recovery journal has no valid index fingerprint.",
                            );
                        }
                        // Roll back one journal at a time under the repository gate and store lock.
                        // react-doctor-disable-next-line react-doctor/async-await-in-loop
                        const moved = await this.pendingMovedPaths(journal, directories.gitDir);
                        const retained = await rollbackMovedPaths(
                            moved,
                            this.options.repositoryRoot,
                            directories.gitDir,
                            this.git,
                            journal.expectedIndexFingerprint,
                        );
                        if (retained.length > 0) {
                            await this.options.store.transitionJournal(journal.id, "ghost");
                            retainedIds.push(journal.id);
                        } else {
                            await this.options.store.deleteJournal(journal.id);
                            rolledBackIds.push(journal.id);
                        }
                    } catch {
                        await this.options.store.transitionJournal(journal.id, "ghost");
                        retainedIds.push(journal.id);
                    }
                }
                return { rolledBackIds, retainedIds };
            }),
        );
    }

    private async revertUnderGate(
        input: {
            readonly transactionId: string;
            readonly baseOid?: string;
            readonly files: readonly RevertFile[];
            readonly shelf?: ShelfJournalShelfLink;
        },
        recoveryDirectory: string,
        gitDirectory: string,
    ): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        const originalHead = await this.currentHead();
        const state: RevertState = {
            transactionId: input.transactionId,
            baseOid: input.baseOid ?? originalHead ?? (await this.git.emptyTreeOid()),
            originalHead,
            expectedIndex: await this.currentIndexFingerprint(),
            journal: {
                id: input.transactionId,
                state: "shelvePendingRevert",
                pathProgress: {},
                shelf: input.shelf,
            },
            moved: [],
            recoveryObjectHashes: [],
            pathProgress: {},
            seenPaths: new Set<string>(),
        };
        let committed = false;

        try {
            await this.writePendingJournal(state);
            await this.checkpoint("journal-created");
            for (const file of input.files) {
                // Per-path journal checkpoints and index fingerprints make this transaction ordered.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                await this.revertFile(file, state, recoveryDirectory, gitDirectory);
            }
            await this.commitJournal(state);
            committed = true;
            await this.checkpoint("journal-committed");
            return { baseOid: state.baseOid, recoveryDirectory };
        } catch (error) {
            if (committed) throw error;
            const retained = await rollbackMovedPaths(
                state.moved,
                this.options.repositoryRoot,
                gitDirectory,
                this.git,
                state.expectedIndex,
            );
            if (retained.length > 0) throw new ShelfRollbackRetainedError(retained);
            await this.options.store.deleteJournal(input.transactionId);
            throw error;
        }
    }

    private async revertFile(
        file: RevertFile,
        state: RevertState,
        recoveryDirectory: string,
        gitDirectory: string,
    ): Promise<void> {
        const relativePath = assertRepositoryRelativePath(file.relativePath);
        if (state.seenPaths.has(relativePath)) {
            throw new RecoverySafetyError(
                "A shelf recovery transaction cannot contain a path twice.",
            );
        }
        state.seenPaths.add(relativePath);
        // Snapshot index state only after the transaction-wide Git precondition has held.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
        const originalIndexEntry = await this.git.getIndexEntry(relativePath);
        // Preserve index-entry failure precedence before its fingerprint is read.
        // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
        const originalIndexFingerprint = await this.git.getIndexPathFingerprint(relativePath);
        const target = resolveRepositoryPath(this.options.repositoryRoot, relativePath);
        const recoveryPath = resolveRecoveryPath(recoveryDirectory, relativePath);
        // Lexical containment permits a deleted parent; writeBaseFile recreates and realpath-checks it.
        await assertContainedParentIfPresent(this.options.repositoryRoot, target);
        const entry: MovedPath = {
            relativePath,
            target,
            recoveryPath,
            hadOriginal: (await fingerprint(target)) !== "absent",
            originalIndexEntry,
            originalIndexFingerprint,
            writtenFingerprint: "absent",
            writtenIndexEntry: originalIndexEntry,
            writtenIndexFingerprint: originalIndexFingerprint,
        };
        state.pathProgress[entry.relativePath] = journalProgress(entry, "planned");
        // Persist the planned state before a source move can make recovery necessary.
        // react-doctor-disable-next-line react-doctor/async-parallel, react-doctor/async-defer-await
        await this.writePendingJournal(state);
        await this.moveOriginal(entry, state, gitDirectory);

        const baseEntry = await this.git.getBaseEntry(state.baseOid, relativePath);
        await this.writeBase(entry, baseEntry, file.baseBytes, state);
        await this.updateIndex(entry, baseEntry, state);
        if (entry.hadOriginal && (await fingerprint(recoveryPath)) === "absent") {
            throw new RecoverySafetyError("Recovery object disappeared before journal commit.");
        }
        await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
        await this.checkpoint("recovery-verified");
    }

    private async moveOriginal(
        entry: MovedPath,
        state: RevertState,
        gitDirectory: string,
    ): Promise<void> {
        if (!entry.hadOriginal) {
            state.moved.push(entry);
            return;
        }
        const details = await lstat(entry.target);
        if (!details.isFile() || details.isSymbolicLink()) {
            throw new RecoverySafetyError("Only regular files can enter recovery staging.");
        }
        // Containment must be checked before fingerprinting a recovery target.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await ensureContainedParent(gitDirectory, entry.recoveryPath);
        if ((await fingerprint(entry.recoveryPath)) !== "absent") {
            throw new RecoverySafetyError("Recovery staging path already exists.");
        }
        await assertContainedParent(this.options.repositoryRoot, entry.target);
        await assertContainedParent(gitDirectory, entry.recoveryPath);
        await rename(entry.target, entry.recoveryPath);
        state.moved.push(entry);
        state.pathProgress[entry.relativePath] = journalProgress(entry, "moved");
        // The move must be journaled before checkpoint code or a subsequent guard can fail.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.writePendingJournal(state);
        await this.checkpoint("source-moved");
        if ((await fingerprint(entry.target)) !== "absent") {
            throw new RecoverySafetyError("A path reappeared during the recovery transaction.");
        }
        // Re-check recovery containment after rename before preserving a recovery snapshot.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await assertContainedParent(gitDirectory, entry.recoveryPath);
        const snapshot = await this.options.store.putObject(
            "recovery-" + state.transactionId,
            await readFile(entry.recoveryPath),
        );
        // Re-read by address before journaling so a corrupted recovery object cannot commit.
        await this.options.store.readObject("recovery-" + state.transactionId, snapshot.hash);
        state.recoveryObjectHashes.push(snapshot.hash);
        await this.writePendingJournal(state);
    }

    private async writeBase(
        entry: MovedPath,
        baseEntry: ShelfJournalIndexEntry | undefined,
        suppliedBaseBytes: Uint8Array | undefined,
        state: RevertState,
    ): Promise<void> {
        if (baseEntry && !isRegularFileMode(baseEntry.mode)) {
            throw new RecoverySafetyError("Only regular-file base entries can be restored.");
        }
        if (baseEntry) {
            await writeBaseFile(
                this.options.repositoryRoot,
                entry.target,
                suppliedBaseBytes ?? (await this.git.readBlob(baseEntry.oid)),
            );
            entry.writtenFingerprint = await fingerprint(entry.target);
        }
        state.pathProgress[entry.relativePath] = journalProgress(entry, "written");
        // A written base must be durable in the journal before the mutation checkpoint runs.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.writePendingJournal(state);
        await this.checkpoint("base-written");
        if ((await fingerprint(entry.target)) !== entry.writtenFingerprint) {
            throw new RecoverySafetyError("A transaction-written path changed before commit.");
        }
    }

    private async updateIndex(
        entry: MovedPath,
        baseEntry: ShelfJournalIndexEntry | undefined,
        state: RevertState,
    ): Promise<void> {
        await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
        await this.git.writeIndexEntry(entry.relativePath, baseEntry);
        entry.writtenIndexEntry = await this.git.getIndexEntry(entry.relativePath);
        entry.writtenIndexFingerprint = await this.git.getIndexPathFingerprint(entry.relativePath);
        if (!sameIndexEntry(entry.writtenIndexEntry, baseEntry)) {
            throw new RecoverySafetyError("Git did not restore the expected base index entry.");
        }
        state.expectedIndex = await this.currentIndexFingerprint();
        state.pathProgress[entry.relativePath] = journalProgress(entry, "written");
        await this.writePendingJournal(state);
        await this.checkpoint("index-updated");
    }

    private async writePendingJournal(state: RevertState): Promise<void> {
        await this.options.store.writeJournal({
            ...state.journal,
            pathProgress: state.pathProgress,
            expectedIndexFingerprint: state.expectedIndex,
            recoveryObjectHashes: state.recoveryObjectHashes,
        });
    }

    private async commitJournal(state: RevertState): Promise<void> {
        await this.options.store.writeJournal({
            ...state.journal,
            state: "shelved",
            pathProgress: Object.fromEntries(
                Object.entries(state.pathProgress).map(([relativePath, progress]) => [
                    relativePath,
                    { ...progress, phase: "reverted" as const },
                ]),
            ),
            expectedIndexFingerprint: state.expectedIndex,
            recoveryObjectHashes: state.recoveryObjectHashes,
        });
    }

    private async pendingMovedPaths(
        journal: ShelfJournal,
        gitDir: string,
    ): Promise<readonly MovedPath[]> {
        const recoveryDirectory = recoveryDirectoryFor(gitDir, journal.id);
        const moved: MovedPath[] = [];
        for (const [relativePath, progress] of Object.entries(journal.pathProgress)) {
            if (!isJournalPathProgress(progress)) {
                throw new RecoverySafetyError(
                    "Pending recovery journal has invalid path progress.",
                );
            }
            const safeRelativePath = assertRepositoryRelativePath(relativePath);
            const target = resolveRepositoryPath(this.options.repositoryRoot, safeRelativePath);
            const recoveryPath = resolveRecoveryPath(recoveryDirectory, safeRelativePath);
            // Keep path checks ordered and fail closed before reading either filesystem location.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop, react-doctor/async-parallel
            await assertContainedParentIfPresent(this.options.repositoryRoot, target);
            await assertContainedParentIfPresent(gitDir, recoveryPath);
            const targetFingerprint = await fingerprint(target);
            const recoveryFingerprint = await fingerprint(recoveryPath);
            if (progress.phase === "planned") {
                if (!progress.hadOriginal) {
                    if (targetFingerprint === "absent" && recoveryFingerprint === "absent")
                        continue;
                    throw new RecoverySafetyError(
                        "Planned recovery path has ambiguous filesystem state.",
                    );
                }
                if (targetFingerprint !== "absent" && recoveryFingerprint === "absent") continue;
                if (targetFingerprint !== "absent" || recoveryFingerprint === "non-regular") {
                    throw new RecoverySafetyError(
                        "Planned recovery path has ambiguous filesystem state.",
                    );
                }
            }
            if (progress.hadOriginal && recoveryFingerprint === "absent") {
                throw new RecoverySafetyError("Pending recovery original is missing.");
            }
            moved.push({
                relativePath: safeRelativePath,
                target,
                recoveryPath,
                hadOriginal: progress.hadOriginal,
                originalIndexEntry: progress.originalIndexEntry,
                originalIndexFingerprint: progress.originalIndexFingerprint,
                writtenFingerprint: progress.writtenFingerprint,
                writtenIndexEntry: progress.writtenIndexEntry ?? progress.originalIndexEntry,
                writtenIndexFingerprint: progress.writtenIndexFingerprint,
            });
        }
        return moved;
    }

    private async verifyGitPreconditions(
        originalHead: string | undefined,
        expectedIndex: string | undefined,
    ): Promise<void> {
        if ((await this.currentHead()) !== originalHead) {
            throw new RecoverySafetyError("HEAD changed during the shelf recovery transaction.");
        }
        if ((await this.currentIndexFingerprint()) !== expectedIndex) {
            throw new RecoverySafetyError("Index changed during the shelf recovery transaction.");
        }
    }

    private async currentHead(): Promise<string | undefined> {
        return this.options.getHead ? this.options.getHead() : this.git.getHead();
    }

    private async currentIndexFingerprint(): Promise<string | undefined> {
        return this.options.getIndexFingerprint
            ? this.options.getIndexFingerprint()
            : this.git.getIndexFingerprint();
    }

    private async checkpoint(checkpoint: RevertCheckpoint): Promise<void> {
        await this.options.checkpoint?.(checkpoint);
    }
}

/** Performs restart-time rollback for pending journals while leaving committed shelves untouched. */
export async function resumePendingShelfRecoveries(
    options: ShelfReverterOptions,
): Promise<PendingShelfRecoveryResult> {
    return new ShelfReverter(options).resumePending();
}

/**
 * Explicitly purges only recovery transaction directories older than retention.
 *
 * Shelf deletion never calls this function, so retained originals stay available
 * until the configured minimum window expires and a purge is requested.
 */
export async function purgeRecoverySnapshots(options: {
    readonly gitDir: string;
    readonly minimumRetentionMs: number;
    readonly now?: number;
}): Promise<readonly string[]> {
    const recoveryRoot = resolveRecoveryPath(options.gitDir, path.join("intelligit", "recovery"));
    let transactionIds: readonly string[];
    try {
        await assertContainedParentIfPresent(options.gitDir, recoveryRoot);
        const rootDetails = await lstat(recoveryRoot);
        if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
            throw new RecoverySafetyError("Recovery staging root is not a regular directory.");
        }
        transactionIds = await readdir(recoveryRoot);
    } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
    }
    const now = options.now ?? Date.now();
    const purged: string[] = [];
    // Extension host target is ES2022, so retain the compatible immutable copy before sorting.
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    for (const transactionId of [...transactionIds].sort()) {
        const target = resolveRecoveryPath(recoveryRoot, assertIdentifier(transactionId));
        // Purge in stable order so a safety failure leaves the remaining snapshots untouched.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await assertContainedParent(options.gitDir, target);
        const details = await lstat(target);
        if (details.isSymbolicLink()) {
            throw new RecoverySafetyError(
                "Recovery staging transaction is not a regular directory.",
            );
        }
        if (
            !details.isDirectory() ||
            (options.minimumRetentionMs > 0 && now - details.mtimeMs < options.minimumRetentionMs)
        )
            continue;
        await assertContainedParent(options.gitDir, target);
        await rm(target, { recursive: true, force: false });
        purged.push(transactionId);
    }
    return purged;
}

async function rollbackMovedPaths(
    moved: readonly MovedPath[],
    repositoryRoot: string,
    gitDirectory: string,
    git: ShelfRecoveryGit,
    expectedIndexFingerprint: string | undefined,
): Promise<readonly string[]> {
    const retained: string[] = [];
    for (const entry of [...moved].reverse()) {
        try {
            // Validate recovery containment before any guard can inspect or alter its path.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            await assertContainedParentIfPresent(gitDirectory, entry.recoveryPath);
            if (!(await matchesWrittenIndexState(entry, git, expectedIndexFingerprint))) {
                retained.push(entry.relativePath);
                continue;
            }
            if ((await fingerprint(entry.target)) !== entry.writtenFingerprint) {
                retained.push(entry.relativePath);
                continue;
            }
            const recoveryFingerprint = entry.hadOriginal
                ? await fingerprint(entry.recoveryPath)
                : "absent";
            if (
                entry.hadOriginal &&
                (recoveryFingerprint === "absent" || recoveryFingerprint === "non-regular")
            ) {
                retained.push(entry.relativePath);
                continue;
            }

            // Restore the index first so a later filesystem failure leaves the recovery copy intact.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            await git.writeIndexEntry(entry.relativePath, entry.originalIndexEntry);
            if (!(await matchesOriginalIndexState(entry, git))) {
                retained.push(entry.relativePath);
                continue;
            }
            if (entry.writtenIndexFingerprint === undefined) {
                expectedIndexFingerprint = await git.getIndexFingerprint();
            }
            if (entry.writtenFingerprint !== "absent") {
                await assertContainedParent(repositoryRoot, entry.target);
                await rm(entry.target, { force: true });
            }
            if (entry.hadOriginal) {
                // Refuse a symlinked target before checking whether it remains absent.
                // react-doctor-disable-next-line react-doctor/async-defer-await
                await ensureContainedParent(repositoryRoot, entry.target);
                if ((await fingerprint(entry.target)) !== "absent") {
                    retained.push(entry.relativePath);
                    continue;
                }
                await assertContainedParent(gitDirectory, entry.recoveryPath);
                await rename(entry.recoveryPath, entry.target);
            }
        } catch {
            retained.push(entry.relativePath);
        }
    }
    return retained.reverse();
}

async function matchesWrittenIndexState(
    entry: MovedPath,
    git: ShelfRecoveryGit,
    expectedIndexFingerprint: string | undefined,
): Promise<boolean> {
    if (!sameIndexEntry(await git.getIndexEntry(entry.relativePath), entry.writtenIndexEntry)) {
        return false;
    }
    return entry.writtenIndexFingerprint !== undefined
        ? (await git.getIndexPathFingerprint(entry.relativePath)) === entry.writtenIndexFingerprint
        : expectedIndexFingerprint === undefined ||
              (await git.getIndexFingerprint()) === expectedIndexFingerprint;
}

async function matchesOriginalIndexState(
    entry: MovedPath,
    git: ShelfRecoveryGit,
): Promise<boolean> {
    if (!sameIndexEntry(await git.getIndexEntry(entry.relativePath), entry.originalIndexEntry)) {
        return false;
    }
    return (
        entry.originalIndexFingerprint === undefined ||
        (await git.getIndexPathFingerprint(entry.relativePath)) === entry.originalIndexFingerprint
    );
}

/**
 * Writes base bytes with exclusive creation and containment checks.
 *
 * Node has no openat-family confinement. When O_NOFOLLOW is unavailable, lstat
 * bracketing remains the best available fail-closed guard; retained originals
 * bound the residual race rather than claiming a guarantee Node cannot provide.
 */
async function writeBaseFile(
    repositoryRoot: string,
    target: string,
    bytes: Uint8Array,
): Promise<void> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    // Containment is a prerequisite for the absent-target guard and exclusive creation.
    // react-doctor-disable-next-line react-doctor/async-defer-await
    await ensureContainedParent(repositoryRoot, target);
    if ((await fingerprint(target)) !== "absent") {
        throw new RecoverySafetyError("Refusing to replace an existing recovery target.");
    }

    const file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
    );
    try {
        await file.writeFile(bytes);
        await file.sync();
    } finally {
        await file.close();
    }
    await chmod(target, 0o600);
    const details = await lstat(target);
    if (details.isSymbolicLink() || !details.isFile()) {
        throw new RecoverySafetyError("Base write did not create a regular file.");
    }
    await assertContainedParent(repositoryRoot, target);
}

function journalProgress(
    entry: MovedPath,
    phase: ShelfJournalPathProgress["phase"],
): ShelfJournalPathProgress {
    return {
        phase,
        target: entry.target,
        recoveryPath: entry.recoveryPath,
        hadOriginal: entry.hadOriginal,
        writtenFingerprint: entry.writtenFingerprint,
        originalIndexEntry: entry.originalIndexEntry,
        writtenIndexEntry: entry.writtenIndexEntry,
        originalIndexFingerprint: entry.originalIndexFingerprint,
        writtenIndexFingerprint: entry.writtenIndexFingerprint,
    };
}

function isJournalPathProgress(value: unknown): value is ShelfJournalPathProgress {
    if (!value || typeof value !== "object") return false;
    const progress = value as Partial<ShelfJournalPathProgress>;
    return (
        (progress.phase === "planned" ||
            progress.phase === "moved" ||
            progress.phase === "written" ||
            progress.phase === "reverted") &&
        typeof progress.target === "string" &&
        typeof progress.recoveryPath === "string" &&
        typeof progress.hadOriginal === "boolean" &&
        typeof progress.writtenFingerprint === "string" &&
        isOptionalIndexEntry(progress.originalIndexEntry) &&
        isOptionalIndexEntry(progress.writtenIndexEntry) &&
        isIndexFingerprintPair(progress.originalIndexFingerprint, progress.writtenIndexFingerprint)
    );
}

function isOptionalIndexEntry(value: unknown): value is ShelfJournalIndexEntry | undefined {
    return value === undefined || isIndexEntry(value);
}

function isIndexFingerprintPair(original: unknown, written: unknown): boolean {
    return (
        (original === undefined && written === undefined) ||
        (isIndexFingerprint(original) && isIndexFingerprint(written))
    );
}

function isIndexEntry(value: unknown): value is ShelfJournalIndexEntry {
    return (
        !!value &&
        typeof value === "object" &&
        "mode" in value &&
        "oid" in value &&
        typeof value.mode === "string" &&
        typeof value.oid === "string" &&
        /^[0-7]{1,6}$/.test(value.mode) &&
        /^[a-f0-9]{40,64}$/.test(value.oid)
    );
}

function sameIndexEntry(
    left: ShelfJournalIndexEntry | undefined,
    right: ShelfJournalIndexEntry | undefined,
): boolean {
    return left?.mode === right?.mode && left?.oid === right?.oid;
}

function isRegularFileMode(mode: string): boolean {
    return mode === "100644" || mode === "100755";
}

async function fingerprint(target: string): Promise<string> {
    try {
        const details = await lstat(target);
        if (!details.isFile() || details.isSymbolicLink()) {
            return "non-regular";
        }
        return `${(details.mode & 0o7777).toString(8)}:${createHash("sha256")
            .update(await readFile(target))
            .digest("hex")}`;
    } catch (error) {
        if (isNotFound(error)) return "absent";
        throw error;
    }
}

async function isSameFilesystem(repositoryRoot: string, gitDir: string): Promise<boolean> {
    const [worktree, git] = await Promise.all([stat(repositoryRoot), stat(gitDir)]);
    return worktree.dev === git.dev;
}

function assertIdentifier(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
        throw new RecoverySafetyError("Invalid recovery transaction ID.");
    return value;
}

function recoveryDirectoryFor(gitDirectory: string, transactionId: string): string {
    return resolveRecoveryPath(
        gitDirectory,
        path.join("intelligit", "recovery", assertIdentifier(transactionId)),
    );
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

function isIndexFingerprint(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
