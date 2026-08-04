import { shouldOfferRebaseForcePush } from "./push";
import { writeRebaseManifest } from "./storage";
import type { RebaseSessionManifest } from "./types";

/** The shared terminal outcome after Git has produced a rebased HEAD object. */
export type InteractiveRebaseCompletionResult =
    | { status: "completed"; rebasedHeadOid: string }
    | { status: "completed-with-local-state-warning"; rebasedHeadOid: string }
    | { status: "completed-pending-push"; manifest: RebaseSessionManifest };

/**
 * Persists the terminal rebase lifecycle and returns the matching host result.
 *
 * Callers retain ownership of their distinct session cleanup timing: a pending push offer keeps
 * its manifest, while a completed rebase leaves the caller to remove its terminal manifest. Once
 * Git has completed, a terminal manifest write failure becomes a local-state warning; earlier
 * lifecycle writes still reject so Git never runs without its required recovery state.
 */
export async function completeInteractiveRebase(
    storageRoot: string,
    manifest: RebaseSessionManifest,
    rebasedHeadOid: string,
): Promise<InteractiveRebaseCompletionResult> {
    if (shouldOfferRebaseForcePush(manifest.hasPushedCommit, manifest.pushTarget)) {
        const pendingPushManifest = {
            ...manifest,
            lifecycle: "completed-pending-push" as const,
            rebasedHeadOid,
        };
        try {
            await writeRebaseManifest(storageRoot, pendingPushManifest);
        } catch {
            return { status: "completed-with-local-state-warning", rebasedHeadOid };
        }
        return { status: "completed-pending-push", manifest: pendingPushManifest };
    }
    try {
        await writeRebaseManifest(storageRoot, {
            ...manifest,
            lifecycle: "done",
            rebasedHeadOid,
        });
    } catch {
        return { status: "completed-with-local-state-warning", rebasedHeadOid };
    }
    return { status: "completed", rebasedHeadOid };
}
