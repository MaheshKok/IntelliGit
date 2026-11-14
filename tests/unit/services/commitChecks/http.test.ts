import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import {
    createHttpGetJson,
    createHttpRequestJson,
    HttpError,
    httpGetJson,
    httpRequestJson,
} from "../../../../src/services/commitChecks/http";

interface FakeRequest extends EventEmitter {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    timeoutCallback?: () => void;
}

function makeRequest(): FakeRequest {
    const req = new EventEmitter() as FakeRequest;
    // setTimeout(0) is the clear-call (no callback); setTimeout(ms, cb) arms the timeout.
    req.setTimeout = vi.fn((_ms: number, callback?: () => void) => {
        if (callback) req.timeoutCallback = callback;
        return req;
    });
    // Real ClientRequest.destroy(err) surfaces err via the "error" event.
    req.destroy = vi.fn((err: Error) => {
        req.emit("error", err);
        return req;
    });
    return req;
}

function makeResponse(
    statusCode: number | undefined,
    headers: Record<string, string | string[] | undefined> = {},
): EventEmitter & { statusCode?: number; headers: Record<string, string | string[] | undefined> } {
    const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        headers: Record<string, string | string[] | undefined>;
    };
    res.statusCode = statusCode;
    res.headers = headers;
    return res;
}

/** Wire up https.get to hand the executor a fake req and invoke the callback with res. */
function stubGet(req: FakeRequest, res: EventEmitter): void {
    vi.mocked(https.get).mockImplementation(
        // The overloaded signature is sidestepped; we only need (url, options, cb).
        ((_url: string, _options: unknown, cb: (r: unknown) => void) => {
            cb(res);
            return req;
        }) as unknown as typeof https.get,
    );
}

describe("httpGetJson", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves parsed JSON on a 2xx response", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", { Authorization: "Bearer t" });
        res.emit("data", Buffer.from('{"a":'));
        res.emit("data", Buffer.from("1}")); // chunked body must be reassembled
        res.emit("end");

        await expect(promise).resolves.toEqual({ a: 1 });
        expect(https.get).toHaveBeenCalledWith(
            "https://api.test/x",
            { headers: { Authorization: "Bearer t" } },
            expect.any(Function),
        );
    });

    it("observes token-free response metadata without changing a successful JSON result", async () => {
        const req = makeRequest();
        const headers = {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "99",
            "x-ratelimit-reset": "3600",
        };
        const res = makeResponse(200, headers);
        const observe = vi.fn();
        stubGet(req, res);

        const fetchJson = createHttpGetJson(observe);
        const promise = fetchJson("https://api.test/x", { Authorization: "Bearer secret" });
        res.emit("data", Buffer.from('{"a":1}'));
        res.emit("end");

        await expect(promise).resolves.toEqual({ a: 1 });
        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith({
            url: "https://api.test/x",
            statusCode: 200,
            headers,
        });
    });

    it("swallows response observer failures", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        const observe = vi.fn(() => {
            throw new Error("observer failed");
        });
        stubGet(req, res);

        const promise = createHttpGetJson(observe)("https://api.test/x", {});
        res.emit("data", Buffer.from('{"a":1}'));
        res.emit("end");

        await expect(promise).resolves.toEqual({ a: 1 });
        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith({
            url: "https://api.test/x",
            statusCode: 200,
            headers: {},
        });
    });

    it("resolves an empty object when the body is empty", async () => {
        const req = makeRequest();
        const res = makeResponse(204);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        res.emit("end");

        await expect(promise).resolves.toEqual({});
    });

    it("rejects on a non-2xx status with a truncated body and response headers", async () => {
        const req = makeRequest();
        const res = makeResponse(404, { "x-ratelimit-remaining": "0" });
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", { Authorization: "Bearer secret" });
        res.emit("data", Buffer.from("Not Found"));
        res.emit("end");

        await expect(promise).rejects.toThrow("HTTP 404: Not Found");
        await expect(promise).rejects.toMatchObject({
            statusCode: 404,
            headers: { "x-ratelimit-remaining": "0" },
        } satisfies Partial<HttpError>);
        // The token must never appear in the rejection.
        await expect(promise).rejects.not.toThrow(/secret/);
    });

    it("treats a missing statusCode as a failure", async () => {
        const req = makeRequest();
        const res = makeResponse(undefined);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        res.emit("end");

        await expect(promise).rejects.toThrow("HTTP 0:");
    });

    it("rejects when the body is not valid JSON", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        res.emit("data", Buffer.from("<html>not json</html>"));
        res.emit("end");

        await expect(promise).rejects.toThrow("Invalid JSON response");
    });

    it("rejects when the request emits a network error", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        req.emit("error", new Error("ECONNRESET"));

        await expect(promise).rejects.toThrow("ECONNRESET");
    });

    it("destroys the request and rejects on timeout", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        expect(req.setTimeout).toHaveBeenCalledWith(15000, expect.any(Function));
        req.timeoutCallback?.(); // fire the armed timeout

        await expect(promise).rejects.toThrow("HTTP request timed out");
        expect(req.destroy).toHaveBeenCalledTimes(1);
    });
});

describe("httpRequestJson", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function stubRequest(req: FakeRequest & { end?: unknown }, res: EventEmitter): void {
        req.end = vi.fn();
        vi.mocked(https.request).mockImplementation(((
            _url: string,
            _options: unknown,
            cb: (r: unknown) => void,
        ) => {
            cb(res);
            return req;
        }) as unknown as typeof https.request);
    }

    it("a timeout after a 403 response head keeps the definite refusal", async () => {
        const req = makeRequest();
        const res = makeResponse(403);
        stubRequest(req, res);
        const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
        // The server sent its refusal but stalls before finishing the body.
        req.timeoutCallback?.();
        res.emit("error", new Error("aborted"));
        res.emit("close");

        await expect(
            promise,
            "a body timeout cannot erase an already received 403",
        ).rejects.toMatchObject({ name: "HttpError", statusCode: 403 });
    });

    it("sends one POST with its JSON body and resolves the 2xx body", async () => {
        const req = makeRequest();
        const res = makeResponse(201);
        stubRequest(req, res);
        const observe = vi.fn();

        const promise = createHttpRequestJson(observe)(
            "POST",
            "https://api.test/runs/1/cancel",
            { Authorization: "Bearer t" },
            { reason: "x" },
        );
        res.emit("data", Buffer.from("{}"));
        res.emit("end");

        await expect(promise).resolves.toEqual({});
        expect(https.request).toHaveBeenCalledWith(
            "https://api.test/runs/1/cancel",
            {
                method: "POST",
                headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
            },
            expect.any(Function),
        );
        expect((req as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledWith(
            '{"reason":"x"}',
        );
        expect(https.get).not.toHaveBeenCalled();
        expect(observe).toHaveBeenCalledWith(
            expect.objectContaining({ url: "https://api.test/runs/1/cancel", statusCode: 201 }),
        );
    });

    it("rejects a 403 as an HttpError and follows no redirect", async () => {
        for (const statusCode of [403, 302]) {
            const req = makeRequest();
            const res = makeResponse(statusCode, { location: "https://elsewhere.test/" });
            stubRequest(req, res);

            const promise = httpRequestJson("POST", "https://api.test/jobs/1/retry", {});
            res.emit("end");

            await expect(promise).rejects.toMatchObject({ name: "HttpError", statusCode });
            expect(https.request).toHaveBeenCalledTimes(1);
            vi.clearAllMocks();
        }
    });

    it("a request the transport refuses to build rejects as never sent", async () => {
        vi.mocked(https.request).mockImplementation((() => {
            throw new TypeError('Invalid character in header content ["Authorization"]');
        }) as unknown as typeof https.request);

        await expect(
            httpRequestJson("POST", "https://api.test/runs/1/cancel", { Authorization: "x\ny" }),
            "a request that was never created is a definite non-send",
        ).rejects.toMatchObject({
            name: "RequestNotSentError",
            message: 'Invalid character in header content ["Authorization"]',
        });
    });

    it("a rejected beforeSend sends nothing", async () => {
        await expect(
            httpRequestJson("POST", "https://api.test/runs/1/cancel", {}, undefined, async () => {
                throw new Error("Remote data changed.");
            }),
        ).rejects.toThrow("Remote data changed.");
        expect(
            https.request,
            "the fence step runs before the request exists",
        ).not.toHaveBeenCalled();
    });

    it("a DNS or connection refusal before any socket connects rejects as never sent", async () => {
        for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
            const req = makeRequest() as FakeRequest & { end: unknown };
            // Node reports these asynchronously, after `request()` has returned.
            req.end = vi.fn(() => {
                queueMicrotask(() => {
                    req.emit(
                        "error",
                        Object.assign(new Error(`getaddrinfo ${code} no-such-host`), { code }),
                    );
                });
            });
            vi.mocked(https.request).mockImplementation(
                (() => req) as unknown as typeof https.request,
            );

            await expect(
                httpRequestJson("POST", "https://no-such-host/runs/1/cancel", {}),
                `${code} before connection must delete the action fence`,
            ).rejects.toMatchObject({
                name: "RequestNotSentError",
                message: `getaddrinfo ${code} no-such-host`,
            });
        }
    });

    it("a socket error after the request exists is not a never-sent error", async () => {
        const req = makeRequest() as FakeRequest & { end: unknown };
        req.end = vi.fn(() => {
            req.emit("error", new Error("socket hang up"));
        });
        vi.mocked(https.request).mockImplementation((() => req) as unknown as typeof https.request);

        await expect(
            httpRequestJson("POST", "https://api.test/runs/1/cancel", {}),
        ).rejects.toMatchObject({ name: "Error", message: "socket hang up" });
    });

    it("a POST whose connection drops after the headers rejects so the action can refresh", async () => {
        for (const drop of ["close", "error"] as const) {
            const req = makeRequest();
            const res = makeResponse(202);
            stubRequest(req, res);

            const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
            res.emit("data", Buffer.from('{"par'));
            if (drop === "error") {
                expect(
                    () => res.emit("error", new Error("aborted")),
                    "a cut-off response's error is handled, never thrown into the extension host",
                ).not.toThrow();
            }
            res.emit("close");

            expect(
                await stateOf(promise),
                `a response cut by "${drop}" must settle the write so its uncertain outcome can refresh`,
            ).toBe("rejected");
            await expect(
                promise,
                "the request was sent, so it is never a non-send",
            ).rejects.not.toMatchObject({
                name: "RequestNotSentError",
            });
            expect(
                req.setTimeout,
                "the idle timeout is cleared on the way out",
            ).toHaveBeenLastCalledWith(0);
            vi.clearAllMocks();
        }
    });

    it("a reply cut off after its status line still reaches the response observer once", async () => {
        // A 2xx cut-off rejects without ever building the reply, so it pins the observer to the head.
        for (const statusCode of [429, 202]) {
            const req = makeRequest();
            const headers = {
                "retry-after": "60",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1700000000",
            };
            const res = makeResponse(statusCode, headers);
            stubRequest(req, res);
            const observe = vi.fn();

            const promise = createHttpRequestJson(observe)(
                "POST",
                "https://api.test/runs/1/cancel",
                {},
            );
            res.emit("data", Buffer.from('{"message":"API rate'));
            res.emit("close");
            await promise.catch(() => undefined);

            expect(
                observe,
                `the request gate's cooldown must read the headers of a cut-off ${statusCode}`,
            ).toHaveBeenCalledTimes(1);
            expect(observe).toHaveBeenCalledWith({
                url: "https://api.test/runs/1/cancel",
                statusCode,
                headers,
            });
            vi.clearAllMocks();
        }
    });

    it("a non-2xx reply whose body is cut off rejects as the HttpError its status line decided", async () => {
        for (const drop of ["close", "error"] as const) {
            const req = makeRequest();
            const res = makeResponse(403, { "x-accepted-github-permissions": "actions=write" });
            stubRequest(req, res);

            const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
            res.emit("data", Buffer.from('{"message":"Resource not acc'));
            if (drop === "error") res.emit("error", new Error("aborted"));
            res.emit("close");

            await expect(
                promise,
                `a 403 cut off by "${drop}" is the same refusal as a whole 403`,
            ).rejects.toMatchObject({
                name: "HttpError",
                statusCode: 403,
                headers: { "x-accepted-github-permissions": "actions=write" },
            });
            vi.clearAllMocks();
        }
    });

    it("a 3xx reply whose body is cut off rejects as the HttpError its status line decided", async () => {
        const req = makeRequest();
        const res = makeResponse(302);
        stubRequest(req, res);

        const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
        res.emit("data", Buffer.from("<html>Moved"));
        res.emit("close");

        await expect(
            promise,
            "a cut-off 302 is the same definite refusal as a whole 302",
        ).rejects.toMatchObject({ name: "HttpError", statusCode: 302 });
    });

    it("a 2xx reply cut off before any body byte still rejects, though an empty body would parse", async () => {
        const req = makeRequest();
        const res = makeResponse(202);
        stubRequest(req, res);

        const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
        res.emit("close");

        await expect(
            promise,
            "a cut-off 2xx stays uncertain, never a whole empty reply",
        ).rejects.toThrow("The connection closed before the response ended.");
    });

    it("a response that ends normally still resolves when its close follows", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubRequest(req, res);

        const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
        res.emit("data", Buffer.from("{}"));
        res.emit("end");
        res.emit("close");

        await expect(promise, "close after end is the normal ending").resolves.toEqual({});
    });

    it("the request closing after the answer arrived leaves settling to the response", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubRequest(req, res);

        const promise = httpRequestJson("POST", "https://api.test/runs/1/cancel", {});
        req.emit("close");
        res.emit("data", Buffer.from("{}"));
        res.emit("end");

        await expect(
            promise,
            "a request close that beats the response's end must not reject a whole answer",
        ).resolves.toEqual({});
    });

    it("an error on a fresh socket that never connected rejects as never sent", async () => {
        for (const code of ["ENETUNREACH", "EPERM"]) {
            const req = socketRequest({ reused: false, connects: false, code });

            await expect(
                httpRequestJson("POST", "https://api.test/runs/1/cancel", {}),
                `${code} on a socket that never connected must delete the action fence`,
            ).rejects.toMatchObject({ name: "RequestNotSentError", message: `connect ${code}` });
            expect(req.end).toHaveBeenCalledTimes(1);
        }
    });

    it("an error after the socket connected may have sent the request", async () => {
        socketRequest({ reused: false, connects: true, code: "ECONNRESET" });

        await expect(
            httpRequestJson("POST", "https://api.test/runs/1/cancel", {}),
            "a connected socket (a failed TLS handshake included) may have carried the POST",
        ).rejects.toMatchObject({ name: "Error", message: "connect ECONNRESET" });
    });

    it("an error on a reused keep-alive socket may have sent the request", async () => {
        // ECONNREFUSED included: a refusal code after the socket connected is not proof of a non-send.
        for (const code of ["ECONNRESET", "ECONNREFUSED"]) {
            socketRequest({ reused: true, connects: false, code });

            await expect(
                httpRequestJson("POST", "https://api.test/runs/1/cancel", {}),
                `a reused socket was already connected, so the POST may have gone out (${code})`,
            ).rejects.toMatchObject({ name: "Error", message: `connect ${code}` });
        }
    });
});

describe("send() shared by the badge GETs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a badge GET whose connection drops after the headers rejects", async () => {
        const req = makeRequest();
        const res = makeResponse(200);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        res.emit("data", Buffer.from('{"a":'));
        res.emit("close");

        expect(
            await stateOf(promise),
            "a cut-off badge read must settle instead of loading forever",
        ).toBe("rejected");
    });
});

/** "pending", "resolved" or "rejected" once every queued callback has run. */
async function stateOf(promise: Promise<unknown>): Promise<string> {
    let state = "pending";
    promise.then(
        () => (state = "resolved"),
        () => (state = "rejected"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return state;
}

/**
 * A request whose socket Node hands over on `end()`: fresh and still connecting unless
 * `reused`; it connects first when `connects`; then it fails with `code`.
 */
function socketRequest(options: {
    reused: boolean;
    connects: boolean;
    code: string;
}): FakeRequest & { end: ReturnType<typeof vi.fn> } {
    const req = makeRequest() as FakeRequest & {
        end: ReturnType<typeof vi.fn>;
        reusedSocket: boolean;
    };
    req.reusedSocket = options.reused;
    req.end = vi.fn(() => {
        const socket = Object.assign(new EventEmitter(), { connecting: !options.reused });
        req.emit("socket", socket);
        queueMicrotask(() => {
            if (options.connects) {
                socket.connecting = false;
                socket.emit("connect");
            }
            req.emit(
                "error",
                Object.assign(new Error(`connect ${options.code}`), {
                    code: options.code,
                    syscall: "connect",
                }),
            );
        });
    });
    vi.mocked(https.request).mockImplementation((() => req) as unknown as typeof https.request);
    return req;
}
