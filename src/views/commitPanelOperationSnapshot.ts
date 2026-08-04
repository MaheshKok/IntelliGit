import type { GitOps } from "../git/operations";
import { resolveGitDir } from "../git/gitDirectory";
import { deriveRebaseControl } from "../git/interactiveRebase/rebaseControl";
import { readLiveRebaseManifest } from "../git/interactiveRebase/storage";
import type { CommitPanelOperationSnapshot } from "../webviews/protocol/commitPanelMessages";

/**
 * Derives the commit-panel operation protocol from one repository's filesystem marker snapshot.
 *
 * The storage root is optional because callers without extension-global storage cannot correlate
 * a live rebase with an extension-owned manifest.
 */
export async function operationSnapshotForRepository({
    gitOps,
    repositoryRoot,
    interactiveRebaseStorageRoot,
}: {
    gitOps: Pick<GitOps, "getActiveOperation">;
    repositoryRoot: string;
    interactiveRebaseStorageRoot?: string;
}): Promise<CommitPanelOperationSnapshot> {
    const activeOperation = await gitOps.getActiveOperation();
    if (activeOperation !== "rebase") return { activeOperation };
    const liveManifest = await readLiveRebaseManifest(interactiveRebaseStorageRoot, repositoryRoot);
    const rebaseControl = await deriveRebaseControl({
        gitDir: resolveGitDir(repositoryRoot),
        ...(liveManifest ? { liveManifest } : {}),
    });
    return {
        activeOperation,
        // `none` here means the rebase ended between the two probes. Reporting `none` as the
        // operation would also erase any merge, cherry-pick, or revert the first probe saw
        // underneath it and unfence the commit path, so the uncorrelated classification is
        // reported instead: a stale rebase is corrected by the marker's own watcher event,
        // while a dropped operation is not corrected by anything.
        rebaseControl:
            rebaseControl === "none" ? (liveManifest ? "foreign" : "unowned") : rebaseControl,
    };
}
