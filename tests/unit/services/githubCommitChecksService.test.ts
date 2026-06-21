import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    httpsGet: vi.fn(),
}));

vi.mock("vscode", () => ({
    authentication: {
        getSession: mocks.getSession,
    },
    l10n: {
        t: interpolateL10n,
    },
}));

vi.mock("https", () => ({
    get: mocks.httpsGet,
}));

import {
    getGithubCommitChecks,
    normalizeGithubChecks,
    parseGithubRemoteUrl,
} from "../../../src/services/githubCommitChecksService";

function makeGitOps(remotes: Record<string, string>): GitOps {
    return {
        getRemotes: vi.fn(async () => Object.keys(remotes)),
        getRemoteUrl: vi.fn(async (remote: string) => remotes[remote] ?? null),
    } as unknown as GitOps;
}

function mockGithubJson(...payloads: unknown[]): void {
    let index = 0;
    mocks.httpsGet.mockImplementation((_url, _options, callback) => {
        const handlers = new Map<string, (chunk?: Buffer) => void>();
        const res = {
            statusCode: 200,
            on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                handlers.set(event, handler);
                return res;
            }),
        };
        queueMicrotask(() => {
            callback(res);
            handlers.get("data")?.(Buffer.from(JSON.stringify(payloads[index++] ?? {})));
            handlers.get("end")?.();
        });
        return {
            on: vi.fn(),
            setTimeout: vi.fn(),
            destroy: vi.fn(),
        };
    });
}

describe("githubCommitChecksService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
    });

    it("parses common GitHub remote URLs", () => {
        expect(parseGithubRemoteUrl("https://github.com/owner/repo.git")).toEqual({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("git@github.com:owner/repo.git")).toEqual({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("ssh://git@github.com/owner/repo.git")).toEqual({
            owner: "owner",
            repo: "repo",
        });
        expect(parseGithubRemoteUrl("https://gitlab.com/owner/repo.git")).toBeNull();
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

    it("fetches checks for the first GitHub remote and prompts auth on request", async () => {
        mockGithubJson({ check_runs: [] }, []);
        const gitOps = makeGitOps({
            upstream: "https://gitlab.com/owner/repo.git",
            origin: "git@github.com:owner/repo.git",
        });

        const snapshot = await getGithubCommitChecks(gitOps, "abc1234");

        expect(snapshot.state).toBe("none");
        expect(mocks.getSession).toHaveBeenCalledWith("github", ["repo"], { createIfNone: true });
        expect(mocks.httpsGet).toHaveBeenCalledTimes(2);
        expect(mocks.httpsGet.mock.calls[0][0]).toContain(
            "/repos/owner/repo/commits/abc1234/check-runs",
        );
        expect(mocks.httpsGet.mock.calls[1][0]).toContain(
            "/repos/owner/repo/commits/abc1234/statuses",
        );
    });

    it("returns unavailable when no GitHub remote exists", async () => {
        const snapshot = await getGithubCommitChecks(
            makeGitOps({ origin: "https://gitlab.com/owner/repo.git" }),
            "abc1234",
        );

        expect(snapshot.state).toBe("unavailable");
        expect(mocks.getSession).not.toHaveBeenCalled();
    });
});
