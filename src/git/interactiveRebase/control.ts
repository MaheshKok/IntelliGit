import { rm } from "node:fs/promises";
import { completeInteractiveRebase } from "./completion";
import { createGitEditorCommand } from "./editorCommand";
import { errorMessage, readGitText } from "./gitText";
import { deriveRebaseControl, type RebaseControl } from "./rebaseControl";
import type { InteractiveRebaseRunDependencies } from "./run";
import {
    deleteRebaseSessionDirectory,
    getRebaseStoragePaths,
    type LiveRebaseSessionManifest,
    readLiveRebaseManifest,
    releaseRebaseReservation,
    writeRebaseManifest,
} from "./storage";
import type { RebaseSessionManifest } from "./types";

/** Dependencies needed to control an already-running interactive rebase. */
export type InteractiveRebaseControlDependencies = Pick<
    InteractiveRebaseRunDependencies,
    "executor" | "mutationGate" | "storageRoot" | "gitDir" | "commonDir" | "helperScriptPath"
>;

/** Outcome of continuing or aborting a live interactive rebase. */
export type InteractiveRebaseControlResult =
    | {
          /** No Git rebase state exists for the repository. */
          status: "no-rebase-in-progress";
      }
    | {
          /** A foreign rebase cannot safely receive IntelliGit helper input. */
          status: "foreign-continue-refused";
      }
    | {
          /** An unowned rebase continued with no IntelliGit state mutation. */
          status: "continued";
          /** Confirms that the command deliberately used the unowned contract. */
          rebaseControl: "unowned";
      }
    | {
          /** An abort command completed under the named ownership contract. */
          status: "aborted";
          /** Ownership state that scoped the completed abort side effects. */
          rebaseControl: RebaseControl;
      }
    | {
          /** An owned rebase completed and its durable state was removed. */
          status: "completed";
          /** Fresh HEAD object ID observed after the completed rebase. */
          rebasedHeadOid: string;
      }
    | {
          /** An owned rebase completed and retained its pending force-push offer. */
          status: "completed-pending-push";
          /** The retained manifest that pins the offered force-push target. */
          manifest: RebaseSessionManifest;
      }
    | {
          /**
           * A still-live rebase stopped with unmerged index entries.
           *
           * Owned and unowned rebases share this outcome because the user's next action is the
           * same either way, so it deliberately carries no ownership state: a caller that needs
           * one re-reads the snapshot rather than trusting a value captured before the pause.
           */
          status: "paused-conflict";
      }
    | {
          /** An owned helper stopped Git without creating an index conflict. */
          status: "paused-helper-stop";
          /** Captured Git stderr for the caller's contextual user-facing guidance. */
          stderr: string;
      }
    | {
          /** Git or storage could not safely complete the requested operation. */
          status: "failed";
          /** Ownership contract in effect when the failure occurred. */
          rebaseControl: RebaseControl;
          /** Machine-readable failure category for the caller's localized message mapping. */
          reason: "git-failed" | "ownership-changed";
          /** Captured diagnostic suitable for contextual caller logging or guidance. */
          message: string;
      };

const PASS_THROUGH_GIT_EDITOR = "true";

/**
 * Continues a live interactive rebase under its freshly derived ownership contract.
 *
 * The ownership read is intentionally inside the mutation gate so a queued mutation cannot
 * replace the rebase state between correlation and the Git command.
 */
export async function continueInteractiveRebase(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
): Promise<InteractiveRebaseControlResult> {
    return dependencies.mutationGate.run(repoRoot, dependencies.commonDir, async () => {
        const manifest = await readLiveRebaseManifest(dependencies.storageRoot, repoRoot);
        const control = await deriveRebaseControl({
            gitDir: dependencies.gitDir,
            liveManifest: manifest,
        });
        switch (control) {
            case "none":
                return { status: "no-rebase-in-progress" };
            case "unowned":
                return continueUnownedRebase(dependencies);
            case "foreign":
                return { status: "foreign-continue-refused" };
            case "owned":
                return manifest
                    ? continueOwnedRebase(dependencies, repoRoot, manifest)
                    : ownedManifestMissing();
            default:
                return assertNeverRebaseControl(control);
        }
    });
}

/**
 * Aborts a live interactive rebase under its freshly derived ownership contract.
 *
 * Foreign and unowned rebases use a no-op editor command so Git never opens a blocking editor in
 * the extension host, while only owned state may be removed after Git reports abort success.
 */
export async function abortInteractiveRebase(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
): Promise<InteractiveRebaseControlResult> {
    return dependencies.mutationGate.run(repoRoot, dependencies.commonDir, async () => {
        const manifest = await readLiveRebaseManifest(dependencies.storageRoot, repoRoot);
        const control = await deriveRebaseControl({
            gitDir: dependencies.gitDir,
            liveManifest: manifest,
        });
        switch (control) {
            case "none":
                return { status: "no-rebase-in-progress" };
            case "unowned":
            case "foreign":
                return abortPassThroughRebase(dependencies, control);
            case "owned":
                return manifest
                    ? abortOwnedRebase(dependencies, repoRoot, manifest)
                    : ownedManifestMissing();
            default:
                return assertNeverRebaseControl(control);
        }
    });
}

async function continueOwnedRebase(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
    manifest: LiveRebaseSessionManifest,
): Promise<InteractiveRebaseControlResult> {
    try {
        const rebase = await dependencies.executor.runBinary(["rebase", "--continue"], {
            expectedExitCodes: [0, 1],
            env: helperEditorEnvironment(dependencies, repoRoot, manifest),
        });
        if (rebase.exitCode === 0) {
            const rebasedHeadOid = await readGitText(dependencies.executor, ["rev-parse", "HEAD"]);
            const completion = await completeInteractiveRebase(
                requiredStorageRoot(dependencies),
                manifest,
                rebasedHeadOid,
            );
            if (completion.status === "completed-pending-push") {
                await cleanUpOwnedSession(dependencies, repoRoot, manifest, false);
                return completion;
            }
            await cleanUpOwnedSession(dependencies, repoRoot, manifest, true);
            return completion;
        }

        const stateAfterContinue = await deriveRebaseControl({
            gitDir: dependencies.gitDir,
            liveManifest: manifest,
        });
        if (stateAfterContinue === "owned") {
            const unmerged = await readGitText(dependencies.executor, ["ls-files", "-u"]);
            await writeRebaseManifest(requiredStorageRoot(dependencies), {
                ...manifest,
                lifecycle: "paused",
            });
            return unmerged.length > 0
                ? { status: "paused-conflict" }
                : { status: "paused-helper-stop", stderr: rebase.stderr.toString("utf8") };
        }
        if (stateAfterContinue === "none") {
            await cleanUpOwnedSession(dependencies, repoRoot, manifest, true);
            return ownedFailure(
                "git-failed",
                "Git stopped the rebase without leaving resumable state.",
            );
        }
        return ownedFailure(
            "ownership-changed",
            "Rebase ownership changed while Continue was running.",
        );
    } catch (error) {
        return failOwnedIfNotLive(dependencies, repoRoot, manifest, error);
    }
}

async function abortOwnedRebase(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
    manifest: LiveRebaseSessionManifest,
): Promise<InteractiveRebaseControlResult> {
    try {
        await dependencies.executor.runBinary(["rebase", "--abort"], {
            env: helperEditorEnvironment(dependencies, repoRoot, manifest),
        });
        await cleanUpOwnedSession(dependencies, repoRoot, manifest, true);
        return { status: "aborted", rebaseControl: "owned" };
    } catch (error) {
        return ownedFailure("git-failed", errorMessage(error));
    }
}

async function continueUnownedRebase(
    dependencies: InteractiveRebaseControlDependencies,
): Promise<InteractiveRebaseControlResult> {
    try {
        const rebase = await dependencies.executor.runBinary(["rebase", "--continue"], {
            expectedExitCodes: [0, 1],
            env: passThroughEditorEnvironment(),
        });
        if (rebase.exitCode === 0) return { status: "continued", rebaseControl: "unowned" };
        // Git exits 1 both when it stops at the next conflict and when it refuses to continue at
        // all, and the rebase we do not own is the common multi-conflict case. Treating every
        // non-zero exit as a failure would report a rebase that is sitting there waiting for the
        // user as dead, so only unmerged entries under a still-live rebase are read as a pause.
        const unmerged = (await isRebaseStillLive(dependencies))
            ? await readGitText(dependencies.executor, ["ls-files", "-u"])
            : "";
        return unmerged.length > 0
            ? { status: "paused-conflict" }
            : passThroughFailure("unowned", rebase.stderr.toString("utf8"));
    } catch (error) {
        return passThroughFailure("unowned", errorMessage(error));
    }
}

/** Reports whether Git still holds rebase state, without correlating it to any session. */
async function isRebaseStillLive(
    dependencies: InteractiveRebaseControlDependencies,
): Promise<boolean> {
    return (await deriveRebaseControl({ gitDir: dependencies.gitDir })) !== "none";
}

async function abortPassThroughRebase(
    dependencies: InteractiveRebaseControlDependencies,
    control: "unowned" | "foreign",
): Promise<InteractiveRebaseControlResult> {
    try {
        await dependencies.executor.runBinary(["rebase", "--abort"], {
            env: passThroughEditorEnvironment(),
        });
        return { status: "aborted", rebaseControl: control };
    } catch (error) {
        return passThroughFailure(control, errorMessage(error));
    }
}

async function failOwnedIfNotLive(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
    manifest: LiveRebaseSessionManifest,
    error: unknown,
): Promise<InteractiveRebaseControlResult> {
    const state = await deriveRebaseControl({
        gitDir: dependencies.gitDir,
        liveManifest: manifest,
    });
    if (state === "none") {
        await cleanUpOwnedSession(dependencies, repoRoot, manifest, true);
        return ownedFailure("git-failed", errorMessage(error));
    }
    // A Git fatal that left our own rebase live is a Git failure, not a change of ownership. Both
    // keep the session, but reporting the wrong one sends the caller looking for a foreign rebase
    // that is not there — only a state that stopped answering to our marker changed hands.
    return ownedFailure(
        state === "owned" ? "git-failed" : "ownership-changed",
        errorMessage(error),
    );
}

async function cleanUpOwnedSession(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
    manifest: RebaseSessionManifest,
    deleteManifest: boolean,
): Promise<void> {
    const storageRoot = requiredStorageRoot(dependencies);
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    await deleteRebaseSessionDirectory(storageRoot, repoRoot, manifest.sessionId);
    if (deleteManifest) await rm(paths.manifestPath(manifest.sessionId), { force: true });
    await releaseRebaseReservation({
        sessionId: manifest.sessionId,
        pointerPath: paths.reservationPath,
    });
}

function helperEditorEnvironment(
    dependencies: InteractiveRebaseControlDependencies,
    repoRoot: string,
    manifest: RebaseSessionManifest,
): Record<string, string> {
    const sessionDirectory = getRebaseStoragePaths(
        requiredStorageRoot(dependencies),
        repoRoot,
    ).sessionDirectory(manifest.sessionId);
    return {
        GIT_SEQUENCE_EDITOR: createGitEditorCommand(
            dependencies.helperScriptPath,
            "sequence",
            sessionDirectory,
        ),
        GIT_EDITOR: createGitEditorCommand(
            dependencies.helperScriptPath,
            "message",
            sessionDirectory,
        ),
    };
}

function passThroughEditorEnvironment(): Record<string, string> {
    return { GIT_SEQUENCE_EDITOR: PASS_THROUGH_GIT_EDITOR, GIT_EDITOR: PASS_THROUGH_GIT_EDITOR };
}

function requiredStorageRoot(dependencies: InteractiveRebaseControlDependencies): string {
    if (dependencies.storageRoot) return dependencies.storageRoot;
    throw new Error("Interactive rebase storage is unavailable for owned state.");
}

/**
 * Refuses the owned contract when no live manifest backs it.
 *
 * `deriveRebaseControl` can only answer `owned` by matching a marker against a live manifest, so
 * this is unreachable today. It is kept, and fails closed, so a future derivation that learns to
 * claim ownership from other evidence cannot run owned cleanup against a session it never read.
 */
function ownedManifestMissing(): InteractiveRebaseControlResult {
    return ownedFailure("ownership-changed", "Owned rebase state had no live manifest.");
}

/** Builds the failure that a non-owned contract may report without touching any IntelliGit state. */
function passThroughFailure(
    control: "unowned" | "foreign",
    message: string,
): InteractiveRebaseControlResult {
    return { status: "failed", rebaseControl: control, reason: "git-failed", message };
}

function ownedFailure(
    reason: "git-failed" | "ownership-changed",
    message: string,
): InteractiveRebaseControlResult {
    return { status: "failed", rebaseControl: "owned", reason, message };
}

/** Makes a newly added rebase-control state a compile-time exhaustiveness error. */
function assertNeverRebaseControl(control: never): never {
    void control;
    throw new Error("Unhandled interactive rebase control state.");
}
