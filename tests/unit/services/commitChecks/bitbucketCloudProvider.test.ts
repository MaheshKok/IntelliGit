// Spec-derived tests for the Bitbucket Cloud commit-check provider. All cases are
// written from the public contract — match URL parsing, the single fixed host, the
// state-mapping table, pagination with a page cap, Bearer auth, auth
// short-circuit, HTTP error handling, and token-leakage guardrails — not by reading the
// implementation. The vscode module is module-mocked; FetchJson and CredentialStore are
// doubled locally so no network or SecretStorage touches occur.

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { FetchJson } from "../../../../src/services/commitChecks/http";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

// Module-level mocks (must appear before the import under test)

vi.mock("vscode", () => ({
    l10n: {
        t: interpolateL10n,
    },
}));

import {
    BitbucketCloudProvider,
    parseBitbucketCloudUrl,
} from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type * as vscode from "vscode";

// Test doubles

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

/** Constructs a CredentialStore seeded with a token for bitbucket.org. */
function storeWithToken(token: string): CredentialStore {
    return new CredentialStore(
        makeSecrets({ "intelligit.commitChecks.token:bitbucket.org": token }),
    );
}

/** Constructs a CredentialStore with no stored tokens. */
function emptyStore(): CredentialStore {
    return new CredentialStore(makeSecrets());
}

function throwingStore(): CredentialStore {
    return new CredentialStore({
        get: vi.fn(async () => {
            throw new Error("secret store unavailable");
        }),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as vscode.SecretStorage);
}

/** Wraps a single status row in a one-page response and a token-bearing provider. */
function providerForStatus(bitbucketState: string, token = "bb-token"): BitbucketCloudProvider {
    return new BitbucketCloudProvider(
        fetchReturning(() => ({
            values: [
                {
                    key: "CI",
                    name: "CI / pipeline build",
                    state: bitbucketState,
                    url: "https://bitbucket.org/acme/app/pipelines/1",
                    description: "test run",
                },
            ],
        })),
        storeWithToken(token),
    );
}

// A stable Bitbucket Cloud ref used throughout getChecks tests

const bbRef = {
    host: "bitbucket.org",
    workspace: "acme",
    repo: "app",
} as ProviderRepoRef;

// parseBitbucketCloudUrl

describe("parseBitbucketCloudUrl", () => {
    it("parses an HTTPS URL with .git suffix", () => {
        expect(parseBitbucketCloudUrl("https://bitbucket.org/acme/app.git")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("parses an HTTPS URL without .git suffix", () => {
        expect(parseBitbucketCloudUrl("https://bitbucket.org/acme/app")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("parses a SCP-like SSH URL with .git suffix", () => {
        expect(parseBitbucketCloudUrl("git@bitbucket.org:acme/app.git")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("parses a SCP-like SSH URL without .git suffix", () => {
        expect(parseBitbucketCloudUrl("git@bitbucket.org:acme/app")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("strips a trailing .git from the repo", () => {
        const result = parseBitbucketCloudUrl("https://bitbucket.org/acme/app.git");
        expect(result?.repo).toBe("app");
        expect(result?.repo).not.toMatch(/\.git$/);
    });

    it("uses only the first two path segments (ignores deeper paths)", () => {
        // Bitbucket Cloud has no nested workspaces; a deeper path keeps workspace/repo.
        expect(parseBitbucketCloudUrl("https://bitbucket.org/acme/app/extra")).toMatchObject({
            workspace: "acme",
            repo: "app",
        });
    });

    it("is case-insensitive for the bitbucket.org host in HTTPS scheme", () => {
        expect(parseBitbucketCloudUrl("https://BitBucket.ORG/acme/app.git")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("is case-insensitive for the bitbucket.org host in SCP scheme", () => {
        expect(parseBitbucketCloudUrl("git@BitBucket.ORG:acme/app.git")).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("trims surrounding whitespace before parsing", () => {
        expect(parseBitbucketCloudUrl("  https://bitbucket.org/acme/app.git  ")).toMatchObject({
            workspace: "acme",
            repo: "app",
        });
    });

    // --- Rejection cases ---

    it("returns null for a GitHub HTTPS URL", () => {
        expect(parseBitbucketCloudUrl("https://github.com/owner/repo.git")).toBeNull();
    });

    it("returns null for a GitLab HTTPS URL", () => {
        expect(parseBitbucketCloudUrl("https://gitlab.com/owner/repo.git")).toBeNull();
    });

    it("returns null for the Bitbucket Server-style host (different host)", () => {
        expect(parseBitbucketCloudUrl("https://bitbucket.acme.com/acme/app.git")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(parseBitbucketCloudUrl("")).toBeNull();
    });

    it("returns null for a completely invalid string", () => {
        expect(parseBitbucketCloudUrl("not a url")).toBeNull();
    });

    it("returns null for a single path segment (no workspace/repo distinction)", () => {
        expect(parseBitbucketCloudUrl("https://bitbucket.org/onlyone")).toBeNull();
    });

    it("returns null for an SCP URL with a single path segment", () => {
        expect(parseBitbucketCloudUrl("git@bitbucket.org:onlyone")).toBeNull();
    });

    it("returns null for a URL with no path", () => {
        expect(parseBitbucketCloudUrl("https://bitbucket.org")).toBeNull();
    });

    it("returns null for a non-HTTPS http:// bitbucket.org URL (plaintext is never queried)", () => {
        // The host matches but the scheme is http; the SSRF guard must reject it.
        expect(parseBitbucketCloudUrl("http://bitbucket.org/acme/app.git")).toBeNull();
    });

    it("returns null for a non-HTTP(S) scheme on the bitbucket.org host", () => {
        expect(parseBitbucketCloudUrl("ftp://bitbucket.org/acme/app.git")).toBeNull();
    });
});

// BitbucketCloudProvider.match

describe("BitbucketCloudProvider.match", () => {
    it("matches a bitbucket.org HTTPS remote without a HostMap entry", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("https://bitbucket.org/acme/app.git", {})).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("matches a bitbucket.org SCP remote without a HostMap entry", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("git@bitbucket.org:acme/app.git", {})).toMatchObject({
            host: "bitbucket.org",
            workspace: "acme",
            repo: "app",
        });
    });

    it("ignores HostMap entries: a custom host mapped to bitbucket-cloud does not match", () => {
        // Bitbucket Cloud is SaaS-only (api.bitbucket.org). A self-hosted host belongs to
        // the Bitbucket Data Center provider, never this one, so the HostMap is ignored.
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        const hostMap = { "bb.acme.com": "bitbucket-cloud" as const };
        expect(provider.match("https://bb.acme.com/acme/app.git", hostMap)).toBeNull();
    });

    it("returns null for a GitHub remote regardless of HostMap contents", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("https://github.com/owner/repo.git", {})).toBeNull();
    });

    it("returns null for a GitLab remote", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("git@gitlab.com:owner/repo.git", {})).toBeNull();
    });

    it("returns null for an http:// bitbucket.org remote (SSRF guard)", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("http://bitbucket.org/acme/app.git", {})).toBeNull();
    });

    it("returns null for an invalid remote URL", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.match("not-a-url", {})).toBeNull();
    });

    it("exposes 'bitbucket-cloud' as its provider id", () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        expect(provider.id).toBe("bitbucket-cloud");
    });
});

// BitbucketCloudProvider.getChecks — auth short-circuit (no token)

describe("BitbucketCloudProvider.getChecks — no token stored", () => {
    it("returns state 'unavailable' and never calls fetchJson when no token is stored", async () => {
        const fetchJson = vi.fn();
        const provider = new BitbucketCloudProvider(fetchJson, emptyStore());

        const snapshot = await provider.getChecks(bbRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("includes a sign-in hint naming the host when no token is stored", async () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.error).toBeDefined();
        expect(snapshot.error).toMatch(/sign in/i);
        expect(snapshot.error).toContain("bitbucket.org");
    });

    it("returns an empty items array when no token is stored", async () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.items).toEqual([]);
    });

    it("records the commit hash in the snapshot even when token is absent", async () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(bbRef, "deadbeef");
        expect(snapshot.hash).toBe("deadbeef");
    });
});

// BitbucketCloudProvider.getChecks — request construction & auth

describe("BitbucketCloudProvider.getChecks — request construction", () => {
    it("calls the correct Bitbucket Cloud statuses endpoint on the api host", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(bbRef, "abc1234");

        const expectedUrl =
            "https://api.bitbucket.org/2.0/repositories/acme/app/commit/abc1234/statuses?pagelen=100";
        expect(fetchJson).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    });

    it("URL-encodes the workspace, repo, and commit hash", async () => {
        const oddRef = {
            host: "bitbucket.org",
            workspace: "ac me",
            repo: "ap/p",
        } as ProviderRepoRef;
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(oddRef, "sha/123");

        const calledUrl = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toContain(`/repositories/${encodeURIComponent("ac me")}/`);
        expect(calledUrl).toContain(`/${encodeURIComponent("ap/p")}/commit/`);
        expect(calledUrl).toContain(`/commit/${encodeURIComponent("sha/123")}/statuses`);
    });

    it("sends a Bearer auth header carrying the stored token verbatim", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-access-token"));

        await provider.getChecks(bbRef, "abc1234");

        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers.Authorization).toBe("Bearer bb-access-token");
    });

    it("uses Bearer (never Basic) even when the token contains a colon", async () => {
        // The credential store holds one opaque token per host; app-password style
        // user:secret Basic auth is not supported. A colon in the token must not switch
        // the scheme — the whole value is sent verbatim as a Bearer token.
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("a:b:c"));

        await provider.getChecks(bbRef, "abc1234");

        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers.Authorization).toBe("Bearer a:b:c");
    });

    it("calls fetchJson exactly once when there is no next page", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(bbRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("returns unavailable when the credential store rejects", async () => {
        const fetchJson = vi.fn();
        const provider = new BitbucketCloudProvider(fetchJson, throwingStore());

        const snapshot = await provider.getChecks(bbRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toBe("secret store unavailable");
        expect(fetchJson).not.toHaveBeenCalled();
    });
});

// BitbucketCloudProvider.getChecks — pagination

describe("BitbucketCloudProvider.getChecks — pagination", () => {
    it("follows a single 'next' link and merges statuses across both pages", async () => {
        const page2 = "https://api.bitbucket.org/2.0/page2";
        const fetchJson = vi.fn(async (url: string) => {
            if (url === page2) {
                return { values: [{ key: "CI", name: "CI / deploy", state: "SUCCESSFUL" }] };
            }
            return {
                values: [{ key: "CI", name: "CI / build", state: "SUCCESSFUL" }],
                next: page2,
            };
        });
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        const snapshot = await provider.getChecks(bbRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(2);
        expect(snapshot.items).toHaveLength(2);
        expect(snapshot.state).toBe("success");
    });

    it("stops paginating when no 'next' link is present", async () => {
        const fetchJson = vi.fn(async () => ({
            values: [{ key: "CI", name: "CI / build", state: "SUCCESSFUL" }],
        }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(bbRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("caps pagination at MAX_PAGES even when 'next' always points forward", async () => {
        // Every page returns a fresh 'next', so only the cap can terminate the loop.
        const fetchJson = vi.fn(async () => ({
            values: [{ key: "CI", name: "CI / build", state: "SUCCESSFUL" }],
            next: "https://api.bitbucket.org/2.0/never-ending",
        }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(bbRef, "abc1234");

        // The cap is 5 pages; the loop must not run unbounded.
        expect(fetchJson).toHaveBeenCalledTimes(5);
    });

    it("does not follow next links outside the Bitbucket Cloud API host", async () => {
        const fetchJson = vi.fn(async () => ({
            values: [{ key: "CI", name: "CI / build", state: "SUCCESSFUL" }],
            next: "https://evil.example.com/2.0/repositories/acme/app/statuses",
        }));
        const provider = new BitbucketCloudProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(bbRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });
});

// BitbucketCloudProvider.getChecks — empty / malformed responses

describe("BitbucketCloudProvider.getChecks — empty and malformed responses", () => {
    it("returns state 'none' for an empty values array", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({ values: [] })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });

    it("returns state 'none' when the body has no values key", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({ message: "unexpected" })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });

    it("returns state 'none' and empty items for a non-object response without throwing", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => "a string"),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("none");
        expect(snapshot.items).toEqual([]);
    });

    it("returns state 'none' and does not throw for a null response", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => null),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("none");
    });
});

// BitbucketCloudProvider.getChecks — HTTP errors → unavailable

describe("BitbucketCloudProvider.getChecks — HTTP errors", () => {
    it("returns state 'unavailable' with a sign-in hint for HTTP 401", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to bitbucket.org");
    });

    it("returns state 'unavailable' with a sign-in hint for HTTP 403", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 403: Forbidden");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to bitbucket.org");
    });

    it("returns state 'unavailable' for HTTP 500 with the raw message", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("HTTP 500");
    });

    it("returns state 'unavailable' for a network timeout", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP request timed out");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
    });

    // --- CRITICAL: token must never appear in error messages ---

    it("does NOT include the token in the error message on HTTP 401", async () => {
        const secretToken = "bb-THIS-MUST-NOT-LEAK";
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("does NOT include the token in the error message on HTTP 500", async () => {
        const secretToken = "bb-SERVER-ERROR-LEAK-CHECK";
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("does NOT include a user:secret token in the error message on a network error", async () => {
        const secretToken = "alice@example.com:bb-NETWORK-LEAK-CHECK";
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("ECONNRESET");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("redacts the token when a transport error echoes it verbatim", async () => {
        // The earlier leak tests throw token-free errors, so they cannot prove the
        // guarantee. This throws an error whose text embeds the stored token (as a
        // misbehaving proxy/SDK might echo the Authorization header), and asserts the
        // token is scrubbed to *** before reaching the snapshot.
        const secretToken = "bb-token";
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("boom bb-token");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.error).toContain("***");
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("returns empty items array on HTTP error", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.items).toEqual([]);
    });

    it("records the commit hash in an unavailable snapshot", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "deadc0de");
        expect(snapshot.hash).toBe("deadc0de");
    });
});

// BitbucketCloudProvider.getChecks — state mapping (full table)

describe("BitbucketCloudProvider.getChecks — Bitbucket state → CommitCheckState mapping", () => {
    it("maps 'SUCCESSFUL' → 'success'", async () => {
        const snapshot = await providerForStatus("SUCCESSFUL").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("success");
    });

    it("maps 'FAILED' → 'failure'", async () => {
        const snapshot = await providerForStatus("FAILED").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("failure");
    });

    it("maps 'INPROGRESS' → 'pending'", async () => {
        const snapshot = await providerForStatus("INPROGRESS").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("pending");
    });

    it("maps 'PENDING' → 'pending'", async () => {
        const snapshot = await providerForStatus("PENDING").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("pending");
    });

    it("maps 'STOPPED' → 'cancelled'", async () => {
        const snapshot = await providerForStatus("STOPPED").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("cancelled");
    });

    it("maps the pipeline-only 'EXPIRED' → 'timed_out'", async () => {
        const snapshot = await providerForStatus("EXPIRED").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("timed_out");
    });

    it("maps an unrecognized state string → 'unknown'", async () => {
        const snapshot = await providerForStatus("SOME_FUTURE_STATE").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("unknown");
    });

    it("matches the state case-insensitively (lowercase 'successful')", async () => {
        const snapshot = await providerForStatus("successful").getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.state !== "none")?.state).toBe("success");
    });
});

// BitbucketCloudProvider.getChecks — aggregate state over multiple statuses

describe("BitbucketCloudProvider.getChecks — aggregate snapshot state", () => {
    it("returns snapshot state 'success' when all statuses are SUCCESSFUL", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [
                    { key: "CI", name: "CI / build", state: "SUCCESSFUL" },
                    { key: "CI", name: "CI / lint", state: "SUCCESSFUL" },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("success");
    });

    it("returns snapshot state 'failure' when any status is FAILED", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [
                    { key: "CI", name: "CI / build", state: "SUCCESSFUL" },
                    { key: "CI", name: "CI / test", state: "FAILED" },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("failure");
    });

    it("returns snapshot state 'pending' when any status is INPROGRESS (no failure)", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [
                    { key: "CI", name: "CI / build", state: "SUCCESSFUL" },
                    { key: "CI", name: "CI / deploy", state: "INPROGRESS" },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("pending");
    });

    it("returns snapshot state 'none' for an empty values array", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({ values: [] })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("none");
    });
});

// BitbucketCloudProvider.getChecks — snapshot shape & filtering

describe("BitbucketCloudProvider.getChecks — snapshot shape", () => {
    it("includes the commit hash in the snapshot", async () => {
        const snapshot = await providerForStatus("SUCCESSFUL").getChecks(bbRef, "sha42");
        expect(snapshot.hash).toBe("sha42");
    });

    it("includes a non-empty summary string", async () => {
        const snapshot = await providerForStatus("SUCCESSFUL").getChecks(bbRef, "sha42");
        expect(typeof snapshot.summary).toBe("string");
        expect(snapshot.summary.length).toBeGreaterThan(0);
    });

    it("sets every check item source to 'status'", async () => {
        const snapshot = await providerForStatus("SUCCESSFUL").getChecks(bbRef, "sha42");
        for (const item of snapshot.items) {
            expect(item.source).toBe("status");
        }
    });

    it("maps the url field to the item's url property", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [
                    {
                        key: "CI",
                        name: "CI / build",
                        state: "SUCCESSFUL",
                        url: "https://bitbucket.org/acme/app/pipelines/99",
                    },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.items[0]?.url).toBe("https://bitbucket.org/acme/app/pipelines/99");
    });

    it("falls back to the status key as the item name when name is absent", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [{ key: "deploy-prod", state: "SUCCESSFUL" }],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.items.find((i) => i.name === "deploy-prod")).toBeDefined();
    });

    it("includes every build status, regardless of name (no CI/CD allowlist)", async () => {
        // The Bitbucket statuses endpoint returns build statuses only, so all rows are
        // surfaced. None are dropped for failing to match a CI/CD keyword.
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [
                    { key: "1", name: "Jenkins", state: "SUCCESSFUL" },
                    { key: "2", name: "SonarCloud Quality Gate", state: "SUCCESSFUL" },
                    { key: "3", name: "CI / build", state: "SUCCESSFUL" },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.items).toHaveLength(3);
    });
});

// BitbucketCloudProvider.getChecks — non-keyword tools must not be silently hidden

describe("BitbucketCloudProvider.getChecks — non-CI/CD-keyword tools surface their state", () => {
    it("reports 'failure' for a failing 'Jenkins' status whose name lacks CI/CD keywords", async () => {
        // Regression: with an allowlist filter, a row named "Jenkins" would be dropped and
        // a real failure would collapse to 'none'. The badge must show the failure.
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [{ key: "jenkins", name: "Jenkins", state: "FAILED" }],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("failure");
        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0]?.name).toBe("Jenkins");
    });

    it("reports 'failure' for a failing 'SonarCloud Quality Gate' status", async () => {
        const provider = new BitbucketCloudProvider(
            fetchReturning(() => ({
                values: [{ key: "sonar", name: "SonarCloud Quality Gate", state: "FAILED" }],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "sha");
        expect(snapshot.state).toBe("failure");
    });
});

// BitbucketCloudProvider.getChecks — signInHost (actionable sign-in target)

describe("BitbucketCloudProvider.getChecks — signInHost", () => {
    it("sets signInHost to the ref host when no token is stored", async () => {
        const provider = new BitbucketCloudProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.signInHost).toBe("bitbucket.org");
    });

    it("sets signInHost to the ref host on HTTP 401", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.signInHost).toBe("bitbucket.org");
    });

    it("sets signInHost to the ref host on HTTP 403", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 403: Forbidden");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.signInHost).toBe("bitbucket.org");
    });

    it("leaves signInHost unset on HTTP 500 (not a sign-in problem)", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.signInHost).toBeUndefined();
    });

    it("leaves signInHost unset on a network error (not a sign-in problem)", async () => {
        const provider = new BitbucketCloudProvider(
            vi.fn(async () => {
                throw new Error("ECONNRESET");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(bbRef, "abc1234");
        expect(snapshot.signInHost).toBeUndefined();
    });
});
