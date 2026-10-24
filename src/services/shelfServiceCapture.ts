import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitExecutor } from "../git/executor";
import { assertShelfCaptureStateSupported, captureWorktreeRawFidelity } from "../shelf/capture";
import { validateShelfManifestPath } from "../shelf/importValidation";
import type { ShelfFileEntry, ShelfLayerBlock, ShelfMetadata } from "../shelf/model";
import { classifyPatchHeader } from "../shelf/patchClassification";
import { generateLayerPatches, generateUntrackedPatch, indexPatchBlocks } from "../shelf/patchIO";
import type { ShelfStore } from "../shelf/store";
import { assertContainedParentIfPresent } from "../shelf/recoveryPaths";
import { pathFingerprint } from "./shelfServiceOperations";

/** Input fields required to capture durable shelf artifacts. */
export interface ShelfCaptureRequest {
    readonly name: string;
    readonly paths: readonly string[];
}

/** Immutable capture result used by the host to perform an optional destructive revert. */
export interface ShelfCaptureArtifacts {
    readonly shelfId: string;
    readonly generation: number;
    readonly baseCommit?: string;
    readonly revertFiles: readonly (readonly {
        readonly relativePath: string;
        readonly baseBytes?: Uint8Array;
    }[])[];
}

/** Dependencies owned by the host service while capture persists one shelf generation. */
export interface ShelfCaptureDependencies {
    readonly repositoryRoot: string;
    readonly executor: GitExecutor;
    readonly store: ShelfStore;
    readonly recordBaseRevisions: boolean;
    readonly materializeEntry: (
        relativePath: string,
        base: Buffer,
        indexPatch: Buffer | undefined,
        worktreePatch: Buffer | undefined,
    ) => Promise<Buffer | undefined>;
}

/** Captures selected Git layers and records all immutable shelf artifacts before returning. */
export async function captureShelfArtifacts(
    input: ShelfCaptureRequest,
    dependencies: ShelfCaptureDependencies,
): Promise<ShelfCaptureArtifacts> {
    const shelfId = randomUUID();
    const captured = await captureShelfObjects(input, dependencies, shelfId);
    const metadata: ShelfMetadata = {
        name: input.name,
        baseCommit: captured.baseCommit,
        lifecycle: "shelved",
        createdAt: Date.now(),
    };
    const manifest = await dependencies.store.writeShelfGeneration(shelfId, {
        schemaVersion: 1,
        objectHashes: captured.objectHashes,
        metadata,
        files: captured.entries,
    });
    return {
        shelfId,
        generation: manifest.generation,
        baseCommit: captured.baseCommit,
        revertFiles: captured.revertFiles,
    };
}

/** Immutable whole-file layers awaiting one caller-owned generation publication. */
export interface ShelfCapturedObjects {
    readonly baseCommit?: string;
    readonly entries: readonly ShelfFileEntry[];
    readonly objectHashes: readonly string[];
    readonly revertFiles: ShelfCaptureArtifacts["revertFiles"];
}

/** Reuses ordinary layer/raw capture without publishing a pointer; caller holds ordered locks. */
export async function captureShelfObjects(
    input: ShelfCaptureRequest,
    dependencies: ShelfCaptureDependencies,
    shelfId: string,
    maximumPatchBytes?: number,
): Promise<ShelfCapturedObjects> {
    await assertShelfCaptureStateSupported(dependencies.executor, dependencies.repositoryRoot);
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-capture-"));
    try {
        const source = await collectCaptureSource(input.paths, directory, dependencies.executor);
        if (
            maximumPatchBytes !== undefined &&
            [...source.patchByPath.values()].reduce(
                (size, entry) => size + (entry.index?.length ?? 0) + (entry.worktree?.length ?? 0),
                0,
            ) > maximumPatchBytes
        )
            throw new Error("Shelf capture exceeds the supported aggregate size.");
        return persistCaptureSource(shelfId, source, dependencies);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

interface CaptureSource {
    readonly baseCommit?: string;
    readonly patchByPath: ReadonlyMap<string, LayerPatches>;
}

interface LayerPatches {
    readonly index?: Buffer;
    readonly worktree?: Buffer;
    readonly untracked?: boolean;
}

async function collectCaptureSource(
    paths: readonly string[],
    directory: string,
    executor: GitExecutor,
): Promise<CaptureSource> {
    const indexPatchPath = path.join(directory, "index.patch");
    const worktreePatchPath = path.join(directory, "worktree.patch");
    await generateLayerPatches(executor, { indexPatchPath, worktreePatchPath, paths });
    const [indexPatch, worktreePatch, baseCommit, untrackedPaths] = await Promise.all([
        readFile(indexPatchPath),
        readFile(worktreePatchPath),
        readHead(executor),
        findUntrackedPaths(executor, paths),
    ]);
    const patchByPath = new Map<string, LayerPatches>();
    addBlocks(patchByPath, indexPatch, "index");
    addBlocks(patchByPath, worktreePatch, "worktree");
    await addUntrackedBlocks(patchByPath, untrackedPaths, directory, executor);
    return { baseCommit, patchByPath };
}

async function addUntrackedBlocks(
    patchByPath: Map<string, LayerPatches>,
    paths: readonly string[],
    directory: string,
    executor: GitExecutor,
): Promise<void> {
    for (const relativePath of paths) {
        const patchPath = path.join(directory, `untracked-${patchByPath.size}.patch`);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Git generates one untracked patch at a time, and each result is immediately assigned to its source path.
        await generateUntrackedPatch(executor, { patchPath, relativePath });
        patchByPath.set(relativePath, { worktree: await readFile(patchPath), untracked: true });
    }
}

async function persistCaptureSource(
    shelfId: string,
    source: CaptureSource,
    dependencies: ShelfCaptureDependencies,
): Promise<ShelfCapturedObjects> {
    const entries: ShelfFileEntry[] = [];
    const revertFiles: Array<
        readonly { readonly relativePath: string; readonly baseBytes?: Uint8Array }[]
    > = [];
    const objectHashes = new Set<string>();
    const sortedPatches = Array.from(source.patchByPath.entries());
    sortedPatches.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [relativePath, patches] of sortedPatches) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Persist entries in sorted path order so object writes and recovery metadata remain deterministic.
        const captured = await persistCaptureEntry(
            shelfId,
            relativePath,
            patches,
            source.baseCommit,
            dependencies,
            objectHashes,
        );
        entries.push(captured.entry);
        revertFiles.push(captured.revertFiles);
    }
    if (entries.length === 0) throw new Error("No selected changes to shelve.");
    return { baseCommit: source.baseCommit, entries, objectHashes: [...objectHashes], revertFiles };
}

async function persistCaptureEntry(
    shelfId: string,
    relativePath: string,
    patches: LayerPatches,
    baseCommit: string | undefined,
    dependencies: ShelfCaptureDependencies,
    objectHashes: Set<string>,
): Promise<{
    readonly entry: ShelfFileEntry;
    readonly revertFiles: readonly {
        readonly relativePath: string;
        readonly baseBytes?: Uint8Array;
    }[];
}> {
    const capturedIndexBlock = patches.index
        ? await persistBlock(shelfId, relativePath, patches.index, dependencies.store, objectHashes)
        : undefined;
    const capturedWorktreeBlock = patches.worktree
        ? await persistBlock(
              shelfId,
              relativePath,
              patches.worktree,
              dependencies.store,
              objectHashes,
          )
        : undefined;
    const blocks = [capturedIndexBlock, capturedWorktreeBlock].filter(
        (block): block is ShelfLayerBlock => block !== undefined,
    );
    const base = baseCommit
        ? await readHistoryBase(baseCommit, blocks, dependencies.executor)
        : undefined;
    const [indexBlock, worktreeBlock] = await persistBaseObjects(
        shelfId,
        base,
        [capturedIndexBlock, capturedWorktreeBlock],
        dependencies.store,
        objectHashes,
        dependencies.recordBaseRevisions,
    );
    let entry = createEntry(relativePath, patches, indexBlock, worktreeBlock, base, baseCommit);
    entry = await captureRawFidelity(
        shelfId,
        entry,
        relativePath,
        patches,
        base,
        dependencies,
        objectHashes,
    );
    const blockForRevert = worktreeBlock ?? indexBlock;
    return {
        entry,
        revertFiles:
            blockForRevert?.status === "R" && blockForRevert.renamedFrom
                ? [
                      { relativePath: blockForRevert.renamedFrom, baseBytes: base?.bytes },
                      { relativePath: blockForRevert.path },
                  ]
                : blockForRevert
                  ? [{ relativePath: blockForRevert.path, baseBytes: base?.bytes }]
                  : [],
    };
}

async function persistBaseObjects(
    shelfId: string,
    base: { readonly bytes: Buffer } | undefined,
    blocks: readonly [ShelfLayerBlock | undefined, ShelfLayerBlock | undefined],
    store: ShelfStore,
    objectHashes: Set<string>,
    recordBaseRevisions: boolean,
): Promise<readonly [ShelfLayerBlock | undefined, ShelfLayerBlock | undefined]> {
    if (!recordBaseRevisions || !base || (!blocks[0] && !blocks[1])) return blocks;
    const hash = (await store.putObject(shelfId, base.bytes)).hash;
    objectHashes.add(hash);
    return [
        blocks[0] && { ...blocks[0], baseObjectHash: hash },
        blocks[1] && { ...blocks[1], baseObjectHash: hash },
    ];
}

function createEntry(
    relativePath: string,
    patches: LayerPatches,
    indexBlock: ShelfLayerBlock | undefined,
    worktreeBlock: ShelfLayerBlock | undefined,
    base: { readonly bytes: Buffer } | undefined,
    baseCommit: string | undefined,
): ShelfFileEntry {
    return {
        changeId: `change-${createHash("sha256").update(relativePath).digest("hex").slice(0, 20)}`,
        indexBlock,
        worktreeBlock,
        binary:
            (patches.index !== undefined && classifyPatchHeader(patches.index).binary) ||
            (patches.worktree !== undefined && classifyPatchHeader(patches.worktree).binary),
        untracked: patches.untracked === true,
        baseAvailability:
            base && (indexBlock?.baseObjectHash || worktreeBlock?.baseObjectHash)
                ? "full"
                : baseCommit
                  ? "history"
                  : "none",
        exactReconstruction: true,
        lifecycle: "shelved",
    };
}

async function captureRawFidelity(
    shelfId: string,
    entry: ShelfFileEntry,
    relativePath: string,
    patches: LayerPatches,
    base: { readonly bytes: Buffer } | undefined,
    dependencies: ShelfCaptureDependencies,
    objectHashes: Set<string>,
): Promise<ShelfFileEntry> {
    if (!base || entry.worktreeBlock?.status !== "M") return entry;
    const materialized = await dependencies.materializeEntry(
        relativePath,
        base.bytes,
        patches.index,
        patches.worktree,
    );
    if (!materialized) return entry;
    const fidelity = await captureWorktreeRawFidelity({
        materializedBytes: materialized,
        preimageBytes: base.bytes,
        repositoryRoot: dependencies.repositoryRoot,
        relativePath,
        shelfId,
        store: dependencies.store,
        entry,
    });
    if (fidelity.rawBeforeObjectHash) objectHashes.add(fidelity.rawBeforeObjectHash);
    if (fidelity.rawAfterObjectHash) objectHashes.add(fidelity.rawAfterObjectHash);
    return fidelity.entry;
}

async function persistBlock(
    shelfId: string,
    relativePath: string,
    patch: Buffer,
    store: ShelfStore,
    objectHashes: Set<string>,
): Promise<ShelfLayerBlock> {
    const object = await store.putObject(shelfId, patch);
    objectHashes.add(object.hash);
    const classification = classifyPatchHeader(patch);
    return {
        path: relativePath,
        renamedFrom: classification.renamedFrom,
        status: classification.status,
        patchObjectHash: object.hash,
    };
}

async function readHistoryBase(
    baseCommit: string,
    blocks: readonly ShelfLayerBlock[],
    executor: GitExecutor,
): Promise<{ readonly bytes: Buffer } | undefined> {
    const candidate = blocks.find((block) => block.status !== "A");
    if (!candidate) return undefined;
    const safeRelativePath = validateShelfManifestPath(candidate.renamedFrom ?? candidate.path);
    const result = await executor.runBinary(["show", `${baseCommit}:${safeRelativePath}`], {
        expectedExitCodes: [0, 128],
    });
    return result.exitCode === 0 ? { bytes: result.stdout } : undefined;
}

async function readHead(executor: GitExecutor): Promise<string | undefined> {
    const result = await executor.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
        expectedExitCodes: [0, 1],
    });
    return result.exitCode === 0 ? result.stdout.toString("ascii").trim() : undefined;
}

async function findUntrackedPaths(
    executor: GitExecutor,
    selectedPaths: readonly string[],
): Promise<readonly string[]> {
    const result = await executor.runBinary([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    ]);
    const selected = selectedPaths.length > 0 ? new Set(selectedPaths) : undefined;
    return result.stdout
        .toString("utf8")
        .split("\0")
        .filter((record) => record.startsWith("?? "))
        .map((record) => record.slice(3))
        .filter((relativePath) => !selected || selected.has(relativePath));
}

function addBlocks(
    target: Map<string, LayerPatches>,
    patch: Buffer,
    layer: "index" | "worktree",
): void {
    for (const block of indexPatchBlocks(patch)) {
        target.set(block.path, {
            ...(target.get(block.path) ?? {}),
            [layer]: patch.subarray(block.start, block.end),
        });
    }
}

/**
 * Pins whole-source identities independently of optional ownership provenance.
 * The caller holds the repository/store locks and must invoke the returned assertion
 * after all object IO, immediately before publishing. This reads native whole-file
 * bytes and modes without imposing partial-text eligibility or persisting new state.
 */
export async function captureWholeSourceIdentity(
    selectedPaths: readonly string[],
    expectedHead: string,
    dependencies: ShelfCaptureDependencies,
): Promise<() => Promise<void>> {
    const { executor, repositoryRoot } = dependencies;
    const changed = () => new Error("Whole-file capture source changed before publication.");
    // Entries, not the index file: any `git status` rewrites the file with refreshed stat data alone.
    const listIndex = async () =>
        (await executor.runBinary(["ls-files", "--stage", "-v", "-z"])).stdout
            .toString("utf8")
            .split("\0");
    const listed = await listIndex();
    if ((await readHead(executor)) !== expectedHead) throw changed();
    // Porcelain -z names the destination first, then the source for a rename/copy.
    // Include both endpoints even when the requested whole entry names only one.
    const status = (
        await executor.runBinary([
            "status",
            "--porcelain=v1",
            "--renames",
            "-z",
            "--untracked-files=all",
        ])
    ).stdout
        .toString("utf8")
        .split("\0");
    const paths = new Set(selectedPaths.map(validateShelfManifestPath));
    for (let i = 0; i < status.length; i++) {
        const record = status[i];
        if (!record || !/[RC]/.test(record.slice(0, 2))) continue;
        const destination = record.slice(3);
        const source = status[++i];
        if (paths.has(destination) || paths.has(source)) {
            paths.add(validateShelfManifestPath(destination));
            paths.add(validateShelfManifestPath(source));
        }
    }
    const fingerprints = new Map<string, string>();
    for (const file of paths)
        fingerprints.set(file, await wholePathFingerprint(repositoryRoot, file));
    const entries = (records: readonly string[]) =>
        records.filter((record) => paths.has(record.slice(record.indexOf("\t") + 1))).join("\0");
    const index = entries(listed);
    const assertCurrent = async (): Promise<void> => {
        for (const [file, fingerprint] of fingerprints)
            if ((await wholePathFingerprint(repositoryRoot, file)) !== fingerprint) throw changed();
        if (entries(await listIndex()) !== index) throw changed();
        if ((await readHead(executor)) !== expectedHead) throw changed();
    };
    // Bracket source discovery as well as the later patch collection and object writes.
    await assertCurrent();
    return assertCurrent;
}

/** Checks containment on both sides of a native path fingerprint, including absent rename sources. */
async function wholePathFingerprint(root: string, relativePath: string): Promise<string> {
    const target = path.join(root, relativePath);
    await assertContainedParentIfPresent(root, target);
    const fingerprint = await pathFingerprint(target);
    await assertContainedParentIfPresent(root, target);
    return fingerprint;
}
