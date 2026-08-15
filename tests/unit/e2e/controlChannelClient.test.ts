import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { E2eRequest, E2eResponse } from "../../../src/e2e/protocol";
import { E2E_CHANNEL_READY_MARKER } from "../../../src/e2e/transportFs";
import {
    E2eControlChannelClient,
    type E2eRequestInput,
    writeE2eRequestAtomic,
} from "../../e2e/controlChannelClient";

const REQUEST_PAYLOAD: E2eRequestInput = {
    store: "memento",
    operation: "snapshot",
    scope: "workspace",
    key: "intelligit.selectedRepositoryRoot",
};

let channelDir: string;

beforeEach(async () => {
    channelDir = await mkdtemp(join(tmpdir(), "intelligit-e2e-client-test-"));
});

afterEach(async () => {
    await rm(channelDir, { recursive: true, force: true });
});

/** Waits for the client to publish one complete request file and returns its parsed envelope. */
async function waitForRequest(timeoutMs = 500): Promise<E2eRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const requestFilename = (await readdir(channelDir)).find((filename) =>
            filename.endsWith(".request.json"),
        );
        if (requestFilename !== undefined) {
            return JSON.parse(
                await readFile(join(channelDir, requestFilename), "utf8"),
            ) as E2eRequest;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("test request did not appear within the timeout");
}

/** Writes the response file for a request observed by the test-side fake extension. */
async function writeResponse(response: E2eResponse): Promise<void> {
    await writeFile(
        join(channelDir, `${response.nonce}.response.json`),
        JSON.stringify(response),
        "utf8",
    );
}

describe("writeE2eRequestAtomic", () => {
    it("publishes a complete nonce-bound request and leaves no temp file", async () => {
        const request: E2eRequest = { nonce: "abc123_X", ...REQUEST_PAYLOAD };

        await writeE2eRequestAtomic(channelDir, request);

        expect(
            JSON.parse(await readFile(join(channelDir, "abc123_X.request.json"), "utf8")),
        ).toEqual(request);
        expect(await readdir(channelDir)).toEqual(["abc123_X.request.json"]);
    });
});

describe("E2eControlChannelClient readiness", () => {
    it("waits for the readiness marker before publishing the first request", async () => {
        const client = new E2eControlChannelClient(channelDir, {
            readinessTimeoutMs: 200,
            responseTimeoutMs: 500,
            pollIntervalMs: 5,
        });
        const responsePromise = client.request(REQUEST_PAYLOAD);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await readdir(channelDir)).toEqual([]);

        await writeFile(join(channelDir, E2E_CHANNEL_READY_MARKER), "ready\n", "utf8");
        const request = await waitForRequest();
        expect(request.nonce).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        await writeResponse({ nonce: request.nonce, ok: true });

        await expect(responsePromise).resolves.toEqual({ nonce: request.nonce, ok: true });
    });

    it("reports that the channel never became ready when readiness times out", async () => {
        const client = new E2eControlChannelClient(channelDir, {
            readinessTimeoutMs: 25,
            responseTimeoutMs: 100,
            pollIntervalMs: 5,
        });

        await expect(client.request(REQUEST_PAYLOAD)).rejects.toThrow(
            /channel never became ready/i,
        );
        expect(await readdir(channelDir)).toEqual([]);
    });
});

describe("E2eControlChannelClient response polling", () => {
    it("polls, parses, and returns a typed response envelope", async () => {
        await writeFile(join(channelDir, E2E_CHANNEL_READY_MARKER), "ready\n", "utf8");
        const client = new E2eControlChannelClient(channelDir, {
            readinessTimeoutMs: 100,
            responseTimeoutMs: 500,
            pollIntervalMs: 5,
        });

        const responsePromise = client.request(REQUEST_PAYLOAD);
        const request = await waitForRequest();
        const response: E2eResponse = {
            nonce: request.nonce,
            ok: true,
            result: { kind: "value", value: "/repo/from-e2e" },
        };
        await writeResponse(response);

        await expect(responsePromise).resolves.toEqual(response);
    });

    it("keeps polling through a missing and invalid response until a valid response appears", async () => {
        await writeFile(join(channelDir, E2E_CHANNEL_READY_MARKER), "ready\n", "utf8");
        const client = new E2eControlChannelClient(channelDir, {
            readinessTimeoutMs: 100,
            responseTimeoutMs: 500,
            pollIntervalMs: 5,
        });

        const responsePromise = client.request(REQUEST_PAYLOAD);
        const request = await waitForRequest();
        const responsePath = join(channelDir, `${request.nonce}.response.json`);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(responsePath, '{"nonce":', "utf8");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response: E2eResponse = { nonce: request.nonce, ok: false, error: "rejected" };
        await writeResponse(response);

        await expect(responsePromise).resolves.toEqual(response);
    });

    it("bounds polling when the response remains missing", async () => {
        await writeFile(join(channelDir, E2E_CHANNEL_READY_MARKER), "ready\n", "utf8");
        const client = new E2eControlChannelClient(channelDir, {
            readinessTimeoutMs: 100,
            responseTimeoutMs: 25,
            pollIntervalMs: 5,
        });

        const responsePromise = client.request(REQUEST_PAYLOAD);
        const request = await waitForRequest();

        await expect(responsePromise).rejects.toThrow(
            new RegExp(`did not arrive within 25ms.*${request.nonce}\\.request\\.json`),
        );
    });
});
