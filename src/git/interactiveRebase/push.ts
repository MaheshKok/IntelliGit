import { rm } from "node:fs/promises";
import type { GitExecutor } from "../executor";
import type { RepositoryMutationGate } from "../repositoryMutationGate";
import { isValidBranchName } from "../../utils/gitRefs";
import { errorMessage, readGitText } from "./gitText";
import { isLowerCaseFullObjectId } from "./objectId";
import { REMOTE_HEAD_REF, SAFE_REMOTE_NAME } from "./remoteTarget";
import { getRebaseStoragePaths, writeRebaseManifest } from "./storage";
import type { RebasePushTarget, RebaseSessionManifest } from "./types";

/** Resolves untrusted upstream fields into an all-or-none force-push target. */
export function resolveRebasePushTarget(candidate: unknown): RebasePushTarget | undefined {
    if (!isRecord(candidate) || Object.keys(candidate).length !== 3) return undefined;
    const { remoteName, remoteHeadRef, upstreamOid } = candidate;
    if (
        typeof remoteName !== "string" ||
        !SAFE_REMOTE_NAME.test(remoteName) ||
        typeof remoteHeadRef !== "string" ||
        !REMOTE_HEAD_REF.test(remoteHeadRef) ||
        typeof upstreamOid !== "string" ||
        !isLowerCaseFullObjectId(upstreamOid)
    ) {
        return undefined;
    }
    return { remoteName, remoteHeadRef, upstreamOid };
}

/** Reports whether this completed rebase needs a source- and destination-pinned push offer. */
export function shouldOfferRebaseForcePush(
    hasPushedCommit: boolean,
    pushTarget: RebasePushTarget | undefined,
): boolean {
    return hasPushedCommit && pushTarget !== undefined;
}

/** Reads the branch upstream once, returning no target for every missing or malformed component. */
export async function readRebasePushTarget(
    executor: Pick<GitExecutor, "runBinary">,
    branch: string,
): Promise<RebasePushTarget | undefined> {
    if (!REMOTE_HEAD_REF.test(branch)) return undefined;
    try {
        const output = await readGitText(executor, [
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
            branch,
        ]);
        const fields = output.split("\0");
        if (fields.length !== 3) return undefined;
        const [remoteName, remoteHeadRef, upstreamRef] = fields;
        if (
            !SAFE_REMOTE_NAME.test(remoteName) ||
            !REMOTE_HEAD_REF.test(remoteHeadRef) ||
            !isSafeLocalUpstreamRef(upstreamRef)
        ) {
            return undefined;
        }
        const upstreamOid = await readGitText(executor, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${upstreamRef}^{commit}`,
        ]);
        return resolveRebasePushTarget({ remoteName, remoteHeadRef, upstreamOid });
    } catch {
        return undefined;
    }
}

/** Keeps the second Git lookup rooted at a safe fully-qualified ref returned by Git. */
function isSafeLocalUpstreamRef(upstreamRef: string): boolean {
    return upstreamRef.startsWith("refs/") && isValidBranchName(upstreamRef);
}

/** Dependencies for a post-rebase force push or explicit dismissal. */
export interface RebasePushDependencies {
    /** Executor rooted at the rebased repository. */
    executor: Pick<GitExecutor, "runBinary">;
    /** Shared repository mutation serialization gate. */
    mutationGate: Pick<RepositoryMutationGate, "run">;
    /** Extension-managed global storage directory. */
    storageRoot: string;
    /** Shared Git directory used by the mutation gate lock. */
    commonDir: string;
}

/** The outcome of attempting the source- and destination-pinned force push. */
export type RebaseForcePushResult =
    | {
          /** The remote ref was updated to the rebased object. */
          status: "pushed";
          /** True when the push landed but its durable offer could not be cleared. */
          offerRetained: boolean;
      }
    | { status: "branch-moved" }
    | { status: "head-moved" }
    | { status: "failed"; message: string };

/** Force-pushes only the rebased object after re-verifying the captured branch and HEAD. */
export async function forcePushRebasedHead(
    dependencies: RebasePushDependencies,
    manifest: RebaseSessionManifest,
): Promise<RebaseForcePushResult> {
    const { pushTarget, rebasedHeadOid } = manifest;
    if (!pushTarget || !rebasedHeadOid) {
        return { status: "failed", message: "The rebase push target is incomplete." };
    }
    return dependencies.mutationGate.run(manifest.repoRoot, dependencies.commonDir, async () => {
        try {
            const [branch, head] = await Promise.all([
                readGitText(dependencies.executor, ["symbolic-ref", "--quiet", "HEAD"], {
                    expectedExitCodes: [0, 1],
                }),
                readGitText(dependencies.executor, ["rev-parse", "HEAD"]),
            ]);
            if (branch !== manifest.branch) return { status: "branch-moved" } as const;
            if (head !== rebasedHeadOid) return { status: "head-moved" } as const;
            await dependencies.executor.runBinary([
                "push",
                pushTarget.remoteName,
                `${rebasedHeadOid}:${pushTarget.remoteHeadRef}`,
                `--force-with-lease=${pushTarget.remoteHeadRef}:${pushTarget.upstreamOid}`,
            ]);
            // The remote ref is updated from here on. A bookkeeping failure after this point is
            // not a failed push, and reporting one would invite a second force push against a
            // lease that no longer matches. The retained manifest is what reload reconciliation
            // reads, so the offer resurfaces instead of the outcome being lost.
            const offerRetained = await completeRebasePushOffer(
                dependencies.storageRoot,
                manifest,
            ).then(
                () => false,
                () => true,
            );
            return { status: "pushed", offerRetained } as const;
        } catch (error) {
            return { status: "failed", message: errorMessage(error) } as const;
        }
    });
}

/** Marks a pending offer done and removes its manifest without changing Git state. */
export async function dismissRebasePushOffer(
    storageRoot: string,
    manifest: RebaseSessionManifest,
): Promise<void> {
    await completeRebasePushOffer(storageRoot, manifest);
}

/** Commits a terminal lifecycle before removing the durable offer, restoring it if removal fails. */
async function completeRebasePushOffer(
    storageRoot: string,
    manifest: RebaseSessionManifest,
): Promise<void> {
    const doneManifest = { ...manifest, lifecycle: "done" as const };
    await writeRebaseManifest(storageRoot, doneManifest);
    try {
        await rm(
            getRebaseStoragePaths(storageRoot, manifest.repoRoot).manifestPath(manifest.sessionId),
            {
                force: true,
            },
        );
    } catch (error) {
        await writeRebaseManifest(storageRoot, manifest);
        throw error;
    }
}

/** Narrows a JSON-like value to a record without trusting its keys or fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
