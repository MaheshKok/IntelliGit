import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import type { CommitChecksSnapshot } from "../../../../src/types";
import type {
    CommitChecksProvider,
    HostMap,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";

function makeGitOps(remotes: Record<string, string | null>): GitOps {
    return {
        getRemotes: vi.fn(async () => Object.keys(remotes)),
        getRemoteUrl: vi.fn(async (remote: string) => remotes[remote] ?? null),
    } as unknown as GitOps;
}

function snapshot(state: CommitChecksSnapshot["state"]): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items: [] };
}

function makeProvider(
    id: CommitChecksProvider["id"],
    matchSubstring: string,
    getChecks: CommitChecksProvider["getChecks"],
): CommitChecksProvider {
    return {
        id,
        match: vi.fn((url: string, _hostMap: HostMap): ProviderRepoRef | null =>
            url.includes(matchSubstring) ? { host: matchSubstring } : null,
        ),
        getChecks,
    };
}

describe("CommitChecksCoordinator", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("picks the matching provider for a github remote", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(getChecks).toHaveBeenCalledTimes(1);
    });

    it("returns unavailable (never throws) when no provider matches", async () => {
        const provider = makeProvider("github", "github.com", vi.fn());
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "https://bitbucket.org/team/repo.git" }),
            [provider],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("unavailable");
        expect(result.error).toBe("No GitHub remote found.");
        expect(provider.getChecks).not.toHaveBeenCalled();
    });

    it("returns unavailable when there are no remotes at all", async () => {
        const provider = makeProvider("github", "github.com", vi.fn());
        const coordinator = new CommitChecksCoordinator(makeGitOps({}), [provider]);

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("unavailable");
        expect(provider.getChecks).not.toHaveBeenCalled();
    });

    it("tries origin before other remotes", async () => {
        const githubChecks = vi.fn(async () => snapshot("success"));
        const gitlabChecks = vi.fn(async () => snapshot("failure"));
        const github = makeProvider("github", "github.com", githubChecks);
        const gitlab = makeProvider("gitlab", "gitlab.com", gitlabChecks);
        // Non-origin remote listed first; coordinator must still try origin (github) first.
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({
                upstream: "https://gitlab.com/group/repo.git",
                origin: "git@github.com:owner/repo.git",
            }),
            [github, gitlab],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(githubChecks).toHaveBeenCalledTimes(1);
        expect(gitlabChecks).not.toHaveBeenCalled();
    });

    it("falls through to a later remote when origin matches no provider", async () => {
        const gitlabChecks = vi.fn(async () => snapshot("success"));
        const github = makeProvider("github", "github.com", vi.fn());
        const gitlab = makeProvider("gitlab", "gitlab.com", gitlabChecks);
        // origin is a bitbucket URL no provider matches; the gitlab backup remote must win.
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({
                origin: "https://bitbucket.org/team/repo.git",
                backup: "https://gitlab.com/group/repo.git",
            }),
            [github, gitlab],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(gitlabChecks).toHaveBeenCalledTimes(1);
        expect(github.getChecks).not.toHaveBeenCalled();
    });

    it("first matching provider in the registry wins for one remote", async () => {
        const firstChecks = vi.fn(async () => snapshot("success"));
        const secondChecks = vi.fn(async () => snapshot("failure"));
        const first = makeProvider("github", "github.com", firstChecks);
        const second = makeProvider("gitlab", "github.com", secondChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [first, second],
        );

        await coordinator.getChecks("abc1234");

        expect(firstChecks).toHaveBeenCalledTimes(1);
        expect(secondChecks).not.toHaveBeenCalled();
    });

    it("skips remotes whose URL cannot be resolved", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: null, backup: "git@github.com:owner/repo.git" }),
            [provider],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(getChecks).toHaveBeenCalledTimes(1);
    });

    it("serves a terminal cached snapshot without re-calling the provider", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        const first = await coordinator.getChecks("abc1234");
        const second = await coordinator.getChecks("abc1234");

        expect(getChecks).toHaveBeenCalledTimes(1);
        expect(second).toBe(first); // exact cached object, not a fresh fetch
    });

    it("re-fetches a cached pending snapshot", async () => {
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce(snapshot("pending"))
            .mockResolvedValueOnce(snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        await coordinator.getChecks("abc1234");
        const second = await coordinator.getChecks("abc1234");

        expect(getChecks).toHaveBeenCalledTimes(2);
        expect(second.state).toBe("success");
    });

    it("re-fetches a cached none snapshot (checks not registered yet)", async () => {
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce(snapshot("none"))
            .mockResolvedValueOnce(snapshot("pending"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        await coordinator.getChecks("abc1234");
        const second = await coordinator.getChecks("abc1234");

        expect(getChecks).toHaveBeenCalledTimes(2);
        expect(second.state).toBe("pending");
    });

    it("clear() drops the cache so the next call re-fetches", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        await coordinator.getChecks("abc1234");
        coordinator.clear();
        await coordinator.getChecks("abc1234");

        expect(getChecks).toHaveBeenCalledTimes(2);
    });

    it("returns an unavailable snapshot when a provider throws (never throws)", async () => {
        const provider = makeProvider(
            "github",
            "github.com",
            vi.fn(async () => {
                throw new Error("boom");
            }),
        );
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("unavailable");
        expect(result.error).toBe("boom");
    });
});
