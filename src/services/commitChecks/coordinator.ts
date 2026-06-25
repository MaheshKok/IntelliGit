// Coordinates commit-check providers for one repository. On every request it
// re-resolves Git remotes (the active repo can change at runtime), picks the first
// matching provider (origin first), and caches the resulting snapshot per commit
// hash. Terminal snapshots are served from cache; pending/none states are re-fetched
// so a just-pushed or still-running commit settles without a manual refresh.

import * as vscode from "vscode";
import type { GitOps } from "../../git/operations";
import type { CommitChecksSnapshot } from "../../types";
import { isPendingCheckState } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { unavailableSnapshot } from "./normalize";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";

interface ProviderMatch {
    provider: CommitChecksProvider;
    ref: ProviderRepoRef;
}

/** Resolves a provider per request and caches commit-check snapshots by hash. */
export class CommitChecksCoordinator {
    private readonly cache = new Map<string, CommitChecksSnapshot>();

    /**
     * Builds a coordinator over an ordered provider registry for one repository.
     *
     * @param gitOps - Active repository Git facade; remotes are read on every request.
     * @param providers - Ordered provider registry; first match wins for a given remote.
     * @param hostMap - Self-hosted host to provider-id overrides (empty for GitHub-only).
     */
    constructor(
        private readonly gitOps: GitOps,
        private readonly providers: readonly CommitChecksProvider[],
        private readonly hostMap: HostMap = {},
    ) {}

    /** Drops all cached snapshots; called when the active repository changes. */
    clear(): void {
        this.cache.clear();
    }

    /** Returns the snapshot for a commit, serving a terminal cache hit or re-fetching. */
    async getChecks(hash: string): Promise<CommitChecksSnapshot> {
        const cached = this.cache.get(hash);
        if (cached && !isPendingCheckState(cached.state)) {
            return cached;
        }
        const snapshot = await this.fetchFresh(hash);
        this.cache.set(hash, snapshot);
        return snapshot;
    }

    private async fetchFresh(hash: string): Promise<CommitChecksSnapshot> {
        const match = await this.resolveProvider();
        if (!match) {
            // No registered provider matched any remote (GitHub, GitLab, ...).
            return unavailableSnapshot(hash, vscode.l10n.t("No supported remote found."));
        }
        try {
            return await match.provider.getChecks(match.ref, hash);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
    }

    private async resolveProvider(): Promise<ProviderMatch | null> {
        const remotes = await this.gitOps.getRemotes();
        const ordered = remotes.includes("origin")
            ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
            : remotes;
        for (const remote of ordered) {
            const url = await this.gitOps.getRemoteUrl(remote);
            if (!url) continue;
            for (const provider of this.providers) {
                const ref = provider.match(url, this.hostMap);
                if (ref) return { provider, ref };
            }
        }
        return null;
    }
}
