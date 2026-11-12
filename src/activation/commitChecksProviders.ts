import { BitbucketCloudProvider } from "../services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../services/commitChecks/bitbucketServerProvider";
import type { CiGenerations } from "../services/commitChecks/ciGenerations";
import type { CredentialStore } from "../services/commitChecks/credentialStore";
import { EtagStore } from "../services/commitChecks/etagStore";
import { GitHubProvider } from "../services/commitChecks/githubProvider";
import { GitLabProvider } from "../services/commitChecks/gitlabProvider";
import {
    createHttpGetJson,
    downloadCiLog,
    type DownloadCiLog,
    type FetchJson,
} from "../services/commitChecks/http";
import {
    type CommitChecksRequestGateRegistry,
    gatedFetchWithMeta,
} from "../services/commitChecks/requestGate";
import type { CommitChecksProvider, ProviderId } from "../services/commitChecks/types";

/**
 * Builds every commit-check provider with each of its requests sent through the shared gate.
 *
 * @param requestGateRegistry - The gate every provider's requests run through.
 * @param credentialStore - Tokens for the providers that read them from the store.
 * @param ciCdPattern - The user's CI/CD check-name pattern, if any.
 * @param generations - Its auth generation keys the window's conditional-request store, so a
 *   sign-in change never reuses a body read with another token.
 */
export function createCommitChecksProviders(
    requestGateRegistry: CommitChecksRequestGateRegistry,
    credentialStore: CredentialStore,
    ciCdPattern: RegExp | undefined,
    generations: CiGenerations,
): readonly CommitChecksProvider[] {
    const etags = new EtagStore(() => generations.capture("").authGeneration);
    const fetchFor =
        (providerId: ProviderId): FetchJson =>
        (url, headers) =>
            requestGateRegistry.run(providerId, url, (generation) => {
                const fetchJson = createHttpGetJson((response) => {
                    requestGateRegistry.observeResponse(providerId, response, generation);
                });
                return fetchJson(url, headers);
            });
    const downloadFor =
        (providerId: ProviderId): DownloadCiLog =>
        (url, headers, signal) =>
            requestGateRegistry.run(providerId, url, () => downloadCiLog(url, headers, signal));
    return [
        new GitHubProvider(
            fetchFor("github"),
            ciCdPattern,
            gatedFetchWithMeta(requestGateRegistry, "github"),
            (url) => requestGateRegistry.cooldownEnd("github", url),
            etags,
            downloadFor("github"),
        ),
        new GitLabProvider(
            fetchFor("gitlab"),
            credentialStore,
            ciCdPattern,
            gatedFetchWithMeta(requestGateRegistry, "gitlab"),
            (url) => requestGateRegistry.cooldownEnd("gitlab", url),
            etags,
            downloadFor("gitlab"),
        ),
        new BitbucketCloudProvider(
            fetchFor("bitbucket-cloud"),
            credentialStore,
            gatedFetchWithMeta(requestGateRegistry, "bitbucket-cloud"),
            etags,
        ),
        new BitbucketServerProvider(
            fetchFor("bitbucket-server"),
            credentialStore,
            gatedFetchWithMeta(requestGateRegistry, "bitbucket-server"),
            etags,
        ),
    ];
}
