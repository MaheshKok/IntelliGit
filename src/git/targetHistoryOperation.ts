import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChangelistPersistence } from "../changes/changelistPersistence";
import {
    targetPathUnowned,
    type ChangelistStore,
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
    TargetIndexEntry,
    TargetOperationEvidence,
    TargetWholeFileBefore,
} from "../changes/targetOperation";
import type { ChangelistState } from "../webviews/protocol/changeSelection";
import type { ChangelistTarget } from "../webviews/protocol/changelists";
import type { ShelfDraftChoice } from "../webviews/protocol/targetOperation";
import type { GitExecutor } from "./executor";
import {
    PartialChangesUnsupportedError,
    readPartialSnapshot,
    type PartialFileSnapshot,
} from "./partialSnapshot";
import { RepositoryLockBusyError } from "./repositoryLock";
import {
    captureTargetNativeEvidence,
    gitCleanWholeFiles,
    trustsExecutableBit,
} from "./targetOperationRecovery";

/**
 * Captured history intent belongs to one immutable commit, HEAD and target revision. For
 * `undoCommit`, `commit` is the oldest undone commit; HEAD moves to its only parent.
 */
export interface TargetHistoryRequest {
    readonly id: string;
    readonly kind: "cherryPick" | "revert" | "undoCommit";
    readonly commit: string;
    readonly head: string;
    readonly target: ChangelistTarget;
    readonly mainline?: number;
    /** Explicit copy consent, guarded by the destination draft captured with the prompt. */
    readonly draftChoice?: ShelfDraftChoice;
    readonly sourceDraft?: string;
}

/** Post-mutation failures retain an operation identity rather than promising a retry. */
export interface TargetHistoryResult {
    readonly id: string;
    readonly outcome:
        "notApplied" | "applied" | "appliedNeedsReview" | "conflicted" | "stale" | "busy";
    readonly reason?: string;
}

/**
 * Applies one explicit history intent under metadata then repository locks. Prepared identity
 * precedes Git; persisted after evidence precedes attribution, and known IDs never execute again.
 */
export async function applyTargetHistoryOperation(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    request: TargetHistoryRequest,
): Promise<TargetHistoryResult> {
    const intent = structuredClone(request);
    const git = executor.deriveFor(persistence.root);
    let lease: TargetOperationLease | undefined;
    let prepared = false;
    let attempted = false;
    let result: TargetHistoryResult;
    try {
        lease = await store.acquireTargetOperationLease(persistence.root);
        result = await git.runWithinMutationGate(async (run) => {
            const state = store.inspectTargetOperationLease(persistence.root, lease!);
            const known = knownHistoryRequest(state, intent);
            if (known) return known;
            const { paths, whole, parent } = await admittedPaths(git, intent);
            if (!paths.length) throw new Error("The selected commit contains no changes.");
            const snapshots = await readHistorySnapshots(git, persistence.root, paths, whole);
            const owners = await store.readTargetOperationOwnership(
                persistence.root,
                lease!,
                paths,
            );
            const captured = await captureTargetNativeEvidence(git, persistence, intent.id, paths);
            snapshots.forEach((snapshot, file) => assertSnapshotEvidence(snapshot, captured, file));
            if (captured.head !== intent.head || captured.native.some((entry) => entry.present))
                return { id: intent.id, outcome: "stale" };
            const wholeFileBefore: TargetWholeFileBefore[] = [];
            for (const file of paths.filter((candidate) => whole.has(candidate)))
                wholeFileBefore.push(await wholeBefore(git, persistence, state, file, intent.head));
            const trustExecutableBit = await trustsExecutableBit(git);
            const gitCleanPaths = await gitCleanWholeFiles(git, persistence, {
                paths: captured.paths,
                wholeFileBefore,
            });
            assertAdmitted(
                captured,
                [...snapshots.keys()],
                wholeFileBefore,
                trustExecutableBit,
                gitCleanPaths,
            );
            const before: TargetOperationEvidence = {
                ...captured,
                ...(wholeFileBefore.length ? { wholeFileBefore } : {}),
                entries: paths.map((file, index) => ({
                    changeId: String(index),
                    path: file,
                    outcome: "pending",
                })),
            };
            const beforeHash = await persistence.storeTargetOperationEvidence(before);
            const preparation = await store.prepareTargetOperation(lease!, {
                id: intent.id,
                kind: intent.kind,
                target: intent.target,
                headBefore: intent.head,
                evidenceHash: beforeHash,
                commit: intent.commit,
                ...(intent.draftChoice ? { draftChoice: intent.draftChoice } : {}),
                ...(intent.sourceDraft !== undefined ? { sourceDraft: intent.sourceDraft } : {}),
            });
            if (preparation.status !== "prepared")
                return { id: intent.id, outcome: "appliedNeedsReview" };
            prepared = true;
            // Evidence publication performs I/O; external writers are not protected by our lease.
            // Another process moved HEAD before Undo's own move, which Git refuses: nothing applied.
            const closeStale = async (
                observed: TargetOperationEvidence,
            ): Promise<TargetHistoryResult> => {
                const current = await store.closeStaleTargetOperation(lease!, {
                    id: intent.id,
                    revision: store.inspectTargetOperationLease(persistence.root, lease!).revision,
                    expectedPhase: "prepared",
                    observedEvidenceHash: await persistence.storeTargetOperationEvidence(observed),
                });
                return {
                    id: intent.id,
                    outcome: current.pendingTargetOperation ? "appliedNeedsReview" : "stale",
                };
            };
            attempted = true;
            const expectedHead = intent.kind === "undoCommit" ? parent : intent.head;
            const native = await observeNative(
                git,
                persistence,
                run,
                intent,
                parent,
                paths,
                before,
            );
            const { nativeError } = native;
            let actual = native.actual;
            if (nativeError === false) return await closeStale(actual);
            if (sameObservation(before, actual)) {
                const observedEvidenceHash = await persistence.storeTargetOperationEvidence(actual);
                const current = store.inspectTargetOperationLease(persistence.root, lease!);
                await store.finishTargetOperation(lease!, {
                    id: intent.id,
                    revision: current.revision,
                    expectedPhase: "prepared",
                    observedEvidenceHash,
                });
                return {
                    id: intent.id,
                    outcome: "notApplied",
                    ...(nativeError ? { reason: String(nativeError) } : {}),
                };
            }
            const unmerged = new Set(
                actual.index.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
            );
            let after: TargetOperationEvidence = {
                ...actual,
                checkpoint: "after",
                previousEvidenceHash: beforeHash,
                entries: before.entries.map((entry) => ({
                    ...entry,
                    outcome: unmerged.has(entry.path!) ? "conflicted" : "applied",
                })),
            };
            // Native result is durable even if later snapshot construction or metadata publication fails.
            let afterHash = await persistence.storeTargetOperationEvidence(after);
            let current = store.inspectTargetOperationLease(persistence.root, lease!);
            const phase = unmerged.size ? "conflicted" : "prepared";
            current = await store.checkpointTargetOperation(lease!, {
                id: intent.id,
                revision: current.revision,
                expectedPhase: "prepared",
                phase,
                evidenceHash: afterHash,
            });
            if (unmerged.size) return { id: intent.id, outcome: "conflicted" };
            if (nativeError || actual.head !== expectedHead) {
                await store.markTargetOperationReview(lease!, {
                    id: intent.id,
                    revision: current.revision,
                    expectedPhase: phase,
                });
                return {
                    id: intent.id,
                    outcome: "appliedNeedsReview",
                    reason: nativeError ?? "HEAD changed during history apply.",
                };
            }
            const cleared =
                intent.kind === "undoCommit"
                    ? actual
                    : await quitCompletedHistory(
                          git,
                          persistence,
                          { ...intent, kind: intent.kind },
                          actual,
                          run,
                      );
            if (cleared !== actual) {
                actual = cleared;
                after = {
                    ...after,
                    ...cleared,
                    checkpoint: "after",
                    previousEvidenceHash: afterHash,
                    entries: after.entries,
                };
                afterHash = await persistence.storeTargetOperationEvidence(after);
                current = await store.checkpointTargetOperation(lease!, {
                    id: intent.id,
                    revision: current.revision,
                    expectedPhase: "prepared",
                    phase: "prepared",
                    evidenceHash: afterHash,
                });
            }
            const { attribution, wholeFileAttribution } = await historyAttribution(
                git,
                persistence,
                intent.id,
                snapshots,
                owners,
                state,
                actual,
            );
            after = {
                ...after,
                previousEvidenceHash: afterHash,
                attribution,
                ...(wholeFileAttribution.length ? { wholeFileAttribution } : {}),
            };
            afterHash = await persistence.storeTargetOperationEvidence(after);
            current = await store.checkpointTargetOperation(lease!, {
                id: intent.id,
                revision: current.revision,
                expectedPhase: "prepared",
                phase: "gitApplied",
                evidenceHash: afterHash,
            });
            const observe = async () =>
                persistence.storeTargetOperationEvidence({
                    ...(await captureTargetNativeEvidence(git, persistence, intent.id, paths)),
                    checkpoint: "after" as const,
                    entries: after.entries,
                });
            current = await store.publishTargetOwnership(lease!, {
                id: intent.id,
                revision: current.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash: await observe(),
                trustExecutableBit,
                gitCleanPaths,
            });
            if (current.pendingTargetOperation?.phase !== "ownershipPublished")
                return { id: intent.id, outcome: "appliedNeedsReview" };
            current = await store.finishTargetOperation(lease!, {
                id: intent.id,
                revision: current.revision,
                expectedPhase: "ownershipPublished",
                observedEvidenceHash: await observe(),
            });
            return {
                id: intent.id,
                outcome: current.pendingTargetOperation ? "appliedNeedsReview" : "applied",
            };
        });
    } catch (error) {
        result = {
            id: intent.id,
            outcome:
                attempted || prepared
                    ? "appliedNeedsReview"
                    : error instanceof RepositoryLockBusyError
                      ? "busy"
                      : "notApplied",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    try {
        await lease?.release();
    } catch (error) {
        return {
            id: intent.id,
            outcome: attempted || prepared ? "appliedNeedsReview" : "busy",
            reason: String(error),
        };
    }
    return result;
}

/** Why the targeted rules refuse one whole-file path. */
interface WholeFileRefusal {
    readonly path: string;
    readonly reason: "owned" | "localChanges";
}

/**
 * Undo Commit's route, decided before any destination prompt. `plainReset` means the targeted
 * rules refuse `path`, or the undo has no net change, so the previous release's soft reset has
 * already run instead.
 */
export type UndoCommitPreflight =
    | { readonly route: "targeted" | "busy" }
    | ({ readonly route: "plainReset" } & WholeFileRefusal)
    | { readonly route: "plainReset"; readonly reason: "noChanges" };

/**
 * Under the metadata lease and mutation gate, apply the targeted admission rules to the undone
 * paths. A pending target operation or held lease is `busy`. When the rules refuse a path for its
 * owner or local changes, or no path changes at all, the plain soft reset runs under the same
 * lease, and only while HEAD is still the captured one. Anything else, including a HEAD that
 * another Git process moved meanwhile, is left to the targeted path's own checks.
 */
export async function preflightUndoCommit(
    executor: GitExecutor,
    persistence: ChangelistPersistence,
    store: ChangelistStore,
    request: Pick<TargetHistoryRequest, "commit" | "head">,
): Promise<UndoCommitPreflight> {
    const git = executor.deriveFor(persistence.root);
    let lease: TargetOperationLease | undefined;
    try {
        lease = await store.acquireTargetOperationLease(persistence.root);
        return await git.runWithinMutationGate(async (): Promise<UndoCommitPreflight> => {
            const state = store.inspectTargetOperationLease(persistence.root, lease!);
            if (state.pendingTargetOperation) return { route: "busy" };
            const { paths, parent } = await admittedPaths(git, { ...request, kind: "undoCommit" });
            const captured = await captureTargetNativeEvidence(
                git,
                persistence,
                randomUUID(),
                paths,
            );
            if (captured.head !== request.head || captured.native.some((entry) => entry.present))
                return { route: "targeted" };
            const whole: TargetWholeFileBefore[] = [];
            for (const file of paths)
                whole.push(await wholeBefore(git, persistence, state, file, request.head));
            const refusal = paths.length
                ? wholeFileRefusal(
                      captured,
                      whole,
                      await trustsExecutableBit(git),
                      await gitCleanWholeFiles(git, persistence, {
                          paths: captured.paths,
                          wholeFileBefore: whole,
                      }),
                  )
                : { reason: "noChanges" as const };
            if (!refusal || !(await softResetFrom(git, persistence.gitDir, request.head, parent)))
                return { route: "targeted" };
            return { route: "plainReset", ...refusal };
        });
    } catch (error) {
        if (error instanceof RepositoryLockBusyError) return { route: "busy" };
        throw error;
    } finally {
        // A release failure must not replace the undo's outcome or its error.
        await lease
            ?.release()
            .catch((error: unknown) =>
                console.error("[IntelliGit] Undo Commit lease release failed:", error),
            );
    }
}

/**
 * `reset --soft` to `parent` that moves HEAD only while it still names `head`, so a commit another
 * Git process made after HEAD was read is never dropped from the branch. False means Git finished
 * and refused because another process moved HEAD somewhere other than `parent`.
 */
async function softResetFrom(
    git: GitExecutor,
    gitDir: string,
    head: string,
    parent: string,
): Promise<boolean> {
    // reset --soft refuses on unmerged stages or MERGE_HEAD, read just before the move as Git does.
    const unmerged = (await git.run(["ls-files", "-u", "-z"])).length > 0;
    const merging = await access(path.join(gitDir, "MERGE_HEAD")).then(
        () => true,
        () => false,
    );
    if (unmerged || merging) throw new Error("Cannot do a soft reset in the middle of a merge.");
    // One transaction, so ORIG_HEAD changes only together with HEAD. Only a Git that finished with
    // 128 can have refused; a killed or failed run may have moved HEAD, so its error propagates.
    const { exitCode, stderr } = await git.runBinary(
        ["update-ref", "-m", `reset: moving to ${parent}`, "--stdin"],
        {
            input: Buffer.from(`update HEAD ${parent} ${head}\nupdate ORIG_HEAD ${head}\n`),
            expectedExitCodes: [0, 128],
        },
    );
    if (exitCode === 0) return true;
    const current = (await git.run(["rev-parse", "--verify", "HEAD"]).catch(() => head)).trim();
    // HEAD at the parent may be this move, committed before the transaction failed: not a refusal.
    if (current !== head && current !== parent) return false;
    throw new Error(
        `git update-ref -m exited with 128: ${stderr.toString("utf8").trim() || "(no stderr)"}`,
    );
}

/**
 * Runs the one native mutation between two evidence reads. False means Undo never moved HEAD:
 * another process moved it after Undo captured it, which Git refuses before or during the move.
 */
async function observeNative(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    run: (args: string[]) => Promise<string>,
    intent: TargetHistoryRequest,
    parent: string,
    paths: readonly string[],
    before: TargetOperationEvidence,
): Promise<{ nativeError: string | undefined | false; actual: TargetOperationEvidence }> {
    const immediate = await captureTargetNativeEvidence(git, persistence, intent.id, paths);
    if (intent.kind === "undoCommit" && immediate.head !== before.head)
        return { nativeError: false, actual: immediate };
    assertSameObservation(before, immediate);
    const nativeError = await runHistoryCommand(git, persistence.gitDir, run, intent, parent);
    return {
        nativeError,
        actual: await captureTargetNativeEvidence(git, persistence, intent.id, paths),
    };
}

/**
 * Runs the one native mutation; a failure message is returned so evidence decides what changed.
 * False means Undo's HEAD move was refused because HEAD no longer names the captured commit.
 */
async function runHistoryCommand(
    git: GitExecutor,
    gitDir: string,
    run: (args: string[]) => Promise<string>,
    intent: TargetHistoryRequest,
    parent: string,
): Promise<string | undefined | false> {
    const mainline = intent.mainline === undefined ? [] : ["--mainline", String(intent.mainline)];
    try {
        if (intent.kind === "undoCommit")
            return (await softResetFrom(git, gitDir, intent.head, parent)) ? undefined : false;
        await run([
            intent.kind === "cherryPick" ? "cherry-pick" : "revert",
            "--no-commit",
            ...mainline,
            intent.commit,
        ]);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : "Native history apply failed.";
    }
}

/** Text snapshots for same-mode modifications; unsupported or missing text moves to whole-file. */
async function readHistorySnapshots(
    git: GitExecutor,
    root: string,
    paths: readonly string[],
    whole: Set<string>,
): Promise<Map<string, PartialFileSnapshot>> {
    // Git refuses (and still rewrites raw index stat data) over unstaged affected edits.
    const unstaged = await unstagedPaths(git);
    const dirty = paths.find((file) => !whole.has(file) && unstaged.has(file));
    if (dirty !== undefined)
        throw new Error(
            `"${dirty}" has unstaged changes. Stage or discard them before applying this history action.`,
        );
    const snapshots = new Map<string, PartialFileSnapshot>();
    for (const file of paths.filter((candidate) => !whole.has(candidate))) {
        try {
            snapshots.set(file, await readPartialSnapshot(git, root, file, "working"));
        } catch (error) {
            if (
                !(error instanceof PartialChangesUnsupportedError) &&
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            )
                throw error;
            whole.add(file);
        }
    }
    return snapshots;
}

/**
 * Resolve exact immutable commit parents and include both endpoints by disabling rename folding.
 * Only same-mode regular modifications are text; adds, deletes, symlinks, mode changes and every
 * undo path are whole-file. Undo spans the selected commit's parent through the captured HEAD.
 */
async function admittedPaths(
    git: GitExecutor,
    request: Pick<TargetHistoryRequest, "kind" | "commit" | "head" | "mainline">,
): Promise<{ paths: string[]; whole: Set<string>; parent: string }> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.commit))
        throw new Error("History commit must be an exact object ID.");
    const record = (await git.run(["rev-list", "--parents", "-n", "1", request.commit]))
        .trim()
        .split(" ");
    if (record[0] !== request.commit || record.length < 2)
        throw new Error("History action requires a commit parent.");
    if (request.kind === "undoCommit" && (record.length !== 2 || request.mainline !== undefined))
        throw new Error("Undo to a changelist requires a single-parent commit.");
    if (
        record.length > 2
            ? !Number.isSafeInteger(request.mainline) ||
              request.mainline! < 1 ||
              request.mainline! >= record.length
            : request.mainline !== undefined
    )
        throw new Error("History mainline choice does not match the selected commit.");
    const parent = record[request.mainline ?? 1];
    if (request.kind === "undoCommit") {
        const ancestor = await git.runBinary(
            ["merge-base", "--is-ancestor", request.commit, request.head],
            { expectedExitCodes: [0, 1] },
        );
        if (ancestor.exitCode !== 0)
            throw new Error("The selected commit is not in the current branch history.");
    }
    const result = await git.runBinary([
        "diff-tree",
        "--raw",
        "--no-renames",
        "-r",
        "-z",
        parent,
        request.kind === "undoCommit" ? request.head : request.commit,
    ]);
    if (result.truncated) throw new Error("History affected paths were truncated.");
    return { ...historyPathRecords(result.stdout.toString("utf8"), request.kind), parent };
}

/** Parse `diff-tree --raw -z`; submodules are refused and every non-text change is whole-file. */
function historyPathRecords(
    raw: string,
    kind: TargetHistoryRequest["kind"],
): { paths: string[]; whole: Set<string> } {
    const fields = raw.split("\0");
    const whole = new Set<string>();
    const paths = new Set<string>();
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const meta = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(fields[index]);
        const file = fields[index + 1];
        if (!meta || !file) throw new Error("Unexpected history affected path record.");
        if (meta[1] === "160000" || meta[2] === "160000")
            throw new Error(
                `"${file}" is a submodule, which history actions to a changelist do not support.`,
            );
        paths.add(file);
        if (kind === "undoCommit" || meta[3] !== "M" || meta[1] !== meta[2] || meta[1] === "120000")
            whole.add(file);
    }
    return { paths: [...paths].sort(), whole };
}

/** Paths whose working tree differs from the index, as Git itself reports them through filters. */
async function unstagedPaths(git: GitExecutor): Promise<Set<string>> {
    const result = await git.runBinary([
        "diff",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "-z",
    ]);
    if (result.truncated) throw new Error("Unstaged path listing was truncated.");
    return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
}

/** Reads HEAD independently; clean-looking absence never authorizes structural ownership. */
async function wholeBefore(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    state: ChangelistState,
    file: string,
    head: string,
): Promise<TargetWholeFileBefore> {
    const unowned = targetPathUnowned(state, file);
    const tree = await git.run(["--literal-pathspecs", "ls-tree", "-z", head, "--", file]);
    if (!tree) return { path: file, unowned, head: { kind: "absent" } };
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
    if (!match || match[3] !== file) throw new Error(`"${file}" has an unsupported HEAD entry.`);
    const bytes = (await git.runBinary(["cat-file", "blob", match[2]])).stdout;
    return {
        path: file,
        unowned,
        head: {
            kind: "present",
            mode: match[1] as "100644",
            oid: match[2],
            object: {
                hash: await persistence.storeTargetOperationObject(bytes),
                size: bytes.length,
            },
        },
    };
}

/**
 * Refuse before any Git mutation what publication could not prove: text paths need one plain
 * stage-0 entry, and whole-file paths must be unassigned and identical across HEAD, index and disk.
 */
function assertAdmitted(
    evidence: TargetOperationEvidence,
    text: readonly string[],
    whole: readonly TargetWholeFileBefore[],
    trustExecutableBit: boolean,
    gitClean: readonly string[],
): void {
    for (const file of text) {
        const index = evidence.index.filter((entry) => entry.path === file);
        if (index.length !== 1 || !plainIndexEntry(index[0]))
            throw new Error(`"${file}" has an unsupported index entry for this history action.`);
    }
    const refusal = wholeFileRefusal(evidence, whole, trustExecutableBit, gitClean);
    if (refusal?.reason === "owned")
        throw new Error(
            `"${refusal.path}" already belongs to a changelist. Added, deleted, renamed, linked or re-moded files must be unassigned and clean.`,
        );
    if (refusal)
        throw new Error(
            `"${refusal.path}" has local changes. Added, deleted, renamed, linked or re-moded files must be unassigned and clean.`,
        );
}

function plainIndexEntry(entry: TargetIndexEntry): boolean {
    return entry.stage === 0 && !entry.intentToAdd && !entry.skipWorktree && !entry.assumeUnchanged;
}

/** First whole-file path that is owned, or whose HEAD, index and disk differ; Undo Commit shares it. */
function wholeFileRefusal(
    evidence: TargetOperationEvidence,
    whole: readonly TargetWholeFileBefore[],
    trustExecutableBit: boolean,
    gitClean: readonly string[],
): WholeFileRefusal | undefined {
    for (const captured of whole) {
        const file = captured.path;
        if (!captured.unowned) return { path: file, reason: "owned" };
        const index = evidence.index.filter((entry) => entry.path === file);
        const working = evidence.paths.find((entry) => entry.path === file)?.state;
        const head = captured.head;
        const clean =
            head.kind === "absent"
                ? !index.length && working?.kind === "absent"
                : index.length === 1 &&
                  plainIndexEntry(index[0]) &&
                  index[0].mode === head.mode &&
                  index[0].oid === head.oid &&
                  isDeepStrictEqual(index[0].object, head.object) &&
                  (head.mode === "120000"
                      ? working?.kind === "symlink" &&
                        isDeepStrictEqual(working.target, head.object)
                      : working?.kind === "regular" &&
                        (!trustExecutableBit || working.executable === (head.mode === "100755")) &&
                        (isDeepStrictEqual(working.content, head.object) ||
                            gitClean.includes(file)));
        if (!clean) return { path: file, reason: "localChanges" };
    }
    return undefined;
}

/** Pair a normal text snapshot with exact native evidence, including raw worktree bytes. */
function assertSnapshotEvidence(
    snapshot: PartialFileSnapshot,
    evidence: TargetOperationEvidence,
    file: string,
): void {
    const state = evidence.paths.find((entry) => entry.path === file)?.state;
    if (
        snapshot.head !== evidence.head ||
        snapshot.indexHash !== evidence.indexFingerprint ||
        state?.kind !== "regular" ||
        snapshot.worktreeHash !== state.content.hash
    )
        throw new Error("History snapshot changed during capture.");
}

/** Compare all mutable Git observations, ignoring the checkpoint's entry bookkeeping. */
function sameObservation(left: TargetOperationEvidence, right: TargetOperationEvidence): boolean {
    return (
        left.head === right.head &&
        left.indexFingerprint === right.indexFingerprint &&
        isDeepStrictEqual(left.paths, right.paths) &&
        isDeepStrictEqual(left.index, right.index) &&
        isDeepStrictEqual(left.native, right.native)
    );
}

/** Refuse the mutation when evidence I/O exposed an external state change. */
function assertSameObservation(
    left: TargetOperationEvidence,
    right: TargetOperationEvidence,
): void {
    if (!sameObservation(left, right)) throw new Error("History evidence changed before apply.");
}

/** Build newline-sensitive text anchors from Git's bounded diff of captured immutable bytes. */
export async function historyTextSnapshot(
    git: GitExecutor,
    evidence: Pick<TargetOperationEvidence, "head" | "indexFingerprint">,
    file: string,
    base: string,
    working: string,
) {
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-history-delta-"));
    try {
        const old = path.join(directory, "before");
        const next = path.join(directory, "after");
        await writeFile(old, base, { mode: 0o600 });
        await writeFile(next, working, { mode: 0o600 });
        const diff = await git.runBinary(
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
                old,
                next,
            ],
            {
                expectedExitCodes: [0, 1],
                maxOutputBytes: 8 * 1024 * 1024,
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (diff.truncated)
            throw new Error("History operation diff exceeds the supported text size.");
        const blocks = parseChangeDiff(diff.stdout.toString("utf8"), base, working);
        const contentId = changeFingerprint(JSON.stringify([base, working, blocks]));
        return rangeSnapshot({
            head: evidence.head,
            indexHash: evidence.indexFingerprint,
            working,
            contentId,
            view: { snapshotId: contentId, path: file, side: "working", base, blocks },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** Current pending identity and terminal receipts are authoritative before any native inspection. */
function knownHistoryRequest(
    state: ChangelistState,
    intent: TargetHistoryRequest,
): TargetHistoryResult | undefined {
    const receipt = state.targetOperationReceipts?.[intent.id];
    if (receipt)
        return {
            id: intent.id,
            outcome: receipt.outcome === "aborted" ? "notApplied" : receipt.outcome,
        };
    if (state.pendingTargetOperation)
        return {
            id: intent.id,
            outcome: state.pendingTargetOperation.id === intent.id ? "appliedNeedsReview" : "busy",
        };
    if (state.revision !== intent.target.revision) return { id: intent.id, outcome: "stale" };
    return undefined;
}

/** A successful single-commit revert may retain its marker; quit only that proven native identity. */
export async function quitCompletedHistory(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    intent: Pick<TargetHistoryRequest, "id" | "commit"> & { kind: "cherryPick" | "revert" },
    actual: TargetOperationEvidence,
    run: (args: string[]) => Promise<string>,
): Promise<TargetOperationEvidence> {
    const paths = actual.paths.map((entry) => entry.path);
    if (actual.native.some((entry) => entry.present)) {
        const expectedName = intent.kind === "cherryPick" ? "cherryPickHead" : "revertHead";
        if (actual.native.some((entry) => entry.present && entry.name !== expectedName))
            throw new Error("Unexpected native state after history apply.");
        const marker = path.join(
            persistence.gitDir,
            intent.kind === "cherryPick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
        );
        if ((await readFile(marker, "utf8")).trim() !== intent.commit)
            throw new Error("Native history marker belongs to another commit.");
        assertSameObservation(
            actual,
            await captureTargetNativeEvidence(git, persistence, intent.id, paths),
        );
        await run([intent.kind === "cherryPick" ? "cherry-pick" : "revert", "--quit"]);
        const cleared = await captureTargetNativeEvidence(git, persistence, intent.id, paths);
        if (
            cleared.native.some((entry) => entry.present) ||
            !sameObservation(actual, { ...cleared, native: actual.native })
        )
            throw new Error("Native history cleanup changed applied evidence.");
        return cleared;
    }
    return actual;
}

/** Bind actual text deltas to the captured owners; structural paths move as whole files. */
async function historyAttribution(
    git: GitExecutor,
    persistence: ChangelistPersistence,
    operationId: string,
    snapshots: ReadonlyMap<string, PartialFileSnapshot>,
    owners: Readonly<Record<string, HydratedChangeOwnership | undefined>>,
    state: ChangelistState,
    actual: TargetOperationEvidence,
) {
    const paths = actual.paths.map((entry) => entry.path);
    const attribution = [];
    const wholeFileAttribution = [];
    for (const [index, file] of paths.entries()) {
        const old = snapshots.get(file);
        if (!old) {
            wholeFileAttribution.push({ path: file, changeIds: [String(index)] });
            continue;
        }
        const fresh = await readPartialSnapshot(git, persistence.root, file, "working");
        assertSnapshotEvidence(fresh, actual, file);
        const beforeSnapshot = rangeSnapshot(old);
        const afterSnapshot = rangeSnapshot(fresh);
        const fallback = state.files[file] ?? state.activeId;
        const payload: TargetOperationAttribution = {
            version: 1,
            root: persistence.root,
            gitDir: persistence.gitDir,
            operationId: operationId,
            path: file,
            priorFileOwner: fallback,
            previous:
                owners[file] ?? reconcileRanges(undefined, beforeSnapshot, fallback, fallback),
            before: beforeSnapshot,
            after: afterSnapshot,
            operation: await historyTextSnapshot(git, actual, file, old.working, fresh.working),
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
    return { attribution, wholeFileAttribution };
}
