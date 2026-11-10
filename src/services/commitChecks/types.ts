// Provider seam for commit-check hosts. Each provider matches a Git remote URL to a
// repository reference and fetches a normalized snapshot for one commit hash. The
// coordinator owns remote resolution and caching; providers stay stateless and
// host-specific.

import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import type { CiJob, CommitChecksSnapshot, CommitCiDetailData, ProviderId } from "../../types";
import type { CiOperationContext } from "./ciGenerations";

export type { ProviderId } from "../../types";

/** Maps a self-hosted Git host (e.g. "git.acme.com") to the provider that serves it. */
export type HostMap = Record<string, ProviderId>;

/**
 * Opaque repository reference produced by a provider's `match` and consumed by its own
 * `getChecks`. The base only guarantees the host; each provider narrows it internally
 * (owner/repo, projectPath, workspace/repo, ...).
 */
export interface ProviderRepoRef {
    readonly host: string;
}

/**
 * Where the scan for failed jobs past the page bound continues.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiFailedScanCursor {
    readonly runId: string;
    readonly runAttempt?: number;
    readonly url: string;
}

/**
 * One page of the failed-job overflow scan, or the reason it could not be read.
 *
 * @public consumed by later CI tab phases.
 */
export type CiFailedScanPage =
    { readonly failed: CiJob[]; readonly next?: CiFailedScanCursor } | { readonly error: string };

/** A commit-check host integration: detection plus per-commit fetch. */
export interface CommitChecksProvider {
    readonly id: ProviderId;
    /** What this provider can show or do; attached to every served detail at read time. */
    readonly capabilities: ProviderCiCapabilities;
    /** Returns a repo reference when this provider serves the remote, else null. */
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null;
    /** Returns a stable provider-scoped repository identity for shared caching. */
    keyFor(ref: ProviderRepoRef): string;
    /**
     * Returns a token-free id of the account this provider signs in with for `ref`, so a
     * cached result is only ever served to the account that fetched it. A failed lookup
     * returns an id no other lookup shares. Must not throw.
     */
    accountKey?(ref: ProviderRepoRef): Promise<string>;
    /** Fetches and normalizes the check snapshot for one commit hash. Must not throw. */
    getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot>;
    /**
     * Fetches the run, job and step detail for one commit. Must not throw: failures are
     * an `unavailable` outcome. Absent = the coordinator builds a flat detail from the
     * snapshot.
     */
    getDetail?(
        ref: ProviderRepoRef,
        hash: string,
        ctx: CiOperationContext,
    ): Promise<CommitCiDetailData>;
    /** Reads the next page of failed jobs past the page bound. Must not throw. */
    continueFailedScan?(
        ref: ProviderRepoRef,
        cursor: CiFailedScanCursor,
        ctx: CiOperationContext,
    ): Promise<CiFailedScanPage>;
    /** Continuation guard: true only for a next-page URL under this provider's API base. */
    allowNext?(ref: ProviderRepoRef, url: string): boolean;
}
