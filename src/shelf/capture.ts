import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    assertShelfStateSupported,
    type ShelfFileEntry,
    type ShelfUnsupportedState,
} from "./model";
import type { ShelfStore } from "./store";

/** Minimal byte-safe Git surface used by capture primitives. */
export interface ShelfCaptureGit {
    runBinary(
        args: string[],
        options?: { readonly expectedExitCodes?: readonly number[] },
    ): Promise<{ readonly stdout: Buffer }>;
}

/** Inputs for retaining raw bytes when a layer materialization is inexact. */
export interface CaptureWorktreeRawFidelityInput {
    /** Bytes produced by materializing the captured index-to-worktree layer. */
    readonly materializedBytes: Uint8Array;
    /** Bytes the destructive reverter restores before a raw-fidelity unshelve. */
    readonly preimageBytes: Uint8Array;
    readonly repositoryRoot: string;
    readonly relativePath: string;
    readonly shelfId: string;
    readonly store: ShelfStore;
    readonly entry: ShelfFileEntry;
}

/** Result preserving the immutable entry plus the raw object references. */
export interface CaptureWorktreeRawFidelityResult {
    readonly entry: ShelfFileEntry;
    readonly rawBeforeObjectHash?: string;
    readonly rawAfterObjectHash?: string;
}

/**
 * Stores raw materialized and worktree bytes only when layer reconstruction differs.
 *
 * The caller supplies bytes from the sequential layer materialization; comparing an
 * index blob directly would wrongly classify every ordinary unstaged edit as inexact.
 */
export async function captureWorktreeRawFidelity(
    input: CaptureWorktreeRawFidelityInput,
): Promise<CaptureWorktreeRawFidelityResult> {
    const target = resolveRepositoryFile(input.repositoryRoot, input.relativePath);
    const materialized = Buffer.from(input.materializedBytes);
    const worktree = await readFile(target);
    if (materialized.equals(worktree)) {
        return { entry: input.entry };
    }

    const worktreeBlock = input.entry.worktreeBlock;
    if (!worktreeBlock) {
        throw new Error("Raw worktree fidelity requires a worktree layer block.");
    }
    const before = await input.store.putObject(input.shelfId, input.preimageBytes);
    // Preserve preimage failure ordering; the reentrant store lock serializes these durable writes.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const after = await input.store.putObject(input.shelfId, worktree);
    return {
        entry: {
            ...input.entry,
            exactReconstruction: false,
            worktreeBlock: {
                ...worktreeBlock,
                rawBeforeObjectHash: before.hash,
                rawAfterObjectHash: after.hash,
            },
        },
        rawBeforeObjectHash: before.hash,
        rawAfterObjectHash: after.hash,
    };
}

/** Rejects Git states that cannot be captured faithfully by the Phase-1 model. */
export async function assertShelfCaptureStateSupported(
    git: ShelfCaptureGit,
    repositoryRoot: string,
): Promise<void> {
    const trackedPaths = await assertIndexEntriesSupported(git, repositoryRoot);
    // Keep index validation before HEAD validation so unsupported index state wins deterministically.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const pinnedBasePaths = await assertPinnedBaseEntriesSupported(git, repositoryRoot);
    assertIndexAndPinnedBasePathsDoNotSwapTypes(trackedPaths, pinnedBasePaths);
    await assertStatusEntriesSupported(git, repositoryRoot, trackedPaths, pinnedBasePaths);
    await assertIndexFlagsSupported(git, repositoryRoot);
}

async function assertIndexEntriesSupported(
    git: ShelfCaptureGit,
    repositoryRoot: string,
): Promise<ReadonlySet<string>> {
    const stage = await git.runBinary(["ls-files", "--stage", "-z"], {
        expectedExitCodes: [0],
    });
    const trackedPaths = new Set<string>();
    for (const record of splitNullRecords(stage.stdout)) {
        const parsed = parseStageRecord(record, repositoryRoot);
        if (!parsed) continue;
        assertUnsupportedMode(parsed.mode, parsed.path);
        if (parsed.stage !== "0") assertShelfStateSupported(parsed.path, "unmerged-stage");
        trackedPaths.add(parsed.path);
    }
    return trackedPaths;
}

async function assertPinnedBaseEntriesSupported(
    git: ShelfCaptureGit,
    repositoryRoot: string,
): Promise<ReadonlySet<string>> {
    const head = await git.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
        expectedExitCodes: [0, 1],
    });
    const headOid = head.stdout.toString("ascii").trim();
    if (!headOid) return new Set<string>();

    const tree = await git.runBinary(["ls-tree", "-r", "-z", headOid], {
        expectedExitCodes: [0],
    });
    const pinnedBasePaths = new Set<string>();
    for (const record of splitNullRecords(tree.stdout)) {
        const parsed = parseTreeRecord(record, repositoryRoot);
        if (!parsed) continue;
        assertUnsupportedMode(parsed.mode, parsed.path);
        pinnedBasePaths.add(parsed.path);
    }
    return pinnedBasePaths;
}

async function assertStatusEntriesSupported(
    git: ShelfCaptureGit,
    repositoryRoot: string,
    trackedPaths: ReadonlySet<string>,
    pinnedBasePaths: ReadonlySet<string>,
): Promise<void> {
    const status = await git.runBinary(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        {
            expectedExitCodes: [0],
        },
    );
    for (const record of splitNullRecords(status.stdout)) {
        const parsed = parseStatusRecord(record, repositoryRoot);
        if (!parsed) continue;
        if (parsed.state === "intent-to-add") {
            assertShelfStateSupported(parsed.path, "intent-to-add");
        }
        if (parsed.state === "untracked") {
            assertUntrackedPathDoesNotReplaceTrackedFile(
                parsed.path,
                trackedPaths,
                pinnedBasePaths,
            );
            // Preserve porcelain order so the first unsafe path is the reported capture failure.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await assertUntrackedPathSupported(repositoryRoot, parsed.path);
        }
        if (parsed.state === "tracked-worktree-change") {
            await assertTrackedWorktreePathSupported(repositoryRoot, parsed.path);
        }
    }
}

function assertUntrackedPathDoesNotReplaceTrackedFile(
    relativePath: string,
    ...trackedPathSets: readonly ReadonlySet<string>[]
): void {
    for (
        let separator = relativePath.indexOf("/");
        separator >= 0;
        separator = relativePath.indexOf("/", separator + 1)
    ) {
        const trackedPath = relativePath.slice(0, separator);
        if (trackedPathSets.some((trackedPaths) => trackedPaths.has(trackedPath))) {
            assertShelfStateSupported(trackedPath, "type-swap");
        }
    }
}

function assertIndexAndPinnedBasePathsDoNotSwapTypes(
    trackedPaths: ReadonlySet<string>,
    pinnedBasePaths: ReadonlySet<string>,
): void {
    for (const trackedPath of trackedPaths) {
        assertUntrackedPathDoesNotReplaceTrackedFile(trackedPath, pinnedBasePaths);
    }
    for (const pinnedBasePath of pinnedBasePaths) {
        assertUntrackedPathDoesNotReplaceTrackedFile(pinnedBasePath, trackedPaths);
    }
}

async function assertIndexFlagsSupported(
    git: ShelfCaptureGit,
    repositoryRoot: string,
): Promise<void> {
    const flags = await git.runBinary(["ls-files", "-v", "-z"], {
        expectedExitCodes: [0],
    });
    for (const record of splitNullRecords(flags.stdout)) {
        const parsed = parseFlagRecord(record, repositoryRoot);
        if (!parsed) continue;
        assertShelfStateSupported(parsed.path, parsed.state);
    }
}

function assertUnsupportedMode(mode: string, changeId: string): void {
    if (mode === "120000") assertShelfStateSupported(changeId, "symlink");
    if (mode === "160000") assertShelfStateSupported(changeId, "submodule");
}

function splitNullRecords(output: Buffer): Buffer[] {
    const records: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < output.length; index += 1) {
        if (output[index] !== 0) continue;
        if (index > start) records.push(output.subarray(start, index));
        start = index + 1;
    }
    if (start < output.length) records.push(output.subarray(start));
    return records;
}

function parseStageRecord(
    record: Buffer,
    repositoryRoot: string,
): { readonly mode: string; readonly stage: string; readonly path: string } | undefined {
    const tab = record.indexOf(0x09);
    if (tab < 0) return undefined;
    const [mode, , stage] = record.subarray(0, tab).toString("ascii").split(" ");
    if (!mode || !stage) return undefined;
    return {
        mode,
        stage,
        path: decodeRepositoryPath(repositoryRoot, record.subarray(tab + 1)),
    };
}

function parseTreeRecord(
    record: Buffer,
    repositoryRoot: string,
): { readonly mode: string; readonly path: string } | undefined {
    const tab = record.indexOf(0x09);
    if (tab < 0) return undefined;
    const [mode] = record.subarray(0, tab).toString("ascii").split(" ");
    if (!mode) return undefined;
    return {
        mode,
        path: decodeRepositoryPath(repositoryRoot, record.subarray(tab + 1)),
    };
}

function parseStatusRecord(
    record: Buffer,
    repositoryRoot: string,
):
    | {
          readonly state: "intent-to-add" | "untracked" | "tracked-worktree-change";
          readonly path: string;
      }
    | undefined {
    if (record.length < 4 || record[2] !== 0x20) return undefined;
    const state = record.subarray(0, 2).toString("ascii");
    const pathValue = decodeRepositoryPath(repositoryRoot, record.subarray(3));
    if (state === " A") return { state: "intent-to-add", path: pathValue };
    if (state === "??") return { state: "untracked", path: pathValue };
    if (state[1] !== " ") return { state: "tracked-worktree-change", path: pathValue };
    return undefined;
}

async function assertUntrackedPathSupported(
    repositoryRoot: string,
    relativePath: string,
): Promise<void> {
    await assertFilesystemPathSupported(repositoryRoot, relativePath, false);
}

async function assertTrackedWorktreePathSupported(
    repositoryRoot: string,
    relativePath: string,
): Promise<void> {
    await assertFilesystemPathSupported(repositoryRoot, relativePath, true, true);
}

async function assertFilesystemPathSupported(
    repositoryRoot: string,
    relativePath: string,
    allowMissing: boolean,
    requireRegularFile = false,
): Promise<void> {
    const target = resolveRepositoryFile(repositoryRoot, relativePath);
    let details;
    try {
        details = await lstat(target);
    } catch (error) {
        if (allowMissing && isNotFound(error)) return;
        throw error;
    }
    if (details.isSymbolicLink()) {
        assertShelfStateSupported(relativePath, "symlink");
    }
    if (!details.isDirectory()) {
        if (requireRegularFile && !details.isFile()) {
            assertShelfStateSupported(relativePath, "type-swap");
        }
        return;
    }
    try {
        await lstat(path.join(target, ".git"));
    } catch (error) {
        if (isNotFound(error)) {
            if (requireRegularFile) assertShelfStateSupported(relativePath, "type-swap");
            return;
        }
        throw error;
    }
    assertShelfStateSupported(relativePath, "submodule");
}

function parseFlagRecord(
    record: Buffer,
    repositoryRoot: string,
):
    | {
          readonly state: Extract<ShelfUnsupportedState, "skip-worktree" | "assume-unchanged">;
          readonly path: string;
      }
    | undefined {
    if (record.length < 3 || record[1] !== 0x20) return undefined;
    const tag = String.fromCharCode(record[0]);
    const pathValue = decodeRepositoryPath(repositoryRoot, record.subarray(2));
    if (tag === "S") return { state: "skip-worktree", path: pathValue };
    if (tag >= "a" && tag <= "z") return { state: "assume-unchanged", path: pathValue };
    return undefined;
}

function decodeRepositoryPath(repositoryRoot: string, value: Buffer): string {
    const relativePath = value.toString("utf8");
    resolveRepositoryFile(repositoryRoot, relativePath);
    return relativePath;
}

function resolveRepositoryFile(repositoryRoot: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
        throw new Error("Shelf capture path must be a non-empty relative path.");
    }
    const root = path.resolve(repositoryRoot);
    const target = path.resolve(root, relativePath);
    const relation = path.relative(root, target);
    if (
        relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relation)
    ) {
        throw new Error("Shelf capture path escapes the repository root.");
    }
    return target;
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
