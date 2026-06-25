// Spec-derived tests for the GitLab commit-check provider. All cases are written from
// the public contract — match URL parsing, HostMap lookup, state-mapping table, auth
// short-circuit, HTTP error handling, and token-leakage guardrails — not by reading the
// implementation. The vscode module is module-mocked; FetchJson and CredentialStore are
// doubled locally so no network or SecretStorage touches occur.

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { FetchJson } from "../../../../src/services/commitChecks/http";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

// ---------------------------------------------------------------------------
// Module-level mocks (must appear before the import under test)
// ---------------------------------------------------------------------------

vi.mock("vscode", () => ({
    l10n: {
        t: interpolateL10n,
    },
}));

import {
    GitLabProvider,
    parseGitlabRemoteUrl,
} from "../../../../src/services/commitChecks/gitlabProvider";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Builds a Map-backed SecretStorage double. The returned object is the minimal
 * interface required by CredentialStore; vi.fn spies allow call assertions.
 */
function makeSecrets(initial: Record<string, string> = {}): vscode.SecretStorage {
    const map = new Map(Object.entries(initial));
    return {
        get: vi.fn(async (key: string) => map.get(key)),
        store: vi.fn(async (key: string, val: string) => {
            map.set(key, val);
        }),
        delete: vi.fn(async (key: string) => {
            map.delete(key);
        }),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as vscode.SecretStorage;
}

/** Builds a FetchJson stub that dispatches by URL. */
function fetchReturning(byUrl: (url: string) => unknown): FetchJson {
    return vi.fn(async (url: string) => byUrl(url));
}

/** Constructs a minimal CredentialStore seeded with a token for a host. */
function storeWithToken(host: string, token: string): CredentialStore {
    return new CredentialStore(makeSecrets({ [`intelligit.commitChecks.token:${host}`]: token }));
}

/** Constructs a CredentialStore with no stored tokens. */
function emptyStore(): CredentialStore {
    return new CredentialStore(makeSecrets());
}

// ---------------------------------------------------------------------------
// A stable GitLab ref used throughout getChecks tests
// ---------------------------------------------------------------------------

const gitlabRef = {
    host: "gitlab.com",
    owner: "group/subgroup",
    repo: "my-repo",
} as ProviderRepoRef;

// ---------------------------------------------------------------------------
// parseGitlabRemoteUrl
// ---------------------------------------------------------------------------

describe("parseGitlabRemoteUrl", () => {
    // --- HTTPS happy paths ---

    it("parses a simple HTTPS URL with .git suffix", () => {
        const result = parseGitlabRemoteUrl("https://gitlab.com/owner/repo.git");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    it("parses a simple HTTPS URL without .git suffix", () => {
        const result = parseGitlabRemoteUrl("https://gitlab.com/owner/repo");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    it("parses a nested-group HTTPS URL (two group segments before repo)", () => {
        const result = parseGitlabRemoteUrl("https://gitlab.com/group/subgroup/repo.git");
        expect(result).toMatchObject({
            host: "gitlab.com",
            owner: "group/subgroup",
            repo: "repo",
        });
    });

    it("parses a deeply nested HTTPS URL (three group segments before repo)", () => {
        const result = parseGitlabRemoteUrl("https://gitlab.com/org/group/subgroup/project.git");
        expect(result).toMatchObject({
            host: "gitlab.com",
            owner: "org/group/subgroup",
            repo: "project",
        });
    });

    it("strips trailing .git from repo in HTTPS URL", () => {
        const result = parseGitlabRemoteUrl("https://gitlab.com/owner/repo.git");
        expect(result?.repo).toBe("repo");
        expect(result?.repo).not.toMatch(/\.git$/);
    });

    // --- SCP/SSH happy paths ---

    it("parses a SCP-like SSH URL with .git suffix", () => {
        const result = parseGitlabRemoteUrl("git@gitlab.com:owner/repo.git");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    it("parses a SCP-like SSH URL without .git suffix", () => {
        const result = parseGitlabRemoteUrl("git@gitlab.com:owner/repo");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    it("parses a nested-group SCP URL (two group segments before repo)", () => {
        const result = parseGitlabRemoteUrl("git@gitlab.com:group/subgroup/repo.git");
        expect(result).toMatchObject({
            host: "gitlab.com",
            owner: "group/subgroup",
            repo: "repo",
        });
    });

    it("parses a deeply nested SCP URL (three group segments)", () => {
        const result = parseGitlabRemoteUrl("git@gitlab.com:org/group/subgroup/project");
        expect(result).toMatchObject({
            host: "gitlab.com",
            owner: "org/group/subgroup",
            repo: "project",
        });
    });

    it("strips trailing .git from repo in SCP URL", () => {
        const result = parseGitlabRemoteUrl("git@gitlab.com:owner/repo.git");
        expect(result?.repo).toBe("repo");
    });

    // --- Host normalization ---

    it("is case-insensitive for gitlab.com in HTTPS scheme", () => {
        const result = parseGitlabRemoteUrl("https://GitLab.COM/owner/repo.git");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    it("is case-insensitive for gitlab.com in SCP scheme", () => {
        const result = parseGitlabRemoteUrl("git@GitLab.COM:owner/repo.git");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });

    // --- Rejection cases ---

    it("returns null for a GitHub HTTPS URL", () => {
        expect(parseGitlabRemoteUrl("https://github.com/owner/repo.git")).toBeNull();
    });

    it("returns null for a GitHub SCP URL", () => {
        expect(parseGitlabRemoteUrl("git@github.com:owner/repo.git")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(parseGitlabRemoteUrl("")).toBeNull();
    });

    it("returns null for a completely invalid string", () => {
        expect(parseGitlabRemoteUrl("not a url")).toBeNull();
    });

    it("returns null for a single path segment (no owner/repo distinction)", () => {
        expect(parseGitlabRemoteUrl("https://gitlab.com/onlyone")).toBeNull();
    });

    it("returns null for an SCP URL with a single path segment", () => {
        expect(parseGitlabRemoteUrl("git@gitlab.com:onlyone")).toBeNull();
    });

    it("returns null for a URL with no path", () => {
        expect(parseGitlabRemoteUrl("https://gitlab.com")).toBeNull();
    });

    it("returns null for a Bitbucket HTTPS URL", () => {
        expect(parseGitlabRemoteUrl("https://bitbucket.org/owner/repo.git")).toBeNull();
    });

    it("returns null for a non-HTTPS http:// gitlab.com URL (plaintext is never queried)", () => {
        // The host matches but the scheme is http; the SSRF guard must reject it so a
        // plaintext remote can never be turned into an API request.
        expect(parseGitlabRemoteUrl("http://gitlab.com/group/repo.git")).toBeNull();
    });

    it("returns null for a non-HTTP(S) scheme on the gitlab.com host", () => {
        // ftp:// also has hostname gitlab.com but must not be accepted as a GitLab remote.
        expect(parseGitlabRemoteUrl("ftp://gitlab.com/group/repo.git")).toBeNull();
    });

    it("returns null for an ssh:// scheme URL (only SCP and HTTPS supported)", () => {
        // ssh:// is a distinct scheme from the git@ SCP form; GitLab typically uses SCP.
        // Ensure the parser does not accidentally accept it as GitLab.
        expect(parseGitlabRemoteUrl("ssh://git@github.com/owner/repo.git")).toBeNull();
    });

    it("trims surrounding whitespace before parsing", () => {
        const result = parseGitlabRemoteUrl("  https://gitlab.com/owner/repo.git  ");
        expect(result).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.match  (includes HostMap recognition)
// ---------------------------------------------------------------------------

describe("GitLabProvider.match", () => {
    it("matches gitlab.com without a HostMap entry", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("git@gitlab.com:owner/repo.git", {})).toMatchObject({
            host: "gitlab.com",
            owner: "owner",
            repo: "repo",
        });
    });

    it("matches a self-hosted instance whose hostname is in HostMap with value 'gitlab'", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        const hostMap = { "git.acme.com": "gitlab" as const };

        const httpsResult = provider.match("https://git.acme.com/group/project.git", hostMap);
        expect(httpsResult).toMatchObject({
            host: "git.acme.com",
            owner: "group",
            repo: "project",
        });

        const scpResult = provider.match("git@git.acme.com:group/project.git", hostMap);
        expect(scpResult).toMatchObject({
            host: "git.acme.com",
            owner: "group",
            repo: "project",
        });
    });

    it("does not match a host that is absent from HostMap", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("https://git.acme.com/group/project.git", {})).toBeNull();
    });

    it("does not match an http:// self-hosted URL even when the host is mapped to gitlab", () => {
        // The SSRF guard applies to configured hosts too: a plaintext remote on a
        // mapped host must not resolve to a queryable ref.
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        const hostMap = { "git.acme.com": "gitlab" as const };
        expect(provider.match("http://git.acme.com/group/project.git", hostMap)).toBeNull();
    });

    it("does not match a host mapped to a different provider in HostMap", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        // host is in the map but points to bitbucket-cloud, not gitlab
        const hostMap = { "git.acme.com": "bitbucket-cloud" as const };
        expect(provider.match("https://git.acme.com/group/project.git", hostMap)).toBeNull();
    });

    it("returns null for a GitHub remote regardless of HostMap contents", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("https://github.com/owner/repo.git", {})).toBeNull();
    });

    it("returns null for an invalid remote URL", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("not-a-url", {})).toBeNull();
    });

    it("returns null for a single path segment remote", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("https://gitlab.com/onlyone", {})).toBeNull();
    });

    it("returns null for an empty string", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.match("", {})).toBeNull();
    });

    it("exposes 'gitlab' as its provider id", () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        expect(provider.id).toBe("gitlab");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — auth short-circuit (no token)
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — no token stored", () => {
    it("returns state 'unavailable' and never calls fetchJson when no token is stored", async () => {
        // The runbook requires a missing token to surface an actionable "unavailable"
        // badge (not "none", which hides the badge entirely).
        const fetchJson = vi.fn();
        const provider = new GitLabProvider(fetchJson, emptyStore());

        const snapshot = await provider.getChecks(gitlabRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("includes a sign-in hint naming the host when no token is stored", async () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        // The error message must invite the user to sign in and identify the host so the
        // hint is actionable. The token is never part of this string (none exists here).
        expect(snapshot.error).toBeDefined();
        expect(snapshot.error).toMatch(/sign in/i);
        expect(snapshot.error).toContain("gitlab.com");
    });

    it("returns an empty items array when no token is stored", async () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.items).toEqual([]);
    });

    it("records the commit hash in the snapshot even when token is absent", async () => {
        const provider = new GitLabProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(gitlabRef, "deadbeef");
        expect(snapshot.hash).toBe("deadbeef");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — request construction
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — request construction", () => {
    it("calls the correct GitLab statuses endpoint with the encoded project path", async () => {
        const fetchJson = fetchReturning(() => []);
        const provider = new GitLabProvider(fetchJson, storeWithToken("gitlab.com", "glpat-abc"));

        await provider.getChecks(gitlabRef, "abc1234");

        // project path = encodeURIComponent("group/subgroup/my-repo")
        const expectedPath = encodeURIComponent("group/subgroup/my-repo");
        const expectedUrl = `https://gitlab.com/api/v4/projects/${expectedPath}/repository/commits/abc1234/statuses?per_page=100`;
        expect(fetchJson).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    });

    it("sends the PRIVATE-TOKEN auth header with the stored token", async () => {
        const fetchJson = fetchReturning(() => []);
        const provider = new GitLabProvider(
            fetchJson,
            storeWithToken("gitlab.com", "glpat-supersecret"),
        );

        await provider.getChecks(gitlabRef, "abc1234");

        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers["PRIVATE-TOKEN"]).toBe("glpat-supersecret");
    });

    it("uses the host from the ref for the base URL (self-hosted instance)", async () => {
        const selfHostedRef = {
            host: "git.acme.com",
            owner: "team",
            repo: "project",
        } as ProviderRepoRef;
        const fetchJson = fetchReturning(() => []);
        const provider = new GitLabProvider(fetchJson, storeWithToken("git.acme.com", "glpat-xyz"));

        await provider.getChecks(selfHostedRef, "cafe4321");

        const calledUrl = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl.startsWith("https://git.acme.com/api/v4/projects/")).toBe(true);
    });

    it("URL-encodes the full owner/repo project path including slashes", async () => {
        // owner = "org/group/sub", repo = "app"  → project = "org/group/sub/app"
        const deepRef = {
            host: "gitlab.com",
            owner: "org/group/sub",
            repo: "app",
        } as ProviderRepoRef;
        const fetchJson = fetchReturning(() => []);
        const provider = new GitLabProvider(fetchJson, storeWithToken("gitlab.com", "glpat-abc"));

        await provider.getChecks(deepRef, "sha123");

        const calledUrl = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const expectedProject = encodeURIComponent("org/group/sub/app");
        expect(calledUrl).toContain(`/projects/${expectedProject}/`);
    });

    it("calls fetchJson exactly once (single endpoint)", async () => {
        const fetchJson = fetchReturning(() => []);
        const provider = new GitLabProvider(fetchJson, storeWithToken("gitlab.com", "glpat-abc"));

        await provider.getChecks(gitlabRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — empty / non-array responses
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — empty and malformed responses", () => {
    it("returns state 'none' for an empty array response", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => []),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });

    it("returns state 'none' for a non-array response (object body)", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => ({ message: "unexpected object" })),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });

    it("returns state 'none' and empty items for a non-array response without throwing", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => "a string"),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("none");
        expect(snapshot.items).toEqual([]);
    });

    it("returns state 'none' and does not throw for a null response", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => null),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — HTTP 4xx / 5xx → unavailable
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — HTTP errors", () => {
    it("returns state 'unavailable' with a sign-in hint for HTTP 401", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to gitlab.com");
    });

    it("returns state 'unavailable' with a sign-in hint for HTTP 403", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 403: Forbidden");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to gitlab.com");
    });

    it("returns state 'unavailable' for HTTP 500", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("HTTP 500");
    });

    it("returns state 'unavailable' for a network timeout", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP request timed out");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
    });

    it("includes an error message in the snapshot when fetchJson rejects", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 404: Not Found");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.error).toBeTruthy();
    });

    // --- CRITICAL: token must never appear in error messages ---

    it("does NOT include the token in the error message on HTTP 4xx", async () => {
        const secretToken = "glpat-THIS-MUST-NOT-LEAK";
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("gitlab.com", secretToken),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("does NOT include the token in the error message on HTTP 500", async () => {
        const secretToken = "glpat-SERVER-ERROR-LEAK-CHECK";
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("gitlab.com", secretToken),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("does NOT include the token in the error message on a network error", async () => {
        const secretToken = "glpat-NETWORK-LEAK-CHECK";
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("ECONNRESET");
            }),
            storeWithToken("gitlab.com", secretToken),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("returns empty items array on HTTP error", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "abc1234");
        expect(snapshot.items).toEqual([]);
    });

    it("records the commit hash in an unavailable snapshot", async () => {
        const provider = new GitLabProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "deadc0de");
        expect(snapshot.hash).toBe("deadc0de");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — state mapping (full table)
// ---------------------------------------------------------------------------

/**
 * Builds a single-status response array and wraps it in a provider.
 * The status name is set to "CI / pipeline" so it passes the CI/CD filter.
 */
function providerForStatus(gitlabStatus: string, token = "glpat-abc"): GitLabProvider {
    return new GitLabProvider(
        fetchReturning(() => [
            {
                name: "CI / pipeline build",
                status: gitlabStatus,
                description: "test run",
                target_url: "https://gitlab.com/-/pipelines/1",
                allow_failure: false,
            },
        ]),
        storeWithToken("gitlab.com", token),
    );
}

describe("GitLabProvider.getChecks — GitLab status → CommitCheckState mapping", () => {
    // success
    it("maps 'success' → 'success'", async () => {
        const snapshot = await providerForStatus("success").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state === "success");
        expect(item).toBeDefined();
        expect(item?.state).toBe("success");
    });

    // failure
    it("maps 'failed' → 'failure'", async () => {
        const snapshot = await providerForStatus("failed").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("failure");
    });

    // pending-family states
    it("maps 'running' → 'pending'", async () => {
        const snapshot = await providerForStatus("running").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    it("maps 'pending' → 'pending'", async () => {
        const snapshot = await providerForStatus("pending").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    it("maps 'created' → 'pending'", async () => {
        const snapshot = await providerForStatus("created").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    it("maps 'preparing' → 'pending'", async () => {
        const snapshot = await providerForStatus("preparing").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    it("maps 'waiting_for_resource' → 'pending'", async () => {
        const snapshot = await providerForStatus("waiting_for_resource").getChecks(
            gitlabRef,
            "sha",
        );
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    it("maps 'scheduled' → 'pending'", async () => {
        const snapshot = await providerForStatus("scheduled").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("pending");
    });

    // canceled (note: GitLab spells it with one L; our type uses two L's: "cancelled")
    it("maps 'canceled' → 'cancelled' (two L's in our type)", async () => {
        const snapshot = await providerForStatus("canceled").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("cancelled");
        // Explicitly assert the two-L spelling is used
        expect(item?.state).not.toBe("canceled");
    });

    // skipped
    it("maps 'skipped' → 'skipped'", async () => {
        const snapshot = await providerForStatus("skipped").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("skipped");
    });

    // manual
    it("maps 'manual' → 'action_required'", async () => {
        const snapshot = await providerForStatus("manual").getChecks(gitlabRef, "sha");
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("action_required");
    });

    // unknown fallback
    it("maps an unrecognized status string → 'unknown'", async () => {
        const snapshot = await providerForStatus("some_future_gitlab_status").getChecks(
            gitlabRef,
            "sha",
        );
        const item = snapshot.items.find((i) => i.state !== "none");
        expect(item?.state).toBe("unknown");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — aggregate state over multiple statuses
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — aggregate snapshot state", () => {
    it("returns snapshot state 'success' when all statuses are 'success'", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [
                { name: "CI / build", status: "success" },
                { name: "CI / lint", status: "success" },
            ]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        expect(snapshot.state).toBe("success");
    });

    it("returns snapshot state 'failure' when any status is 'failed'", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [
                { name: "CI / build", status: "success" },
                { name: "CI / test", status: "failed" },
            ]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        expect(snapshot.state).toBe("failure");
    });

    it("returns snapshot state 'pending' when any status is 'running' (no failure)", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [
                { name: "CI / build", status: "success" },
                { name: "CI / deploy", status: "running" },
            ]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        expect(snapshot.state).toBe("pending");
    });

    it("returns snapshot state 'none' for an empty statuses array", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => []),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        expect(snapshot.state).toBe("none");
    });
});

// ---------------------------------------------------------------------------
// GitLabProvider.getChecks — snapshot shape correctness
// ---------------------------------------------------------------------------

describe("GitLabProvider.getChecks — snapshot shape", () => {
    it("includes the commit hash in the snapshot", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [{ name: "CI / build", status: "success" }]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha42");
        expect(snapshot.hash).toBe("sha42");
    });

    it("includes a non-empty summary string", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [{ name: "CI / build", status: "success" }]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha42");
        expect(typeof snapshot.summary).toBe("string");
        expect(snapshot.summary.length).toBeGreaterThan(0);
    });

    it("sets check item source to 'status' (GitLab API endpoint is the commit statuses API)", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [{ name: "CI / build", status: "success" }]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha42");
        for (const item of snapshot.items) {
            expect(item.source).toBe("status");
        }
    });

    it("maps the target_url field to the item's url property", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [
                {
                    name: "CI / build",
                    status: "success",
                    target_url: "https://gitlab.com/-/pipelines/99",
                },
            ]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        const item = snapshot.items[0];
        expect(item?.url).toBe("https://gitlab.com/-/pipelines/99");
    });

    it("uses the status name as the item name", async () => {
        const provider = new GitLabProvider(
            fetchReturning(() => [{ name: "deploy / production", status: "success" }]),
            storeWithToken("gitlab.com", "glpat-abc"),
        );
        const snapshot = await provider.getChecks(gitlabRef, "sha");
        // deploy matches CI/CD filter
        const item = snapshot.items.find((i) => i.name === "deploy / production");
        expect(item).toBeDefined();
    });
});
