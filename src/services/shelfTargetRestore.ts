import type { GitExecutor } from "../git/executor";
import type { ChangelistStore } from "../changes/changelistStore";
import type { RepositoryMutationGate } from "../git/repositoryMutationGate";
import type { ShelfStore } from "../shelf/store";
import { pathFingerprint } from "./shelfServiceOperations";
import { resolveShelfPaths } from "../shelf/paths";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ChangelistPersistence } from "../changes/changelistPersistence";
import {
    ChangelistRevisionError,
    preparedTargetRequestHash,
    targetPathUnowned,
    type TargetOperationLease,
} from "../changes/changelistStore";
import { changeFingerprint, parseChangeDiff } from "../changes/parseDiff";
import {
    rangeSnapshot,
    reconcileRanges,
    type HydratedChangeOwnership,
} from "../changes/rangeMapping";
import type { TargetOperationAttribution } from "../changes/rangeMetadata";
import type {
    TargetOperationAttributionReference,
    TargetOperationEvidence,
    TargetOperationRecord,
    TargetWholeFileBefore,
} from "../changes/targetOperation";
import { replaceRegularWorktreeFile } from "../shelf/safeWorktreeWrite";
import type { GitOps } from "../git/operations";
import {
    PartialChangesUnsupportedError,
    readPartialSnapshot,
    type PartialFileSnapshot,
} from "../git/partialSnapshot";
import { RepositoryLockBusyError } from "../git/repositoryLock";
import { captureTargetNativeEvidence } from "../git/targetOperationRecovery";
import type { ShelfFileEntry } from "../shelf/model";
import type { ShelfPersistenceManifest } from "../shelf/store";
import type { ChangelistTarget } from "../webviews/protocol/changelists";
import type { ShelfDraftChoice } from "../webviews/protocol/targetOperation";
import { isStructural, selectEntries } from "./shelfServiceHelpers";

/** One public per-entry outcome; later protocol code maps these without string parsing. */
export type PerEntryResult =
    | { readonly kind: "applied"; readonly changeId: string }
    | { readonly kind: "conflicted"; readonly changeId: string }
    | { readonly kind: "retained"; readonly changeId: string; readonly reason: string }
    | { readonly kind: "flattenedResidue"; readonly changeId: string }
    | { readonly kind: "refused"; readonly changeId: string; readonly reason: string }
    | {
          readonly kind: "structuralPending";
          readonly changeId: string;
          readonly reason: string;
          readonly path: string;
          readonly pathFingerprint: string;
      };
/** Request for applying complete stored shelf entries. */
export interface UnshelveInput {
    /** Host-captured destination and source identity; omission is legacy internal compatibility. */
    readonly targetOperation?: ShelfRestoreTarget;
    readonly id: string;
    readonly changeIds?: readonly string[];
    readonly removeFromShelf: boolean;
    readonly mode: "flattened" | "exactState";
    readonly expectedShelfGeneration?: number;
}
/** Host-captured intent; both source checksum and destination revision precede mutation. */
export interface ShelfRestoreTarget {
    readonly id: string;
    readonly root: string;
    readonly target: ChangelistTarget;
    readonly sourceChecksum: string;
    readonly draftChoice?: ShelfDraftChoice;
}

/** Targeted outcomes always carry the durable request identity and cannot be mistaken for legacy success. */
export interface TargetShelfMutationResult {
    readonly entries: readonly PerEntryResult[];
    readonly shelfId: string;
    readonly newGeneration?: number;
    readonly status:
        "applied" | "notApplied" | "appliedNeedsReview" | "conflicted" | "stale" | "busy";
    readonly operationId: string;
}

interface RestoreDependencies {
    readonly repositoryRoot: string;
    readonly executor: GitExecutor;
    readonly store: ShelfStore;
    readonly gate: RepositoryMutationGate;
    readonly changelists: ChangelistStore;
    readonly gitOps: GitOps;
    readonly applyEntry: (
        shelfId: string,
        entry: ShelfFileEntry,
        mode: UnshelveInput["mode"],
    ) => Promise<PerEntryResult>;
}

/** One reviewed text result for a conflicted entry of a pending targeted restore. */
export interface TargetConflictResolution {
    readonly operationId: string;
    readonly shelfId: string;
    readonly changeId: string;
    readonly content: string;
    /** Fingerprint the editor saw when it opened; any later file change makes the editor stale. */
    readonly expectedPathFingerprint: string;
}

/** Applies only a newly prepared intent; replay performs observations and metadata completion only. */
export async function restoreTargetedShelf(
    input: UnshelveInput,
    dependencies: RestoreDependencies,
): Promise<TargetShelfMutationResult> {
    return new TargetShelfRestore(input, dependencies).run();
}

/**
 * Continues the recorded pending restore with one reviewed conflict result. The captured
 * destination, source generation and checksum come from the durable record, never the caller.
 */
export async function resolveTargetedShelfConflict(
    resolution: TargetConflictResolution,
    dependencies: RestoreDependencies,
): Promise<TargetShelfMutationResult> {
    const state = dependencies.changelists.get(dependencies.repositoryRoot);
    const pending = state.pendingTargetOperation;
    if (
        pending?.id !== resolution.operationId ||
        pending.kind !== "shelfRestore" ||
        pending.shelf?.id !== resolution.shelfId
    )
        return {
            status: "stale",
            operationId: resolution.operationId,
            entries: [],
            shelfId: resolution.shelfId,
        };
    return new TargetShelfRestore(
        {
            id: pending.shelf.id,
            changeIds: pending.shelf.changeIds,
            removeFromShelf: pending.shelf.removeFromShelf,
            mode: "flattened",
            expectedShelfGeneration: pending.shelf.generation,
            targetOperation: {
                id: pending.id,
                root: dependencies.repositoryRoot,
                target: { kind: "existing", id: pending.destinationId, revision: state.revision },
                sourceChecksum: pending.shelf.checksum,
            },
        },
        dependencies,
    ).resolveConflict(resolution);
}

/** One repository-bound service invocation owns its lease through the final publication. */
class TargetShelfRestore {
    private readonly intent: ShelfRestoreTarget;
    private persistence!: ChangelistPersistence;
    private lease!: TargetOperationLease;
    private durable = false;
    private entries: PerEntryResult[] = [];

    constructor(
        private readonly input: UnshelveInput,
        private readonly deps: RestoreDependencies,
    ) {
        this.intent = input.targetOperation!;
    }

    /** Admits a new request, returns a known receipt, or resumes this exact pending operation. */
    async run(): Promise<TargetShelfMutationResult> {
        return this.locked(async () => {
            const state = this.state();
            const receipt = state.targetOperationReceipts?.[this.intent.id];
            if (receipt) {
                this.durable = true;
                const chain = await this.persistence.loadTargetOperationEvidenceChain(
                    receipt.evidenceHash,
                );
                if (
                    !(await this.sameRequest({
                        requestHash: receipt.requestHash,
                        beforeEvidenceHash: chain.root.hash,
                        headBefore: chain.root.evidence.head,
                        changeIds: chain.root.evidence.entries.map((entry) => entry.changeId),
                    }))
                )
                    return this.result("stale");
                this.entries = evidenceResults(chain.evidence);
                return this.result(receipt.outcome === "aborted" ? "notApplied" : receipt.outcome);
            }
            const pending = state.pendingTargetOperation;
            if (pending) {
                if (pending.id !== this.intent.id) return this.result("busy");
                this.durable = true;
                if (
                    !pending.shelf ||
                    !(await this.sameRequest({ ...pending, changeIds: pending.shelf.changeIds }))
                )
                    return this.result("stale");
                return await this.resume(pending);
            }
            if (state.revision !== this.intent.target.revision) return this.result("stale");
            if ((await this.deps.gitOps.getActiveOperation()) !== "none")
                return this.result("busy");
            const prepared = await this.deps.store.withLock(() => this.apply());
            return prepared ? await this.complete() : this.result("stale");
        });
    }

    /** Writes one reviewed conflict result for this exact pending operation, then continues it. */
    async resolveConflict(
        resolution: TargetConflictResolution,
    ): Promise<TargetShelfMutationResult> {
        return this.locked(async () => {
            const pending = this.state().pendingTargetOperation;
            if (pending?.id !== this.intent.id || pending.phase !== "conflicted")
                return this.result("stale");
            const resolved = await this.deps.store.withLock(() =>
                this.resolveLocked(pending, resolution),
            );
            return resolved ? await this.complete() : this.result("stale");
        });
    }

    /** Validates actual collaborators before locks and never turns a durable mutation into retryable failure. */
    private async locked(
        body: () => Promise<TargetShelfMutationResult>,
    ): Promise<TargetShelfMutationResult> {
        try {
            const root = await realpath(this.deps.repositoryRoot);
            const actual = await realpath(
                (await this.deps.executor.run(["rev-parse", "--show-toplevel"])).trim(),
            );
            if (
                root !== this.intent.root ||
                actual !== root ||
                root !== this.deps.repositoryRoot ||
                !Number.isSafeInteger(this.input.expectedShelfGeneration) ||
                this.input.expectedShelfGeneration! < 0 ||
                !/^[a-f0-9]{64}$/.test(this.intent.sourceChecksum)
            )
                return this.result("stale");
            const shelfPaths = await resolveShelfPaths({
                repositoryRoot: root,
                globalStoragePath: root,
            });
            if (this.deps.store.repositoryId !== shelfPaths.repoId) return this.result("stale");
            const directories = await this.deps.gitOps.getGitDirectories();
            this.persistence = await ChangelistPersistence.open(root, directories.gitDir);
            this.lease = await this.deps.changelists.acquireTargetOperationLease(root);
            try {
                return await this.deps.gate.run(root, directories.commonDir, body);
            } finally {
                await this.lease.release();
            }
        } catch (error) {
            if (this.durable) return this.result("appliedNeedsReview");
            if (error instanceof RepositoryLockBusyError) return this.result("busy");
            if (error instanceof ChangelistRevisionError) return this.result("stale");
            throw error;
        }
    }

    /** Checks the real lease on each metadata read, including reads after awaited filesystem work. */
    private state() {
        return this.deps.changelists.inspectTargetOperationLease(this.intent.root, this.lease);
    }

    /**
     * Proves the incoming intent is the recorded request by rebuilding the store's request hash
     * from this intent plus the values prepare derived from the original source shelf and Git observation.
     */
    private async sameRequest(stored: {
        readonly requestHash: string;
        readonly beforeEvidenceHash: string;
        readonly headBefore: string;
        readonly changeIds: readonly string[];
        readonly sourceDraft?: string;
    }): Promise<boolean> {
        const choice = this.intent.draftChoice ?? { kind: "keep" as const };
        const manifest =
            !this.input.changeIds ||
            (choice.kind === "copySource" && stored.sourceDraft === undefined)
                ? await this.deps.store.readCurrentShelfManifest(this.input.id)
                : undefined;
        // An omitted selection means every entry of the source shelf.
        const requested = new Set(
            this.input.changeIds ?? manifest!.files.map((entry) => entry.changeId),
        );
        if (
            requested.size !== stored.changeIds.length ||
            stored.changeIds.some((id) => !requested.has(id))
        )
            return false;
        const sourceDraft =
            choice.kind === "copySource"
                ? (stored.sourceDraft ??
                  manifest!.metadata.selection?.sourceLists.find(
                      (list) => list.id === choice.sourceListId,
                  )?.draft)
                : undefined;
        try {
            // The same request object prepare received, hashed by the store's own recipe.
            return (
                preparedTargetRequestHash({
                    id: this.intent.id,
                    kind: "shelfRestore",
                    target: this.intent.target,
                    headBefore: stored.headBefore,
                    evidenceHash: stored.beforeEvidenceHash,
                    shelf: {
                        id: this.input.id,
                        generation: this.input.expectedShelfGeneration!,
                        checksum: this.intent.sourceChecksum,
                        changeIds: [...stored.changeIds],
                        removeFromShelf: this.input.removeFromShelf,
                    },
                    draftChoice: choice,
                    ...(sourceDraft !== undefined ? { sourceDraft } : {}),
                }) === stored.requestHash
            );
        } catch {
            return false; // An unnormalizable new-list name cannot be the recorded request.
        }
    }

    /** Keeps the operation identity attached to every targeted result. */
    private result(status: TargetShelfMutationResult["status"]): TargetShelfMutationResult {
        return {
            status,
            operationId: this.intent.id,
            entries: this.entries,
            shelfId: this.input.id,
        };
    }

    /** Captures the exact selected paths, including both rename endpoints. */
    private paths(selected: readonly ShelfFileEntry[]): string[] {
        return [
            ...new Set(
                selected.flatMap((entry) =>
                    [entry.indexBlock, entry.worktreeBlock].flatMap((block) =>
                        block
                            ? [block.path, ...(block.renamedFrom ? [block.renamedFrom] : [])]
                            : [],
                    ),
                ),
            ),
        ].sort();
    }

    /** Reads and checks the original shelf under its lock before any target creation or Git write. */
    private async source(): Promise<ShelfPersistenceManifest | undefined> {
        const manifest = await this.deps.store.readCurrentShelfManifest(this.input.id);
        return manifest.generation === this.input.expectedShelfGeneration &&
            manifest.checksum === this.intent.sourceChecksum
            ? manifest
            : undefined;
    }

    /** Publishes before evidence and per-entry checkpoints while retaining metadata/repository/shelf order. */
    private async apply(): Promise<boolean> {
        await this.deps.store.migrateWithHeldLocks();
        const manifest = await this.source();
        if (!manifest) return false;
        const selected = selectEntries(manifest.files, this.input.changeIds);
        const paths = this.paths(selected);
        const before = await captureTargetNativeEvidence(
            this.deps.executor,
            this.persistence,
            this.intent.id,
            paths,
        );
        const ownership = await this.deps.changelists.readTargetOperationOwnership(
            this.intent.root,
            this.lease,
            paths,
        );
        const snapshots = new Map<string, PartialFileSnapshot>();
        const wholeFileBefore: TargetWholeFileBefore[] = [];
        for (const file of paths) {
            try {
                snapshots.set(
                    file,
                    await readPartialSnapshot(
                        this.deps.executor,
                        this.intent.root,
                        file,
                        "working",
                    ),
                );
            } catch (error) {
                if (
                    !(error instanceof PartialChangesUnsupportedError) &&
                    (error as NodeJS.ErrnoException).code !== "ENOENT"
                )
                    throw error;
                wholeFileBefore.push(await this.wholeBefore(file, before.head));
            }
        }
        const initial: TargetOperationEvidence = {
            ...before,
            wholeFileBefore,
            entries: selected.map((entry) => ({
                changeId: entry.changeId,
                path: (entry.worktreeBlock ?? entry.indexBlock)!.path,
                outcome: "pending",
            })),
        };
        assertSameObservation(
            before,
            await captureTargetNativeEvidence(
                this.deps.executor,
                this.persistence,
                this.intent.id,
                paths,
            ),
        );
        const evidenceHash = await this.persistence.storeTargetOperationEvidence(initial);
        const choice = this.intent.draftChoice ?? { kind: "keep" as const };
        const sourceDraft =
            choice.kind === "copySource"
                ? manifest.metadata.selection?.sourceLists.find(
                      (list) => list.id === choice.sourceListId,
                  )?.draft
                : undefined;
        if (choice.kind === "copySource" && sourceDraft === undefined)
            throw new Error("The selected shelf draft is unavailable.");
        await this.deps.changelists.prepareTargetOperation(this.lease, {
            id: this.intent.id,
            kind: "shelfRestore",
            target: this.intent.target,
            headBefore: initial.head,
            evidenceHash,
            shelf: {
                id: this.input.id,
                generation: manifest.generation,
                checksum: manifest.checksum,
                changeIds: selected.map((entry) => entry.changeId),
                removeFromShelf: this.input.removeFromShelf,
            },
            draftChoice: choice,
            ...(sourceDraft !== undefined ? { sourceDraft } : {}),
        });
        this.durable = true;
        let latest = initial;
        for (const entry of selected) {
            assertSameObservation(
                latest,
                await captureTargetNativeEvidence(
                    this.deps.executor,
                    this.persistence,
                    this.intent.id,
                    paths,
                ),
            );
            const result = await this.deps.applyEntry(this.input.id, entry, this.input.mode);
            this.entries.push(result);
            const observed = await captureTargetNativeEvidence(
                this.deps.executor,
                this.persistence,
                this.intent.id,
                paths,
            );
            if (
                this.input.mode === "flattened" &&
                observed.indexFingerprint !== before.indexFingerprint
            )
                throw new Error("Flattened restore changed the index.");
            latest = await this.after(initial, observed, snapshots, ownership);
            const pending = this.state().pendingTargetOperation!;
            const afterHash = await this.persistence.storeTargetOperationEvidence({
                ...latest,
                previousEvidenceHash: pending.evidenceHash,
            });
            await this.deps.changelists.checkpointTargetOperation(this.lease, {
                id: pending.id,
                revision: this.state().revision,
                expectedPhase: "prepared",
                phase: "prepared",
                evidenceHash: afterHash,
            });
        }
        const pending = this.state().pendingTargetOperation!;
        const conflicted = latest.entries.some((entry) => entry.outcome === "conflicted");
        const afterHash = await this.persistence.storeTargetOperationEvidence({
            ...latest,
            checkpoint: "after",
            previousEvidenceHash: pending.evidenceHash,
        });
        await this.deps.changelists.checkpointTargetOperation(this.lease, {
            id: pending.id,
            revision: this.state().revision,
            expectedPhase: "prepared",
            phase: conflicted ? "conflicted" : "gitApplied",
            evidenceHash: afterHash,
        });
        return true;
    }

    /** Reads HEAD independently; clean-looking absence never authorizes structural ownership. */
    private async wholeBefore(file: string, head: string): Promise<TargetWholeFileBefore> {
        const state = this.state();
        const unowned = targetPathUnowned(state, file);
        const tree = await this.deps.executor.run([
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            head,
            "--",
            file,
        ]);
        if (!tree) return { path: file, unowned, head: { kind: "absent" } };
        const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
        if (!match || match[3] !== file) throw new Error("Unsupported target restore HEAD entry.");
        const bytes = (await this.deps.executor.runBinary(["cat-file", "blob", match[2]])).stdout;
        return {
            path: file,
            unowned,
            head: {
                kind: "present",
                mode: match[1] as "100644",
                oid: match[2],
                object: {
                    hash: await this.persistence.storeTargetOperationObject(bytes),
                    size: bytes.length,
                },
            },
        };
    }

    /** Stores actual before/after Git text attribution for only successful paths. */
    private async after(
        before: TargetOperationEvidence,
        observed: TargetOperationEvidence,
        snapshots: ReadonlyMap<string, PartialFileSnapshot>,
        ownership: Readonly<Record<string, HydratedChangeOwnership | undefined>>,
    ): Promise<TargetOperationEvidence> {
        const entries = before.entries.map((entry) => {
            const result = this.entries.find((result) => result.changeId === entry.changeId);
            return result
                ? {
                      ...entry,
                      outcome: outcome(result),
                      ...("reason" in result ? { reason: result.reason } : {}),
                  }
                : entry;
        });
        const attribution = [];
        const wholeFileAttribution = [];
        for (const file of new Set(
            entries.filter((entry) => entry.outcome === "applied").map((entry) => entry.path!),
        )) {
            const changeIds = entries
                .filter((entry) => entry.path === file && entry.outcome === "applied")
                .map((entry) => entry.changeId);
            const snapshot = snapshots.get(file);
            if (!snapshot) {
                wholeFileAttribution.push({ path: file, changeIds });
                continue;
            }
            const after = await readPartialSnapshot(
                this.deps.executor,
                this.intent.root,
                file,
                "working",
            );
            attribution.push(
                await this.attribution(file, changeIds, snapshot, after, ownership[file]),
            );
        }
        assertSameObservation(
            observed,
            await captureTargetNativeEvidence(
                this.deps.executor,
                this.persistence,
                this.intent.id,
                before.paths.map((entry) => entry.path),
            ),
        );
        return { ...observed, checkpoint: "after", entries, attribution, wholeFileAttribution };
    }

    /** Stores one immutable before/after text attribution for the given successful entries. */
    private async attribution(
        file: string,
        changeIds: readonly string[],
        snapshot: PartialFileSnapshot,
        after: PartialFileSnapshot,
        previous: HydratedChangeOwnership | undefined,
    ): Promise<TargetOperationAttributionReference> {
        const beforeRange = rangeSnapshot(snapshot);
        const priorFileOwner = this.state().files[file] ?? this.state().activeId;
        const payload: TargetOperationAttribution = {
            version: 1,
            root: this.intent.root,
            gitDir: this.persistence.gitDir,
            operationId: this.intent.id,
            path: file,
            priorFileOwner,
            previous:
                previous ?? reconcileRanges(undefined, beforeRange, priorFileOwner, priorFileOwner),
            before: beforeRange,
            after: rangeSnapshot(after),
            operation: await this.operationSnapshot(snapshot, after),
        };
        const bytes = Buffer.from(JSON.stringify(payload));
        return {
            path: file,
            changeIds,
            object: {
                hash: await this.persistence.storeTargetOperationObject(bytes),
                size: bytes.length,
            },
        };
    }

    /**
     * Applies one reviewed conflict result only while the captured shelf, every affected path and
     * the editor's file are unchanged. Attribution covers only the reviewed entry; earlier
     * successful entries keep their saved attribution, and the draft is decided at publication.
     */
    private async resolveLocked(
        pending: TargetOperationRecord,
        resolution: TargetConflictResolution,
    ): Promise<boolean> {
        const saved = await this.persistence.loadTargetOperationEvidence(pending.evidenceHash);
        const manifest = await this.source();
        const evidence = saved.entries.find((entry) => entry.changeId === resolution.changeId);
        const entry = manifest?.files.find((file) => file.changeId === resolution.changeId);
        if (
            evidence?.outcome !== "conflicted" ||
            evidence.path === undefined ||
            !entry ||
            isStructural(entry) ||
            !entry.exactReconstruction
        )
            return false;
        const file = evidence.path;
        const affected = saved.paths.map((value) => value.path);
        try {
            assertSameObservation(
                saved,
                await captureTargetNativeEvidence(
                    this.deps.executor,
                    this.persistence,
                    this.intent.id,
                    affected,
                ),
            );
        } catch {
            return false;
        }
        if (
            (await pathFingerprint(path.join(this.intent.root, file))) !==
            resolution.expectedPathFingerprint
        )
            return false;
        const chain = await this.persistence.loadTargetOperationEvidenceChain(pending.evidenceHash);
        const original = chain.root.evidence.paths.find((value) => value.path === file)?.state;
        if (original?.kind !== "regular") return false;
        const current = await readPartialSnapshot(
            this.deps.executor,
            this.intent.root,
            file,
            "working",
        );
        const working = (
            await this.persistence.loadTargetOperationObject(original.content)
        ).toString("utf8");
        const blocks = await this.blocks(current.view.base, working);
        const before: PartialFileSnapshot = {
            ...current,
            working,
            contentId: changeFingerprint(JSON.stringify([current.view.base, working, blocks])),
            view: { ...current.view, blocks },
        };
        const ownership = await this.deps.changelists.readTargetOperationOwnership(
            this.intent.root,
            this.lease,
            [file],
        );
        this.durable = true;
        await replaceRegularWorktreeFile(
            this.intent.root,
            file,
            Buffer.from(resolution.content, "utf8"),
        );
        const observed = await captureTargetNativeEvidence(
            this.deps.executor,
            this.persistence,
            this.intent.id,
            affected,
        );
        const after = await readPartialSnapshot(
            this.deps.executor,
            this.intent.root,
            file,
            "working",
        );
        const reference = await this.attribution(
            file,
            [resolution.changeId],
            before,
            after,
            ownership[file],
        );
        assertSameObservation(
            observed,
            await captureTargetNativeEvidence(
                this.deps.executor,
                this.persistence,
                this.intent.id,
                affected,
            ),
        );
        const entries = saved.entries.map((value) =>
            value.changeId === resolution.changeId
                ? { changeId: value.changeId, path: file, outcome: "applied" as const }
                : value,
        );
        const evidenceHash = await this.persistence.storeTargetOperationEvidence({
            ...observed,
            checkpoint: "after",
            entries,
            attribution: [...(saved.attribution ?? []), reference],
            wholeFileAttribution: saved.wholeFileAttribution ?? [],
            previousEvidenceHash: pending.evidenceHash,
        });
        await this.deps.changelists.checkpointTargetOperation(this.lease, {
            id: pending.id,
            revision: this.state().revision,
            expectedPhase: "conflicted",
            phase: entries.some((value) => value.outcome === "conflicted")
                ? "conflicted"
                : "gitApplied",
            evidenceHash,
        });
        this.entries = evidenceResults({ ...saved, entries });
        return true;
    }

    /** Parses Git's own no-index text diff between two in-memory sides. */
    private async blocks(left: string, right: string) {
        const directory = await mkdtemp(path.join(tmpdir(), "intelligit-restore-delta-"));
        try {
            const before = path.join(directory, "before");
            const after = path.join(directory, "after");
            await Promise.all([
                writeFile(before, left, { mode: 0o600 }),
                writeFile(after, right, { mode: 0o600 }),
            ]);
            const diff = await this.deps.executor.runBinary(
                [
                    "-c",
                    "diff.suppressBlankEmpty=false",
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--unified=3",
                    "--",
                    before,
                    after,
                ],
                {
                    expectedExitCodes: [0, 1],
                    maxOutputBytes: 8 * 1024 * 1024,
                    signal: AbortSignal.timeout(10_000),
                },
            );
            if (diff.truncated) throw new Error("The operation diff exceeds the supported size.");
            return parseChangeDiff(diff.stdout.toString("utf8"), left, right);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    /** Diffs the accepted real bytes to prove exactly which anchors this operation introduced. */
    private async operationSnapshot(before: PartialFileSnapshot, after: PartialFileSnapshot) {
        const blocks = await this.blocks(before.working, after.working);
        return rangeSnapshot({
            ...after,
            contentId: changeFingerprint(JSON.stringify([before.working, after.working, blocks])),
            view: { ...after.view, base: before.working, blocks },
        });
    }

    /** Continues an identity-proven pending record; successful or uncertain Git is never repeated. */
    private async resume(pending: TargetOperationRecord): Promise<TargetShelfMutationResult> {
        const evidence = await this.persistence.loadTargetOperationEvidence(pending.evidenceHash);
        this.entries = evidenceResults(evidence);
        return this.complete();
    }

    /** Captures a fresh independent observation for every metadata publication boundary. */
    private async observation() {
        const state = this.state();
        const pending = state.pendingTargetOperation!;
        const saved = await this.persistence.loadTargetOperationEvidence(pending.evidenceHash);
        const observed = await captureTargetNativeEvidence(
            this.deps.executor,
            this.persistence,
            this.intent.id,
            saved.paths.map((entry) => entry.path),
        );
        const observedEvidenceHash = await this.persistence.storeTargetOperationEvidence({
            ...saved,
            ...observed,
            checkpoint: saved.checkpoint,
            entries: saved.entries,
            previousEvidenceHash: saved.previousEvidenceHash,
        });
        const shelf = await this.deps.store.readCurrentShelfManifest(this.input.id);
        return {
            id: pending.id,
            revision: state.revision,
            expectedPhase: pending.phase,
            observedEvidenceHash,
            shelf: { id: this.input.id, generation: shelf.generation, checksum: shelf.checksum },
        };
    }

    /** Reopens conflicts only against the captured shelf and unchanged affected paths. */
    private async conflict(pending: TargetOperationRecord): Promise<TargetShelfMutationResult> {
        return this.deps.store.withLock(async () => {
            const saved = await this.persistence.loadTargetOperationEvidence(pending.evidenceHash);
            let manifest: ShelfPersistenceManifest | undefined;
            try {
                manifest = await this.source();
                if (!manifest) throw new Error("The conflict shelf changed.");
                assertSameObservation(
                    saved,
                    await captureTargetNativeEvidence(
                        this.deps.executor,
                        this.persistence,
                        this.intent.id,
                        saved.paths.map((entry) => entry.path),
                    ),
                );
            } catch {
                await this.deps.changelists.markTargetOperationReview(this.lease, {
                    id: pending.id,
                    revision: this.state().revision,
                    expectedPhase: pending.phase,
                });
                return this.result("appliedNeedsReview");
            }
            this.entries = await Promise.all(
                this.entries.map(async (result) => {
                    const entry = manifest.files.find(
                        (entry) => entry.changeId === result.changeId,
                    );
                    if (
                        result.kind !== "conflicted" ||
                        !entry ||
                        (!isStructural(entry) && entry.exactReconstruction)
                    )
                        return result;
                    const block = (entry.worktreeBlock ?? entry.indexBlock)!;
                    const file = block.status === "R" ? block.renamedFrom! : block.path;
                    return {
                        kind: "structuralPending" as const,
                        changeId: entry.changeId,
                        reason:
                            saved.entries.find((value) => value.changeId === entry.changeId)
                                ?.reason ?? "Structural shelf change needs a choice.",
                        path: file,
                        pathFingerprint: await pathFingerprint(path.join(this.intent.root, file)),
                    };
                }),
            );
            return this.result("conflicted");
        });
    }

    /** Publishes ownership once, then the exact shelf receipt, then terminal metadata with pending retained. */
    private async complete(): Promise<TargetShelfMutationResult> {
        let pending = this.state().pendingTargetOperation!;
        if (pending.phase === "conflicted") return this.conflict(pending);
        if (pending.phase === "reviewRequired") return this.result("appliedNeedsReview");
        const evidence = await this.persistence.loadTargetOperationEvidence(pending.evidenceHash);
        const applied = evidence.entries.filter((entry) => entry.outcome === "applied");
        if (
            pending.phase === "gitApplied" &&
            applied.length &&
            applied.length !== evidence.entries.length
        )
            return this.result("appliedNeedsReview");
        if (pending.phase === "gitApplied" && applied.length) {
            await this.deps.store.withLock(async () =>
                this.deps.changelists.publishTargetOwnership(this.lease, await this.observation()),
            );
            pending = this.state().pendingTargetOperation!;
        }
        if (pending.phase === "ownershipPublished" && pending.shelf?.removeFromShelf) {
            await this.deps.changelists.publishTargetShelf(
                this.lease,
                await this.observation(),
                this.deps.store,
            );
            pending = this.state().pendingTargetOperation!;
        }
        if (pending.phase === "reviewRequired") return this.result("appliedNeedsReview");
        await this.deps.changelists.finishTargetOperation(
            this.lease,
            await this.observation(),
            this.deps.store,
        );
        const state = this.state();
        return this.result(
            state.pendingTargetOperation
                ? "appliedNeedsReview"
                : state.targetOperationReceipts![this.intent.id].outcome === "applied"
                  ? "applied"
                  : "notApplied",
        );
    }
}

/** Structural review is a conflict checkpoint even when Git left the local path untouched. */
function outcome(result: PerEntryResult): "applied" | "conflicted" | "retained" | "refused" {
    if (result.kind === "applied" || result.kind === "flattenedResidue") return "applied";
    if (result.kind === "conflicted" || result.kind === "structuralPending") return "conflicted";
    return result.kind;
}

/** Recovery exposes durable entry identities without attempting the source entry again. */
function evidenceResults(evidence: TargetOperationEvidence): PerEntryResult[] {
    return evidence.entries.map((entry) =>
        entry.outcome === "applied" || entry.outcome === "conflicted"
            ? { kind: entry.outcome, changeId: entry.changeId }
            : {
                  kind: entry.outcome === "refused" ? "refused" : "retained",
                  changeId: entry.changeId,
                  reason: entry.reason ?? "Target operation requires review.",
              },
    );
}

/** External changes to affected Git state stop mutation even while extension locks remain held. */
function assertSameObservation(
    saved: TargetOperationEvidence,
    observed: TargetOperationEvidence,
): void {
    if (
        saved.head !== observed.head ||
        saved.indexFingerprint !== observed.indexFingerprint ||
        !isDeepStrictEqual(saved.paths, observed.paths) ||
        !isDeepStrictEqual(saved.index, observed.index) ||
        !isDeepStrictEqual(saved.native, observed.native)
    )
        throw new Error("Target restore state changed before its checkpoint.");
}
