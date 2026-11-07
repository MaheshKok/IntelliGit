import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { FetchJson } from "../../../../src/services/commitChecks/http";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: { t: (message: string) => message },
}));

import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";

const fetchJson: FetchJson = vi.fn(async () => ({}));

function secrets(): vscode.SecretStorage & { tokens: Map<string, string>; failing: boolean } {
    const tokens = new Map<string, string>();
    const storage = {
        tokens,
        failing: false,
        get: vi.fn(async (key: string) => {
            if (storage.failing) throw new Error("keychain locked");
            return tokens.get(key);
        }),
        store: vi.fn(async (key: string, value: string) => {
            tokens.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
            tokens.delete(key);
        }),
        keys: vi.fn(async () => [...tokens.keys()]),
        onDidChange: vi.fn(),
    };
    return storage as unknown as vscode.SecretStorage & {
        tokens: Map<string, string>;
        failing: boolean;
    };
}

async function accountKey(provider: CommitChecksProvider, ref: ProviderRepoRef) {
    expect(provider.accountKey).toBeTypeOf("function");
    return provider.accountKey!(ref);
}

describe("provider accountKey", () => {
    it("GitHub keys by the signed-in account: same account same key, another account or sign-out another key", async () => {
        const provider = new GitHubProvider(fetchJson);
        const ref = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;
        mocks.getSession.mockResolvedValue({ accessToken: "t1", account: { id: "1" } });
        const first = await accountKey(provider, ref);
        mocks.getSession.mockResolvedValue({ accessToken: "t2", account: { id: "1" } });
        expect(await accountKey(provider, ref)).toBe(first);
        mocks.getSession.mockResolvedValue({ accessToken: "t3", account: { id: "2" } });
        expect(await accountKey(provider, ref)).not.toBe(first);
        mocks.getSession.mockResolvedValue(undefined);
        const signedOut = await accountKey(provider, ref);
        expect(signedOut).not.toBe(first);
        expect(mocks.getSession).toHaveBeenLastCalledWith("github", ["repo"], { silent: true });
    });

    it("GitHub: a failed session lookup never yields a key another lookup shares", async () => {
        const provider = new GitHubProvider(fetchJson);
        const ref = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;
        mocks.getSession.mockRejectedValue(new Error("auth down"));
        const a = await accountKey(provider, ref);
        const b = await accountKey(provider, ref);
        expect(a).not.toBe(b);
    });

    for (const [name, create, host] of [
        ["GitLab", (store: CredentialStore) => new GitLabProvider(fetchJson, store), "gitlab.com"],
        [
            "Bitbucket Cloud",
            (store: CredentialStore) => new BitbucketCloudProvider(fetchJson, store),
            "bitbucket.org",
        ],
        [
            "Bitbucket Server",
            (store: CredentialStore) => new BitbucketServerProvider(fetchJson, store),
            "git.acme.com",
        ],
    ] as const) {
        it(`${name} keys by the stored token without writing the token`, async () => {
            const storage = secrets();
            const store = new CredentialStore(storage);
            const provider = create(store);
            const ref = { host } as ProviderRepoRef;
            const signedOut = await accountKey(provider, ref);
            await store.set(host, "first-secret-token-value");
            const first = await accountKey(provider, ref);
            expect(await accountKey(provider, ref)).toBe(first);
            await store.set(host, "second-secret-token-value");
            const second = await accountKey(provider, ref);

            expect(new Set([signedOut, first, second]).size).toBe(3);
            for (const key of [first, second]) {
                expect(key).not.toContain("secret");
                expect(key).not.toContain("token-value");
            }

            storage.failing = true;
            expect(await accountKey(provider, ref)).not.toBe(await accountKey(provider, ref));
        });
    }
});
