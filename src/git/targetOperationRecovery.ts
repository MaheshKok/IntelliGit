import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readFile,
    readlink,
    readdir,
    realpath,
    rename,
    link,
    unlink,
    symlink,
    type FileHandle,
} from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChangelistPersistence } from "../changes/changelistPersistence";
import type { ChangelistStore, TargetOperationLease } from "../changes/changelistStore";
import type {
    TargetOperationEvidence,
    TargetOperationExpectedState,
    TargetPathIdentity,
    TargetPathState,
    TargetIndexEntry,
    TargetAbortPathEvidence,
    TargetIndexPublicationEvidence,
} from "../changes/targetOperation";
import { changeFingerprint } from "../changes/parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { ensureContainedParent } from "../shelf/recoveryPaths";
import type { GitExecutor } from "./executor";
import { RepositoryMutationGate } from "./repositoryMutationGate";
import { RepositoryMutationCoordinator } from "./mutationCoordinator";
import { RepositoryLock } from "./repositoryLock";

type IndexTuple = Omit<TargetIndexEntry, "object">;
/** Index blobs read per Git process; bounds memory when many large files are captured together. */
const BLOB_BATCH = 32;
const nativeRecoveryGate = new RepositoryMutationGate(
    new RepositoryMutationCoordinator(),
    new RepositoryLock(),
);

/** False where core.fileMode is false, as Git for Windows sets it: Git then ignores the disk executable bit. */
export async function trustsExecutableBit(executor: GitExecutor): Promise<boolean> {
    const value = await executor.run(["config", "--bool", "--default", "true", "core.fileMode"]);
    return value.trim() === "true";
}

/** Capture exact affected bytes and index stages; callers durably publish before mutating Git. */
export async function captureTargetNativeEvidence(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    operationId: string,
    affectedPaths: readonly string[],
): Promise<TargetOperationEvidence> {
    const { root, gitDir } = persistence;
    const head = await assertNativeRepository(executor, persistence, true);
    const paths = [...affectedPaths].sort();
    if (
        new Set(paths).size !== paths.length ||
        paths.some(
            (file) =>
                assertRepoRelativePath(file) !== file ||
                file.split("/").some((part) => part.toLowerCase() === ".git") ||
                file.startsWith(".intelligit-recovery/"),
        )
    )
        throw new Error("Unsupported recovery path.");
    const indexFingerprint = changeFingerprint(await readRegularBytes(path.join(gitDir, "index")));
    const native = await readNative(gitDir);
    const entries = (await readIndex(executor)).filter((entry) => paths.includes(entry.path));
    if (entries.some((entry) => entry.mode === "160000" || entry.intentToAdd))
        throw new Error("Unsupported native recovery index representation.");
    const index: TargetIndexEntry[] = [];
    // Each batch is stored before the next is read, so at most BLOB_BATCH blobs are held at once.
    for (let first = 0; first < entries.length; first += BLOB_BATCH) {
        const batch = entries.slice(first, first + BLOB_BATCH);
        const blobs = await readBlobs(
            executor,
            batch.map((entry) => entry.oid),
        );
        for (const [position, entry] of batch.entries()) {
            const bytes = blobs[position];
            index.push({
                ...entry,
                object: {
                    hash: await persistence.storeTargetOperationObject(bytes),
                    size: bytes.length,
                },
            });
        }
    }
    // Equal contents share a digest path; serialize publication across temporary-link cleanup.
    const pathStates: { path: string; state: TargetPathState }[] = [];
    for (const file of paths)
        pathStates.push({ path: file, state: await readPath(persistence, file) });
    if (
        (await executor.run(["rev-parse", "--verify", "HEAD"])).trim() !== head ||
        changeFingerprint(await readRegularBytes(path.join(gitDir, "index"))) !==
            indexFingerprint ||
        !isDeepStrictEqual(await readNative(gitDir), native)
    )
        throw new Error("Native recovery source changed during capture.");
    for (const saved of pathStates) {
        await safeParent(root, saved.path);
        const stat = await lstat(path.join(root, saved.path), { bigint: true }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        });
        if (
            saved.state.kind === "absent"
                ? stat !== undefined
                : !stat || !isDeepStrictEqual(identity(stat), saved.state.identity)
        )
            throw new Error("Native recovery path changed during capture.");
    }
    return {
        version: 1,
        operationId,
        root,
        gitDir,
        checkpoint: "before",
        head,
        indexFingerprint,
        paths: pathStates,
        index,
        native,
        entries: [],
    };
}

/** Restore only a reviewed native operation; the supplied lease must belong to the actual store. */
export async function abortTargetNativeOperation(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    lease: TargetOperationLease,
    expected: TargetOperationExpectedState,
    fault?: (checkpoint: string) => Promise<void>,
): Promise<void> {
    store.readTargetOperationRecovery(lease, persistence.root, expected);
    await assertNativeRepository(executor, persistence);
    executor = executor.deriveFor(persistence.root);
    const commonDir = path.resolve(
        persistence.root,
        (await executor.run(["rev-parse", "--git-common-dir"])).trim(),
    );
    await nativeRecoveryGate.run(persistence.root, commonDir, async () => {
        processStart();
        let state = store.readTargetOperationRecovery(lease, persistence.root, expected);
        let pending = state.pendingTargetOperation!;
        const chain = await persistence.loadTargetOperationEvidenceChain(pending.evidenceHash);
        const before = chain.root.evidence;
        if (chain.root.hash !== pending.beforeEvidenceHash || before.head !== pending.headBefore)
            throw new Error("Native recovery before evidence changed.");
        let current = chain.evidence;
        await restoreGitObjects(executor, persistence, [...before.index, ...current.index]);
        const affected = before.paths.map((entry) => entry.path);
        /** Capture current state while retaining the immutable operation's entry identities. */
        const observe = async (): Promise<TargetOperationEvidence> => ({
            ...(await captureTargetNativeEvidence(executor, persistence, pending.id, affected)),
            entries: current.entries,
        });
        /** Publish evidence before acknowledging a destructive boundary. */
        const checkpoint = async (next: TargetOperationEvidence): Promise<void> => {
            const evidenceHash = await persistence.storeTargetOperationEvidence({
                ...next,
                previousEvidenceHash: pending.evidenceHash,
            });
            await fault?.(`evidence:${next.checkpoint}`);
            state = await store.checkpointTargetAbort(lease, {
                id: pending.id,
                revision: state.revision,
                expectedPhase: pending.phase,
                evidenceHash,
            });
            pending = state.pendingTargetOperation!;
            current = await persistence.loadTargetOperationEvidence(evidenceHash);
            await fault?.(`checkpoint:${next.checkpoint}`);
        };
        if (!current.checkpoint.startsWith("abort")) {
            if (current.checkpoint !== "after")
                throw new Error("Native abort needs reviewed after evidence.");
            const observed = await observe();
            assertObserved(current, observed, true);
            await assertNativeIdentity(executor, pending.kind, pending.commit, observed);
            const abortPaths = current.paths.map((entry, index): TargetAbortPathEvidence => ({
                path: entry.path,
                recoveryPath: `.intelligit-recovery/${pending.id}/${index}`,
                expectedCurrent: entry.state,
                desiredBefore: before.paths.find((saved) => saved.path === entry.path)!.state,
                move: { state: "planned" },
                install: { state: "pending" },
            }));
            await checkpoint({ ...observed, checkpoint: "abortPrepared", abortPaths });
        }
        if (current.checkpoint === "abortPrepared" || current.checkpoint === "abortPath") {
            await restoreAbortPaths(persistence, current, observe, checkpoint, fault);
        }
        if (
            current.checkpoint === "abortPathsRestored" ||
            current.checkpoint === "abortIndexPrepared"
        ) {
            await assertOtherPaths(persistence, current.abortPaths!);
            const publication = await restoreIndex(
                executor,
                persistence,
                current,
                before,
                async (indexPublication) => {
                    await checkpoint({
                        ...(await observe()),
                        checkpoint: "abortIndexPrepared",
                        abortPaths: current.abortPaths,
                        indexPublication,
                    });
                },
                fault,
            );
            await checkpoint({
                ...(await observe()),
                checkpoint: "abortIndexRestored",
                abortPaths: current.abortPaths,
                indexPublication: publication,
            });
        }
        if (current.checkpoint === "abortIndexRestored") {
            const observed = await observe();
            assertObserved(current, observed, false);
            if (!isDeepStrictEqual(observed.index, before.index))
                throw new Error("Native abort affected index changed.");
            if (observed.native.some((entry) => entry.present)) {
                await assertNativeIdentity(executor, pending.kind, pending.commit, observed);
                await fault?.("beforeQuit");
                assertObserved(observed, await observe(), true);
                await executor.runBinary([
                    pending.kind === "cherryPick" ? "cherry-pick" : "revert",
                    "--quit",
                ]);
                await fault?.("afterQuit");
            }
            const cleared = await observe();
            if (
                cleared.native.some((entry) => entry.present) ||
                !isDeepStrictEqual({ ...cleared, native: observed.native }, observed)
            )
                throw new Error("Native cleanup changed repository content.");
            await checkpoint({
                ...cleared,
                checkpoint: "abortNativeCleared",
                abortPaths: current.abortPaths,
                indexPublication: current.indexPublication,
            });
        }
        if (current.checkpoint !== "abortNativeCleared")
            throw new Error("Unsupported native recovery checkpoint.");
        assertObserved(current, await observe(), true);
        await fault?.("beforeFinish");
        assertObserved(current, await observe(), true);
        await store.finishTargetAbort(lease, {
            id: pending.id,
            revision: state.revision,
            expectedPhase: pending.phase,
        });
        await fault?.("afterFinish");
    });
}

/**
 * Bind the executor before any Git-object write or repository-gate acquisition. With `readHead`,
 * the same Git process also reads HEAD and returns it; otherwise it returns an empty string.
 */
async function assertNativeRepository(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    readHead = false,
): Promise<string> {
    const lines = (
        await executor.run([
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            ...(readHead ? ["--verify", "HEAD"] : []),
        ])
    )
        .trim()
        .split("\n");
    if (
        lines.length !== (readHead ? 3 : 2) ||
        (await realpath(lines[0])) !== persistence.root ||
        (await realpath(lines[1])) !== persistence.gitDir
    )
        throw new Error("Recovery repository identity changed.");
    return lines[2] ?? "";
}

/** Reads the given blobs through one `cat-file --batch` process instead of one process per object. */
async function readBlobs(executor: GitExecutor, oids: readonly string[]): Promise<Buffer[]> {
    const output = (
        await executor.runBinary(["cat-file", "--batch"], {
            input: Buffer.from(oids.map((oid) => `${oid}\n`).join("")),
        })
    ).stdout;
    const blobs: Buffer[] = [];
    let position = 0;
    for (const oid of oids) {
        const newline = output.indexOf(10, position);
        const header = /^([a-f0-9]+) blob (\d+)$/.exec(
            output.subarray(position, newline < 0 ? position : newline).toString("utf8"),
        );
        const end = newline + 1 + Number(header?.[2]);
        if (!header || header[1] !== oid || output[end] !== 10)
            throw new Error("Unsupported native recovery object.");
        blobs.push(output.subarray(newline + 1, end));
        position = end + 1;
    }
    if (position !== output.length) throw new Error("Unsupported native recovery object.");
    return blobs;
}

/** Restore paths in order, durably acknowledging each move before any installation. */
async function restoreAbortPaths(
    persistence: ChangelistPersistence,
    initial: TargetOperationEvidence,
    observe: () => Promise<TargetOperationEvidence>,
    publish: (next: TargetOperationEvidence) => Promise<void>,
    fault?: (checkpoint: string) => Promise<void>,
): Promise<void> {
    let current = initial;
    /** Keep the next path's checks aligned with the last successful durable publication. */
    const checkpoint = async (next: TargetOperationEvidence): Promise<void> => {
        await publish(next);
        current = next;
    };
    for (let index = 0; index < current.abortPaths!.length; index++) {
        const prior = current.abortPaths![index];
        assertHeadNativeIndex(current, await observe());
        await assertOtherPaths(persistence, current.abortPaths!, prior.path);
        let entry = await moveAbortPath(persistence, prior, fault);
        if (prior.move.state === "planned")
            await checkpoint({
                ...(await observe()),
                checkpoint: "abortPath",
                abortPaths: current.abortPaths!.map((saved, at) => (at === index ? entry : saved)),
            });
        assertHeadNativeIndex(current, await observe());
        await assertOtherPaths(persistence, current.abortPaths!, entry.path);
        entry = await installAbortPath(persistence, entry, fault);
        if (prior.install.state === "pending")
            await checkpoint({
                ...(await observe()),
                checkpoint: "abortPath",
                abortPaths: current.abortPaths!.map((saved, at) => (at === index ? entry : saved)),
            });
    }
    await checkpoint({
        ...(await observe()),
        checkpoint: "abortPathsRestored",
        abortPaths: current.abortPaths,
    });
}

/** Recognize a prior unacknowledged rename only by exact original/displaced observations. */
async function moveAbortPath(
    persistence: ChangelistPersistence,
    entry: TargetAbortPathEvidence,
    fault?: (checkpoint: string) => Promise<void>,
): Promise<TargetAbortPathEvidence> {
    let original = await readPath(persistence, entry.path);
    let displaced = await readPath(persistence, entry.recoveryPath);
    if (entry.move.state === "moved") {
        if (!samePath(displaced, entry.move.observed, "moved"))
            throw new Error("Native abort recovery bytes changed.");
        return entry;
    }
    if (samePath(original, entry.expectedCurrent, true) && displaced.kind === "absent") {
        await ensureContainedParent(
            persistence.root,
            path.join(persistence.root, entry.recoveryPath),
        );
        if (entry.expectedCurrent.kind !== "absent") {
            await fault?.(`beforeMove:${entry.path}`);
            await safeParent(persistence.root, entry.path);
            await rename(
                path.join(persistence.root, entry.path),
                path.join(persistence.root, entry.recoveryPath),
            );
            await syncParent(path.join(persistence.root, entry.path));
            await syncParent(path.join(persistence.root, entry.recoveryPath));
            await fault?.(`afterMove:${entry.path}`);
        }
        displaced = await readPath(persistence, entry.recoveryPath);
        original = await readPath(persistence, entry.path);
    }
    if (!samePath(displaced, entry.expectedCurrent, "moved") || original.kind !== "absent")
        throw new Error("Native abort displaced bytes changed; retained for review.");
    return { ...entry, move: { state: "moved", observed: displaced } };
}

/** Never overwrite a racing replacement; matching installed bytes permit acknowledgement after restart. */
async function installAbortPath(
    persistence: ChangelistPersistence,
    entry: TargetAbortPathEvidence,
    fault?: (checkpoint: string) => Promise<void>,
): Promise<TargetAbortPathEvidence> {
    let original = await readPath(persistence, entry.path);
    if (entry.install.state === "installed") {
        if (!samePath(original, entry.install.observed, true))
            throw new Error("Restored path changed after installation.");
        return entry;
    }
    if (original.kind === "absent") {
        await fault?.(`beforeInstall:${entry.path}`);
        await installBefore(persistence, entry);
        await fault?.(`afterInstall:${entry.path}`);
        original = await readPath(persistence, entry.path);
    }
    if (!samePath(original, entry.desiredBefore, false))
        throw new Error("Native abort install collided with changed bytes.");
    return { ...entry, install: { state: "installed", observed: original } };
}

/** Byte equality deliberately ignores inode changes caused by exclusive restoration. */
function samePath(
    left: TargetPathState,
    right: TargetPathState,
    compareIdentity: boolean | "moved",
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "absent" || right.kind === "absent") return true;
    const { identity: leftIdentity, ...leftContent } = left;
    const { identity: rightIdentity, ...rightContent } = right;
    return (
        isDeepStrictEqual(leftContent, rightContent) &&
        (!compareIdentity ||
            (compareIdentity === "moved"
                ? leftIdentity.device === rightIdentity.device &&
                  leftIdentity.inode === rightIdentity.inode &&
                  leftIdentity.size === rightIdentity.size
                : isDeepStrictEqual(leftIdentity, rightIdentity)))
    );
}

/** Path restoration never authorizes changes to HEAD, affected index or matching native state. */
function assertHeadNativeIndex(
    saved: TargetOperationEvidence,
    observed: TargetOperationEvidence,
): void {
    if (
        saved.head !== observed.head ||
        !isDeepStrictEqual(saved.index, observed.index) ||
        !isDeepStrictEqual(saved.native, observed.native)
    )
        throw new Error("Native abort HEAD, index or native state changed.");
}

/** Accept native absence only around the already-restored quit boundary. */
function assertObserved(
    saved: TargetOperationEvidence,
    observed: TargetOperationEvidence,
    strictNative: boolean,
): void {
    assertHeadNativeIndex(
        strictNative || observed.native.some((entry) => entry.present)
            ? saved
            : { ...saved, native: observed.native },
        observed,
    );
    if (
        !saved.paths.every((entry) =>
            samePath(
                entry.state,
                observed.paths.find((candidate) => candidate.path === entry.path)!.state,
                true,
            ),
        )
    )
        throw new Error("Native abort affected worktree changed.");
}

/** Verify every other restored or untouched path before each destructive operation. */
async function assertOtherPaths(
    persistence: ChangelistPersistence,
    entries: readonly TargetAbortPathEvidence[],
    except?: string,
): Promise<void> {
    for (const entry of entries) {
        if (entry.path === except) continue;
        const expected =
            entry.install.state === "installed"
                ? entry.install.observed
                : entry.move.state === "moved"
                  ? ({ kind: "absent" } as const)
                  : entry.expectedCurrent;
        if (!samePath(await readPath(persistence, entry.path), expected, true))
            throw new Error("Native abort affected worktree changed.");
    }
}

/** Matching controls must belong to the recorded operation; merge and opposite-kind state are foreign. */
async function assertNativeIdentity(
    executor: GitExecutor,
    kind: string,
    commit: string | undefined,
    observed: TargetOperationEvidence,
): Promise<void> {
    const marker = kind === "cherryPick" ? "cherryPickHead" : "revertHead";
    if (
        observed.native.some(
            (entry) => entry.present && entry.name !== marker && entry.name !== "sequencer",
        )
    )
        throw new Error("Foreign native operation state.");
    if (observed.native.find((entry) => entry.name === marker)?.present) {
        const oid = (
            await executor.run([
                "rev-parse",
                "--verify",
                kind === "cherryPick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
            ])
        ).trim();
        if (oid !== commit) throw new Error("Native operation commit changed.");
    }
}

/** Install complete saved bytes exclusively, retaining the displaced object permanently. */
async function installBefore(
    persistence: ChangelistPersistence,
    entry: TargetAbortPathEvidence,
): Promise<void> {
    const target = path.join(persistence.root, entry.path);
    await ensureContainedParent(persistence.root, target);
    if (entry.desiredBefore.kind === "absent") return;
    const bytes = await persistence.loadTargetOperationObject(
        entry.desiredBefore.kind === "regular"
            ? entry.desiredBefore.content
            : entry.desiredBefore.target,
    );
    if (entry.desiredBefore.kind === "symlink") await symlink(bytes, target);
    else {
        const temp = `${path.join(persistence.root, entry.recoveryPath)}.install`;
        const mode = entry.desiredBefore.executable ? 0o755 : 0o644;
        const handle = await open(temp, "wx", mode).catch(async (error) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = await readPath(persistence, path.relative(persistence.root, temp));
            if (samePath(existing, entry.desiredBefore, false)) return undefined;
            // A crash mid-write leaves a regular prefix of the retained bytes; anything else is foreign.
            if (
                existing.kind !== "regular" ||
                existing.content.size > bytes.length ||
                !bytes
                    .subarray(0, existing.content.size)
                    .equals(await persistence.loadTargetOperationObject(existing.content))
            )
                throw new Error("Recovery install temporary changed.");
            await unlink(temp);
            return open(temp, "wx", mode);
        });
        if (handle) {
            try {
                await handle.writeFile(bytes);
                await handle.chmod(entry.desiredBefore.executable ? 0o755 : 0o644);
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
        await safeParent(persistence.root, entry.path);
        await link(temp, target);
        await unlink(temp);
    }
    await syncParent(target);
}

/** Sync directory entries after each rename or exclusive installation. */
async function syncParent(filename: string): Promise<void> {
    // Windows opens a directory handle but fails FlushFileBuffers on it with EPERM, and has no
    // directory-fsync equivalent; gated by platform so a genuine POSIX I/O failure still throws.
    if (process.platform === "win32") return;
    const handle = await open(path.dirname(filename), constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Persist this Node process's runtime-provided Unix start time without an external platform utility. */
function processStart(): string {
    const start = Math.trunc(performance.timeOrigin);
    if (!Number.isSafeInteger(start) || start <= 0)
        throw new Error("Cannot identify index-lock owner start time.");
    return String(start);
}

/** Only ESRCH proves death; a live PID, including one reused by another process, remains busy. */
function ownerDead(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
}

/** Build from the latest locked index, changing only affected entries and proving the complement unchanged. */
async function restoreIndex(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    saved: TargetOperationEvidence,
    before: TargetOperationEvidence,
    checkpoint: (publication: TargetIndexPublicationEvidence) => Promise<void>,
    fault?: (checkpoint: string) => Promise<void>,
): Promise<TargetIndexPublicationEvidence> {
    const live = path.join(persistence.gitDir, "index");
    const lockPath = `${live}.lock`;
    let publication = saved.indexPublication;
    if (publication) {
        const published = await settleSavedPublication(
            executor,
            persistence,
            publication,
            before,
            live,
            lockPath,
        );
        if (published) return published;
    }
    await fault?.("beforeIndexLock");
    const lock = await open(lockPath, "wx", 0o600);
    try {
        const lockIdentity = identity(await lock.stat({ bigint: true }));
        const start = processStart();
        const liveBytes = await readFile(live);
        const tuples = await readIndex(executor);
        const affected = new Set(before.paths.map((entry) => entry.path));
        const expected = saved.index.map(({ object: _object, ...entry }) => entry);
        if (
            !isDeepStrictEqual(
                tuples.filter((entry) => affected.has(entry.path)),
                expected,
            )
        )
            throw new Error("Native abort affected index changed before lock.");
        const relative = `intelligit/target-operations/${before.operationId}/candidate-${Date.now()}`;
        const candidate = path.join(persistence.gitDir, relative);
        await ensureContainedParent(persistence.gitDir, candidate);
        const candidateHandle = await open(candidate, "wx", 0o600);
        try {
            await candidateHandle.writeFile(liveBytes);
            await candidateHandle.sync();
        } finally {
            await candidateHandle.close();
        }
        publication = {
            state: "prepared",
            liveIndexFingerprint: changeFingerprint(liveBytes),
            candidate: {
                path: relative,
                fingerprint: changeFingerprint(liveBytes),
                identity: identity(await lstat(candidate, { bigint: true })),
            },
            lock: {
                identity: lockIdentity,
                operationId: before.operationId,
                owner: { pid: process.pid, processStart: start },
            },
        };
        await checkpoint(publication);
        await restoreSavedIndexEntries(executor, before, candidate);
        await fault?.("afterCandidateRebuild");
        const result = await readIndex(executor, candidate);
        if (
            !isDeepStrictEqual(
                result.filter((entry) => !affected.has(entry.path)),
                tuples.filter((entry) => !affected.has(entry.path)),
            ) ||
            !isDeepStrictEqual(
                result.filter((entry) => affected.has(entry.path)),
                before.index.map(({ object: _object, ...entry }) => entry),
            )
        )
            throw new Error(
                "Candidate index changed unrelated entries or failed affected restoration.",
            );
        const bytes = await readFile(candidate);
        // Read-write although nothing is written: Windows flushes a file only through a handle
        // with write access, and refuses a read-only one with EPERM.
        const candidateSync = await open(candidate, "r+");
        try {
            await candidateSync.sync();
        } finally {
            await candidateSync.close();
        }
        publication = {
            ...publication,
            candidate: {
                ...publication.candidate,
                fingerprint: changeFingerprint(bytes),
                identity: identity(await lstat(candidate, { bigint: true })),
            },
        };
        await checkpoint(publication);
        await assertOtherPaths(persistence, saved.abortPaths!);
        if (
            changeFingerprint(await readFile(live)) !== publication.liveIndexFingerprint ||
            !isDeepStrictEqual(identity(await lstat(lockPath, { bigint: true })), lockIdentity)
        )
            throw new Error("Live index or owned lock changed.");
        const head = (await executor.run(["rev-parse", "HEAD"])).trim();
        if (
            head !== before.head ||
            !isDeepStrictEqual(await readNative(persistence.gitDir), saved.native)
        )
            throw new Error("Native abort repository changed before index publication.");
        await lock.writeFile(bytes);
        await lock.sync();
        publication = {
            ...publication,
            lock: { ...publication.lock, identity: identity(await lock.stat({ bigint: true })) },
        };
        await checkpoint(publication);
        await fault?.("beforeIndexPublish");
        await assertOtherPaths(persistence, saved.abortPaths!);
        if (
            (await executor.run(["rev-parse", "HEAD"])).trim() !== before.head ||
            !isDeepStrictEqual(await readNative(persistence.gitDir), saved.native)
        )
            throw new Error("Native abort repository changed before publication.");
        const currentLock = await lstat(lockPath, { bigint: true });
        if (
            !isDeepStrictEqual(identity(currentLock), publication.lock.identity) ||
            changeFingerprint(await readFile(lockPath)) !== publication.candidate.fingerprint ||
            changeFingerprint(await readFile(live)) !== publication.liveIndexFingerprint
        )
            throw new Error("Owned index publication changed.");
        await rename(lockPath, live);
        await syncParent(live);
        await fault?.("afterIndexPublish");
        return { ...publication, state: "published" };
    } catch (error) {
        // A refusal releases our lock (gone once published) so Git works and a retry starts over.
        await releaseOwnedLock(lockPath, lock).catch((cleanup: unknown) => {
            throw new Error(
                `${String(error)}; releasing the owned index lock also failed: ${String(cleanup)}`,
                { cause: error },
            );
        });
        throw error;
    } finally {
        await lock.close();
    }
}

/**
 * Returns a saved publication that is already in place; otherwise clears its dead owner's lock so
 * the index step starts over.
 */
async function settleSavedPublication(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    publication: TargetIndexPublicationEvidence,
    before: TargetOperationEvidence,
    live: string,
    lockPath: string,
): Promise<TargetIndexPublicationEvidence | undefined> {
    const candidate = path.join(persistence.gitDir, publication.candidate.path);
    await safeParent(persistence.gitDir, publication.candidate.path);
    // A crash between the candidate rebuild and its checkpoint leaves newer candidate bytes, so only
    // a claimed publication needs the saved candidate; a redirected one still refuses here.
    await readRegularBytes(candidate);
    const currentBytes = await readFile(live);
    const lock = await lstat(lockPath, { bigint: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    });
    // Without a lock only a restored candidate in place proves publication; otherwise start the
    // index step over, whose own locked checks refuse an affected index that moved.
    if (
        !lock &&
        changeFingerprint(currentBytes) === publication.candidate.fingerprint &&
        publication.candidate.fingerprint !== publication.liveIndexFingerprint
    ) {
        const candidateBytes = await readRegularBytes(candidate, publication.candidate.identity);
        if (changeFingerprint(candidateBytes) !== publication.candidate.fingerprint)
            throw new Error("Recovery candidate index changed.");
        const affected = new Set(before.paths.map((entry) => entry.path));
        const restored = (await readIndex(executor, candidate)).filter((entry) =>
            affected.has(entry.path),
        );
        if (
            !isDeepStrictEqual(
                restored,
                before.index.map(({ object: _object, ...entry }) => entry),
            )
        )
            throw new Error("Recovery candidate does not contain restored affected entries.");
        return { ...publication, state: "published" };
    }
    if (!lock) return undefined;
    // A crash after filling our lock but before saving its new identity leaves the same file
    // holding exactly the candidate bytes; a partial fill stays ambiguous. The identity-checked
    // read refuses a lock another Git process replaced while it was being read.
    const filled =
        lock.isFile() &&
        String(lock.dev) === publication.lock.identity.device &&
        String(lock.ino) === publication.lock.identity.inode &&
        changeFingerprint(await readRegularBytes(lockPath, identity(lock))) ===
            publication.candidate.fingerprint;
    if (
        !(filled || isDeepStrictEqual(identity(lock), publication.lock.identity)) ||
        !ownerDead(publication.lock.owner.pid)
    )
        throw new Error("Recovery index lock is busy or ambiguous.");
    if (changeFingerprint(currentBytes) !== publication.liveIndexFingerprint)
        throw new Error("Live index changed during recovery.");
    // The checks above awaited (the read waits for its handle to close), so look at the path once
    // more right before deleting it.
    const still = await lstat(lockPath, { bigint: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    });
    if (!still || !isDeepStrictEqual(identity(still), identity(lock)))
        throw new Error("Recovery index lock is busy or ambiguous.");
    await unlink(lockPath);
    await syncParent(lockPath);
    return undefined;
}

/** Deletes the index lock only while its path still names the file this open handle holds. */
async function releaseOwnedLock(lockPath: string, lock: FileHandle): Promise<void> {
    const onDisk = await lstat(lockPath, { bigint: true }).catch((missing) => {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw missing;
    });
    // The open handle keeps our inode alive, so equal identity proves the path is still ours.
    if (
        onDisk &&
        isDeepStrictEqual(identity(onDisk), identity(await lock.stat({ bigint: true })))
    ) {
        await unlink(lockPath);
        await syncParent(lockPath);
    }
}

/** Read a regular file without redirects or concurrent replacement, optionally enforcing saved identity. */
async function readRegularBytes(filename: string, expected?: TargetPathIdentity): Promise<Buffer> {
    const stat = await lstat(filename, { bigint: true });
    const captured = identity(stat);
    if (!stat.isFile() || (expected && !isDeepStrictEqual(captured, expected)))
        throw new Error("Recovery candidate identity changed.");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (!isDeepStrictEqual(identity(await handle.stat({ bigint: true })), captured))
            throw new Error("Recovery candidate identity changed.");
        const bytes = await handle.readFile();
        if (!isDeepStrictEqual(identity(await lstat(filename, { bigint: true })), captured))
            throw new Error("Recovery candidate changed during read.");
        return bytes;
    } finally {
        await handle.close();
    }
}

/** Preserve the exact lstat identity needed to distinguish a moved file from a replacement. */
function identity(stat: BigIntStats): TargetPathIdentity {
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        size: Number(stat.size),
        modifiedNs: String(stat.mtimeNs),
        changedNs: String(stat.ctimeNs),
    };
}

/** Refuse symlink parents without creating directories during a read. */
async function safeParent(root: string, file: string): Promise<void> {
    let current = root;
    for (const component of path
        .dirname(file)
        .split("/")
        .filter((part) => part !== ".")) {
        current = path.join(current, component);
        const stat = await lstat(current).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        });
        if (!stat) return;
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("Recovery path has an unsafe parent.");
    }
}

/** Read raw bytes without filters or symlink following and reject files that change during capture. */
async function readPath(
    persistence: ChangelistPersistence,
    file: string,
): Promise<TargetPathState> {
    await safeParent(persistence.root, file);
    const filename = path.join(persistence.root, file);
    const stat = await lstat(filename, { bigint: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    });
    if (!stat) return { kind: "absent" };
    let bytes: Buffer;
    if (stat.isSymbolicLink()) bytes = await readlink(filename, { encoding: "buffer" });
    else if (stat.isFile()) {
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!isDeepStrictEqual(identity(await handle.stat({ bigint: true })), identity(stat)))
                throw new Error("Recovery file changed.");
            bytes = await handle.readFile();
        } finally {
            await handle.close();
        }
    } else throw new Error("Unsupported native recovery worktree representation.");
    if (!isDeepStrictEqual(identity(await lstat(filename, { bigint: true })), identity(stat)))
        throw new Error("Recovery file changed.");
    const reference = {
        hash: await persistence.storeTargetOperationObject(bytes),
        size: bytes.length,
    };
    return stat.isSymbolicLink()
        ? { kind: "symlink", target: reference, identity: identity(stat) }
        : {
              kind: "regular",
              executable: (stat.mode & 0o111n) !== 0n,
              content: reference,
              identity: identity(stat),
          };
}

/** Read all logical index tuples so candidate publication can prove unrelated stages and flags survived. */
async function readIndex(executor: GitExecutor, indexPath?: string): Promise<IndexTuple[]> {
    const env = indexPath ? { GIT_INDEX_FILE: indexPath } : undefined;
    // One read: each `-v` stage line ends in NUL and is followed by its `--debug` block.
    const output = (
        await executor.runBinary(["ls-files", "--stage", "-v", "--debug", "-z"], { env })
    ).stdout.toString("utf8");
    const debug = /  ctime:[\s\S]*?\tflags: ([a-f0-9]+)\n/y;
    const tuples: IndexTuple[] = [];
    let position = 0;
    while (position < output.length) {
        const end = output.indexOf("\0", position);
        debug.lastIndex = end + 1;
        const flags = debug.exec(output);
        if (end < position || !flags) throw new Error("Unsupported index debug representation.");
        const match =
            /^([A-Za-z?]) (100644|100755|120000|160000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(
                output.slice(position, end),
            );
        if (!match) throw new Error("Unsupported index entry.");
        tuples.push({
            path: match[5],
            stage: Number(match[4]) as IndexTuple["stage"],
            mode: match[2] as IndexTuple["mode"],
            oid: match[3],
            assumeUnchanged: match[1] === match[1].toLowerCase(),
            skipWorktree: match[1].toUpperCase() === "S",
            intentToAdd: (Number.parseInt(flags[1], 16) & 0x20000000) !== 0,
        });
        position = debug.lastIndex;
    }
    return tuples;
}

/** Native control fingerprints include sequencer names and bytes; symlinks and special files refuse. */
async function readNative(gitDir: string): Promise<TargetOperationEvidence["native"]> {
    return Promise.all(
        (
            [
                ["cherryPickHead", "CHERRY_PICK_HEAD"],
                ["revertHead", "REVERT_HEAD"],
                ["mergeHead", "MERGE_HEAD"],
                ["sequencer", "sequencer"],
            ] as const
        ).map(async ([name, file]) => {
            const filename = path.join(gitDir, file);
            const stat = await lstat(filename).catch((error) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            });
            if (!stat) return { name, present: false };
            if (stat.isSymbolicLink()) throw new Error("Unsafe native control state.");
            if (name !== "sequencer") {
                if (!stat.isFile()) throw new Error("Unsafe native control state.");
                return { name, present: true, hash: changeFingerprint(await readFile(filename)) };
            }
            if (!stat.isDirectory()) throw new Error("Unsafe native sequencer state.");
            const children = await readdir(filename);
            const contents = await Promise.all(
                children.sort().map(async (child) => {
                    const childPath = path.join(filename, child);
                    if (!(await lstat(childPath)).isFile())
                        throw new Error("Unsafe native sequencer entry.");
                    return [child, (await readFile(childPath)).toString("base64")];
                }),
            );
            return { name, present: true, hash: changeFingerprint(JSON.stringify(contents)) };
        }),
    );
}

/** Recreate retained Git blobs and write only the saved affected stages and supported flags. */
async function restoreSavedIndexEntries(
    executor: GitExecutor,
    before: TargetOperationEvidence,
    candidate: string,
): Promise<void> {
    const affected = new Set(before.paths.map((entry) => entry.path));
    const zero = "0".repeat(before.head.length);
    const records =
        [...affected].map((file) => `0 ${zero}\t${file}\0`).join("") +
        before.index
            .map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`)
            .join("");
    await executor.runBinary(["update-index", "-z", "--index-info"], {
        input: Buffer.from(records),
        env: { GIT_INDEX_FILE: candidate },
    });
    for (const entry of before.index) {
        if (entry.assumeUnchanged)
            await executor.runBinary(
                ["--literal-pathspecs", "update-index", "--assume-unchanged", "--", entry.path],
                { env: { GIT_INDEX_FILE: candidate } },
            );
        if (entry.skipWorktree)
            await executor.runBinary(
                ["--literal-pathspecs", "update-index", "--skip-worktree", "--", entry.path],
                { env: { GIT_INDEX_FILE: candidate } },
            );
    }
}

/** Rehydrate only checksum-validated retained blobs with their exact original Git object identity. */
async function restoreGitObjects(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    entries: readonly TargetIndexEntry[],
): Promise<void> {
    const restored = new Set<string>();
    for (const entry of entries) {
        if (restored.has(entry.oid)) continue;
        const bytes = await persistence.loadTargetOperationObject(entry.object);
        const oid = (
            await executor.runBinary(["hash-object", "-w", "--stdin"], { input: bytes })
        ).stdout
            .toString("utf8")
            .trim();
        if (oid !== entry.oid) throw new Error("Recovery Git object identity changed.");
        restored.add(entry.oid);
    }
}
