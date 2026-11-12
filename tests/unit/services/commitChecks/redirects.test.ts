import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import { followRedirects } from "../../../../src/services/commitChecks/http";

interface Sent {
    url: string;
    headers: Record<string, string>;
}

/** A server that answers each URL from `routes`: a redirect target or a final status. */
function stubRoutes(routes: Record<string, { status: number; location?: string }>): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const route = routes[url];
        if (!route) throw new Error(`unexpected request ${url}`);
        const req = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn(() => req),
            destroy: vi.fn(() => req),
        });
        const res = Object.assign(new EventEmitter(), {
            statusCode: route.status,
            headers: route.location ? { location: route.location } : {},
            resume: vi.fn(),
            destroy: vi.fn(),
        });
        queueMicrotask(() => cb(res));
        return req;
    }) as unknown as typeof https.get);
    return sent;
}

const CREDENTIALS = {
    Authorization: "Bearer secret",
    Cookie: "session=1",
    "Private-Token": "glpat",
    "Job-Token": "job",
};
const HEADERS = { ...CREDENTIALS, Accept: "text/plain" };

function credentialNames(headers: Record<string, string>): string[] {
    const names = Object.keys(CREDENTIALS).map((name) => name.toLowerCase());
    return Object.keys(headers).filter((name) => names.includes(name.toLowerCase()));
}

describe("followRedirects", () => {
    beforeEach(() => {
        vi.mocked(https.get).mockReset();
    });

    it("keeps credentials on a same-origin redirect", async () => {
        const sent = stubRoutes({
            "https://api.example.com/logs": { status: 302, location: "/logs/real" },
            "https://api.example.com/logs/real": { status: 200 },
        });
        const { response, url } = await followRedirects("https://api.example.com/logs", HEADERS, {
            maxHops: 5,
        });
        expect(response.statusCode).toBe(200);
        expect(url).toBe("https://api.example.com/logs/real");
        expect(credentialNames(sent[1].headers)).toHaveLength(4);
    });

    it("strips Authorization on origin change", async () => {
        const sent = stubRoutes({
            "https://api.github.com/logs": {
                status: 302,
                location: "https://results.example.net/blob?sig=x",
            },
            "https://results.example.net/blob?sig=x": { status: 200 },
        });
        await followRedirects("https://api.github.com/logs", HEADERS, { maxHops: 5 });
        expect(credentialNames(sent[0].headers)).toHaveLength(4);
        expect(credentialNames(sent[1].headers)).toEqual([]);
        expect(sent[1].headers.Accept).toBe("text/plain");
    });

    it("strips the provider's own credential headers in any letter case", async () => {
        const sent = stubRoutes({
            "https://bb.example.com/log": { status: 307, location: "https://cdn.example.com/l" },
            "https://cdn.example.com/l": { status: 200 },
        });
        await followRedirects(
            "https://bb.example.com/log",
            { "x-api-key": "k", authorization: "Bearer s", Accept: "text/plain" },
            { maxHops: 5, credentialHeaders: ["X-Api-Key"] },
        );
        expect(Object.keys(sent[1].headers)).toEqual(["Accept"]);
    });

    it("port change counts as an origin change", async () => {
        const sent = stubRoutes({
            "https://api.example.com/logs": {
                status: 301,
                location: "https://api.example.com:8443/logs",
            },
            "https://api.example.com:8443/logs": { status: 200 },
        });
        await followRedirects("https://api.example.com/logs", HEADERS, { maxHops: 5 });
        expect(credentialNames(sent[1].headers)).toEqual([]);
    });

    it("chained redirect back to the first origin stays stripped", async () => {
        const sent = stubRoutes({
            "https://api.example.com/a": { status: 302, location: "https://other.example.com/b" },
            "https://other.example.com/b": { status: 303, location: "https://api.example.com/c" },
            "https://api.example.com/c": { status: 200 },
        });
        await followRedirects("https://api.example.com/a", HEADERS, { maxHops: 5 });
        expect(sent.map((request) => request.url)).toEqual([
            "https://api.example.com/a",
            "https://other.example.com/b",
            "https://api.example.com/c",
        ]);
        expect(credentialNames(sent[2].headers)).toEqual([]);
    });

    it("refuses an http: target", async () => {
        const sent = stubRoutes({
            "https://api.example.com/a": { status: 302, location: "http://api.example.com/b" },
            "http://api.example.com/b": { status: 200 },
        });
        await expect(
            followRedirects("https://api.example.com/a", HEADERS, { maxHops: 5 }),
        ).rejects.toThrow(/https/i);
        expect(sent).toHaveLength(1);
    });

    it("refuses a redirect with no Location", async () => {
        stubRoutes({ "https://api.example.com/a": { status: 302 } });
        await expect(
            followRedirects("https://api.example.com/a", HEADERS, { maxHops: 5 }),
        ).rejects.toThrow(/location/i);
    });

    it("follows exactly 5 hops", async () => {
        const routes: Record<string, { status: number; location?: string }> = {};
        for (let hop = 0; hop < 5; hop++) {
            routes[`https://api.example.com/${hop}`] = {
                status: 302,
                location: `https://api.example.com/${hop + 1}`,
            };
        }
        routes["https://api.example.com/5"] = { status: 200 };
        const sent = stubRoutes(routes);
        const { response } = await followRedirects("https://api.example.com/0", HEADERS, {
            maxHops: 5,
        });
        expect(response.statusCode).toBe(200);
        expect(sent).toHaveLength(6);
    });

    it("stops after 5 hops", async () => {
        const routes: Record<string, { status: number; location?: string }> = {};
        for (let hop = 0; hop < 7; hop++) {
            routes[`https://api.example.com/${hop}`] = {
                status: 302,
                location: `https://api.example.com/${hop + 1}`,
            };
        }
        const sent = stubRoutes(routes);
        await expect(
            followRedirects("https://api.example.com/0", HEADERS, { maxHops: 5 }),
        ).rejects.toThrow(/too many redirects/i);
        expect(sent).toHaveLength(6);
    });
});
