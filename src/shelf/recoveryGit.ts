import { createHash } from "node:crypto";
import { readEmptyTreeOid } from "../git/emptyTree";
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
    /** One whole-index read answering the fingerprint and every per-path query above. */
    readIndexListing?(): Promise<IndexListing>;
    /** Reads base entries for many paths in bounded batches; `getBaseEntry` then answers from them. */
    prefetchBaseEntries?(baseOid: string, relativePaths: readonly string[]): Promise<void>;
}

/**
 * A consistent raw `ls-files --stage -v -z` listing. Per-path answers are byte-identical to the
 * `--literal-pathspecs` per-path commands: a path matches itself and every record below `path/`.
 */
export interface IndexListing {
    readonly fingerprint: string;
    entry(relativePath: string): ShelfJournalIndexEntry | undefined;
    pathFingerprint(relativePath: string): string;
}

/** Bounds one batched `ls-tree` command line. */
const BASE_ENTRY_BATCH_PATHS = 200;
const BASE_ENTRY_BATCH_BYTES = 64 * 1024;

/** Default direct Git plumbing; callers already own the repository mutation gate. */
export class GitExecutorRecoveryGit implements ShelfRecoveryGit {
    private emptyTree?: Promise<string>;
    /** Raw base records by path; tree objects are immutable, so they never go stale for one OID. */
    private baseRecords?: { readonly baseOid: string; readonly byPath: Map<string, Buffer> };

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

    /** Reads the whole index once; see {@link IndexListing}. */
    async readIndexListing(): Promise<IndexListing> {
        return parseIndexListing(
            (await this.executor.runBinary(["ls-files", "--stage", "-v", "-z"])).stdout,
        );
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
        const prefetched =
            this.baseRecords?.baseOid === baseOid
                ? this.baseRecords.byPath.get(relativePath)
                : undefined;
        if (prefetched) return parseTreeEntry(prefetched);
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

    /**
     * Batches the per-path `ls-tree` reads: each path keeps exactly the records named by it, which
     * is what the single-path command prints. Parsing, and so any refusal, still happens per path.
     */
    async prefetchBaseEntries(baseOid: string, relativePaths: readonly string[]): Promise<void> {
        const byPath = new Map<string, Buffer>();
        this.baseRecords = { baseOid, byPath };
        if (baseOid === (await this.emptyTreeOid())) return;
        // ls-tree descends into a tree named by one pathspec when another names a path inside it,
        // and then omits the tree's own entry. Such ancestors keep their single-path reads.
        const requested = new Set(relativePaths);
        const ancestors = new Set<string>();
        for (const file of requested)
            for (let slash = file.indexOf("/"); slash > 0; slash = file.indexOf("/", slash + 1))
                if (requested.has(file.slice(0, slash))) ancestors.add(file.slice(0, slash));
        const pending = [...requested].filter((file) => !ancestors.has(file));
        while (pending.length > 0) {
            const batch: string[] = [];
            let bytes = 0;
            while (
                pending.length > 0 &&
                batch.length < BASE_ENTRY_BATCH_PATHS &&
                (batch.length === 0 ||
                    bytes + Buffer.byteLength(pending[0]) <= BASE_ENTRY_BATCH_BYTES)
            ) {
                const next = pending.shift()!;
                bytes += Buffer.byteLength(next) + 1;
                batch.push(next);
            }
            // Bounded sequential batches keep one ls-tree process at a time under the held gate.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const listing = await this.executor.runBinary([
                "--literal-pathspecs",
                "ls-tree",
                "-z",
                baseOid,
                "--",
                ...batch,
            ]);
            const records = new Map<string, Buffer[]>(batch.map((file) => [file, []]));
            for (const record of splitRawNulRecords(listing.stdout)) {
                const tab = record.indexOf(0x09);
                const name = tab < 0 ? undefined : record.subarray(tab + 1, -1).toString("utf8");
                if (name !== undefined) records.get(name)?.push(record);
            }
            for (const [file, matched] of records) byPath.set(file, Buffer.concat(matched));
        }
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

/** Builds per-path views over one raw listing without re-encoding any record bytes. */
function parseIndexListing(bytes: Buffer): IndexListing {
    const records = splitRawNulRecords(bytes);
    // Record positions by exact name and by every ancestor directory, so a literal pathspec's
    // directory match is answered in index order without scanning the whole listing per path.
    const exact = new Map<string, number[]>();
    const below = new Map<string, number[]>();
    records.forEach((record, position) => {
        const tab = record.indexOf(0x09);
        if (tab < 0) throw new RecoverySafetyError("Git returned an invalid index listing.");
        const name = record.subarray(tab + 1, -1).toString("utf8");
        appendPosition(exact, name, position);
        for (let slash = name.indexOf("/"); slash > 0; slash = name.indexOf("/", slash + 1))
            appendPosition(below, name.slice(0, slash), position);
    });
    const matching = (relativePath: string): Buffer[] =>
        [...(exact.get(relativePath) ?? []), ...(below.get(relativePath) ?? [])]
            .sort((left, right) => left - right)
            .map((position) => records[position]);
    return {
        fingerprint: createHash("sha256").update(bytes).digest("hex"),
        // `-v` prefixes each record with a one-letter tag and a space; the entry command has none.
        entry: (relativePath) =>
            parseIndexEntry(
                Buffer.concat(matching(relativePath).map((record) => record.subarray(2))),
            ),
        pathFingerprint: (relativePath) =>
            createHash("sha256")
                .update(Buffer.concat(matching(relativePath)))
                .digest("hex"),
    };
}

function appendPosition(map: Map<string, number[]>, key: string, position: number): void {
    const positions = map.get(key);
    if (positions) positions.push(position);
    else map.set(key, [position]);
}

/** Splits NUL-terminated records, keeping each record's raw bytes and its terminator. */
function splitRawNulRecords(bytes: Buffer): Buffer[] {
    const records: Buffer[] = [];
    let start = 0;
    for (let end = bytes.indexOf(0, start); end >= 0; end = bytes.indexOf(0, start)) {
        records.push(bytes.subarray(start, end + 1));
        start = end + 1;
    }
    if (start < bytes.length) throw new RecoverySafetyError("Git returned an unterminated record.");
    return records;
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
