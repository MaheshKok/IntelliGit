import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitExecutor } from "../git/executor";
import { validateShelfManifestPath } from "../shelf/importValidation";
import type { ShelfFileEntry } from "../shelf/model";
import { ensureContainedParent, resolveRecoveryPath } from "../shelf/recoveryPaths";
import { replaceRegularWorktreeFile } from "../shelf/safeWorktreeWrite";
import {
    ShelfStaleShelfError,
    type ShelfPersistenceManifest,
    type ShelfStore,
} from "../shelf/store";
import { pathFingerprint } from "./shelfServiceOperations";
import { isUtf8, repositoryPath } from "./shelfServiceHelpers";

/** Immutable three-way content supplied to the shelf merge editor. */
export interface ShelfConflictSessionPayload {
    readonly path: string;
    readonly base: string;
    readonly current: string;
    readonly patchedBase: string;
    readonly worktreeFingerprint: string;
    readonly shelfGeneration: number;
}

/** Request opening the content-backed session for one already-conflicted entry. */
export interface OpenShelfConflictSessionInput {
    readonly id: string;
    readonly changeId: string;
}

/** Guarded request applying a user-produced shelf merge result. */
export interface ApplyShelfConflictResolutionInput extends OpenShelfConflictSessionInput {
    readonly content: string;
    readonly expectedShelfGeneration: number;
    readonly expectedPathFingerprint: string;
    readonly staleOverride?: "overwriteParkingCurrent";
}

/** Explicit result lets the host distinguish a stale prompt from a successful mutation. */
export type ApplyShelfConflictResolutionResult =
    | { readonly status: "applied"; readonly newGeneration: number }
    | { readonly status: "stale"; readonly reason: "shelf" | "path" }
    | { readonly status: "refused"; readonly reason: string };

interface MaterializeInput {
    readonly id: string;
    readonly entry: ShelfFileEntry;
    readonly base: Buffer;
}

interface ParkCurrentInput {
    readonly id: string;
    readonly generation: number;
    readonly path: string;
    readonly bytes: Buffer;
}

/** Dependencies intentionally keep the session independent of the host panel and Git staging. */
export interface ShelfConflictSessionDependencies {
    readonly repositoryRoot: string;
    readonly store: ShelfStore;
    readonly withMutation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly readBase: (id: string, entry: ShelfFileEntry) => Promise<Buffer | undefined>;
    readonly materializePatchedBase?: (input: MaterializeInput) => Promise<Buffer | undefined>;
    readonly executor?: GitExecutor;
    readonly getGitDirectories?: () => Promise<{ readonly gitDir: string }>;
    readonly parkCurrent?: (input: ParkCurrentInput) => Promise<void>;
}

/** Returns the local side from ordinary git merge-file markers, preserving surrounding text. */
export function extractOursFromConflictMarkers(content: string): string {
    const lines = content.match(/.*(?:\n|$)/g) ?? [];
    const result: string[] = [];
    let inConflict = false;
    let include = true;
    let foundMarker = false;

    for (const line of lines) {
        if (!inConflict && line.startsWith("<<<<<<<")) {
            inConflict = true;
            include = true;
            foundMarker = true;
            continue;
        }
        if (inConflict && line.startsWith("=======")) {
            include = false;
            continue;
        }
        if (inConflict && line.startsWith(">>>>>>>")) {
            inConflict = false;
            continue;
        }
        if (!inConflict || include) result.push(line);
    }
    return foundMarker && !inConflict ? result.join("") : content;
}

/** Runs the same temporary-directory patch materialization used by flattened merge-file fallback. */
async function materializeShelfPatchedBase(
    input: MaterializeInput,
    dependencies: Pick<ShelfConflictSessionDependencies, "store" | "executor">,
): Promise<Buffer | undefined> {
    const executor = dependencies.executor;
    if (!executor) throw new Error("Shelf conflict materialization requires a Git executor.");
    const block = input.entry.worktreeBlock;
    if (!block) return undefined;
    const safePath = validateShelfManifestPath(block.path);
    const indexPatch = input.entry.indexBlock?.patchObjectHash
        ? await dependencies.store.readObject(input.id, input.entry.indexBlock.patchObjectHash)
        : Buffer.alloc(0);
    const worktreePatch = block.patchObjectHash
        ? await dependencies.store.readObject(input.id, block.patchObjectHash)
        : Buffer.alloc(0);
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-materialize-"));
    try {
        const target = path.join(directory, safePath);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, input.base);
        const patch = Buffer.concat([indexPatch, worktreePatch]);
        const checked = await executor.runBinary(["-C", directory, "apply", "--check", "-"], {
            input: patch,
            expectedExitCodes: [0, 1],
        });
        if (checked.exitCode !== 0) return undefined;
        await executor.runBinary(["-C", directory, "apply", "-"], { input: patch });
        // Must await before the finally removes `directory`: returning the pending
        // readFile lets the rm win the race and surface a spurious ENOENT.
        return await readFile(target);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** Owns read-only session construction plus guarded working-tree-only resolution. */
export class ShelfConflictSessionService {
    /** Binds the session to its store, repository, and mutation-serialization collaborators. */
    constructor(private readonly dependencies: ShelfConflictSessionDependencies) {}

    /** Reads immutable sides without acquiring the mutation queue or repository lock. */
    async open(input: OpenShelfConflictSessionInput): Promise<ShelfConflictSessionPayload> {
        const manifest = await this.dependencies.store.readCurrentShelfManifest(input.id);
        const entry = this.conflictedEntry(manifest, input.changeId);
        const block = entry.worktreeBlock!;
        const safePath = validateShelfManifestPath(block.path);
        const base = await this.dependencies.readBase(input.id, entry);
        if (!base || !isUtf8(base))
            throw new Error("Shelf conflict base is unavailable or not UTF-8.");
        const materialized = await this.materializePatchedBase({ id: input.id, entry, base });
        if (!materialized || !isUtf8(materialized)) {
            throw new Error("Shelf conflict patched base is unavailable or not UTF-8.");
        }
        const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
        const bytes = await readFile(target);
        if (!isUtf8(bytes)) throw new Error("Shelf conflict current file is not UTF-8.");
        const fingerprint = await pathFingerprint(target);
        if (fingerprint.startsWith("type:") || fingerprint === "absent") {
            throw new Error("Shelf conflict target is no longer a regular file.");
        }
        return {
            path: safePath,
            base: base.toString("utf8"),
            current: extractOursFromConflictMarkers(bytes.toString("utf8")),
            patchedBase: materialized.toString("utf8"),
            worktreeFingerprint: fingerprint,
            shelfGeneration: manifest.generation,
        };
    }

    /** Materializes and writes merge-file output for flattened regular-text M/M conflicts. */
    async mergeTextEntry(
        id: string,
        entry: ShelfFileEntry,
    ): Promise<"applied" | "conflicted" | undefined> {
        if (!entry.worktreeBlock || entry.baseAvailability === "none") return undefined;
        const base = await this.dependencies.readBase(id, entry);
        if (!base || !isUtf8(base)) return undefined;
        const patchedBase = await this.materializePatchedBase({ id, entry, base });
        if (!patchedBase || !isUtf8(patchedBase)) return undefined;
        const safePath = validateShelfManifestPath(entry.worktreeBlock.path);
        const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
        const current = await readFile(target).catch(() => undefined);
        if (!current || !isUtf8(current) || !this.dependencies.executor) return undefined;
        const directory = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-merge-"));
        try {
            const basePath = path.join(directory, "base");
            const currentPath = path.join(directory, "current");
            const shelvedPath = path.join(directory, "shelved");
            // react-doctor-disable-next-line react-doctor/async-parallel -- All three temporary merge inputs must be durable before Git reads any of them.
            await Promise.all([
                writeFile(basePath, base),
                writeFile(currentPath, current),
                writeFile(shelvedPath, patchedBase),
            ]);
            const result = await this.dependencies.executor.runBinary(
                ["merge-file", "-p", currentPath, basePath, shelvedPath],
                { expectedExitCodes: [0, 1] },
            );
            await replaceRegularWorktreeFile(
                this.dependencies.repositoryRoot,
                safePath,
                result.stdout,
            );
            return result.exitCode === 0 ? "applied" : "conflicted";
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    /** Re-enters normal mutation serialization and applies only after both preconditions are current. */
    async apply(
        input: ApplyShelfConflictResolutionInput,
    ): Promise<ApplyShelfConflictResolutionResult> {
        try {
            return await this.dependencies.withMutation(async () => {
                const manifest = await this.dependencies.store.readCurrentShelfManifest(input.id);
                const generationStale = manifest.generation !== input.expectedShelfGeneration;
                if (generationStale && !input.staleOverride) {
                    return { status: "stale", reason: "shelf" };
                }
                if (generationStale) return this.applyLocked(manifest, input, true);
                try {
                    return await this.dependencies.store.withGenerationCas(
                        {
                            shelfId: input.id,
                            expectedShelfGeneration: input.expectedShelfGeneration,
                        },
                        async () => this.applyLocked(manifest, input, false),
                    );
                } catch (error) {
                    if (!(error instanceof ShelfStaleShelfError)) throw error;
                    if (!input.staleOverride) return { status: "stale", reason: "shelf" };
                    const current = await this.dependencies.store.readCurrentShelfManifest(
                        input.id,
                    );
                    return this.applyLocked(current, input, true);
                }
            });
        } catch (error) {
            if (error instanceof ShelfStaleShelfError) return { status: "stale", reason: "shelf" };
            throw error;
        }
    }

    private async materializePatchedBase(input: MaterializeInput): Promise<Buffer | undefined> {
        return this.dependencies.materializePatchedBase
            ? this.dependencies.materializePatchedBase(input)
            : materializeShelfPatchedBase(input, this.dependencies);
    }

    private conflictedEntry(manifest: ShelfPersistenceManifest, changeId: string): ShelfFileEntry {
        const entry = manifest.files.find((candidate) => candidate.changeId === changeId);
        if (
            !entry ||
            !entry.worktreeBlock ||
            entry.worktreeBlock.status !== "M" ||
            entry.binary ||
            !entry.exactReconstruction ||
            entry.baseAvailability === "none"
        ) {
            throw new Error("Shelf entry is not eligible for a text conflict session.");
        }
        return entry;
    }

    private async applyLocked(
        manifest: ShelfPersistenceManifest,
        input: ApplyShelfConflictResolutionInput,
        generationStale: boolean,
    ): Promise<ApplyShelfConflictResolutionResult> {
        const entry = this.conflictedEntry(manifest, input.changeId);
        const safePath = validateShelfManifestPath(entry.worktreeBlock!.path);
        const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
        const currentFingerprint = await pathFingerprint(target);
        const pathStale = currentFingerprint !== input.expectedPathFingerprint;
        if ((generationStale || pathStale) && !input.staleOverride) {
            return { status: "stale", reason: generationStale ? "shelf" : "path" };
        }
        if (generationStale || pathStale) {
            const current = await readFile(target).catch(() => undefined);
            if (!current)
                return {
                    status: "refused",
                    reason: "Current shelf conflict file cannot be parked.",
                };
            try {
                await this.parkCurrent({
                    id: input.id,
                    generation: manifest.generation,
                    path: safePath,
                    bytes: current,
                });
            } catch (error) {
                return {
                    status: "refused",
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
        }
        await replaceRegularWorktreeFile(
            this.dependencies.repositoryRoot,
            safePath,
            Buffer.from(input.content, "utf8"),
        );
        const next = await markShelfEntryApplied(
            this.dependencies.store,
            input.id,
            manifest,
            entry.changeId,
        );
        return { status: "applied", newGeneration: next.generation };
    }

    private async parkCurrent(input: ParkCurrentInput): Promise<void> {
        if (this.dependencies.parkCurrent) return this.dependencies.parkCurrent(input);
        if (!this.dependencies.getGitDirectories) {
            throw new Error("Shelf recovery parking is unavailable.");
        }
        const { gitDir } = await this.dependencies.getGitDirectories();
        await parkShelfConflictCurrent(this.dependencies.store, gitDir, input);
    }
}

/** Preserves overridden local bytes in the same recovery area that explicit recovery purge manages. */
async function parkShelfConflictCurrent(
    store: ShelfStore,
    gitDir: string,
    input: ParkCurrentInput,
): Promise<void> {
    const journalId = `shelf-conflict-${randomUUID().replaceAll("-", "")}`;
    const recoveryDirectory = path.join(gitDir, "intelligit", "recovery", journalId);
    const target = resolveRecoveryPath(recoveryDirectory, validateShelfManifestPath(input.path));
    await store.writeJournal({
        id: journalId,
        state: "unshelvePending",
        pathProgress: { [input.path]: "conflictParking" },
        shelf: { id: input.id, generation: input.generation },
    });
    try {
        await ensureContainedParent(gitDir, target);
        const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
        const file = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
            0o600,
        );
        try {
            await file.writeFile(input.bytes);
            await file.sync();
        } finally {
            await file.close();
        }
        await chmod(target, 0o600);
        await store.transitionJournal(journalId, "applied");
    } catch (error) {
        await rm(recoveryDirectory, { recursive: true, force: true });
        await store.deleteJournal(journalId).catch(() => undefined);
        throw error;
    }
}

/** Reuses the ordinary applied-entry journal and ghost transition for a successful resolution. */
async function markShelfEntryApplied(
    store: ShelfStore,
    shelfId: string,
    manifest: ShelfPersistenceManifest,
    changeId: string,
): Promise<ShelfPersistenceManifest> {
    const files = manifest.files.map((entry) =>
        entry.changeId === changeId ? { ...entry, lifecycle: "applied" as const } : entry,
    );
    const allApplied = files.every((entry) => entry.lifecycle === "applied");
    const journalId = `unshelve-${randomUUID().replaceAll("-", "")}`;
    // react-doctor-disable-next-line react-doctor/async-parallel -- Recovery requires the pending journal to be durable before its shelf generation changes.
    await store.writeJournal({
        id: journalId,
        state: "unshelvePending",
        pathProgress: { [changeId]: "applied" },
        shelf: { id: shelfId, generation: manifest.generation },
    });
    const next = await store.writeShelfGeneration(shelfId, {
        schemaVersion: manifest.schemaVersion,
        objectHashes: manifest.objectHashes,
        metadata: {
            ...manifest.metadata,
            lifecycle: allApplied ? "applied" : "shelved",
            appliedAt: allApplied ? Date.now() : undefined,
        },
        files,
    });
    await store.transitionJournal(journalId, allApplied ? "ghost" : "applied");
    return next;
}
