import { shouldOfferRebaseForcePush } from "./push";
import { writeRebaseManifest } from "./storage";
import type { RebaseSessionManifest } from "./types";

/** The shared terminal outcome after Git has produced a rebased HEAD object. */
export type InteractiveRebaseCompletionResult =
    | { status: "completed"; rebasedHeadOid: string }
    | { status: "completed-pending-push"; manifest: RebaseSessionManifest };

/**
 * Persists the terminal rebase lifecycle and returns the matching host result.
 *
 * Callers retain ownership of their distinct session cleanup timing: a pending push offer keeps
 * its manifest, while a completed rebase leaves the caller to remove its terminal manifest.
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
        await writeRebaseManifest(storageRoot, pendingPushManifest);
        return { status: "completed-pending-push", manifest: pendingPushManifest };
    }
    await writeRebaseManifest(storageRoot, {
        ...manifest,
        lifecycle: "done",
        rebasedHeadOid,
    });
    return { status: "completed", rebasedHeadOid };
}
