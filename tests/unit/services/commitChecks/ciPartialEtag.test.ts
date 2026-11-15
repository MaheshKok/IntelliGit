import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");
vi.mock("vscode", () => ({
    authentication: {
        getSession: async () => ({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        }),
    },
    l10n: { t: (message: string) => message },
}));

import { createCommitChecksProviders } from "../../../../src/activation/commitChecksProviders";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { CommitChecksRequestGateRegistry } from "../../../../src/services/commitChecks/requestGate";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

// A snapshot a provider marks partial is not persisted, so every poll asks the server again. It
// must stay on conditional requests (plan Phase 5): an unchanged answer is then a free 304.

interface Sent {
    url: string;
    headers: Record<string, string>;
}
type Route = (url: string) => unknown;

function respond(
    status: number,
    headers: Record<string, string>,
    body: string | undefined,
    cb: (r: unknown) => void,
): EventEmitter {
    const req = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(() => req),
        destroy: vi.fn(() => req),
    });
    const res = Object.assign(new EventEmitter(), { statusCode: status, headers });
    cb(res);
    queueMicrotask(() => {
        if (body) res.emit("data", Buffer.from(body));
        res.emit("end");
    });
    return req;
}

/** Every 200 carries an `ETag` of its body; a request naming the current one gets a 304. */
function stubServer(route: Route): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const text = JSON.stringify(route(url));
        const etag = `W/"${createHash("sha1").update(text).digest("hex")}"`;
        if (options.headers["If-None-Match"] === etag) {
            return respond(304, { "x-ratelimit-remaining": "4990" }, undefined, cb);
        }
        return respond(200, { etag }, text, cb);
    }) as unknown as typeof https.get);
    return sent;
}

function providerById(id: string): CommitChecksProvider {
    const store = { get: async () => "token" } as unknown as CredentialStore;
    const all = createCommitChecksProviders(
        new CommitChecksRequestGateRegistry("cooling down"),
        store,
        undefined,
        new CiGenerations(),
    );
    return all.find((provider) => provider.id === id) as CommitChecksProvider;
}

const SHA = "a".repeat(40);
const conditional = (requests: readonly Sent[]) =>
    requests.filter((request) => request.headers["If-None-Match"] !== undefined);

interface Case {
    name: string;
    id: string;
    ref: ProviderRepoRef;
    requestsPerPoll: number;
    route: Route;
}

const cases: Case[] = [
    {
        name: "GitHub parent at the 1000 check-suite limit",
        id: "github",
        ref: { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef,
        requestsPerPoll: 3,
        route: (url) => {
            const { pathname } = new URL(url);
            if (pathname.endsWith("/check-suites")) return { total_count: 1000, check_suites: [] };
            if (pathname.endsWith("/status")) return { statuses: [] };
            return {
                total_count: 1,
                check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success" }],
            };
        },
    },
    {
        name: "GitLab full first page",
        id: "gitlab",
        ref: { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef,
        requestsPerPoll: 1,
        route: () =>
            Array.from({ length: 100 }, (_, index) => ({
                name: `ci/job-${index}`,
                status: "success",
            })),
    },
    {
        name: "Bitbucket Cloud refused next link",
        id: "bitbucket-cloud",
        ref: { host: "bitbucket.org", workspace: "w", repo: "r" } as ProviderRepoRef,
        requestsPerPoll: 1,
        route: () => ({
            values: [{ key: "build", state: "SUCCESSFUL" }],
            next: "https://evil.example.com/2.0/next",
        }),
    },
    {
        name: "Bitbucket Server page without nextPageStart",
        id: "bitbucket-server",
        ref: { host: "bb.example.com", project: "P", repo: "r" } as ProviderRepoRef,
        requestsPerPoll: 1,
        route: () => ({ values: [{ key: "build", state: "SUCCESSFUL" }], isLastPage: false }),
    },
];

describe("a partial snapshot stays on conditional polling", () => {
    // A braced body: a returned mock would be run as a cleanup hook.
    beforeEach(() => {
        vi.mocked(https.get).mockReset();
    });

    it.each(cases)("$name", async ({ id, ref, requestsPerPoll, route }) => {
        const sent = stubServer(route);
        const provider = providerById(id);
        for (let poll = 0; poll < 3; poll++) {
            const snapshot = await provider.getChecks(ref, SHA);
            expect(snapshot.partial, "the snapshot under test is partial").toBe(true);
            expect(snapshot.state, "and finished").toBe("success");
        }
        expect(sent).toHaveLength(requestsPerPoll * 3);
        // The first poll leaves no stored ETag; the second, now conditional, stores one.
        expect(conditional(sent.slice(0, requestsPerPoll * 2))).toHaveLength(0);
        expect(
            conditional(sent.slice(requestsPerPoll * 2)),
            "an unchanged partial parent must send If-None-Match on every request of the third poll",
        ).toHaveLength(requestsPerPoll);
    });
});
