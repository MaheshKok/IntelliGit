import type { GitExecutor } from "../executor";
import { errorMessage, readGitText } from "./gitText";
import {
    deriveRebaseControlFromEvidence,
    readRebaseDirectoryEvidence,
    type LiveRebaseManifest,
    type RebaseControl,
    type RebaseDirectoryEvidence,
} from "./rebaseControl";
import { listRebaseManifests, type RebaseManifestListEntry } from "./storage";
import type { RebaseManifestAmbiguousReason, RebaseSessionManifest } from "./types";

/** Dependencies required to collect one repository-scoped reconciliation snapshot. */
export interface RebaseReconciliationDependencies {
    /** Extension-managed storage root that contains repository-scoped rebase manifests. */
    storageRoot: string;
    /** Worktree-local Git directory containing transient rebase state. */
    gitDir: string;
    /** Repository-bound Git runner used only for bounded read-only probes. */
    executor: Pick<GitExecutor, "runBinary">;
}

/** Current HEAD object-id evidence, including a failure state that cannot authorize recovery. */
type RebaseHeadEvidence =
    | { status: "known"; oid: string }
    | { status: "unavailable"; message: string };

/** Current symbolic branch evidence, preserving detached HEAD as distinct state. */
type RebaseBranchEvidence =
    | { status: "attached"; ref: string }
    | { status: "detached" }
    | { status: "unavailable"; message: string };

type ReconciledLiveManifest = LiveRebaseManifest & RebaseSessionManifest;

/**
 * Immutable evidence collected once for a repository before any reconciliation disposition is chosen.
 *
 * The marker-first selection is deliberately NOT carried here. The classifier derives it from this
 * snapshot alone, so a caller cannot hand it a precomputed ownership hint the evidence contradicts.
 */
export interface RebaseReconciliationEvidence {
    /** One physical rebase-directory snapshot, including marker and metadata when available. */
    rebaseDirectory: RebaseDirectoryEvidence;
    /** Every retained manifest result for the repository, including malformed files. */
    manifests: RebaseManifestListEntry[];
    /** Current HEAD object-id probe result. */
    head: RebaseHeadEvidence;
    /** Current symbolic branch probe result, or detached state. */
    branch: RebaseBranchEvidence;
}

/** Reasons that require retaining a manifest for a later user decision. */
type RebaseReconciliationAmbiguityReason =
    | `manifest-${RebaseManifestAmbiguousReason}`
    | "manifest-missing"
    | "rebase-directory-correlation-failed"
    | "rebase-directory-present"
    | "branch-unavailable-or-moved"
    | "head-unavailable"
    | "head-moved"
    | "pending-push-retained";

/** One manifest's pure reconciliation disposition. */
type RebaseSessionDisposition =
    | {
          /** A live session positively correlated to the active rebase directory. */
          status: "owned";
          sessionId: string;
      }
    | {
          /** No rebase directory remains and Git still proves the rebase never advanced. */
          status: "discard";
          sessionId: string;
      }
    | {
          /** State must remain untouched until a later user-facing decision. */
          status: "ambiguous";
          sessionId: string;
          reason: RebaseReconciliationAmbiguityReason;
      };

/** The full pure decision for one repository snapshot. */
export interface RebaseReconciliationResult {
    /** Active rebase control scope; only `owned` may receive IntelliGit message injection. */
    rebaseControl: RebaseControl | "none";
    /** One disposition for each manifest file observed in the repository storage namespace. */
    dispositions: RebaseSessionDisposition[];
}

/**
 * Collects a marker-first, repository-scoped snapshot without modifying Git or durable storage.
 *
 * The rebase directory and marker are read once before manifest selection. Git probe failures are
 * represented in the returned evidence so the pure classifier can default-deny rather than throw.
 */
export async function gatherRebaseReconciliationEvidence(
    dependencies: RebaseReconciliationDependencies,
    repoRoot: string,
): Promise<RebaseReconciliationEvidence> {
    const [rebaseDirectory, manifests, head, branch] = await Promise.all([
        readRebaseDirectoryEvidence(dependencies.gitDir),
        listRebaseManifests(dependencies.storageRoot, repoRoot),
        readCurrentHead(dependencies.executor),
        readCurrentBranch(dependencies.executor),
    ]);
    return { rebaseDirectory, manifests, head, branch };
}

/**
 * Classifies retained rebase session state using only an already-collected repository snapshot.
 *
 * This function performs no filesystem, Git, clock, or mutation work. Any missing, conflicting,
 * unreadable, detached, or mismatched evidence becomes an explicit ambiguous disposition.
 */
export function reconcileRebaseSessions(
    evidence: RebaseReconciliationEvidence,
): RebaseReconciliationResult {
    const liveManifests = selectLiveManifests(evidence.manifests);
    const selectedLiveManifest = selectMarkerMatchedLiveManifest(
        evidence.rebaseDirectory,
        evidence.manifests,
    );
    const markerControl = deriveRebaseControlFromEvidence({
        rebaseDirectory: evidence.rebaseDirectory,
        liveManifest: selectedLiveManifest,
        hasLiveManifest: liveManifests.length > 0,
    });
    const rebaseControl =
        markerControl === "owned" &&
        selectedLiveManifest &&
        !matchesRebaseDirectoryMetadata(evidence.rebaseDirectory, selectedLiveManifest)
            ? "foreign"
            : markerControl;
    const ownedSessionId = rebaseControl === "owned" ? selectedLiveManifest?.sessionId : undefined;
    const dispositions = evidence.manifests.map((entry) =>
        assertKnownRebaseSessionDisposition(
            classifyManifest(entry, evidence, rebaseControl, ownedSessionId),
        ),
    );
    return { rebaseControl, dispositions };
}

/** Reads current HEAD through the shared bounded Git text probe. */
async function readCurrentHead(
    executor: Pick<GitExecutor, "runBinary">,
): Promise<RebaseHeadEvidence> {
    try {
        return { status: "known", oid: await readGitText(executor, ["rev-parse", "HEAD"]) };
    } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
    }
}

/** Reads a symbolic branch while preserving Git's normal detached-HEAD exit status. */
async function readCurrentBranch(
    executor: Pick<GitExecutor, "runBinary">,
): Promise<RebaseBranchEvidence> {
    try {
        const ref = await readGitText(executor, ["symbolic-ref", "--quiet", "HEAD"], {
            expectedExitCodes: [0, 1],
        });
        return ref ? { status: "attached", ref } : { status: "detached" };
    } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
    }
}

/** Selects the one live manifest that positively answers to the captured marker. */
function selectMarkerMatchedLiveManifest(
    rebaseDirectory: RebaseDirectoryEvidence,
    manifests: RebaseManifestListEntry[],
): ReconciledLiveManifest | undefined {
    if (rebaseDirectory.status !== "merge" || !rebaseDirectory.marker) return undefined;
    return selectLiveManifests(manifests).find(
        (manifest) => manifest.sessionId === rebaseDirectory.marker,
    );
}

/** Extracts only valid, filename-correlated live manifests from hostile persisted state. */
function selectLiveManifests(manifests: RebaseManifestListEntry[]): ReconciledLiveManifest[] {
    return manifests.flatMap((entry) => {
        if (entry.result.status !== "valid") return [];
        const manifest = entry.result.manifest;
        return entry.sessionId === manifest.sessionId && isLiveManifest(manifest) ? [manifest] : [];
    });
}

/** Narrows lifecycle state before it can participate in rebase-directory ownership. */
function isLiveManifest(manifest: RebaseSessionManifest): manifest is ReconciledLiveManifest {
    return (
        manifest.lifecycle === "starting" ||
        manifest.lifecycle === "running" ||
        manifest.lifecycle === "paused"
    );
}

/** Requires all three Git metadata files before a marker match can claim the live directory. */
function matchesRebaseDirectoryMetadata(
    rebaseDirectory: RebaseDirectoryEvidence,
    manifest: RebaseSessionManifest,
): boolean {
    return (
        rebaseDirectory.status === "merge" &&
        rebaseDirectory.headName === manifest.branch &&
        rebaseDirectory.onto === manifest.baseHash &&
        rebaseDirectory.origHead === manifest.expectedHead
    );
}

/** Applies one manifest's matrix row after the repository-level directory decision is known. */
function classifyManifest(
    entry: RebaseManifestListEntry,
    evidence: RebaseReconciliationEvidence,
    rebaseControl: RebaseControl | "none",
    ownedSessionId: string | undefined,
): RebaseSessionDisposition {
    switch (entry.result.status) {
        case "ambiguous":
            return ambiguous(entry.sessionId, `manifest-${entry.result.reason}`);
        case "missing":
            return ambiguous(entry.sessionId, "manifest-missing");
        case "valid":
            return classifyValidManifest(
                entry.sessionId,
                entry.result.manifest,
                evidence,
                rebaseControl,
                ownedSessionId,
            );
        default:
            return assertNeverRebaseManifestReadResult(entry.result);
    }
}

/** Applies live ownership, no-directory deletion, and default-deny retention to valid state. */
function classifyValidManifest(
    sessionId: string,
    manifest: RebaseSessionManifest,
    evidence: RebaseReconciliationEvidence,
    rebaseControl: RebaseControl | "none",
    ownedSessionId: string | undefined,
): RebaseSessionDisposition {
    if (sessionId !== manifest.sessionId) return ambiguous(sessionId, "manifest-missing");
    if (rebaseControl === "owned" && ownedSessionId === manifest.sessionId) {
        return { status: "owned", sessionId: manifest.sessionId };
    }
    if (manifest.lifecycle === "completed-pending-push") {
        return classifyPendingPushManifest(manifest, evidence);
    }
    if (evidence.rebaseDirectory.status !== "none") {
        return ambiguous(
            manifest.sessionId,
            isLiveManifest(manifest)
                ? "rebase-directory-correlation-failed"
                : "rebase-directory-present",
        );
    }
    if (!isCurrentManifestBranch(evidence.branch, manifest)) {
        return ambiguous(manifest.sessionId, "branch-unavailable-or-moved");
    }
    if (evidence.head.status !== "known") return ambiguous(manifest.sessionId, "head-unavailable");
    return evidence.head.oid === manifest.expectedHead
        ? { status: "discard", sessionId: manifest.sessionId }
        : ambiguous(manifest.sessionId, "head-moved");
}

/** Retains pending-push state without rearming a push offer after the original live success path. */
function classifyPendingPushManifest(
    manifest: RebaseSessionManifest,
    evidence: RebaseReconciliationEvidence,
): RebaseSessionDisposition {
    if (!isCurrentManifestBranch(evidence.branch, manifest)) {
        return ambiguous(manifest.sessionId, "branch-unavailable-or-moved");
    }
    if (evidence.head.status !== "known") return ambiguous(manifest.sessionId, "head-unavailable");
    return evidence.head.oid === manifest.rebasedHeadOid
        ? ambiguous(manifest.sessionId, "pending-push-retained")
        : ambiguous(manifest.sessionId, "head-moved");
}

/** Checks the current symbolic branch without treating a same-tip branch switch as safe. */
function isCurrentManifestBranch(
    branch: RebaseBranchEvidence,
    manifest: RebaseSessionManifest,
): boolean {
    return branch.status === "attached" && branch.ref === manifest.branch;
}

/** Builds an explicit default-deny disposition without changing durable state. */
function ambiguous(
    sessionId: string,
    reason: RebaseReconciliationAmbiguityReason,
): RebaseSessionDisposition {
    return { status: "ambiguous", sessionId, reason };
}

/** Forces callers that inspect a disposition to handle every member of its discriminated union. */
function assertKnownRebaseSessionDisposition(
    disposition: RebaseSessionDisposition,
): RebaseSessionDisposition {
    switch (disposition.status) {
        case "owned":
        case "discard":
        case "ambiguous":
            return disposition;
        default:
            return assertNeverRebaseSessionDisposition(disposition);
    }
}

/** Preserves exhaustiveness when a new session disposition is added to the reconciliation matrix. */
function assertNeverRebaseSessionDisposition(disposition: never): never {
    void disposition;
    throw new Error("Unhandled interactive rebase reconciliation disposition.");
}

/** Preserves exhaustiveness when persisted read-result variants change. */
function assertNeverRebaseManifestReadResult(result: never): never {
    void result;
    throw new Error("Unhandled interactive rebase manifest read result.");
}
