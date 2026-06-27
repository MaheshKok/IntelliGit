// Provider seam for commit-check hosts. Each provider matches a Git remote URL to a
// repository reference and fetches a normalized snapshot for one commit hash. The
// coordinator owns remote resolution and caching; providers stay stateless and
// host-specific.

import type { CommitChecksSnapshot } from "../../types";

/** Identifier for a supported commit-check host. */
export type ProviderId = "github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server";

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

/** A commit-check host integration: detection plus per-commit fetch. */
export interface CommitChecksProvider {
    readonly id: ProviderId;
    /** Returns a repo reference when this provider serves the remote, else null. */
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null;
    /** Fetches and normalizes the check snapshot for one commit hash. Must not throw. */
    getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot>;
}
