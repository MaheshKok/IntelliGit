import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GitExecutor } from "../executor";
import type { RepositoryMutationGate } from "../repositoryMutationGate";
import { createGitEditorCommand } from "./editorCommand";
import { evaluateInteractiveRebaseGuards } from "./guards";
import { shouldOfferRebaseForcePush } from "./push";
import { writeInteractiveRebaseSession } from "./session";
import {
    createRebaseSessionDirectory,
    deleteRebaseSessionDirectory,
    getRebaseStoragePaths,
    releaseRebaseReservation,
    tryAcquireRebaseReservation,
    writeRebaseManifest,
} from "./storage";
import type {
    InteractiveRebaseRunResult,
    RebaseReservation,
    RebaseSessionManifest,
    RebaseTodoEntry,
    SubmittedRebaseDialogRequest,
} from "./types";

/** Dependencies required to start one accepted interactive-rebase submission. */
export interface InteractiveRebaseRunDependencies {
    /** Executor rooted at the accepted repository. */
    executor: Pick<GitExecutor, "run" | "runBinary">;
    /** Shared repository mutation serialization gate. */
    mutationGate: Pick<RepositoryMutationGate, "run">;
    /** Repository-level probe for the states requiring a whole-index commit, for the in-gate re-check. */
    hasWholeIndexOperationInProgress: () => Promise<boolean>;
    /** Extension-managed global storage directory. */
    storageRoot: string | undefined;
    /** Worktree Git directory used to detect live rebase state. */
    gitDir: string;
    /** Shared Git directory used by the mutation gate lock. */
    commonDir: string;
    /** Built standalone editor-helper script. */
    helperScriptPath: string;
    /** Test seam for the session identifier. */
    createSessionId?: () => string;
    /** Test seam for manifest timestamps. */
    now?: () => Date;
}

/** Input captured by the accepted dialog handoff. */
export interface InteractiveRebaseRunInput {
    /** Immutable request snapshot validated before the runner is called. */
    request: SubmittedRebaseDialogRequest;
    /** Validated todo entries in the submitted order. */
    entries: readonly RebaseTodoEntry[];
}

/** Runs one accepted interactive-rebase submission through its owned helper session. */
export async function runInteractiveRebaseSubmission(
    dependencies: InteractiveRebaseRunDependencies,
    input: InteractiveRebaseRunInput,
): Promise<InteractiveRebaseRunResult> {
    const { request } = input;
    if (!dependencies.storageRoot) return { status: "failed", reason: "storage-unavailable" };
    if (!(await exists(dependencies.helperScriptPath))) {
        return { status: "failed", reason: "editor-helper-missing" };
    }

    const storageRoot = dependencies.storageRoot;
    const sessionId = (dependencies.createSessionId ?? randomUUID)();
    let reservation: RebaseReservation | undefined;
    let shouldCleanUp = false;
    let shouldDeleteManifest = true;
    try {
        const acquired = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot: request.repoRoot,
            gitDir: dependencies.gitDir,
            sessionId,
        });
        if (acquired.status === "rejected") {
            return { status: "failed", reason: acquired.reason };
        }
        reservation = acquired.reservation;
        shouldCleanUp = true;

        const session = await createRebaseSessionDirectory(
            storageRoot,
            request.repoRoot,
            sessionId,
        );
        await writeInteractiveRebaseSession(session, input.entries);
        const pushTarget = request.pushTarget;
        const manifest: RebaseSessionManifest = {
            version: 1,
            sessionId,
            repoRoot: request.repoRoot,
            branch: request.expectedBranch,
            ...(pushTarget ? { pushTarget } : {}),
            baseHash: request.baseHash,
            expectedHead: request.expectedHead,
            createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            lifecycle: "starting",
        };
        await writeRebaseManifest(storageRoot, manifest);

        const result = await dependencies.mutationGate.run(
            request.repoRoot,
            dependencies.commonDir,
            async () => {
                const [branch, head] = await Promise.all([
                    readGitText(dependencies.executor, ["symbolic-ref", "--quiet", "HEAD"]),
                    readGitText(dependencies.executor, ["rev-parse", "HEAD"]),
                ]);
                if (branch !== manifest.branch)
                    return { status: "failed", reason: "branch-moved" } as const;
                if (head !== manifest.expectedHead)
                    return { status: "failed", reason: "head-moved" } as const;
                if (await hasRebaseDirectory(dependencies.gitDir)) {
                    return { status: "failed", reason: "rebase-in-progress" } as const;
                }
                // The spec requires every guard re-evaluated here, not just the two revisions
                // above: submission checked them before this callback joined the mutation queue,
                // and a mutation that ran while it waited can dirty the working tree or start a
                // bisect. Only a check inside the critical section is not separated from the
                // spawn below by another mutation.
                const guards = await evaluateInteractiveRebaseGuards({
                    executor: dependencies.executor,
                    selectedHash: manifest.baseHash,
                    hasWholeIndexOperationInProgress: dependencies.hasWholeIndexOperationInProgress,
                });
                if (guards.status === "rejected") {
                    return { status: "guard-rejected", reason: guards.reason } as const;
                }
                const runningManifest = { ...manifest, lifecycle: "running" } as const;
                await writeRebaseManifest(storageRoot, runningManifest);
                const rebase = await dependencies.executor.runBinary(
                    ["rebase", "-i", manifest.baseHash],
                    {
                        expectedExitCodes: [0, 1],
                        env: {
                            GIT_SEQUENCE_EDITOR: createGitEditorCommand(
                                dependencies.helperScriptPath,
                                "sequence",
                                session.directory,
                            ),
                            GIT_EDITOR: createGitEditorCommand(
                                dependencies.helperScriptPath,
                                "message",
                                session.directory,
                            ),
                        },
                    },
                );
                if (rebase.exitCode === 0) {
                    const rebasedHeadOid = await readGitText(dependencies.executor, [
                        "rev-parse",
                        "HEAD",
                    ]);
                    if (shouldOfferRebaseForcePush(request.hasPushedCommit, pushTarget)) {
                        const pendingPushManifest = {
                            ...runningManifest,
                            lifecycle: "completed-pending-push" as const,
                            rebasedHeadOid,
                        };
                        await writeRebaseManifest(storageRoot, pendingPushManifest);
                        shouldDeleteManifest = false;
                        return {
                            status: "completed-pending-push",
                            manifest: pendingPushManifest,
                        } as const;
                    }
                    await writeRebaseManifest(storageRoot, {
                        ...runningManifest,
                        lifecycle: "done",
                        rebasedHeadOid,
                    });
                    return { status: "completed", rebasedHeadOid } as const;
                }
                if (!(await hasRebaseDirectory(dependencies.gitDir))) {
                    return { status: "failed", reason: "rebase-failed" } as const;
                }
                const unmerged = await readGitText(dependencies.executor, ["ls-files", "-u"]);
                await writeRebaseManifest(storageRoot, {
                    ...runningManifest,
                    lifecycle: "paused",
                });
                if (unmerged.length > 0) return { status: "paused-conflict" } as const;
                return {
                    status: "paused-helper-stop",
                    stderr: rebase.stderr.toString("utf8"),
                } as const;
            },
        );
        if (result.status === "paused-conflict" || result.status === "paused-helper-stop") {
            shouldCleanUp = false;
        }
        return result;
    } catch (error) {
        // `runBinary` rejects on any exit code outside `expectedExitCodes`, so a Git fatal (128)
        // that already wrote `rebase-merge` lands here rather than on the paused path below.
        // Cleanup is only correct for an exit verifiably not paused, and a probe that cannot
        // answer that question is not a verification — both the "rebase is live" and the
        // "cannot tell" answers must keep the session, since deleting it would strand a real
        // rebase with no todo, no message map, and no reservation.
        shouldCleanUp = shouldCleanUp && (await isVerifiablyNotPaused(dependencies.gitDir));
        return { status: "failed", reason: "unexpected-error", message: errorMessage(error) };
    } finally {
        if (reservation && shouldCleanUp) {
            await deleteRebaseSessionDirectory(storageRoot, request.repoRoot, sessionId);
            if (shouldDeleteManifest) {
                await rm(
                    getRebaseStoragePaths(storageRoot, request.repoRoot).manifestPath(sessionId),
                    {
                        force: true,
                    },
                );
            }
            await releaseRebaseReservation(reservation);
        }
    }
}

/** Byte ceiling for the runner's own probes, so a huge conflict cannot exhaust the host. */
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Reads a successful Git command's trimmed UTF-8 output under a fixed byte ceiling. */
async function readGitText(
    executor: Pick<GitExecutor, "runBinary">,
    args: string[],
): Promise<string> {
    // `ls-files -u` grows with the conflict, so every probe is bounded. A truncated probe is
    // never trimmed into a plausible-looking answer: it throws and joins the not-paused path.
    const result = await executor.runBinary(args, { maxOutputBytes: MAX_PROBE_OUTPUT_BYTES });
    if (result.truncated) throw new Error(`Git output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes.`);
    return result.stdout.toString("utf8").trim();
}

/**
 * Reports whether Git verifiably left no resumable rebase behind.
 *
 * A probe that throws answers "unknown", which must not be read as "nothing to keep", so the
 * unreadable case reports false and the session survives.
 */
async function isVerifiablyNotPaused(gitDir: string): Promise<boolean> {
    try {
        return !(await hasRebaseDirectory(gitDir));
    } catch {
        return false;
    }
}

/** Reports whether Git still has either active interactive-rebase directory. */
async function hasRebaseDirectory(gitDir: string): Promise<boolean> {
    return (
        (await exists(path.join(gitDir, "rebase-merge"))) ||
        (await exists(path.join(gitDir, "rebase-apply")))
    );
}

/** Returns false only for a missing path so an unreadable live-rebase probe fails closed. */
async function exists(target: string): Promise<boolean> {
    try {
        await stat(target);
        return true;
    } catch (error) {
        if (isMissingPath(error)) return false;
        throw error;
    }
}

/** Narrows a Node filesystem error to an absent path. */
function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

/** Turns an unknown thrown value into a bounded diagnostic for the UI. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
