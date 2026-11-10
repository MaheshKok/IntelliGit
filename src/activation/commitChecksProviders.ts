import { BitbucketCloudProvider } from "../services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../services/commitChecks/bitbucketServerProvider";
import type { CredentialStore } from "../services/commitChecks/credentialStore";
import { GitHubProvider } from "../services/commitChecks/githubProvider";
import { GitLabProvider } from "../services/commitChecks/gitlabProvider";
import { createHttpGetJson, type FetchJson } from "../services/commitChecks/http";
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
 */
export function createCommitChecksProviders(
    requestGateRegistry: CommitChecksRequestGateRegistry,
    credentialStore: CredentialStore,
    ciCdPattern: RegExp | undefined,
): readonly CommitChecksProvider[] {
    const fetchFor =
        (providerId: ProviderId): FetchJson =>
        (url, headers) =>
            requestGateRegistry.run(providerId, url, (generation) => {
                const fetchJson = createHttpGetJson((response) => {
                    requestGateRegistry.observeResponse(providerId, response, generation);
                });
                return fetchJson(url, headers);
            });
    return [
        new GitHubProvider(
            fetchFor("github"),
            ciCdPattern,
            gatedFetchWithMeta(requestGateRegistry, "github"),
            (url) => requestGateRegistry.cooldownEnd("github", url),
        ),
        new GitLabProvider(fetchFor("gitlab"), credentialStore, ciCdPattern),
        new BitbucketCloudProvider(fetchFor("bitbucket-cloud"), credentialStore),
        new BitbucketServerProvider(fetchFor("bitbucket-server"), credentialStore),
    ];
}
