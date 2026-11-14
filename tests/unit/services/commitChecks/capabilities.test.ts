import { describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import type { CommitChecksSnapshot } from "../../../../src/types";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

import {
    NO_CI_CAPABILITIES,
    type ProviderCiCapabilities,
} from "../../../../src/shared/ci/capabilities";
import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import type { FetchJson } from "../../../../src/services/commitChecks/http";

const FLAGS: readonly (keyof ProviderCiCapabilities)[] = [
    "runs",
    "jobs",
    "steps",
    "runHeader",
    "logs",
    "failureSummary",
    "annotations",
    "rerunFailed",
    "rerunJob",
    "cancel",
    "requiredChecks",
    "optionalJobs",
    "usualDuration",
    "attemptHistory",
];

describe("provider capabilities", () => {
    it("each provider declares only the flags its landed phases implement", () => {
        const fetch: FetchJson = vi.fn();
        const store = {} as CredentialStore;
        // Phase 2: GitHub reads runs, jobs, steps and the run header. Phase 3: GitLab reads
        // pipelines, jobs and the pipeline header; its API has no steps. Phase 7: both read
        // job logs and failure summaries. Phase 8: both re-run failed jobs, re-run one job and
        // cancel a run, and explain a refused write with their own scope help.
        const write = ["rerunFailed", "rerunJob", "cancel"] as const;
        const landed: Record<string, readonly (keyof ProviderCiCapabilities)[]> = {
            github: ["runs", "jobs", "steps", "runHeader", "logs", "failureSummary", ...write],
            gitlab: ["runs", "jobs", "runHeader", "logs", "failureSummary", ...write],
        };
        const scopeHelp: Record<string, string> = {
            github: "commit.checks.tab.writeScopeHelpGithub",
            gitlab: "commit.checks.tab.writeScopeHelpGitlab",
        };
        const providers: CommitChecksProvider[] = [
            new GitHubProvider(fetch),
            new GitLabProvider(fetch, store),
            new BitbucketCloudProvider(fetch, store),
            new BitbucketServerProvider(fetch, store),
        ];
        for (const provider of providers) {
            const on = landed[provider.id] ?? [];
            for (const flag of FLAGS) {
                expect(provider.capabilities[flag], `${provider.id}.${flag}`).toBe(
                    on.includes(flag),
                );
            }
            expect(provider.capabilities.writeScopeHelp, provider.id).toBe(scopeHelp[provider.id]);
            expect(
                provider.capabilities.rerunFailedLabel,
                `${provider.id}: only GitLab's retry also restarts canceled jobs`,
            ).toBe(
                provider.id === "gitlab" ? "commit.checks.tab.rerunFailedAndCanceled" : undefined,
            );
            expect(provider.runAction === undefined, `${provider.id}.runAction`).toBe(
                !on.includes("cancel"),
            );
            expect(provider.getDetail === undefined, `${provider.id}.getDetail`).toBe(
                on.length === 0,
            );
            expect(Object.isFrozen(provider.capabilities), provider.id).toBe(true);
        }
        expect(Object.keys(NO_CI_CAPABILITIES).sort()).toEqual([...FLAGS].sort());
    });

    it("floor detail carries the provider's capabilities", async () => {
        const snapshot: CommitChecksSnapshot = {
            hash: "abc1234",
            state: "failure",
            summary: "Checks failed",
            items: [
                {
                    name: "build",
                    description: "Build failed",
                    state: "failure",
                    source: "status",
                    url: "https://ci.example.com/1",
                    id: "ci/build",
                },
                { name: "lint", description: "", state: "pending", source: "check-run" },
            ],
        };
        const capabilities: ProviderCiCapabilities = { ...NO_CI_CAPABILITIES, usualDuration: true };
        const provider: CommitChecksProvider = {
            id: "bitbucket-server",
            capabilities,
            match: () => ({ host: "git.acme.com" }),
            keyFor: (ref: ProviderRepoRef) => `bitbucket-server:${ref.host}`,
            getChecks: vi.fn(async () => snapshot),
        };
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => "https://git.acme.com/scm/p/r.git"),
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(gitOps, [provider]);

        const detail = await coordinator.getDetail(
            "abc1234",
            {},
            { repoKey: "/repo", authGeneration: 0, lifecycleGeneration: 0 },
        );

        expect(detail?.capabilities).toEqual(capabilities);
        expect(detail).toMatchObject({
            hash: "abc1234",
            provider: "bitbucket-server",
            repoKey: "/repo",
            complete: false,
            outcome: "failure",
            runs: [],
            runsCoverage: "full",
            otherChecksCoverage: "full",
        });
        expect(detail?.otherChecks).toEqual([
            {
                id: "ci/build",
                name: "build",
                description: "Build failed",
                state: "failure",
                source: "status",
                url: "https://ci.example.com/1",
            },
            { name: "lint", description: "", state: "pending", source: "check-run" },
        ]);
    });
});
