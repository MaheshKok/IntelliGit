import { createHash } from "node:crypto";
import { GitExecutor } from "../git/executor";
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
    writeIndexEntry(relativePath: string, entry: ShelfJournalIndexEntry | undefined): Promise<void>;
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
        this.emptyTree ??= this.readEmptyTreeOid();
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

    /** Updates one index entry via Git's own index.lock protocol. */
    async writeIndexEntry(
        relativePath: string,
        entry: ShelfJournalIndexEntry | undefined,
    ): Promise<void> {
        const record = entry
            ? `${assertMode(entry.mode)} ${assertOid(entry.oid)}\t${relativePath}\0`
            : `0 ${"0".repeat((await this.emptyTreeOid()).length)}\t${relativePath}\0`;
        await this.executor.runBinary(["update-index", "-z", "--index-info"], {
            input: Buffer.from(record),
        });
    }

    private async readEmptyTreeOid(): Promise<string> {
        return readOid(
            (
                await this.executor.runBinary(["hash-object", "-t", "tree", "--stdin"], {
                    input: Buffer.alloc(0),
                })
            ).stdout,
            "empty tree",
        );
    }
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
