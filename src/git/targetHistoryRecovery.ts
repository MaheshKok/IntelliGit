import type { ChangelistPersistence } from "../changes/changelistPersistence";
import type { ChangelistStore, TargetOperationLease } from "../changes/changelistStore";
import type {
    TargetOperationExpectedState,
    TargetOperationEvidence,
} from "../changes/targetOperation";
import { isUtf8 } from "node:buffer";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { reconcileRanges } from "../changes/rangeMapping";
import type { TargetOperationAttribution } from "../changes/rangeMetadata";
import { MAX_PARTIAL_TEXT_BYTES } from "./partialSnapshot";
import type { GitExecutor } from "./executor";
import {
    abortTargetNativeOperation,
    captureTargetNativeEvidence,
    gitCleanWholeFiles,
    trustsExecutableBit,
} from "./targetOperationRecovery";
import {
    historyTextSnapshot,
    quitCompletedHistory,
    type TargetHistoryResult,
} from "./targetHistoryOperation";

/** Host-only review identity binds explicit completion/discard consent to exact observed bytes. */
export interface TargetHistoryReview extends TargetOperationExpectedState {
    readonly action: "continue" | "abort";
    readonly recordedEvidenceHash: string;
    readonly observedEvidenceHash: string;
    readonly paths: readonly string[];
}

/** Read authoritative pending metadata before any native operation classification. */
export async function captureTargetHistoryReview(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    action: "continue" | "abort",
): Promise<TargetHistoryReview | undefined> {
    const lease = await store.acquireTargetOperationLease(persistence.root);
    try {
        const state = store.inspectTargetOperationLease(persistence.root, lease);
        const pending = state.pendingTargetOperation;
        if (!pending) return undefined;
        if (!["cherryPick", "revert"].includes(pending.kind))
            throw new Error("The pending target operation requires its own recovery workflow.");
        const git = executor.deriveFor(persistence.root);
        return await git.runWithinMutationGate(async () => {
            const saved = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
            const paths = saved.paths.map((entry) => entry.path);
            const observed = await captureTargetNativeEvidence(git, persistence, pending.id, paths);
            return {
                action,
                id: pending.id,
                revision: state.revision,
                expectedPhase: pending.phase,
                recordedEvidenceHash: pending.evidenceHash,
                observedEvidenceHash: await persistence.storeTargetOperationEvidence(observed),
                paths,
            };
        });
    } finally {
        await lease.release();
    }
}

/** Continue only the user's reviewed targeted resolution; never invoke native continue. */
export async function continueReviewedTargetHistoryOperation(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    review: TargetHistoryReview,
): Promise<TargetHistoryResult> {
    let lease: TargetOperationLease | undefined;
    let result: TargetHistoryResult;
    const git = executor.deriveFor(persistence.root);
    try {
        lease = await store.acquireTargetOperationLease(persistence.root);
        result = await git.runWithinMutationGate(async (run) => {
            if (review.action !== "continue")
                throw new Error("Completion requires its own review decision.");
            const trustExecutableBit = await trustsExecutableBit(git);
            let state = readReviewedOperation(store, persistence, lease!, review);
            let pending = state.pendingTargetOperation!;
            const chain = await persistence.loadTargetOperationEvidenceChain(pending.evidenceHash);
            let saved = chain.evidence;
            const actual = await reviewedCurrent(git, persistence, review);
            if (
                actual.head !== pending.headBefore ||
                (await git.run(["ls-files", "-u", "-z"])).length
            )
                throw new Error(
                    "Resolve all index conflicts without changing HEAD before continuing.",
                );
            if (pending.phase === "conflicted") {
                if (!isDeepStrictEqual(saved.native, actual.native))
                    throw new Error("Native state changed since the recorded conflict.");
                const attribution = await resolvedAttribution(
                    git,
                    persistence,
                    store,
                    lease!,
                    chain.root.evidence,
                    actual,
                    trustExecutableBit,
                );
                saved = {
                    ...actual,
                    checkpoint: "after",
                    previousEvidenceHash: pending.evidenceHash,
                    entries: saved.entries.map((entry) => ({
                        ...entry,
                        outcome: "applied" as const,
                    })),
                    attribution,
                };
                const evidenceHash = await persistence.storeTargetOperationEvidence(saved);
                state = await store.checkpointTargetOperation(lease!, {
                    id: pending.id,
                    revision: state.revision,
                    expectedPhase: "conflicted",
                    phase: "gitApplied",
                    evidenceHash,
                });
                pending = state.pendingTargetOperation!;
            }
            if (pending.phase !== "gitApplied" && pending.phase !== "ownershipPublished")
                throw new Error("This history checkpoint requires separate recovery review.");
            const observed = await captureTargetNativeEvidence(
                git,
                persistence,
                pending.id,
                review.paths,
            );
            if (!sameHistoryBytes(saved, observed))
                throw new Error("Accepted history content changed after review.");
            if (!isDeepStrictEqual(saved.native, observed.native)) {
                if (
                    !saved.native.some((entry) => entry.present) ||
                    observed.native.some((entry) => entry.present)
                )
                    throw new Error("Unexpected native state during completion recovery.");
                // Quit already happened before a crash. Only acknowledge its exact native-absent result.
            } else if (observed.native.some((entry) => entry.present)) {
                await quitCompletedHistory(
                    git,
                    persistence,
                    {
                        id: pending.id,
                        kind: pending.kind as "cherryPick" | "revert",
                        commit: pending.commit!,
                    },
                    observed,
                    run,
                );
            }
            const cleaned = await captureTargetNativeEvidence(
                git,
                persistence,
                pending.id,
                review.paths,
            );
            if (!sameHistoryBytes(saved, cleaned) || cleaned.native.some((entry) => entry.present))
                throw new Error("Native cleanup changed the accepted resolution.");
            if (!isDeepStrictEqual(saved.native, cleaned.native)) {
                saved = {
                    ...saved,
                    native: cleaned.native,
                    previousEvidenceHash: pending.evidenceHash,
                };
                const evidenceHash = await persistence.storeTargetOperationEvidence(saved);
                state = await store.checkpointTargetNativeCompletionCleanup(lease!, {
                    id: pending.id,
                    revision: state.revision,
                    expectedPhase: "gitApplied",
                    evidenceHash,
                });
                pending = state.pendingTargetOperation!;
            }
            const observe = async () =>
                persistence.storeTargetOperationEvidence({
                    ...(await captureTargetNativeEvidence(
                        git,
                        persistence,
                        pending.id,
                        review.paths,
                    )),
                    checkpoint: "after" as const,
                    entries: saved.entries,
                });
            if (pending.phase === "gitApplied") {
                state = await store.publishTargetOwnership(lease!, {
                    id: pending.id,
                    revision: state.revision,
                    expectedPhase: "gitApplied",
                    observedEvidenceHash: await observe(),
                    trustExecutableBit,
                    // Re-derived under today's attributes, so a resumed operation whose commit
                    // changed .gitattributes can land in review instead of owning the file.
                    gitCleanPaths: await gitCleanWholeFiles(git, persistence, chain.root.evidence),
                });
                pending = state.pendingTargetOperation!;
            }
            if (pending.phase !== "ownershipPublished")
                return { id: pending.id, outcome: "appliedNeedsReview" };
            state = await store.finishTargetOperation(lease!, {
                id: pending.id,
                revision: state.revision,
                expectedPhase: "ownershipPublished",
                observedEvidenceHash: await observe(),
            });
            return {
                id: pending.id,
                outcome: state.pendingTargetOperation ? "appliedNeedsReview" : "applied",
            };
        });
    } catch (error) {
        result = {
            id: review.id,
            outcome: "appliedNeedsReview",
            reason: error instanceof Error ? error.message : "History completion requires review.",
        };
    }
    try {
        await lease?.release();
    } catch (error) {
        return { id: review.id, outcome: "appliedNeedsReview", reason: String(error) };
    }
    return result;
}

/** Abort only the reviewed targeted paths through the accepted affected-path restore engine. */
export async function abortReviewedTargetHistoryOperation(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    review: TargetHistoryReview,
): Promise<TargetHistoryResult> {
    let lease: TargetOperationLease | undefined;
    let result: TargetHistoryResult;
    const git = executor.deriveFor(persistence.root);
    try {
        lease = await store.acquireTargetOperationLease(persistence.root);
        const expected = await git.runWithinMutationGate(async () => {
            if (review.action !== "abort")
                throw new Error("Discard requires its own review decision.");
            let state = readReviewedOperation(store, persistence, lease!, review);
            let pending = state.pendingTargetOperation!;
            if (pending.completion || pending.phase === "gitApplied")
                throw new Error("Completion was selected; only metadata recovery remains.");
            const saved = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
            const observed = await reviewedCurrent(git, persistence, review);
            if (
                observed.head !== pending.headBefore ||
                !isDeepStrictEqual(saved.native, observed.native)
            )
                throw new Error("History identity or native state changed before discard.");
            if (!sameHistoryBytes(saved, observed) && !pending.phase.startsWith("abort")) {
                if (pending.phase !== "prepared" && pending.phase !== "conflicted")
                    throw new Error("Changed affected content requires a new recovery decision.");
                const evidenceHash = await persistence.storeTargetOperationEvidence({
                    ...observed,
                    checkpoint: "after",
                    previousEvidenceHash: pending.evidenceHash,
                    entries: saved.entries,
                });
                state = await store.checkpointTargetOperation(lease!, {
                    id: pending.id,
                    revision: state.revision,
                    expectedPhase: pending.phase,
                    phase: pending.phase,
                    evidenceHash,
                });
                pending = state.pendingTargetOperation!;
            }
            return { id: pending.id, revision: state.revision, expectedPhase: pending.phase };
        });
        // The engine reacquires the repository gate and rechecks the exact checkpoint before every restore.
        await abortTargetNativeOperation(git, persistence, store, lease, expected);
        result = { id: review.id, outcome: "notApplied" };
    } catch (error) {
        result = {
            id: review.id,
            outcome: "appliedNeedsReview",
            reason: error instanceof Error ? error.message : "History abort requires review.",
        };
    }
    try {
        await lease?.release();
    } catch (error) {
        return { id: review.id, outcome: "appliedNeedsReview", reason: String(error) };
    }
    return result;
}

/** Require the same authoritative record that was displayed before the confirmation prompt. */
function readReviewedOperation(
    store: ChangelistStore,
    persistence: ChangelistPersistence,
    lease: TargetOperationLease,
    review: TargetHistoryReview,
) {
    const state = store.inspectTargetOperationLease(persistence.root, lease);
    const pending = state.pendingTargetOperation;
    if (
        !pending ||
        pending.id !== review.id ||
        state.revision !== review.revision ||
        pending.phase !== review.expectedPhase ||
        pending.evidenceHash !== review.recordedEvidenceHash ||
        !["cherryPick", "revert"].includes(pending.kind)
    )
        throw new Error("The targeted history review is stale.");
    return state;
}

/** Recheck the exact preview bytes and reject foreign rebase state before any native mutation. */
async function reviewedCurrent(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    review: TargetHistoryReview,
) {
    for (const directory of ["rebase-merge", "rebase-apply"]) {
        const exists = await lstat(path.join(persistence.gitDir, directory)).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false;
                throw error;
            },
        );
        if (exists) throw new Error("A foreign rebase prevents targeted history recovery.");
    }
    const reviewed = await persistence.loadTargetOperationEvidence(review.observedEvidenceHash);
    const actual = await captureTargetNativeEvidence(git, persistence, review.id, review.paths);
    // Abort owns only the captured paths. Its candidate index starts from the latest unrelated entries.
    const compared =
        review.action === "abort"
            ? { ...actual, indexFingerprint: reviewed.indexFingerprint }
            : actual;
    if (!sameHistoryBytes(reviewed, compared) || !isDeepStrictEqual(reviewed.native, actual.native))
        throw new Error("Affected history state changed after the review.");
    return actual;
}

/** Native marker cleanup may differ; every Git byte and affected path identity must remain exact. */
function sameHistoryBytes(left: TargetOperationEvidence, right: TargetOperationEvidence): boolean {
    return (
        left.operationId === right.operationId &&
        left.head === right.head &&
        left.indexFingerprint === right.indexFingerprint &&
        isDeepStrictEqual(left.index, right.index) &&
        isDeepStrictEqual(left.paths, right.paths)
    );
}

/** Reconstruct text ownership evidence from durable before bytes and the user's accepted resolution. */
async function resolvedAttribution(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    lease: TargetOperationLease,
    before: TargetOperationEvidence,
    after: TargetOperationEvidence,
    trustExecutableBit: boolean,
) {
    const paths = before.paths.map((entry) => entry.path);
    const state = store.inspectTargetOperationLease(persistence.root, lease);
    const owners = await store.readTargetOperationOwnership(persistence.root, lease, paths);
    const attribution = [];
    for (const [index, file] of paths.entries()) {
        const tree = await git.run([
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            before.head,
            "--",
            file,
        ]);
        const entry = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
        if (!entry || entry[3] !== file)
            throw new Error("This structural resolution requires separate ownership review.");
        const baseResult = await git.runBinary(["cat-file", "blob", entry[2]], {
            maxOutputBytes: MAX_PARTIAL_TEXT_BYTES + 1,
        });
        if (baseResult.truncated) throw new Error("History base exceeds supported text bounds.");
        const base = historyText(baseResult.stdout);
        const old = await evidenceText(persistence, before, file, entry[1], trustExecutableBit);
        const working = await evidenceText(persistence, after, file, entry[1], trustExecutableBit);
        const beforeSnapshot = await historyTextSnapshot(git, before, file, base, old);
        const afterSnapshot = await historyTextSnapshot(git, after, file, base, working);
        const fallback = state.files[file] ?? state.activeId;
        const payload: TargetOperationAttribution = {
            version: 1,
            root: persistence.root,
            gitDir: persistence.gitDir,
            operationId: before.operationId,
            path: file,
            priorFileOwner: fallback,
            previous:
                owners[file] ?? reconcileRanges(undefined, beforeSnapshot, fallback, fallback),
            before: beforeSnapshot,
            after: afterSnapshot,
            operation: await historyTextSnapshot(git, after, file, old, working),
        };
        const bytes = Buffer.from(JSON.stringify(payload));
        attribution.push({
            path: file,
            changeIds: [String(index)],
            object: {
                hash: await persistence.storeTargetOperationObject(bytes),
                size: bytes.length,
            },
        });
    }
    return attribution;
}

/** Text recovery does not reinterpret symlinks, mode changes, sparse entries, or special index flags. */
async function evidenceText(
    persistence: ChangelistPersistence,
    evidence: TargetOperationEvidence,
    file: string,
    mode: string,
    trustExecutableBit: boolean,
): Promise<string> {
    const state = evidence.paths.find((entry) => entry.path === file)?.state;
    const entries = evidence.index.filter((entry) => entry.path === file);
    if (
        state?.kind !== "regular" ||
        (trustExecutableBit && state.executable !== (mode === "100755")) ||
        entries.length !== 1 ||
        entries[0].stage !== 0 ||
        entries[0].mode !== mode ||
        entries[0].assumeUnchanged ||
        entries[0].skipWorktree ||
        entries[0].intentToAdd
    )
        throw new Error("History resolution needs supported regular text evidence.");
    return historyText(await persistence.loadTargetOperationObject(state.content));
}

/** Preserve raw UTF-8 bytes and newline conventions within the established partial-text limit. */
function historyText(bytes: Buffer): string {
    if (bytes.length > MAX_PARTIAL_TEXT_BYTES || bytes.includes(0) || !isUtf8(bytes))
        throw new Error("History resolution exceeds supported text evidence.");
    return bytes.toString("utf8");
}
