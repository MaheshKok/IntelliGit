import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

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
    await removeScratchDirectories(channelDir);
});

/**
 * Waits for the client to publish one complete request file and returns its parsed envelope.
 *
 * The budget guards a hang, not a deadline any assertion here is about: the publish always
 * happens, and on a shared Windows runner it has outlasted the 500ms this used to allow. The first
 * attempt of run 34700493095 failed three cases at the old budget with `test request did not
 * appear within the timeout` while the client was still inside its temp-file-plus-rename publish;
 * the re-run of the same commit passed them.
 */
async function waitForRequest(timeoutMs = 10_000): Promise<E2eRequest> {
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

/**
 * Keeps a promise the test awaits later from surfacing as an unhandled rejection when the test
 * fails before it reaches that assertion. Node reports the abandoned rejection run-wide -- `Errors
 * 1 error`, exit code 1, no test red -- which is the mode this file's `bounds polling` case
 * already documents; a handler attached at creation is what keeps a red test red on its own terms.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => undefined);
    return promise;
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
        const responsePromise = handled(client.request(REQUEST_PAYLOAD));

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

        const responsePromise = handled(client.request(REQUEST_PAYLOAD));
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

        const responsePromise = handled(client.request(REQUEST_PAYLOAD));
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

        // The handler is attached where the promise is created, not at the assertion. This is the
        // one case in the file whose promise is expected to REJECT, and `responseTimeoutMs` is 25ms
        // -- less than the `waitForRequest` directory poll below costs on a slow filesystem. So the
        // rejection lands while nothing is watching it, Node reports an unhandled rejection, and
        // that fails the RUN while this test still passes: `.rejects` is satisfied by a promise
        // that rejected earlier, so the assertion never notices it was late. Measured on
        // windows-latest at 10a7e3a9 -- `Tests 4160 passed | 46 skipped (4206)`, `Errors 1 error`,
        // exit code 1, no test red anywhere. Reproducible on any platform by sleeping 80ms in the
        // gap this line closes.
        const outcome = client.request(REQUEST_PAYLOAD).catch((error: unknown) => error);
        const request = await waitForRequest();
        const rejection = await outcome;

        expect(
            rejection,
            "the bounded poll must reject rather than resolve; a resolved value here would mean " +
                "the deadline was never enforced",
        ).toBeInstanceOf(Error);
        expect(
            (rejection as Error).message,
            "the timeout must name both the bound it exceeded and the request left unanswered",
        ).toMatch(new RegExp(`did not arrive within 25ms.*${request.nonce}\\.request\\.json`));
    });
});
