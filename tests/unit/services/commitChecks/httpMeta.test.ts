import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import {
    createHttpGetJson,
    createHttpGetJsonWithMeta,
    HttpError,
} from "../../../../src/services/commitChecks/http";

type Headers = Record<string, string | string[] | undefined>;

function makeRequest(): EventEmitter & { setTimeout: () => unknown; destroy: () => unknown } {
    const req = new EventEmitter() as EventEmitter & {
        setTimeout: () => unknown;
        destroy: () => unknown;
    };
    req.setTimeout = vi.fn(() => req);
    req.destroy = vi.fn(() => req);
    return req;
}

/** Answers every `https.get` with one response carrying `body` and `headers`. */
function stubResponse(statusCode: number, headers: Headers, body: string): void {
    vi.mocked(https.get).mockImplementation(((
        _url: string,
        _options: unknown,
        cb: (r: unknown) => void,
    ) => {
        const req = makeRequest();
        const res = Object.assign(new EventEmitter(), { statusCode, headers });
        cb(res);
        queueMicrotask(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
        });
        return req;
    }) as unknown as typeof https.get);
}

describe("createHttpGetJsonWithMeta", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("headers reach the caller", async () => {
        const link = '<https://api.test/x?page=2>; rel="next"';
        stubResponse(200, { link, etag: 'W/"1"' }, '{"a":1}');
        const observed: number[] = [];

        const response = await createHttpGetJsonWithMeta((meta) => {
            observed.push(meta.statusCode);
        })("https://api.test/x", { Authorization: "Bearer t" });

        expect(response).toEqual({
            statusCode: 200,
            headers: { link, etag: 'W/"1"' },
            body: { a: 1 },
        });
        expect(observed).toEqual([200]);
    });

    it("rejects a non-2xx response as HttpError with its headers, like FetchJson", async () => {
        stubResponse(403, { "x-ratelimit-remaining": "0" }, "nope");
        const failure = createHttpGetJsonWithMeta()("https://api.test/x", {});
        await expect(failure).rejects.toBeInstanceOf(HttpError);
        await expect(failure).rejects.toMatchObject({
            statusCode: 403,
            headers: { "x-ratelimit-remaining": "0" },
        });
    });

    it("existing FetchJson unchanged", async () => {
        stubResponse(200, { link: "<x>" }, '{"a":1}');
        await expect(createHttpGetJson()("https://api.test/x", {})).resolves.toEqual({ a: 1 });
        stubResponse(200, {}, "");
        await expect(createHttpGetJson()("https://api.test/x", {})).resolves.toEqual({});
    });
});
