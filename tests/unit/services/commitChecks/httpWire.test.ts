import * as https from "https";
import type { Socket } from "net";
import { Duplex } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    httpGetJson,
    httpRequestJson,
    RequestNotSentError,
} from "../../../../src/services/commitChecks/http";

// Only the agent's wire is replaced: ClientRequest, the HTTP parser and IncomingMessage are Node's.
class AgentSocket extends Duplex {
    connecting = false;
    setTimeout = vi.fn(() => this);
    constructor(readonly answer: (socket: AgentSocket) => void) {
        super();
    }
    setNoDelay(): this {
        return this;
    }
    setKeepAlive(): this {
        return this;
    }
    ref(): this {
        return this;
    }
    unref(): this {
        return this;
    }
    _read(): void {}
    _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
        done();
        if (chunk.toString().includes("\r\n\r\n")) queueMicrotask(() => this.answer(this));
    }
}

const wires: AgentSocket[] = [];
let serial = 0;

function transport(answer: AgentSocket["answer"]): string {
    vi.spyOn(https.globalAgent, "createConnection").mockImplementation(() => {
        const socket = new AgentSocket(answer);
        wires.push(socket);
        return socket as unknown as Socket;
    });
    return `https://wire-${++serial}.invalid/`;
}

function send(method: string, url: string): Promise<unknown> {
    return method === "POST" ? httpRequestJson(method, url, {}) : httpGetJson(url, {});
}

async function stateOf(promise: Promise<unknown>): Promise<string> {
    return Promise.race([
        promise.then(
            () => "resolved",
            (error: Error) => error.name,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
}

describe("send() over Node's real HTTP client", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const socket of wires.splice(0)) socket.destroy();
    });

    it("a 101 reply nobody asked for settles the POST and the badge GET", async () => {
        const url = transport((socket) => {
            socket.push(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
            );
        });
        for (const method of ["POST", "GET"]) {
            expect(
                await stateOf(send(method, url)),
                `a ${method} answered with 101 must reject instead of keeping the UI busy`,
            ).toBe("Error");
        }
    });

    it("a body cut off mid-way rejects, and never as a non-send", async () => {
        const url = transport((socket) => {
            socket.push('HTTP/1.1 202 Accepted\r\nContent-Length: 100\r\n\r\n{"part":');
            setImmediate(() => socket.destroy());
        });
        for (const method of ["POST", "GET"]) {
            const error = await send(method, url).catch((caught: unknown) => caught);
            expect(error, `a cut-off ${method} rejects`).toBeInstanceOf(Error);
            expect(error, `a cut-off ${method} reached the provider`).not.toBeInstanceOf(
                RequestNotSentError,
            );
        }
    });

    it("a body that ends when the server closes the connection still resolves", async () => {
        const url = transport((socket) => {
            socket.push("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}");
            setImmediate(() => socket.push(null));
        });
        for (const method of ["POST", "GET"]) {
            await expect(
                send(method, url),
                `a ${method} whose body ends at connection close is a whole answer`,
            ).resolves.toEqual({});
        }
    });

    it("a reset on a reused keep-alive socket may have sent the POST", async () => {
        let received = 0;
        const url = transport((socket) => {
            if (++received === 1) socket.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            else socket.destroy(new Error("connection reset"));
        });
        await httpRequestJson("POST", url, {});
        const error = await httpRequestJson("POST", url, {}).catch((caught: unknown) => caught);
        expect(wires, "the second POST rode the pooled socket").toHaveLength(1);
        expect(
            error,
            "a reused socket was connected, so the POST may have gone out",
        ).not.toBeInstanceOf(RequestNotSentError);
    });
});
