import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import { HttpError, type FetchJson } from "../../../../src/services/commitChecks/http";
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

    it("builds a stable lowercase cache key", () => {
        const provider = new GitHubProvider(vi.fn());

        expect(
            provider.keyFor({
                host: "GitHub.com",
                owner: "Owner",
                repo: "Repo",
            } as ProviderRepoRef),
        ).toBe("github:github.com:owner/repo");
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
        expect(mocks.getSession).toHaveBeenCalledWith("github", ["repo"], { silent: true });
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
        for (const call of (fetchJson as ReturnType<typeof vi.fn>).mock.calls) {
            const headers = call[1] as Record<string, string>;
            expect(headers.Authorization).toBe("Bearer gh-token");
        }
    });

    it("fetches every page of GitHub check runs and combined statuses", async () => {
        const checkRuns = Array.from({ length: 101 }, (_, index) => ({
            name: `CI / check ${index}`,
            status: "completed",
            conclusion: "success",
        }));
        const statuses = Array.from({ length: 101 }, (_, index) => ({
            context: `CI status ${index}`,
            state: "success",
        }));
        const fetchJson = fetchReturning((url) => {
            const parsed = new URL(url);
            const page = Number(parsed.searchParams.get("page") ?? "1");
            const start = (page - 1) * 100;
            if (parsed.pathname.endsWith("/check-runs")) {
                return {
                    total_count: checkRuns.length,
                    check_runs: checkRuns.slice(start, start + 100),
                };
            }
            return {
                state: "success",
                total_count: statuses.length,
                statuses: statuses.slice(start, start + 100),
            };
        });
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.items).toHaveLength(202);
        expect(fetchJson).toHaveBeenCalledTimes(4);
        const calledUrls = (fetchJson as ReturnType<typeof vi.fn>).mock.calls.map(
            (call) => call[0] as string,
        );
        expect(calledUrls).toEqual(
            expect.arrayContaining([
                "https://api.github.com/repos/owner/repo/commits/abc1234/check-runs?per_page=100&filter=latest&page=1",
                "https://api.github.com/repos/owner/repo/commits/abc1234/check-runs?per_page=100&filter=latest&page=2",
                "https://api.github.com/repos/owner/repo/commits/abc1234/status?per_page=100&page=1",
                "https://api.github.com/repos/owner/repo/commits/abc1234/status?per_page=100&page=2",
            ]),
        );
        expect(calledUrls.some((url) => url.includes("/statuses?"))).toBe(false);
        expect(calledUrls.some((url) => url.includes("page=3"))).toBe(false);
    });

    it("uses GitHub's combined status so old pending history cannot keep a completed context pending", async () => {
        const fetchJson = fetchReturning((url) => {
            if (url.includes("/check-runs")) return { total_count: 0, check_runs: [] };
            if (url.includes("/statuses?")) {
                return [
                    { context: "CI / build", state: "success" },
                    { context: "CI / build", state: "pending" },
                ];
            }
            return {
                state: "success",
                total_count: 1,
                statuses: [{ context: "CI / build", state: "success" }],
            };
        });
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("success");
        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0]).toMatchObject({ name: "CI / build", state: "success" });
        const calledUrls = (fetchJson as ReturnType<typeof vi.fn>).mock.calls.map(
            (call) => call[0] as string,
        );
        expect(calledUrls.some((url) => url.includes("/statuses?"))).toBe(false);
    });

    it("discards an endpoint's earlier pages when a later page fails", async () => {
        const firstPageChecks = Array.from({ length: 100 }, (_, index) => ({
            name: `CI / check ${index}`,
            status: "completed",
            conclusion: "success",
        }));
        const fetchJson = vi.fn(async (url: string) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/check-runs")) {
                if (parsed.searchParams.get("page") === "2") throw new Error("page 2 failed");
                return { total_count: 101, check_runs: firstPageChecks };
            }
            return {
                state: "success",
                total_count: 1,
                statuses: [{ context: "CI / status", state: "success" }],
            };
        });
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("success");
        expect(snapshot.items).toEqual([
            expect.objectContaining({ name: "CI / status", state: "success" }),
        ]);
    });

    it("keeps sign-in recovery when a later page rejects the GitHub session", async () => {
        const firstPageChecks = Array.from({ length: 100 }, (_, index) => ({
            name: `CI / check ${index}`,
            status: "completed",
            conclusion: "success",
        }));
        const fetchJson = vi.fn(async (url: string) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/check-runs")) {
                if (parsed.searchParams.get("page") === "2") {
                    throw new HttpError(401, "HTTP 401: Bad credentials", {});
                }
                return { total_count: 101, check_runs: firstPageChecks };
            }
            throw new Error("status endpoint failed");
        });
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.signInHost).toBe("github.com");
    });

    it("does not prompt or fetch when no GitHub session already exists", async () => {
        mocks.getSession.mockResolvedValue(undefined);
        const fetchJson = vi.fn();
        const provider = new GitHubProvider(fetchJson);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("none");
        expect(snapshot.items).toEqual([]);
        expect(mocks.getSession).toHaveBeenCalledWith("github", ["repo"], { silent: true });
        expect(fetchJson).not.toHaveBeenCalled();
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

    it("redacts the session token from the error it posts when both endpoints reject", async () => {
        // HttpError embeds the first 200 bytes of the response body, so an intercepting proxy
        // whose error page echoes the request headers puts the token straight into the snapshot.
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new Error("HTTP 502: upstream echoed the request headers, sent=gh-token");
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).not.toContain("gh-token");
        expect(snapshot.error).toContain("***");
    });

    it("offers a sign-in recovery badge when the session token is rejected", async () => {
        // Parity with GitLab and both Bitbucket providers: a rejected credential yields a
        // snapshot carrying signInHost, which is the only thing that renders the popover's
        // "Sign in" button. Without it a revoked GitHub session is a dead-end error badge.
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new HttpError(401, "HTTP 401: Bad credentials", {});
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.signInHost).toBe("github.com");
    });

    it("offers sign-in for a 403 that is a missing scope rather than an exhausted quota", async () => {
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new HttpError(403, "HTTP 403: Resource not accessible", {
                    "x-ratelimit-remaining": "4321",
                });
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.signInHost).toBe("github.com");
    });

    it("does not offer sign-in when a 403 is an exhausted rate limit", async () => {
        // GitHub answers a spent primary quota with 403 and x-ratelimit-remaining: 0 -- the
        // same pair requestGate keys its backoff on. Signing in again does not refill a
        // quota, so a "Sign in" button here sends the user somewhere that cannot help.
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new HttpError(403, "HTTP 403: API rate limit exceeded", {
                    "x-ratelimit-remaining": "0",
                });
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.signInHost).toBeUndefined();
        expect(snapshot.error).toContain("rate limit exceeded");
    });

    it("offers sign-in when only one of the two endpoints reports a rejected credential", async () => {
        // The two endpoints settle independently, so a 401 can arrive on either side while
        // the other fails for an unrelated reason. Reading only the first would report the
        // transport error and hide the actionable one.
        const provider = new GitHubProvider(
            vi.fn(async (url: string) => {
                if (url.includes("/statuses")) throw new HttpError(401, "HTTP 401: Bad", {});
                throw new Error("HTTP request timed out");
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.signInHost).toBe("github.com");
    });

    it("does not offer sign-in for a transport failure that carries no status", async () => {
        const provider = new GitHubProvider(
            vi.fn(async () => {
                throw new Error("HTTP request timed out");
            }),
        );

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.signInHost).toBeUndefined();
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

    it("admits a row the default filter drops when a custom ciCdPattern matches it", async () => {
        // "sonarcloud" is not a built-in CI/CD term; a custom include pattern keeps it.
        const fetchJson: FetchJson = vi.fn(async (url: string) => {
            if (url.includes("/statuses")) return [{ context: "sonarcloud", state: "success" }];
            return { check_runs: [] };
        });
        const provider = new GitHubProvider(fetchJson, /sonarcloud/i);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.items.find((i) => i.name === "sonarcloud")).toBeDefined();
    });

    it("drops a default-CI row when a narrow custom ciCdPattern excludes it", async () => {
        const fetchJson: FetchJson = vi.fn(async (url: string) => {
            if (url.includes("/statuses")) return [];
            return {
                check_runs: [{ name: "CI / build", status: "completed", conclusion: "success" }],
            };
        });
        const provider = new GitHubProvider(fetchJson, /deploy/i);

        const snapshot = await provider.getChecks(githubRef, "abc1234");

        expect(snapshot.items.find((i) => i.name === "CI / build")).toBeUndefined();
    });
});
