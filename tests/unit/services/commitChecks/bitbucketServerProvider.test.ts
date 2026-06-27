// Spec-derived tests for the Bitbucket Server / Data Center commit-check provider. All
// cases are written from the public contract — HostMap-only matching (no built-in host),
// URL parsing with the /scm clone prefix and SSRF scheme guard, the global build-status
// endpoint shape, Bearer auth, the state-mapping table, auth short-circuit, HTTP error
// handling, the no-allowlist guarantee, and token-leakage guardrails — not by reading the
// implementation. The vscode module is module-mocked; FetchJson and CredentialStore are
// doubled locally so no network or SecretStorage touches occur.

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { FetchJson } from "../../../../src/services/commitChecks/http";
import type { HostMap } from "../../../../src/services/commitChecks/types";

// Module-level mocks (must appear before the import under test)

vi.mock("vscode", () => ({
    l10n: {
        t: interpolateL10n,
    },
}));

import {
    BitbucketServerProvider,
    parseBitbucketServerUrl,
} from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type * as vscode from "vscode";

// Test doubles

const SERVER_HOST = "bb.acme.com";
const SERVER_MAP: HostMap = { [SERVER_HOST]: "bitbucket-server" };
const serverRef = { host: SERVER_HOST };

/** Builds a Map-backed SecretStorage double exposing the minimal CredentialStore surface. */
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

/** Builds a FetchJson stub that ignores the URL and returns a fixed body. */
function fetchReturning(body: () => unknown): FetchJson {
    return vi.fn(async () => body());
}

/** Constructs a CredentialStore seeded with a token for the given host. */
function storeWithToken(token: string, host = SERVER_HOST): CredentialStore {
    return new CredentialStore(makeSecrets({ [`intelligit.commitChecks.token:${host}`]: token }));
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

/** Wraps a single status row in a build-status response with a token-bearing provider. */
function providerForStatus(state: string, token = "bb-token"): BitbucketServerProvider {
    return new BitbucketServerProvider(
        fetchReturning(() => ({ values: [{ key: "CI", name: "CI build", state }] })),
        storeWithToken(token),
    );
}

// parseBitbucketServerUrl — URL parsing against a supplied host

describe("parseBitbucketServerUrl", () => {
    it("matches the HTTPS clone form with the /scm prefix", () => {
        const ref = parseBitbucketServerUrl("https://bb.acme.com/scm/proj/repo.git", SERVER_HOST);
        expect(ref).toEqual({ host: SERVER_HOST });
    });

    it("matches the HTTPS form without a /scm prefix", () => {
        const ref = parseBitbucketServerUrl("https://bb.acme.com/proj/repo.git", SERVER_HOST);
        expect(ref).toEqual({ host: SERVER_HOST });
    });

    it("matches the ssh:// form with an explicit port", () => {
        const ref = parseBitbucketServerUrl(
            "ssh://git@bb.acme.com:7999/proj/repo.git",
            SERVER_HOST,
        );
        expect(ref).toEqual({ host: SERVER_HOST });
    });

    it("matches the SCP-like git@host:path form", () => {
        const ref = parseBitbucketServerUrl("git@bb.acme.com:proj/repo.git", SERVER_HOST);
        expect(ref).toEqual({ host: SERVER_HOST });
    });

    it("rejects an http:// remote (SSRF guard)", () => {
        expect(
            parseBitbucketServerUrl("http://bb.acme.com/scm/proj/repo.git", SERVER_HOST),
        ).toBeNull();
    });

    it("returns null when the host does not match", () => {
        expect(
            parseBitbucketServerUrl("https://other.com/scm/proj/repo.git", SERVER_HOST),
        ).toBeNull();
    });

    it("returns null for a bare host with no project/repo path", () => {
        expect(parseBitbucketServerUrl("https://bb.acme.com/", SERVER_HOST)).toBeNull();
    });

    it("returns null for a host with only one path segment", () => {
        expect(parseBitbucketServerUrl("https://bb.acme.com/scm/proj", SERVER_HOST)).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(parseBitbucketServerUrl("", SERVER_HOST)).toBeNull();
    });

    it("matches case-insensitively on the host", () => {
        const ref = parseBitbucketServerUrl("https://BB.ACME.COM/scm/proj/repo.git", SERVER_HOST);
        expect(ref).toEqual({ host: SERVER_HOST });
    });
});

// BitbucketServerProvider.match — HostMap-only selection

describe("BitbucketServerProvider.match", () => {
    const provider = new BitbucketServerProvider(
        fetchReturning(() => ({ values: [] })),
        emptyStore(),
    );

    it("matches a remote whose host is mapped to bitbucket-server", () => {
        const ref = provider.match("https://bb.acme.com/scm/proj/repo.git", SERVER_MAP);
        expect(ref).toEqual({ host: SERVER_HOST });
    });

    it("returns null when the host is absent from the HostMap", () => {
        expect(provider.match("https://bb.acme.com/scm/proj/repo.git", {})).toBeNull();
    });

    it("returns null when the host is mapped to a different provider", () => {
        const ref = provider.match("https://bb.acme.com/scm/proj/repo.git", {
            [SERVER_HOST]: "gitlab",
        });
        expect(ref).toBeNull();
    });

    it("does not match bitbucket.org (that is the Cloud provider's job)", () => {
        expect(provider.match("https://bitbucket.org/team/repo.git", SERVER_MAP)).toBeNull();
    });
});

// BitbucketServerProvider.getChecks — auth short-circuit

describe("BitbucketServerProvider.getChecks — auth", () => {
    it("returns unavailable with a sign-in hint when no token is stored", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketServerProvider(fetchJson, emptyStore());
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to bb.acme.com");
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("sends an Authorization: Bearer header carrying the stored token verbatim", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketServerProvider(
            fetchJson,
            storeWithToken("http-access-token"),
        );
        await provider.getChecks(serverRef, "abc1234");
        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers.Authorization).toBe("Bearer http-access-token");
    });

    it("uses Bearer even when the token contains a colon", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("a:b:c"));
        await provider.getChecks(serverRef, "abc1234");
        const headers = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
            string,
            string
        >;
        expect(headers.Authorization).toBe("Bearer a:b:c");
    });

    it("returns unavailable when the credential store rejects", async () => {
        const fetchJson = vi.fn();
        const provider = new BitbucketServerProvider(fetchJson, throwingStore());

        const snapshot = await provider.getChecks(serverRef, "abc1234");

        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toBe("secret store unavailable");
        expect(fetchJson).not.toHaveBeenCalled();
    });
});

// BitbucketServerProvider.getChecks — request construction

describe("BitbucketServerProvider.getChecks — request", () => {
    it("requests the global build-status endpoint keyed by commit SHA only", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));
        await provider.getChecks(serverRef, "deadbeef");
        const calledUrl = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toBe(
            "https://bb.acme.com/rest/build-status/1.0/commits/deadbeef?limit=100&start=0",
        );
    });

    it("percent-encodes the commit hash in the request URL", async () => {
        const fetchJson = fetchReturning(() => ({ values: [] }));
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));
        await provider.getChecks(serverRef, "sha/../etc");
        const calledUrl = (fetchJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toContain(`/commits/${encodeURIComponent("sha/../etc")}?`);
    });
});

// BitbucketServerProvider.getChecks — offset pagination
//
// Server reports paging via isLastPage/nextPageStart. A failing build on a second page
// must not be dropped, so the provider follows nextPageStart until isLastPage, bounded by
// a page cap. A response missing isLastPage is treated as the final (and only) page.

describe("BitbucketServerProvider.getChecks — pagination", () => {
    it("aggregates build statuses across multiple pages", async () => {
        const fetchJson = vi
            .fn()
            .mockResolvedValueOnce({
                isLastPage: false,
                nextPageStart: 100,
                values: [{ key: "1", name: "build", state: "SUCCESSFUL" }],
            })
            .mockResolvedValueOnce({
                isLastPage: true,
                values: [{ key: "2", name: "deploy", state: "FAILED" }],
            });
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));

        const snapshot = await provider.getChecks(serverRef, "abc1234");

        // Both pages contribute; the page-2 FAILED must survive and drive the aggregate.
        expect(snapshot.items).toHaveLength(2);
        expect(snapshot.state).toBe("failure");
        expect(fetchJson).toHaveBeenCalledTimes(2);
        // The second request must carry the server-supplied offset.
        expect(fetchJson.mock.calls[1][0]).toContain("start=100");
    });

    it("stops at a single page when the first page is the last", async () => {
        const fetchJson = vi.fn().mockResolvedValue({
            isLastPage: true,
            values: [{ key: "1", name: "build", state: "SUCCESSFUL" }],
        });
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(serverRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("treats a response without isLastPage as the only page", async () => {
        const fetchJson = vi.fn().mockResolvedValue({
            values: [{ key: "1", name: "build", state: "SUCCESSFUL" }],
        });
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));

        await provider.getChecks(serverRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("caps the page chain even when the server never reports the last page", async () => {
        // A pathological isLastPage=false chain must not loop forever; MAX_PAGES bounds it.
        const fetchJson = vi.fn(async (url: string) => {
            const start = Number(new URL(url).searchParams.get("start"));
            return {
                isLastPage: false,
                nextPageStart: start + 100,
                values: [{ key: String(start), name: "build", state: "SUCCESSFUL" }],
            };
        });
        const provider = new BitbucketServerProvider(fetchJson, storeWithToken("bb-token"));

        const snapshot = await provider.getChecks(serverRef, "abc1234");

        expect(fetchJson).toHaveBeenCalledTimes(5); // MAX_PAGES
        expect(snapshot.items).toHaveLength(5);
    });
});

// BitbucketServerProvider.getChecks — state mapping

describe("BitbucketServerProvider.getChecks — state mapping", () => {
    it("maps SUCCESSFUL to success", async () => {
        const snapshot = await providerForStatus("SUCCESSFUL").getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("success");
    });

    it("maps FAILED to failure", async () => {
        const snapshot = await providerForStatus("FAILED").getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("failure");
    });

    it("maps INPROGRESS to pending", async () => {
        const snapshot = await providerForStatus("INPROGRESS").getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("pending");
    });

    it("maps an unknown state to unknown", async () => {
        const snapshot = await providerForStatus("WAT").getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("unknown");
    });

    it("matches the state string case-insensitively", async () => {
        const snapshot = await providerForStatus("failed").getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("failure");
    });
});

// BitbucketServerProvider.getChecks — empty / malformed responses

describe("BitbucketServerProvider.getChecks — empty and malformed", () => {
    it("returns none for an empty values array", async () => {
        const provider = new BitbucketServerProvider(
            fetchReturning(() => ({ values: [] })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("none");
        expect(snapshot.items).toEqual([]);
    });

    it("returns none when the response is not a status page", async () => {
        const provider = new BitbucketServerProvider(
            fetchReturning(() => ({ unexpected: true })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("none");
    });

    it("returns none when the response is null", async () => {
        const provider = new BitbucketServerProvider(
            fetchReturning(() => null),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("none");
    });
});

// BitbucketServerProvider.getChecks — the no-allowlist guarantee

describe("BitbucketServerProvider.getChecks — no CI/CD allowlist", () => {
    it("reports 'failure' for a failing 'Jenkins' status whose name lacks CI/CD keywords", async () => {
        // Regression: an allowlist filter would drop a row named "Jenkins" and collapse a
        // real failure to 'none'. The badge must show the failure.
        const provider = new BitbucketServerProvider(
            fetchReturning(() => ({
                values: [{ key: "jenkins", name: "Jenkins", state: "FAILED" }],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.state).toBe("failure");
        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0]?.name).toBe("Jenkins");
    });

    it("includes every build status, regardless of name", async () => {
        const provider = new BitbucketServerProvider(
            fetchReturning(() => ({
                values: [
                    { key: "1", name: "Jenkins", state: "SUCCESSFUL" },
                    { key: "2", name: "Nexus IQ", state: "SUCCESSFUL" },
                    { key: "3", name: "CI / build", state: "SUCCESSFUL" },
                ],
            })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.items).toHaveLength(3);
    });

    it("falls back to the status key as the item name when name is absent", async () => {
        const provider = new BitbucketServerProvider(
            fetchReturning(() => ({ values: [{ key: "deploy-prod", state: "SUCCESSFUL" }] })),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "sha");
        expect(snapshot.items.find((i) => i.name === "deploy-prod")).toBeDefined();
    });
});

// BitbucketServerProvider.getChecks — HTTP error handling

describe("BitbucketServerProvider.getChecks — HTTP errors", () => {
    it("maps HTTP 401 to unavailable with a sign-in hint", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("Sign in to bb.acme.com");
    });

    it("maps HTTP 403 to unavailable with a sign-in hint", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 403: Forbidden");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.error).toContain("Sign in to bb.acme.com");
    });

    it("maps HTTP 500 to unavailable preserving the status in the message", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("HTTP 500");
    });

    it("maps a network timeout to unavailable without leaking the token", async () => {
        // A timeout is neither 401/403 nor a clean HTTP status: it must still resolve to an
        // unavailable snapshot (never throw) and the message must not echo the token.
        const secretToken = "bb-timeout-token";
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("network timeout after 10000ms");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.state).toBe("unavailable");
        expect(snapshot.error).toContain("timeout");
        expect(snapshot.error).not.toContain(secretToken);
    });

    it("returns an empty items array on HTTP error", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.items).toEqual([]);
    });

    it("records the commit hash in an unavailable snapshot", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: boom");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "deadc0de");
        expect(snapshot.hash).toBe("deadc0de");
    });
});

// BitbucketServerProvider.getChecks — token must never leak

describe("BitbucketServerProvider.getChecks — token non-leakage", () => {
    it("does NOT include the token in the error message on HTTP 500", async () => {
        const secretToken = "bb-SERVER-LEAK-CHECK";
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.summary).not.toContain(secretToken);
    });

    it("redacts the token when a transport error echoes it verbatim", async () => {
        // The token-free error tests cannot prove the guarantee. This throws an error
        // whose text embeds the stored token and asserts it is scrubbed to *** before
        // reaching the snapshot.
        const secretToken = "bb-token";
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("boom bb-token");
            }),
            storeWithToken(secretToken),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.error).not.toContain(secretToken);
        expect(snapshot.error).toContain("***");
        expect(snapshot.summary).not.toContain(secretToken);
    });
});

// BitbucketServerProvider.getChecks — signInHost (actionable sign-in target)

describe("BitbucketServerProvider.getChecks — signInHost", () => {
    it("sets signInHost to the mapped server host when no token is stored", async () => {
        const provider = new BitbucketServerProvider(vi.fn(), emptyStore());
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.signInHost).toBe(SERVER_HOST);
    });

    it("sets signInHost to the mapped server host on HTTP 401", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 401: Unauthorized");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.signInHost).toBe(SERVER_HOST);
    });

    it("sets signInHost to the mapped server host on HTTP 403", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 403: Forbidden");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.signInHost).toBe(SERVER_HOST);
    });

    it("leaves signInHost unset on HTTP 500 (not a sign-in problem)", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("HTTP 500: Internal Server Error");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.signInHost).toBeUndefined();
    });

    it("leaves signInHost unset on a network error (not a sign-in problem)", async () => {
        const provider = new BitbucketServerProvider(
            vi.fn(async () => {
                throw new Error("ECONNRESET");
            }),
            storeWithToken("bb-token"),
        );
        const snapshot = await provider.getChecks(serverRef, "abc1234");
        expect(snapshot.signInHost).toBeUndefined();
    });
});
