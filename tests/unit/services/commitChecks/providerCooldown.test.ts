import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { HttpError } from "../../../../src/services/commitChecks/http";

vi.mock("vscode", () => ({
    authentication: { getSession: vi.fn() },
    l10n: { t: (message: string) => message },
}));

import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { CommitChecksRequestGateRegistry } from "../../../../src/services/commitChecks/requestGate";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

const store = {} as CredentialStore;

/** The cooldown end the HEAD monitor reads for a repository, as activation wires it. */
function headCooldown(
    registry: CommitChecksRequestGateRegistry,
    provider: CommitChecksProvider,
    ref: ProviderRepoRef,
): number {
    const url = provider.apiUrl?.(ref);
    if (!url) throw new Error("provider names no request bucket");
    return registry.cooldownEnd(provider.id, url);
}

describe("request bucket of a repository for the HEAD monitor", () => {
    it("a GitLab cooldown does not pause an unrelated GitHub repository, and the reverse", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        const github = new GitHubProvider();
        const gitlab = new GitLabProvider(vi.fn(), store);
        const githubRef = github.match("https://github.com/o/r.git", {});
        const gitlabRef = gitlab.match("https://gitlab.com/o/r.git", {});
        if (!githubRef || !gitlabRef) throw new Error("no match");
        await expect(
            registry.run("gitlab", "https://gitlab.com/api/v4/projects/o%2Fr", async () => {
                throw new HttpError(429, "HTTP 429", { "retry-after": "60" });
            }),
        ).rejects.toThrow();
        expect(headCooldown(registry, gitlab, gitlabRef)).toBe(61_000);
        expect(headCooldown(registry, github, githubRef)).toBe(0);

        const other = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        await expect(
            other.run("github", "https://api.github.com/repos/o/r", async () => {
                throw new HttpError(429, "HTTP 429", { "retry-after": "120" });
            }),
        ).rejects.toThrow();
        expect(headCooldown(other, github, githubRef)).toBe(121_000);
        expect(headCooldown(other, gitlab, gitlabRef)).toBe(0);
    });

    it("a cooldown on one self-hosted host does not pause another host of the same provider", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        const gitlab = new GitLabProvider(vi.fn(), store);
        const hosts = { "gitlab.one.test": "gitlab", "gitlab.two.test": "gitlab" } as const;
        const one = gitlab.match("https://gitlab.one.test/o/r.git", hosts);
        const two = gitlab.match("https://gitlab.two.test/o/r.git", hosts);
        if (!one || !two) throw new Error("no match");
        await expect(
            registry.run("gitlab", gitlab.apiUrl(one), async () => {
                throw new HttpError(429, "HTTP 429", { "retry-after": "60" });
            }),
        ).rejects.toThrow();
        expect(headCooldown(registry, gitlab, one)).toBe(61_000);
        expect(headCooldown(registry, gitlab, two)).toBe(0);
    });

    it("both Bitbucket providers name the bucket their requests use", () => {
        const cloud = new BitbucketCloudProvider(vi.fn(), store);
        const server = new BitbucketServerProvider(vi.fn(), store);
        const cloudRef = cloud.match("https://bitbucket.org/w/r.git", {});
        const serverRef = server.match("https://bb.example.test/scm/p/r.git", {
            "bb.example.test": "bitbucket-server",
        });
        if (!cloudRef || !serverRef) throw new Error("no match");
        expect(new URL(cloud.apiUrl()).origin).toBe("https://api.bitbucket.org");
        expect(new URL(server.apiUrl(serverRef)).origin).toBe("https://bb.example.test");
    });
});
