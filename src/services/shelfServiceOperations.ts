import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GitExecutor } from "../git/executor";
import { validateImportedPatch, validateShelfManifestPath } from "../shelf/importValidation";
import type { ShelfFileEntry, ShelfMetadata } from "../shelf/model";
import { classifyPatchHeader } from "../shelf/patchClassification";
import { indexPatchBlocks } from "../shelf/patchIO";
import { ensureContainedParent, resolveRepositoryPath } from "../shelf/recoveryPaths";
import type { ShelfStore } from "../shelf/store";

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Lightweight immutable shelf metadata for list responses. */
export interface ShelfSummary {
    readonly id: string;
    readonly generation: number;
    readonly metadata: ShelfMetadata;
}
/** Lock-consistent shelf catalog view returned by the host service. */
export interface ShelfListResult {
    readonly shelfIds: readonly string[];
    readonly corruptShelfIds: readonly string[];
    readonly catalogGeneration: number;
    readonly shelves: readonly ShelfSummary[];
}

/** User-selected action for a structural shelf entry. */
export interface StructuralResolutionInput {
    readonly id: string;
    readonly changeId: string;
    readonly expectedShelfGeneration: number;
    readonly expectedPathFingerprint: string;
    readonly action: "keepLocal" | "useShelved" | "deleteLocal" | "renameLocal";
    readonly targetPath?: string;
}

/** Concatenates selected index and worktree layer patches into the documented lossy export. */
export async function exportFlattenedPatch(
    store: ShelfStore,
    shelfId: string,
    entries: readonly ShelfFileEntry[],
): Promise<Buffer> {
    const pieces: Buffer[] = [];
    for (const entry of entries) {
        for (const block of [entry.indexBlock, entry.worktreeBlock]) {
            if (block?.patchObjectHash)
                pieces.push(await store.readObject(shelfId, block.patchObjectHash));
        }
    }
    return Buffer.concat(pieces);
}

/** Imports bounded ordinary patch files into a content-only shelf; full-fidelity metadata is unavailable by design. */
export async function importPatchFiles(
    store: ShelfStore,
    fileUris: readonly string[],
    name?: string,
): Promise<{ readonly shelfId: string; readonly generation: number }> {
    if (fileUris.length === 0) throw new Error("At least one patch file is required.");
    const shelfId = randomUUID();
    const hashes = new Set<string>();
    const files: ShelfFileEntry[] = [];
    for (const fileUri of fileUris) {
        const patch = await readImportPatch(fileUri);
        validateImportedPatch(patch);
        for (const block of indexPatchBlocks(patch)) {
            const bytes = patch.subarray(block.start, block.end);
            const object = await store.putObject(shelfId, bytes);
            const classification = classifyPatchHeader(bytes);
            hashes.add(object.hash);
            files.push({
                changeId: `import-${files.length}`,
                worktreeBlock: {
                    path: block.path,
                    renamedFrom: classification.renamedFrom,
                    status: classification.status,
                    patchObjectHash: object.hash,
                },
                binary: classification.binary,
                untracked: false,
                baseAvailability: "none",
                exactReconstruction: true,
                lifecycle: "shelved",
            });
        }
    }
    if (files.length === 0) throw new Error("Patch contains no importable change blocks.");
    const manifest = await store.writeShelfGeneration(shelfId, {
        schemaVersion: 1,
        objectHashes: [...hashes],
        metadata: { name: name ?? "Imported patches", lifecycle: "shelved", createdAt: Date.now() },
        files,
    });
    return { shelfId, generation: manifest.generation };
}

/** Performs one validated structural action against the working tree. */
export async function resolveStructuralAction(
    input: StructuralResolutionInput,
    dependencies: {
        readonly repositoryRoot: string;
        readonly executor: GitExecutor;
        readonly store: ShelfStore;
    },
    entry: ShelfFileEntry,
): Promise<void> {
    const block = entry.worktreeBlock ?? entry.indexBlock;
    if (!block) throw new Error("Structural shelf entry has no file path.");
    const sourcePath = block.status === "R" ? (block.renamedFrom ?? block.path) : block.path;
    const source = resolveRepositoryPath(
        dependencies.repositoryRoot,
        validateShelfManifestPath(sourcePath),
    );
    if ((await pathFingerprint(source)) !== input.expectedPathFingerprint) {
        throw new Error("Structural resolution path is stale.");
    }
    if (input.action === "keepLocal") return;
    if (input.action === "deleteLocal") {
        await assertFreshStructuralSource(
            dependencies.repositoryRoot,
            source,
            input.expectedPathFingerprint,
        );
        await rm(source, { force: false });
        return;
    }
    if (input.action === "renameLocal") {
        if (!input.targetPath) throw new Error("Rename resolution requires a target path.");
        const target = resolveRepositoryPath(
            dependencies.repositoryRoot,
            validateShelfManifestPath(input.targetPath),
        );
        await assertAbsentStructuralTarget(dependencies.repositoryRoot, target);
        await assertFreshStructuralSource(
            dependencies.repositoryRoot,
            source,
            input.expectedPathFingerprint,
        );
        await assertAbsentStructuralTarget(dependencies.repositoryRoot, target);
        await rename(source, target);
        return;
    }
    if (!block.patchObjectHash) throw new Error("Structural shelf patch is missing.");
    const patch = await dependencies.store.readObject(input.id, block.patchObjectHash);
    validateImportedPatch(patch);
    const checked = await dependencies.executor.runBinary(["apply", "--check", "-"], {
        input: patch,
        expectedExitCodes: [0, 1],
    });
    if (checked.exitCode !== 0)
        throw new Error("Shelved structural patch cannot be applied safely.");
    await dependencies.executor.runBinary(["apply", "-"], { input: patch });
}

/** Returns a stable regular-file fingerprint or a sentinel for absent and non-regular paths. */
export async function pathFingerprint(target: string): Promise<string> {
    try {
        const details = await lstat(target);
        if (!details.isFile() || details.isSymbolicLink())
            return `type:${details.mode.toString(8)}`;
        return `${(details.mode & 0o7777).toString(8)}:${createHash("sha256")
            .update(await readFile(target))
            .digest("hex")}`;
    } catch (error) {
        if (isNotFound(error)) return "absent";
        throw error;
    }
}

async function readImportPatch(fileUri: string): Promise<Buffer> {
    if (!path.isAbsolute(fileUri)) throw new Error("Patch import path must be absolute.");
    const details = await lstat(fileUri);
    if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size <= 0 ||
        details.size > MAX_IMPORT_BYTES
    ) {
        throw new Error("Patch import file is unsafe or exceeds the import limit.");
    }
    return readFile(fileUri);
}

async function assertFreshStructuralSource(
    repositoryRoot: string,
    target: string,
    expectedFingerprint: string,
): Promise<void> {
    await ensureContainedParent(repositoryRoot, target);
    if ((await pathFingerprint(target)) !== expectedFingerprint) {
        throw new Error("Structural resolution path is stale.");
    }
}

async function assertAbsentStructuralTarget(repositoryRoot: string, target: string): Promise<void> {
    await ensureContainedParent(repositoryRoot, target);
    if ((await pathFingerprint(target)) !== "absent") {
        throw new Error("Structural rename target already exists.");
    }
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
