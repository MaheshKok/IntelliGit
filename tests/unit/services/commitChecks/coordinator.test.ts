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
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";

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

    it("returns none (no badge) when no provider matches the remote", async () => {
        // An unmapped/unsupported remote is a configuration state, not a recoverable
        // error: yield no badge (state "none"), never an "unavailable" error badge that
        // the UI would render and that would invite pointless TTL re-fetches.
        const provider = makeProvider("github", "github.com", vi.fn());
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "https://bitbucket.org/team/repo.git" }),
            [provider],
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("none");
        expect(provider.getChecks).not.toHaveBeenCalled();
    });

    it("returns none when there are no remotes at all", async () => {
        const provider = makeProvider("github", "github.com", vi.fn());
        const coordinator = new CommitChecksCoordinator(makeGitOps({}), [provider]);

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("none");
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

// Real BitbucketServerProvider routing: the HostMap, not the remote alone, drives selection.

/** Minimal SecretStorage double seeding one token, for wiring a real CredentialStore. */
function secretsWith(entries: Record<string, string>): import("vscode").SecretStorage {
    const map = new Map(Object.entries(entries));
    return {
        get: vi.fn(async (key: string) => map.get(key)),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as import("vscode").SecretStorage;
}

describe("CommitChecksCoordinator — Bitbucket Server selection via HostMap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("selects the bitbucket-server provider for a host mapped to it", async () => {
        const store = new CredentialStore(
            secretsWith({ "intelligit.commitChecks.token:bb.acme.com": "bb-token" }),
        );
        const fetchJson = vi.fn(async () => ({ values: [{ key: "ci", state: "FAILED" }] }));
        const provider = new BitbucketServerProvider(fetchJson, store);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "https://bb.acme.com/scm/proj/repo.git" }),
            [provider],
            { "bb.acme.com": "bitbucket-server" },
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("failure"); // the real provider ran and aggregated the row
        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("does NOT select the provider when the host is absent from the HostMap", async () => {
        const store = new CredentialStore(
            secretsWith({ "intelligit.commitChecks.token:bb.acme.com": "bb-token" }),
        );
        const fetchJson = vi.fn(async () => ({ values: [{ key: "ci", state: "FAILED" }] }));
        const provider = new BitbucketServerProvider(fetchJson, store);
        // Empty HostMap: the same remote must NOT route to the server provider.
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "https://bb.acme.com/scm/proj/repo.git" }),
            [provider],
            {},
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("none");
        expect(fetchJson).not.toHaveBeenCalled();
    });
});

describe("CommitChecksCoordinator — feature-enabled gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns a none snapshot and never touches remotes or providers when disabled", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const gitOps = makeGitOps({ origin: "git@github.com:owner/repo.git" });
        const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { enabled: false });

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("none");
        expect(provider.match).not.toHaveBeenCalled();
        expect(getChecks).not.toHaveBeenCalled();
        expect(gitOps.getRemotes).not.toHaveBeenCalled();
    });

    it("resolves and fetches normally when enabled is true", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
            {},
            { enabled: true },
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(getChecks).toHaveBeenCalledTimes(1);
    });
});

describe("CommitChecksCoordinator — per-provider toggle (hard-stop)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("hard-stops at the matched-but-disabled origin provider without falling through", async () => {
        const gitlabChecks = vi.fn(async () => snapshot("failure"));
        const githubChecks = vi.fn(async () => snapshot("success"));
        const gitlab = makeProvider("gitlab", "gitlab.com", gitlabChecks);
        const github = makeProvider("github", "github.com", githubChecks);
        // origin (gitlab) matches first and is disabled; the enabled github upstream must
        // NOT be consulted — a disabled matched provider yields no badge, full stop.
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({
                origin: "https://gitlab.com/group/repo.git",
                upstream: "git@github.com:owner/repo.git",
            }),
            [gitlab, github],
            {},
            { providerEnabled: { gitlab: false } },
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("none");
        expect(gitlabChecks).not.toHaveBeenCalled();
        expect(githubChecks).not.toHaveBeenCalled();
    });

    it("calls the same matched provider when it is enabled (the gate, not ordering, suppresses)", async () => {
        const gitlabChecks = vi.fn(async () => snapshot("failure"));
        const githubChecks = vi.fn(async () => snapshot("success"));
        const gitlab = makeProvider("gitlab", "gitlab.com", gitlabChecks);
        const github = makeProvider("github", "github.com", githubChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({
                origin: "https://gitlab.com/group/repo.git",
                upstream: "git@github.com:owner/repo.git",
            }),
            [gitlab, github],
            {},
            { providerEnabled: { gitlab: true } },
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("failure");
        expect(gitlabChecks).toHaveBeenCalledTimes(1);
        expect(githubChecks).not.toHaveBeenCalled();
    });

    it("treats an unlisted provider id as enabled (default true)", async () => {
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
            {},
            { providerEnabled: { gitlab: false } }, // github unlisted → enabled
        );

        const result = await coordinator.getChecks("abc1234");

        expect(result.state).toBe("success");
        expect(getChecks).toHaveBeenCalledTimes(1);
    });
});

describe("CommitChecksCoordinator — TTL throttle (fake clock)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("serves a cached pending snapshot within the TTL, then re-fetches after it elapses", async () => {
        let clock = 1_000;
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce(snapshot("pending"))
            .mockResolvedValueOnce(snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
            {},
            { ttlMs: 15_000, now: () => clock },
        );

        const first = await coordinator.getChecks("abc1234"); // fetch #1 at t=1000
        clock = 5_000; // within TTL
        const second = await coordinator.getChecks("abc1234"); // cache hit
        expect(getChecks).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);

        clock = 17_000; // 16s after fetch → past 15s TTL
        const third = await coordinator.getChecks("abc1234"); // re-fetch
        expect(getChecks).toHaveBeenCalledTimes(2);
        expect(third.state).toBe("success");
    });

    it("auto-recovers an unavailable snapshot after the TTL (simulated 429 clears)", async () => {
        let clock = 0;
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce(snapshot("unavailable"))
            .mockResolvedValueOnce(snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
            {},
            { ttlMs: 10_000, now: () => clock },
        );

        await coordinator.getChecks("abc1234");
        clock = 5_000;
        const cached = await coordinator.getChecks("abc1234");
        expect(getChecks).toHaveBeenCalledTimes(1); // within TTL → cached unavailable
        expect(cached.state).toBe("unavailable");

        clock = 11_000;
        const recovered = await coordinator.getChecks("abc1234");
        expect(getChecks).toHaveBeenCalledTimes(2); // past TTL → re-fetch
        expect(recovered.state).toBe("success");
    });

    it("serves a terminal success indefinitely even long past the TTL", async () => {
        let clock = 0;
        const getChecks = vi.fn(async () => snapshot("success"));
        const provider = makeProvider("github", "github.com", getChecks);
        const coordinator = new CommitChecksCoordinator(
            makeGitOps({ origin: "git@github.com:owner/repo.git" }),
            [provider],
            {},
            { ttlMs: 1_000, now: () => clock },
        );

        await coordinator.getChecks("abc1234");
        clock = 9_999_999; // far past any TTL
        await coordinator.getChecks("abc1234");

        expect(getChecks).toHaveBeenCalledTimes(1); // terminal → never re-fetched
    });
});
