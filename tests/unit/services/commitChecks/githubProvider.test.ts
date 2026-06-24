import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { FetchJson } from "../../../../src/services/commitChecks/http";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
}));

vi.mock("vscode", () => ({
    authentication: {
        getSession: mocks.getSession,
    },
    l10n: {
        t: interpolateL10n,
    },
}));

import {
    GitHubProvider,
    normalizeGithubChecks,
    parseGithubRemoteUrl,
} from "../../../../src/services/commitChecks/githubProvider";

// Carries owner/repo like a real GitHubRepoRef; the upcast to the narrower ProviderRepoRef
// is what the coordinator does in practice (the provider casts back internally).
const githubRef = { host: "github.com", owner: "owner", repo: "repo" } as ProviderRepoRef;

function fetchReturning(byUrl: (url: string) => unknown): FetchJson {
    return vi.fn(async (url: string) => byUrl(url));
}

describe("GitHubProvider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
    });

    it("parses common GitHub remote URLs and rejects other hosts", () => {
        expect(parseGithubRemoteUrl("https://github.com/owner/repo.git")).toMatchObject({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("git@github.com:owner/repo.git")).toMatchObject({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("ssh://git@github.com/owner/repo.git")).toMatchObject({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("https://gitlab.com/owner/repo.git")).toBeNull();
        expect(parseGithubRemoteUrl("https://github.com/owner/group/repo.git")).toBeNull();
        expect(parseGithubRemoteUrl("not a url")).toBeNull();
    });

    it("match returns a ref for github remotes and null otherwise", () => {
        const provider = new GitHubProvider(vi.fn());
        expect(provider.match("git@github.com:owner/repo.git", {})).toMatchObject({
            host: "github.com",
            owner: "owner",
            repo: "repo",
        });
        expect(provider.match("https://gitlab.com/owner/repo.git", {})).toBeNull();
    });

    it("normalizes check runs and commit statuses into one snapshot", () => {
        const snapshot = normalizeGithubChecks(
            "abc1234",
            {
                check_runs: [
                    {
                        name: "CI - Build & Release / build",
                        status: "completed",
                        conclusion: "success",
                        html_url: "https://github.com/owner/repo/actions/runs/1",
                        output: { summary: "Build passed" },
                    },
                    {
                        name: "Code Review Skipped",
                        status: "completed",
                        conclusion: "skipped",
                        output: { title: "Review skipped" },
                    },
                    {
                        name: "CodeRabbit",
                        status: "completed",
                        conclusion: "success",
                        output: { summary: "Review completed" },
                    },
                ],
            },
            [
                {
                    context: "GitGuardian Security Checks",
                    state: "success",
                    description: "No secrets detected",
                    target_url: "https://example.test/security",
                },
            ],
        );

        expect(snapshot.state).toBe("success");
        expect(snapshot.summary).toBe("All checks passed");
        expect(snapshot.items.map((item) => item.name)).toEqual([
            "CI - Build & Release / build",
            "GitGuardian Security Checks",
        ]);
        expect(snapshot.items[1].state).toBe("success");
    });

    it("does not aggregate unknown check-run conclusions as success", () => {
        const snapshot = normalizeGithubChecks(
            "abc1234",
            {
                check_runs: [
                    {
                        name: "CI / deploy",
                        status: "completed",
                        conclusion: "unexpected",
                    },
                ],
            },
            [],
        );

        expect(snapshot.state).toBe("unknown");
        expect(snapshot.state).not.toBe("success");
    });

    it("summarizes mixed successful and skipped CI checks", () => {
        const snapshot = normalizeGithubChecks(
            "abc1234",
            {
                check_runs: [
                    {
                        name: "CI - Build & Release / build",
                        status: "completed",
                        conclusion: "success",
                    },
                    {
                        name: "CI - Build & Release / release",
                        status: "completed",
                        conclusion: "skipped",
                        output: { title: "Release skipped" },
                    },
                ],
            },
            [],
        );

        expect(snapshot.state).toBe("success");
        expect(snapshot.summary).toBe("Release skipped");
        expect(snapshot.items.map((item) => item.state)).toEqual(["success", "skipped"]);
    });

    it("normalizes pending and failed CI states", () => {
        const snapshot = normalizeGithubChecks(
            "abc1234",
            {
                check_runs: [
                    {
                        name: "CI / deploy",
                        status: "queued",
                        output: { title: "Queued" },
                    },
                ],
            },
            {
                statuses: [
                    {
                        context: "lint",
                        state: "error",
                        description: "lint failed",
                    },
                    {
                        context: "workflow",
                        state: "pending",
                    },
                ],
            },
        );

        expect(snapshot.state).toBe("failure");
        expect(snapshot.summary).toBe("Checks failed");
        expect(snapshot.items.map((item) => item.state)).toEqual(["pending", "failure", "pending"]);
    });

    it("fetches both endpoints with auth and returns none for empty checks", async () => {
        const fetchJson = fetchReturning((url) =>
            url.includes("/check-runs") ? { check_runs: [] } : [],
        );
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("none");
        expect(mocks.getSession).toHaveBeenCalledWith("github", ["repo"], { createIfNone: true });
        expect(fetchJson).toHaveBeenCalledTimes(2);
        const calledUrls = (fetchJson as ReturnType<typeof vi.fn>).mock.calls.map(
            (call) => call[0] as string,
        );
        expect(calledUrls[0]).toBe(
            "https://api.github.com/repos/owner/repo/commits/abc1234/check-runs?per_page=100",
        );
        expect(calledUrls[1]).toBe(
            "https://api.github.com/repos/owner/repo/commits/abc1234/statuses?per_page=100",
        );
        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers.Authorization).toBe("Bearer gh-token");
    });

    it("treats unexpected API shapes (no check_runs / non-array statuses) as none", async () => {
        // Both endpoints return objects without the expected arrays; guards must not throw.
        const provider = new GitHubProvider(fetchReturning(() => ({})));

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("none");
        expect(snapshot.items).toEqual([]);
    });

    it("returns unavailable when GitHub auth fails and never fetches", async () => {
        mocks.getSession.mockRejectedValue(new Error("login cancelled"));
        const fetchJson = vi.fn();
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toBe("GitHub authentication failed: login cancelled");
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("returns unavailable only when BOTH endpoints reject", async () => {
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new Error("network down");
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toBe("network down");
    });

    it("still normalizes when only one endpoint rejects", async () => {
        const fetchJson: FetchJson = vi.fn(async (url: string) => {
            if (url.includes("/statuses")) throw new Error("statuses 500");
            return {
                check_runs: [{ name: "CI / build", status: "completed", conclusion: "success" }],
            };
        });
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("success");
        expect(snapshot.items).toHaveLength(1);
    });
});
