import { createHash } from "node:crypto";
import { copyFile, open, rename, rm } from "node:fs/promises";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import { readEmptyTreeOid } from "../git/emptyTree";
import { GitExecutor } from "../git/executor";
import { isExclusiveCreateBlocked } from "../git/repositoryLock";
import { REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS } from "../git/repositoryMutationGate";
import type { ShelfJournalIndexEntry } from "./store";

/** Git's stable empty-tree object ID used when a repository is unborn. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Raised when recovery cannot establish a safe filesystem or Git state. */
export class RecoverySafetyError extends Error {
    /** Creates a safety refusal with a caller-safe explanation. */
    constructor(message: string) {
        super(message);
        this.name = "RecoverySafetyError";
    }
}

/** Injectable Git plumbing used inside the already-held repository mutation gate. */
export interface ShelfRecoveryGit {
    getHead(): Promise<string | undefined>;
    getIndexFingerprint(): Promise<string>;
    getIndexPathFingerprint(relativePath: string): Promise<string>;
    emptyTreeOid(): Promise<string>;
    getBaseEntry(
        baseOid: string,
        relativePath: string,
    ): Promise<ShelfJournalIndexEntry | undefined>;
    getIndexEntry(relativePath: string): Promise<ShelfJournalIndexEntry | undefined>;
    readBlob(oid: string): Promise<Buffer>;
    /**
     * `verify` runs once this call holds index.lock and before it writes, so no other Git process
     * can change the index between the two; a rejection ends the write.
     */
    writeIndexEntry(
        relativePath: string,
        entry: ShelfJournalIndexEntry | undefined,
        verify?: () => Promise<void>,
    ): Promise<void>;
}

/** Default direct Git plumbing; callers already own the repository mutation gate. */
export class GitExecutorRecoveryGit implements ShelfRecoveryGit {
    private emptyTree?: Promise<string>;

    /** Binds binary plumbing to the active repository without re-entering its gate. */
    constructor(private readonly executor: GitExecutor) {}

    /** Returns HEAD, with Git's quiet unborn-repository result represented as undefined. */
    async getHead(): Promise<string | undefined> {
        const result = await this.executor.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
            expectedExitCodes: [0, 1],
        });
        return result.exitCode === 0 ? readOid(result.stdout, "HEAD") : undefined;
    }

    /** Hashes the raw index listing so flags excluded by write-tree still guard recovery. */
    async getIndexFingerprint(): Promise<string> {
        const listing = await this.executor.runBinary(["ls-files", "--stage", "-v", "-z"]);
        return createHash("sha256").update(listing.stdout).digest("hex");
    }

    /** Hashes one raw index record, including flags, without coupling rollback to other paths. */
    async getIndexPathFingerprint(relativePath: string): Promise<string> {
        const listing = await this.executor.runBinary([
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-v",
            "-z",
            "--",
            relativePath,
        ]);
        return createHash("sha256").update(listing.stdout).digest("hex");
    }

    /** Computes the repository's object-format-specific empty tree ID once. */
    async emptyTreeOid(): Promise<string> {
        this.emptyTree ??= readEmptyTreeOid(
            this.executor,
            () => new RecoverySafetyError("Git returned an invalid empty tree object ID."),
        );
        return this.emptyTree;
    }

    /** Reads the pinned tree entry with literal pathspec handling. */
    async getBaseEntry(
        baseOid: string,
        relativePath: string,
    ): Promise<ShelfJournalIndexEntry | undefined> {
        if (baseOid === (await this.emptyTreeOid())) return undefined;
        return parseTreeEntry(
            (
                await this.executor.runBinary([
                    "--literal-pathspecs",
                    "ls-tree",
                    "-z",
                    baseOid,
                    "--",
                    relativePath,
                ])
            ).stdout,
        );
    }

    /** Reads the one supported stage-zero index entry for a literal path. */
    async getIndexEntry(relativePath: string): Promise<ShelfJournalIndexEntry | undefined> {
        return parseIndexEntry(
            (
                await this.executor.runBinary([
                    "--literal-pathspecs",
                    "ls-files",
                    "--stage",
                    "-z",
                    "--",
                    relativePath,
                ])
            ).stdout,
        );
    }

    /** Reads raw blob bytes for a base tree entry. */
    async readBlob(oid: string): Promise<Buffer> {
        return (await this.executor.runBinary(["cat-file", "blob", assertOid(oid)])).stdout;
    }

    /**
     * Updates one index entry under an index.lock this call takes first, as Git itself does:
     * `verify` runs while the lock is held, Git edits a copy of the index inside the lock file,
     * and the lock file is renamed onto the index.
     */
    async writeIndexEntry(
        relativePath: string,
        entry: ShelfJournalIndexEntry | undefined,
        verify?: () => Promise<void>,
    ): Promise<void> {
        const record = entry
            ? `${assertMode(entry.mode)} ${assertOid(entry.oid)}\t${relativePath}\0`
            : `0 ${"0".repeat((await this.emptyTreeOid()).length)}\t${relativePath}\0`;
        const index = (
            await this.executor.runBinary([
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "index",
            ])
        ).stdout
            .toString("utf8")
            .replace(/\n$/, "");
        const lock = `${index}.lock`;
        await takeIndexLock(lock);
        let published = false;
        try {
            await verify?.();
            // A repository where nothing was ever staged has no index, which Git reads as empty,
            // so Git then writes an empty index into the lock to start from.
            await copyFile(index, lock).catch(async (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                await this.executor.runBinary(["read-tree", "--empty"], {
                    env: { GIT_INDEX_FILE: lock },
                });
            });
            await this.executor.runBinary(["update-index", "-z", "--index-info"], {
                input: Buffer.from(record),
                env: { GIT_INDEX_FILE: lock },
            });
            await renameOntoIndex(lock, index);
            published = true;
        } finally {
            // A failed cleanup must not replace the error that got here; a lock left behind gets
            // the "File exists" advice on the next write.
            if (!published) await rm(lock, { force: true }).catch(() => undefined);
        }
    }
}

/**
 * Creates the index lock exclusively, waiting out another Git process (VS Code's own refresh)
 * that holds it briefly. Past the bound it fails with Git's own wording.
 */
async function takeIndexLock(lock: string): Promise<void> {
    try {
        await acquireWithBoundedWait(async () => (await open(lock, "wx")).close(), {
            timeoutMs: REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
            retryDelayMs: 50,
            isBusy: isExclusiveCreateBlocked,
        });
    } catch (error) {
        if (!isExclusiveCreateBlocked(error)) throw error;
        throw new Error(
            `Unable to create '${lock}': File exists. Another Git process seems to be running in this repository; if none is, remove that file and try again.`,
            { cause: error },
        );
    }
}

/**
 * Windows refuses to rename onto a file another process has open, and Git readers open the index
 * briefly; Git retries that refusal when it publishes an index, so this does too.
 */
async function renameOntoIndex(lock: string, index: string): Promise<void> {
    await acquireWithBoundedWait(() => rename(lock, index), {
        timeoutMs: REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
        retryDelayMs: 50,
        isBusy: (error) =>
            process.platform === "win32" &&
            ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""),
    });
}

function parseTreeEntry(bytes: Buffer): ShelfJournalIndexEntry | undefined {
    const records = splitNulRecords(bytes);
    if (records.length === 0) return undefined;
    if (records.length !== 1)
        throw new RecoverySafetyError("Expected one base tree entry per recovery path.");
    const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t/.exec(records[0]);
    if (!match) throw new RecoverySafetyError("Base tree entry is not a regular blob.");
    return { mode: match[1], oid: match[2] };
}

function parseIndexEntry(bytes: Buffer): ShelfJournalIndexEntry | undefined {
    const records = splitNulRecords(bytes);
    if (records.length === 0) return undefined;
    if (records.length !== 1)
        throw new RecoverySafetyError("Unmerged index entries cannot enter shelf recovery.");
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t/.exec(records[0]);
    if (!match || match[3] !== "0") {
        throw new RecoverySafetyError("Unmerged index entries cannot enter shelf recovery.");
    }
    return { mode: match[1], oid: match[2] };
}

function splitNulRecords(bytes: Buffer): string[] {
    return bytes
        .toString("utf8")
        .split("\0")
        .filter((record) => record.length > 0);
}

function readOid(bytes: Buffer, label: string): string {
    const oid = bytes.toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) {
        throw new RecoverySafetyError(`Git returned an invalid ${label} object ID.`);
    }
    return oid;
}

function assertMode(value: string): string {
    if (!/^[0-7]{6}$/.test(value)) throw new RecoverySafetyError("Invalid Git index mode.");
    return value;
}

function assertOid(value: string): string {
    if (!/^[a-f0-9]{40,64}$/.test(value)) throw new RecoverySafetyError("Invalid Git object ID.");
    return value;
}
