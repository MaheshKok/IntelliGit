import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import { httpGetJson } from "../../../../src/services/commitChecks/http";

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

function makeResponse(statusCode: number | undefined): EventEmitter & { statusCode?: number } {
    const res = new EventEmitter() as EventEmitter & { statusCode?: number };
    res.statusCode = statusCode;
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

    it("resolves an empty object when the body is empty", async () => {
        const req = makeRequest();
        const res = makeResponse(204);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", {});
        res.emit("end");

        await expect(promise).resolves.toEqual({});
    });

    it("rejects on a non-2xx status with a truncated body and no headers", async () => {
        const req = makeRequest();
        const res = makeResponse(404);
        stubGet(req, res);

        const promise = httpGetJson("https://api.test/x", { Authorization: "Bearer secret" });
        res.emit("data", Buffer.from("Not Found"));
        res.emit("end");

        await expect(promise).rejects.toThrow("HTTP 404: Not Found");
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
